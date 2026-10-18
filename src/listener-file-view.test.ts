/**
 * Reading a session's files from the phone, end to end against a real git.
 *
 * The file view rides the diff channel (`serveDiff`, label `session.diff`): same checks in the
 * same order, with `kind` inside the seal as the only thing that tells a file answer from a diff
 * answer. These tests pin that the kinds do not cross, that the sealed answer is bound to its
 * request, that nothing about the tree is in the clear, and that a request which fails an earlier
 * step never reaches git. The phone here is `v2Party`, an independent implementation of the
 * envelope.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';

let gitRuns = 0;
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: ((cmd: string, ...rest: unknown[]) => {
            if (cmd === 'git') gitRuns++;
            return (actual.spawnSync as (...args: unknown[]) => unknown)(cmd, ...rest);
        }) as typeof actual.spawnSync,
    };
});

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const TMP = mkdtempSync(join(tmpdir(), 'hwip-file-view-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
delete process.env.HWIP_FILE_VIEW;

const { fileViewBytes, handleDiffFilesRequest, handleDiffFileRequest, handleFileTreeRequest, handleFileBlobRequest, computeListenerDeviceId, setSubscriberTrust } =
    await import('./listener.js');
const { FILE_VIEW_WINDOW_BYTES, FILE_VIEW_WINDOW_MS } = await import('./file-view-budget.js');
const { setFileView } = await import('./file-view-switch.js');
const { repoRootOf } = await import('./session-diff.js');
const { DIFF_PAGE_MAX_BYTES } = await import('./session-diff.js');
const { getDevicePublicKey, initDeviceCrypto } = await import('./crypto.js');
const { trustEveryKey } = await import('../tests/helpers/trust.js');
const { rememberSessions } = await import('./session-registry.js');

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf-8' });
const write = (root: string, rel: string, data: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
};

const SESSION = 'hwip-api';
const REPO = join(TMP, 'work', 'api');
const phone = v2Party();
const stranger = v2Party();
let listenerKey: string;

type Wire = Record<string, unknown>;
const ALLOWED_FRAME_KEYS = new Set(['subtype', 'requestId', 'sessionName', 'targetDeviceId', 'at', 'encrypted', 'error']);

beforeAll(async () => {
    await initDeviceCrypto();
    listenerKey = getDevicePublicKey() as string;
    setSubscriberTrust(trustEveryKey);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("agent.diff.tree / agent.diff.blob — a session's files", () => {
    const device = computeListenerDeviceId();
    let sent: Wire[];
    const send = (data: Wire) => { sent.push(data); };

    type Handler = typeof handleFileTreeRequest;
    /** The frame the phone would send: routing in the clear, the question sealed. `inner` replaces the sealed body whole. */
    const frame = (kind: 'tree' | 'blob', ask: Record<string, unknown> = {}, over: Wire = {}, inner?: Record<string, unknown>): Wire => {
        const requestId = (over.requestId as string | undefined) ?? 'r1';
        const sessionName = (over.sessionName as string | undefined) ?? SESSION;
        const body = inner ?? { v: 1, kind: `${kind}.request`, requestId, path: kind === 'tree' ? '' : 'src/index.ts', ...(kind === 'blob' ? { offset: 0 } : {}), ...ask };
        return {
            subtype: `agent.diff.${kind}.request`,
            targetDeviceId: device,
            sessionName,
            requestId,
            deviceId: 'dev_phone',
            subscriberPublicKey: phone.publicKey,
            encrypted: phone.seal('session.diff', JSON.stringify(body), listenerKey, sessionName),
            ...over,
        };
    };

    const ask = async (handler: Handler, request: Wire): Promise<Wire> => {
        const before = sent.length;
        handler(request, send);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1];
    };
    const askTree = (ask_: Record<string, unknown> = {}, over: Wire = {}) => ask(handleFileTreeRequest, frame('tree', ask_, over));
    const askBlob = (ask_: Record<string, unknown> = {}, over: Wire = {}) => ask(handleFileBlobRequest, frame('blob', ask_, over));

    const opened = (reply: Wire): Record<string, any> =>
        JSON.parse(phone.open('session.diff', reply.encrypted as Parameters<typeof phone.open>[1], SESSION)) as Record<string, any>;

    const remember = (cwd = REPO) => rememberSessions([{ name: SESSION, cwd, agentKind: 'claude' }]);

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        sent = [];
        gitRuns = 0;
        setSubscriberTrust(trustEveryKey);
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(REPO, { recursive: true, force: true });
        mkdirSync(REPO, { recursive: true });
        git(REPO, 'init', '-q', '-b', 'main');
        write(REPO, '.gitignore', 'ignored.txt\nignored-dir/\n');
        write(REPO, 'src/index.ts', 'export const a = 1;\n');
        write(REPO, 'README.md', 'hello\n');
        git(REPO, 'add', '-A');
        git(REPO, 'commit', '-q', '-m', 'chore: seed');
        write(REPO, 'src/new.ts', 'one\ntwo\n');
        write(REPO, 'ignored.txt', 'nobody reads this\n');
    });

    describe('routing', () => {
        it('does not claim other ephemeral traffic, nor the diff subtypes', () => {
            expect(handleFileTreeRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleFileTreeRequest({ subtype: 'agent.diff.blob.request' }, send)).toBe(false);
            expect(handleFileBlobRequest({ subtype: 'agent.diff.tree.request' }, send)).toBe(false);
            expect(handleDiffFilesRequest({ subtype: 'agent.diff.tree.request' }, send)).toBe(false);
            expect(handleDiffFileRequest({ subtype: 'agent.diff.blob.request' }, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine, or without an id or session', () => {
            remember();
            expect(handleFileTreeRequest(frame('tree', {}, { targetDeviceId: 'dev_other' }), send)).toBe(false);
            expect(handleFileBlobRequest(frame('blob', {}, { requestId: '' }), send)).toBe(false);
            expect(handleFileTreeRequest(frame('tree', {}, { sessionName: '' }), send)).toBe(false);
            expect(sent).toEqual([]);
            expect(gitRuns).toBe(0);
        });
    });

    describe('a directory listing', () => {
        it('opens for the phone and is bound to the request it answers', async () => {
            remember();
            const reply = await askTree({ path: '' });
            expect(reply.subtype).toBe('agent.diff.tree.result');
            expect(reply.requestId).toBe('r1');
            expect(reply.error).toBeUndefined();
            const answer = opened(reply);
            expect(answer).toMatchObject({ v: 1, kind: 'tree.result', requestId: 'r1', path: '' });
            expect(answer.entries).toEqual([
                { name: '.gitignore', type: 'file' },
                { name: 'README.md', type: 'file' },
                { name: 'src', type: 'dir' },
            ]);
            // The request's cursor is not echoed, and a last page has no next one.
            expect(answer).not.toHaveProperty('cursor');
            expect(answer.truncated).toBeFalsy();
            expect(answer).not.toHaveProperty('base');
        });

        it('lists a sub-directory by its path, with an untracked file in it', async () => {
            remember();
            const answer = opened(await askTree({ path: 'src' }));
            expect(answer).toMatchObject({ kind: 'tree.result', path: 'src' });
            expect(answer.entries).toEqual([
                { name: 'index.ts', type: 'file' },
                { name: 'new.ts', type: 'file' },
            ]);
        });

        it('answers an ignored or missing directory as absent, not as an error', async () => {
            remember();
            write(REPO, 'ignored-dir/inside', 'x');
            for (const path of ['nope', 'ignored-dir', 'ignored.txt']) {
                const reply = await askTree({ path });
                expect(reply.error).toBeUndefined();
                expect(opened(reply)).toMatchObject({ kind: 'tree.result', path, entries: [], body: 'absent' });
            }
        });

        it('hands out the next page cursor only when the page is cut, and the cursor continues it', async () => {
            // 500 names a hundred characters long are ~60 KiB of JSON: more than a sealed frame carries.
            const long = (i: number) => `${'n'.repeat(100)}-${String(i).padStart(3, '0')}.txt`;
            for (let i = 0; i < 500; i++) write(REPO, `many/${long(i)}`, '');
            git(REPO, 'add', '-A');
            remember();

            const seen: string[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < 40; page++) {
                const reply = await askTree({ path: 'many', ...(cursor === undefined ? {} : { cursor }) });
                expect(reply.error).toBeUndefined();
                const answer = opened(reply);
                expect(JSON.stringify(answer).length).toBeLessThanOrEqual(24 * 1024);
                seen.push(...answer.entries.map((e: { name: string }) => e.name));
                if (!answer.truncated) {
                    expect(answer).not.toHaveProperty('cursor');
                    break;
                }
                // The cursor is the last name of this page, not the one the request carried.
                expect(answer.cursor).toBe(answer.entries[answer.entries.length - 1].name);
                expect(answer.cursor).not.toBe(cursor);
                cursor = answer.cursor;
            }
            expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => long(i)));
        });
    });

    describe('a file', () => {
        it('opens one page of its text, bound to the request, with no base', async () => {
            remember();
            const reply = await askBlob({ path: 'src/index.ts', offset: 0 });
            expect(reply.subtype).toBe('agent.diff.blob.result');
            const answer = opened(reply);
            expect(answer).toMatchObject({
                v: 1, kind: 'blob.result', requestId: 'r1', path: 'src/index.ts', offset: 0,
                body: 'text', chunk: 'export const a = 1;\n', length: 20, hasMore: false, total: 20, masked: 0,
            });
            expect(answer.etag).toMatch(/^[0-9a-f]{16}$/);
            expect(answer).not.toHaveProperty('base');
        });

        it('pages by byte offset and the etag stays the same across pages', async () => {
            write(REPO, 'big.txt', 'plain words here\n'.repeat(Math.ceil((DIFF_PAGE_MAX_BYTES * 2) / 17)));
            remember();
            const first = opened(await askBlob({ path: 'big.txt', offset: 0 }));
            expect(first.hasMore).toBe(true);
            expect(first.length).toBeLessThanOrEqual(DIFF_PAGE_MAX_BYTES);
            const second = opened(await askBlob({ path: 'big.txt', offset: first.length }));
            expect(second.offset).toBe(first.length);
            expect(second.etag).toBe(first.etag);
            expect(first.total).toBeGreaterThan(DIFF_PAGE_MAX_BYTES);
        });

        it('shows a symlink as its target string and never follows it', async () => {
            const { symlinkSync } = await import('fs');
            symlinkSync('/etc/passwd', join(REPO, 'link'));
            git(REPO, 'add', 'link');
            remember();
            expect(opened(await askBlob({ path: 'link' }))).toMatchObject({ kind: 'blob.result', body: 'symlink', target: '/etc/passwd' });
        });

        it('seals no more than the wire lists: no ok flag from the reader', async () => {
            remember();
            const answer = opened(await askBlob({ path: 'src/index.ts' }));
            expect(Object.keys(answer).sort()).toEqual(
                ['body', 'chunk', 'etag', 'hasMore', 'kind', 'length', 'masked', 'offset', 'path', 'requestId', 'total', 'v'],
            );
        });

        it('pages text whose escaped form outgrows a frame, losing nothing', async () => {
            // A control character is one byte in the file and six in JSON.
            const text = '\u0001 \u0002 ok\n'.repeat(4_000) + 'tail\n';
            write(REPO, 'ctl.txt', text);
            remember();
            let seen = '';
            for (let page = 0, offset = 0; page < 20; page++) {
                const reply = await askBlob({ path: 'ctl.txt', offset });
                expect(reply.error).toBeUndefined();
                const answer = opened(reply);
                expect(JSON.stringify(answer).length).toBeLessThanOrEqual(24 * 1024);
                seen += answer.chunk;
                offset += answer.length;
                if (!answer.hasMore) break;
            }
            expect(seen).toBe(text);
        });

        it('masks a secret in the text and says how many, before it is paged', async () => {
            write(REPO, 'config.txt', 'gh = ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
            remember();
            const answer = opened(await askBlob({ path: 'config.txt' }));
            expect(answer.chunk).toBe('gh = ***\n');
            expect(answer.masked).toBe(1);
        });

        it('answers what a file is instead of its text: binary, filtered, submodule', async () => {
            write(REPO, 'bin.dat', 'a\0b');
            write(REPO, '.env', 'TOKEN=hunter2\n');
            write(REPO, 'nested/inner.txt', 'x');
            git(join(REPO, 'nested'), 'init', '-q');
            git(REPO, 'add', '-f', '.env');
            remember();
            expect(opened(await askBlob({ path: 'bin.dat' }))).toMatchObject({ kind: 'blob.result', body: 'binary', size: 3 });
            const filtered = opened(await askBlob({ path: '.env' }));
            expect(filtered).toMatchObject({ kind: 'blob.result', body: 'filtered' });
            expect(JSON.stringify(filtered)).not.toContain('hunter2');
            expect(opened(await askBlob({ path: 'nested' }))).toMatchObject({ kind: 'blob.result', body: 'submodule' });
        });

        it('answers a path outside the visible set as absent, whatever the reason', async () => {
            remember();
            for (const path of ['ignored.txt', 'no/such/file.ts']) {
                const reply = await askBlob({ path });
                expect(reply.error).toBeUndefined();
                expect(opened(reply)).toMatchObject({ kind: 'blob.result', path, body: 'absent' });
            }
        });

        it('refuses a path that breaks the string rules with bad_path, in the clear and without a path in it', async () => {
            remember();
            for (const path of ['../x', '/etc/passwd', 'a/.GIT/b', 'a//b']) {
                const reply = await askBlob({ path });
                expect(reply.error).toBe('bad_path');
                expect(reply.encrypted).toBeUndefined();
                expect(JSON.stringify(reply)).not.toContain('passwd');
            }
            expect((await askTree({ path: '../x' })).error).toBe('bad_path');
            expect((await askBlob({ path: '' })).error).toBe('bad_path');
            expect((await askBlob({ path: 7 })).error).toBe('bad_path');
        });

        it('refuses an offset that is not a page offset with bad_range', async () => {
            remember();
            for (const offset of [-1, 1.5, 'x']) expect((await askBlob({ offset })).error).toBe('bad_range');
            expect((await askBlob({ offset: 999_999 })).error).toBe('bad_range');
        });
    });

    it('refuses a cursor that is not a string', async () => {
        remember();
        gitRuns = 0;
        for (const cursor of [7, null, ['a']]) expect((await askTree({ cursor })).error).toBe('bad_request');
        expect(gitRuns).toBe(0);
    });

    describe('kinds do not cross (one label serves diff and files)', () => {
        const wrong = async (handler: Handler, request: Wire): Promise<void> => {
            const reply = await ask(handler, request);
            expect(reply.error).toBe('bad_request');
            expect(reply.encrypted).toBeUndefined();
        };

        it('refuses a tree.request sealed into a file.request frame, and a file.request into a blob.request frame', async () => {
            remember();
            gitRuns = 0;
            const treeSealed = { v: 1, kind: 'tree.request', requestId: 'r1', path: '' };
            await wrong(handleDiffFileRequest as Handler, { ...frame('tree', {}, {}, treeSealed), subtype: 'agent.diff.file.request' });
            const fileSealed = { v: 1, kind: 'file.request', requestId: 'r1', base: 'head', path: 'src/index.ts' };
            await wrong(handleFileBlobRequest, frame('blob', {}, {}, fileSealed));
            expect(gitRuns).toBe(0);
        });

        it('refuses a tree or blob request that carries a base', async () => {
            remember();
            gitRuns = 0;
            await wrong(handleFileTreeRequest, frame('tree', { base: 'head' }));
            await wrong(handleFileBlobRequest, frame('blob', { base: 'head' }));
            expect(gitRuns).toBe(0);
        });

        it('refuses a diff request sealed as a blob.request, and a request whose sealed id is another', async () => {
            remember();
            gitRuns = 0;
            await wrong(handleFileTreeRequest, frame('tree', {}, {}, { v: 1, kind: 'blob.request', requestId: 'r1', path: '', offset: 0 }));
            await wrong(handleFileTreeRequest, frame('tree', { requestId: 'other' }));
            await wrong(handleFileTreeRequest, frame('tree', { v: 2 }));
            expect(gitRuns).toBe(0);
        });
    });

    describe('what crosses the relay', () => {
        it('puts nothing but routing fields in the clear, for a listing and for a file', async () => {
            remember();
            const replies = [await askTree({ path: 'src' }), await askBlob({ path: 'src/index.ts' })];
            for (const reply of replies) {
                expect(Object.keys(reply).every((k) => ALLOWED_FRAME_KEYS.has(k))).toBe(true);
                expect(reply.targetDeviceId).toBe('dev_phone');
                const wire = JSON.stringify(reply);
                for (const secret of ['src', 'index.ts', 'new.ts', 'export const', 'entries', 'chunk']) expect(wire).not.toContain(secret);
            }
        });
    });

    describe('before git', () => {
        it('refuses a session it has no record of and a request without a key, with no git run', async () => {
            remember();
            gitRuns = 0;
            expect((await askTree({}, { sessionName: 'hwip-elsewhere' })).error).toBe('unknown_session');
            const stripped = await askTree({}, { subscriberPublicKey: undefined });
            expect(stripped.error).toBe('e2ee_required');
            expect(stripped.encrypted).toBeUndefined();
            expect(gitRuns).toBe(0);
        });

        it('says so when the session directory is not a repository', async () => {
            const plain = join(TMP, 'plain-dir');
            mkdirSync(plain, { recursive: true });
            remember(plain);
            expect((await askBlob()).error).toBe('not_a_repo');
        });
    });

    describe('the switch (V13)', () => {
        /** The directory the switch is kept under: what git calls the repository's top, not the path the test built. */
        const project = () => repoRootOf(REPO) as string;
        const refused = async (): Promise<void> => {
            for (const reply of [await askTree({ path: 'src' }), await askBlob({ path: 'src/index.ts' })]) {
                expect(reply.error).toBe('file_view_off');
                expect(reply.encrypted).toBeUndefined();
            }
        };

        it('refuses a project turned off, asks git for nothing past the repository root, and answers again when turned on', async () => {
            remember();
            setFileView(project(), false, 'project');
            gitRuns = 0;
            await refused();
            // One `rev-parse --show-toplevel` per request: the switch is read by the repository it names.
            expect(gitRuns).toBe(2);
            setFileView(project(), true, 'project');
            expect((await askTree({ path: 'src' })).error).toBeUndefined();
        });

        it('does not turn off the diff view beside it', async () => {
            remember();
            setFileView(project(), false, 'project');
            const reply = await ask(handleDiffFilesRequest, {
                subtype: 'agent.diff.files.request', targetDeviceId: device, sessionName: SESSION, requestId: 'r1', deviceId: 'dev_phone',
                subscriberPublicKey: phone.publicKey,
                encrypted: phone.seal('session.diff', JSON.stringify({ v: 1, kind: 'files.request', requestId: 'r1', base: 'head' }), listenerKey, SESSION),
            });
            expect(reply.error).toBeUndefined();
            expect(reply.encrypted).toBeDefined();
        });

        it('is turned off for every project by the global switch', async () => {
            remember();
            setFileView(project(), false, 'global');
            await refused();
        });

        it('is turned off for one run by HWIP_FILE_VIEW=0 in the listener environment', async () => {
            remember();
            process.env.HWIP_FILE_VIEW = '0';
            try {
                await refused();
            } finally {
                delete process.env.HWIP_FILE_VIEW;
            }
        });
    });

    describe('the byte budget (D6)', () => {
        afterEach(() => {
            // Close the window the test opened: an instant past its end drops it.
            fileViewBytes.charge(SESSION, 0, Date.now() + FILE_VIEW_WINDOW_MS);
        });

        it('turns a blob away once a session has read its 32 MiB, and still lists directories', async () => {
            remember();
            fileViewBytes.charge(SESSION, FILE_VIEW_WINDOW_BYTES);
            gitRuns = 0;
            const refusedBlob = await askBlob({ path: 'src/index.ts' });
            expect(refusedBlob.error).toBe('rate_limited');
            expect(refusedBlob.encrypted).toBeUndefined();
            // Only the repository root was asked for; no file was read.
            expect(gitRuns).toBe(1);
            expect(opened(await askTree({ path: 'src' })).entries).toHaveLength(2);
        });

        it('counts the text a page carried and nothing else', async () => {
            remember();
            await askTree({ path: 'src' });
            await askBlob({ path: 'ignored.txt' });
            // A listing and a "nothing there" counted for nothing: one byte short of the share is still not spent.
            fileViewBytes.charge(SESSION, FILE_VIEW_WINDOW_BYTES - 1);
            expect(fileViewBytes.spent(SESSION)).toBe(false);
            fileViewBytes.charge(SESSION, 0, Date.now() + FILE_VIEW_WINDOW_MS);
            fileViewBytes.charge(SESSION, FILE_VIEW_WINDOW_BYTES - 20);
            expect(fileViewBytes.spent(SESSION)).toBe(false);
            // src/index.ts is 20 bytes: that page takes the session to its share.
            expect(opened(await askBlob({ path: 'src/index.ts' })).length).toBe(20);
            expect(fileViewBytes.spent(SESSION)).toBe(true);
        });
    });

    describe('the log (V12)', () => {
        beforeEach(() => { vi.mocked(console.log).mockClear(); });

        const lines = (): string[] =>
            vi.mocked(console.log).mock.calls.map((c) => String(c[0])).filter((line) => line.includes('file-view:'));

        it('writes one line per request: who, what, how much, how it ended — and never the content', async () => {
            write(REPO, 'config.txt', 'gh = ghp_abcdefghijklmnopqrstuvwxyz0123456789\nplain words\n');
            remember();
            await askTree({ path: 'src' });
            await askBlob({ path: 'config.txt' });
            await askBlob({ path: 'ignored.txt' });
            await askBlob({ path: '../escape' });
            const written = lines();
            expect(written).toHaveLength(4);
            expect(written[0]).toMatch(/file-view: at=\d{4}-\d\d-\d\dT[\d:.]+Z device="dev_phone" session="hwip-api" op=tree path="src" bytes=0 masked=0 result=ok$/);
            expect(written[1]).toMatch(/op=blob path="config.txt" bytes=\d+ masked=1 result=ok$/);
            expect(written[2]).toMatch(/op=blob path="ignored.txt" bytes=0 masked=0 result=absent$/);
            expect(written[3]).toMatch(/op=blob path="..\/escape" bytes=0 masked=0 result=bad_path$/);
            for (const line of written) {
                for (const content of ['plain words', 'ghp_', 'export const', 'nobody reads']) expect(line).not.toContain(content);
            }
        });

        it('keeps a hostile name on its one line, cut to a length a person can read', async () => {
            remember();
            await askBlob({ path: `a\nb\u001b[31m\u009b\u202e\u2028${'x'.repeat(500)}` });
            await askTree({ path: 'src' }, { sessionName: SESSION, deviceId: 'dev\nfake: forged line' });
            const written = lines();
            expect(written).toHaveLength(2);
            for (const line of written) expect(line).not.toMatch(/[\n\u001b\u009b\u2028\u202e]/);
            expect(written[0]).toContain('path="a\\nb\\u001b[31m\\u009b\\u202e\\u2028');
            expect(written[0].length).toBeLessThan(500);
            expect(written[1]).toContain('device="dev\\nfake: forged line"');
        });

        it('does not write a request that never opened: no key, a stranger\'s key, or one sealed for another session', async () => {
            remember();
            await askTree({}, { subscriberPublicKey: undefined });
            await askTree({}, { subscriberPublicKey: stranger.publicKey });
            // The seal is for this session; the frame names another, so it does not open there.
            const forged = frame('tree');
            await ask(handleFileTreeRequest, { ...forged, sessionName: 'hwip-elsewhere' });
            expect(lines()).toEqual([]);
        });

        it('writes a refused request too, with the code that refused it, but not one the rate limit turned away', async () => {
            remember();
            setFileView(repoRootOf(REPO) as string, false, 'project');
            await askBlob({ path: 'src/index.ts' });
            setFileView(repoRootOf(REPO) as string, true, 'project');
            expect(lines()).toHaveLength(1);
            expect(lines()[0]).toMatch(/path="src\/index.ts" bytes=0 masked=0 result=file_view_off$/);
        });
    });
});
