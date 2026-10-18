/**
 * Reading a session's changes from the phone, end to end against a real git.
 *
 * The wire carries routing fields in the clear and nothing else: which base,
 * which file and which page are inside a sealed request, and the answer comes
 * back sealed and bound to that request. The phone here is `v2Party`, an
 * independent implementation of the envelope, so "it opens" is a statement
 * about the wire format.
 *
 * What the request may make git do is fixed (see session-diff.ts): a session
 * name selects a directory, the base is one of two enumerated choices, and a
 * path is resolved inside the repository. These tests check that a request
 * which fails any earlier step never reaches git at all.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

let failSeal = false;
vi.mock('./crypto.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto.js')>();
    return {
        ...actual,
        sealV2: ((...args: Parameters<typeof actual.sealV2>) =>
            failSeal ? Promise.reject(new Error('seal exploded')) : actual.sealV2(...args)) as typeof actual.sealV2,
    };
});

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const TMP = mkdtempSync(join(tmpdir(), 'hwip-diff-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleDiffFilesRequest, handleDiffFileRequest, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
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
const OUTSIDE = join(TMP, 'secrets');
const phone = v2Party();
const stranger = v2Party();
let listenerKey: string;

type Wire = Record<string, unknown>;
const ALLOWED_FRAME_KEYS = new Set(['subtype', 'requestId', 'sessionName', 'targetDeviceId', 'at', 'encrypted', 'error']);

beforeAll(async () => {
    await initDeviceCrypto();
    listenerKey = getDevicePublicKey() as string;
    setSubscriberTrust(trustEveryKey);
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(join(OUTSIDE, 'keys.txt'), 'super secret\n');
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("agent.diff — what changed in a session's repo", () => {
    const device = computeListenerDeviceId();
    let sent: Wire[];
    const send = (data: Wire) => { sent.push(data); };

    /** The frame the phone would send: routing in the clear, the question sealed. */
    const frame = (kind: 'files' | 'file', ask: Record<string, unknown> = {}, over: Wire = {}): Wire => {
        const requestId = (over.requestId as string | undefined) ?? 'r1';
        const sessionName = (over.sessionName as string | undefined) ?? SESSION;
        const inner = { v: 1, kind: `${kind}.request`, requestId, base: 'head', ...(kind === 'file' ? { path: 'src/index.ts' } : {}), ...ask };
        return {
            subtype: `agent.diff.${kind}.request`,
            targetDeviceId: device,
            sessionName,
            requestId,
            deviceId: 'dev_phone',
            subscriberPublicKey: phone.publicKey,
            encrypted: phone.seal('session.diff', JSON.stringify(inner), listenerKey, sessionName),
            ...over,
        };
    };

    /** Send a request and wait for the one reply it gets. */
    const ask = async (handler: typeof handleDiffFilesRequest, request: Wire): Promise<Wire> => {
        const before = sent.length;
        handler(request, send);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1];
    };
    const askFiles = (ask_: Record<string, unknown> = {}, over: Wire = {}) => ask(handleDiffFilesRequest, frame('files', ask_, over));
    const askFile = (ask_: Record<string, unknown> = {}, over: Wire = {}) => ask(handleDiffFileRequest, frame('file', ask_, over));

    /** What the phone reads from a sealed answer. */
    const opened = (reply: Wire): Record<string, any> =>
        JSON.parse(phone.open('session.diff', reply.encrypted as Parameters<typeof phone.open>[1], SESSION)) as Record<string, any>;

    const remember = (cwd = REPO) => rememberSessions([{ name: SESSION, cwd, agentKind: 'claude' }]);

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        sent = [];
        gitRuns = 0;
        failSeal = false;
        setSubscriberTrust(trustEveryKey);
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(REPO, { recursive: true, force: true });
        mkdirSync(REPO, { recursive: true });
        git(REPO, 'init', '-q', '-b', 'main');
        write(REPO, 'src/index.ts', 'export const a = 1;\n');
        write(REPO, 'README.md', 'hello\n');
        git(REPO, 'add', '-A');
        git(REPO, 'commit', '-q', '-m', 'chore: seed');
        write(REPO, 'src/index.ts', 'export const a = 1;\nexport const b = 2;\n');
        write(REPO, 'src/new.ts', 'one\ntwo\n');
    });

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleDiffFilesRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleDiffFileRequest({ subtype: 'agent.diff.files.request' }, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine, or without an id or session', () => {
            remember();
            expect(handleDiffFilesRequest(frame('files', {}, { targetDeviceId: 'dev_other' }), send)).toBe(false);
            expect(handleDiffFilesRequest(frame('files', {}, { requestId: '' }), send)).toBe(false);
            expect(handleDiffFilesRequest(frame('files', {}, { sessionName: '' }), send)).toBe(false);
            expect(sent).toEqual([]);
            expect(gitRuns).toBe(0);
        });

        // The registry is the only source of a repository path.
        it('refuses a session it has no record of', async () => {
            remember();
            const reply = await askFiles({}, { sessionName: 'hwip-elsewhere' });
            // The seal is bound to the session name the frame names; the registry has no such session.
            expect(reply.error).toBe('unknown_session');
        });

        it('says so when the session directory is not a repository', async () => {
            const plain = join(TMP, 'plain-dir');
            mkdirSync(plain, { recursive: true });
            remember(plain);
            expect((await askFiles()).error).toBe('not_a_repo');
        });

        it('says so when the session directory is gone', async () => {
            remember(join(TMP, 'no-such-dir'));
            expect((await askFiles()).error).toBe('missing_directory');
        });
    });

    describe('what crosses the relay', () => {
        it('puts nothing but routing fields in the clear, for a list and for a file', async () => {
            remember();
            const replies = [await askFiles(), await askFile()];
            for (const reply of replies) {
                expect(Object.keys(reply).every((k) => ALLOWED_FRAME_KEYS.has(k))).toBe(true);
                expect(reply.targetDeviceId).toBe('dev_phone');
                const wire = JSON.stringify(reply);
                for (const secret of ['src/index.ts', 'src/new.ts', 'export const', 'diff --git', 'head']) {
                    expect(wire).not.toContain(secret);
                }
            }
        });
    });

    describe('a request without a key, from a listener that has never sealed', () => {
        it('is refused as e2ee_required and runs no git', async () => {
            remember();
            for (const stripped of [{ subscriberPublicKey: undefined }, { subscriberPublicKey: '' }]) {
                const files = await askFiles({}, stripped);
                const file = await askFile({}, stripped);
                expect([files.error, file.error]).toEqual(['e2ee_required', 'e2ee_required']);
                for (const reply of [files, file]) {
                    expect(reply.encrypted).toBeUndefined();
                    expect(reply).not.toHaveProperty('files');
                    expect(reply).not.toHaveProperty('chunk');
                }
            }
            expect(gitRuns).toBe(0);
        });
    });

    describe('a request that asks for a seal but cannot be opened', () => {
        it('is bad_request when the sealed question is missing or is not an envelope', async () => {
            remember();
            for (const encrypted of [undefined, null, 'text', { v: 1 }, { v: 2, salt: 'x' }]) {
                expect((await askFiles({}, { encrypted })).error).toBe('bad_request');
            }
            expect(gitRuns).toBe(0);
        });

        it('is bad_request when the question was sealed by a key that is not the phone key', async () => {
            remember();
            const forged = stranger.seal('session.diff', JSON.stringify({ v: 1, kind: 'files.request', requestId: 'r1', base: 'head' }), listenerKey, SESSION);
            expect((await askFiles({}, { encrypted: forged })).error).toBe('bad_request');
            expect(gitRuns).toBe(0);
        });

        it('is bad_request when the question was sealed for another session, or for another purpose', async () => {
            remember();
            const body = JSON.stringify({ v: 1, kind: 'files.request', requestId: 'r1', base: 'head' });
            const otherSession = phone.seal('session.diff', body, listenerKey, 'hwip-other');
            const otherPurpose = phone.seal('stream.input', body, listenerKey, SESSION);
            expect((await askFiles({}, { encrypted: otherSession })).error).toBe('bad_request');
            expect((await askFiles({}, { encrypted: otherPurpose })).error).toBe('bad_request');
            expect(gitRuns).toBe(0);
        });

        // The seal binds the session, not the request: a relay can hand a listener
        // an old sealed question under a new frame, or a list question under a file frame.
        it('is bad_request when the question inside is not the one the frame names', async () => {
            remember();
            const old = frame('files', {}, { requestId: 'old' }).encrypted;
            expect((await askFiles({}, { encrypted: old })).error).toBe('bad_request');
            const listQuestion = frame('files').encrypted;
            expect((await ask(handleDiffFileRequest, { ...frame('file'), encrypted: listQuestion })).error).toBe('bad_request');
            expect((await askFiles({ kind: 'file.request' })).error).toBe('bad_request');
            expect((await askFiles({ v: 2 })).error).toBe('bad_request');
            expect(gitRuns).toBe(0);
        });

        it('answers a key that does not check out with the reason, and runs no git', async () => {
            remember();
            setSubscriberTrust({
                admit: async () => ({ kind: 'refuse', reason: 'subscriber_unverified' }),
                sealedOnly: () => true,
                acceptCommand: () => true,
            });
            const replies = [await askFiles(), await askFile()];
            expect(replies.map((r) => r.error)).toEqual(['subscriber_unverified', 'subscriber_unverified']);
            for (const reply of replies) expect(reply.encrypted).toBeUndefined();
            expect(gitRuns).toBe(0);
        });

        it('answers a key that is not a string the same way', async () => {
            remember();
            const reply = await askFiles({}, { subscriberPublicKey: [phone.publicKey] });
            expect(reply.error).toBe('subscriber_unverified');
            expect(gitRuns).toBe(0);
        });
    });

    describe('the file list', () => {
        it('answers sealed, with the changed files, line counts and the base', async () => {
            remember();

            const reply = await askFiles();

            expect(reply).toMatchObject({ subtype: 'agent.diff.files.result', requestId: 'r1', sessionName: SESSION });
            expect(opened(reply)).toEqual({
                v: 1,
                kind: 'files.result',
                requestId: 'r1',
                base: 'head',
                branch: { head: 'main' },
                files: [
                    { path: 'src/index.ts', status: 'M', added: 1, removed: 0 },
                    { path: 'src/new.ts', status: '?', added: 2, removed: 0 },
                ],
                truncated: false,
            });
        });

        it('seals the branch, its upstream and how far apart they are', async () => {
            remember();
            const remote = join(TMP, 'remote.git');
            rmSync(remote, { recursive: true, force: true });
            git(TMP, 'init', '-q', '--bare', '-b', 'main', remote);
            git(REPO, 'remote', 'add', 'origin', remote);
            git(REPO, 'push', '-q', '-u', 'origin', 'main');
            git(REPO, 'commit', '-q', '--allow-empty', '-m', 'chore: local one');
            git(REPO, 'commit', '-q', '--allow-empty', '-m', 'chore: local two');

            const answer = opened(await askFiles());

            expect(answer.branch).toEqual({ head: 'main', upstream: 'origin/main', ahead: 2, behind: 0 });
            expect(JSON.stringify(answer)).not.toContain(remote);
        });

        it('compares against the default branch when asked, and names it', async () => {
            remember();
            git(REPO, 'checkout', '-q', '-b', 'feature');
            git(REPO, 'commit', '-q', '-am', 'feat: b');

            const reply = await askFiles({ base: 'default' });

            expect(opened(reply)).toMatchObject({ base: 'default', baseName: 'main' });
            expect(opened(reply).files.map((f: { path: string }) => f.path)).toEqual(['src/index.ts', 'src/new.ts']);
        });

        it('says no_default_branch rather than guessing', async () => {
            remember();
            git(REPO, 'branch', '-m', 'develop');
            expect((await askFiles({ base: 'default' })).error).toBe('no_default_branch');
        });

        // A revision from the wire would land in a git argument position.
        it('refuses anything but the two choices, and runs no git', async () => {
            remember();
            for (const base of ['--output=/tmp/x', 'HEAD~1', 'main', 7, {}, null, undefined]) {
                expect((await askFiles({ base })).error).toBe('bad_request');
                expect((await askFile({ base })).error).toBe('bad_request');
            }
            expect(gitRuns).toBe(0);
        });

        it('lists Korean paths as they are written', async () => {
            remember();
            write(REPO, '한글 파일.txt', 'x\n');
            expect(opened(await askFiles()).files.map((f: { path: string }) => f.path)).toContain('한글 파일.txt');
        });

        it('does not list an ignored file', async () => {
            remember();
            write(REPO, '.gitignore', '.env\n');
            write(REPO, '.env', 'SECRET=1\n');
            expect(opened(await askFiles()).files.map((f: { path: string }) => f.path)).not.toContain('.env');
        });

        it('cuts a list that would not fit one sealed frame, and says it was cut', async () => {
            remember();
            for (let i = 0; i < 150; i++) write(REPO, `generated/${'d'.repeat(120)}/${String(i).padStart(4, '0')}.txt`, 'x\n');

            const answer = opened(await askFiles());

            expect(answer.truncated).toBe(true);
            expect(answer.files.length).toBeGreaterThan(0);
            expect(answer.files.length).toBeLessThan(150);
            expect(JSON.stringify(answer).length).toBeLessThanOrEqual(24 * 1024);
            expect(answer.branch).toEqual({ head: 'main' });
        });
    });

    describe('one file', () => {
        it("answers sealed, bound to the request, with that file's patch", async () => {
            remember();

            const reply = await askFile();
            const answer = opened(reply);

            expect(reply).toMatchObject({ subtype: 'agent.diff.file.result', requestId: 'r1' });
            expect(answer).toMatchObject({
                v: 1, kind: 'file.result', requestId: 'r1', base: 'head', path: 'src/index.ts', offset: 0, hasMore: false, masked: 0,
            });
            expect(answer.chunk).toContain('+export const b = 2;');
            expect(answer.etag).toMatch(/^[0-9a-f]{16}$/);
        });

        it('shows a new file as an addition', async () => {
            remember();
            expect(opened(await askFile({ path: 'src/new.ts' })).chunk).toContain('+one');
        });

        it('masks what looks like a secret and says how many', async () => {
            remember();
            write(REPO, 'src/config.ts', 'export const password = "correct-horse-battery";\n');

            const answer = opened(await askFile({ path: 'src/config.ts' }));

            expect(answer.masked).toBe(1);
            expect(answer.chunk).not.toContain('correct-horse');
        });

        it('has nothing to show for an ignored file asked for by name', async () => {
            remember();
            write(REPO, '.gitignore', '.env\n');
            write(REPO, '.env', 'SECRET=hunter2hunter2\n');
            const answer = opened(await askFile({ path: '.env' }));
            expect(answer.chunk).toBe('');
            expect(JSON.stringify(answer)).not.toContain('hunter2');
        });

        it('refuses a path that climbs out of the repository', async () => {
            remember();
            expect((await askFile({ path: '../../secrets/keys.txt' })).error).toBe('path_outside_repo');
            expect((await askFile({ path: join(OUTSIDE, 'keys.txt') })).error).toBe('path_outside_repo');
        });

        // resolve() alone would accept this: the string stays inside the repo and only the filesystem knows it leaves.
        it('refuses a symlink that points outside the repository', async () => {
            remember();
            symlinkSync(join(OUTSIDE, 'keys.txt'), join(REPO, 'escape.txt'));
            expect((await askFile({ path: 'escape.txt' })).error).toBe('path_outside_repo');
        });

        // After `--` git reads any name as a path, so a name shaped like an option is just a file.
        it('treats a path shaped like a git option as a path, and changes nothing in the repository', async () => {
            remember();
            write(REPO, '-n.txt', 'dash\n');
            const before = git(REPO, 'status', '--porcelain=v1', '-z') + git(REPO, 'rev-parse', 'HEAD');

            const asked = [await askFile({ path: '-n.txt' }), await askFile({ path: '--output=leaked.txt' }), await askFile({ path: '--stat' })];

            expect(opened(asked[0]).chunk).toContain('+dash');
            expect(opened(asked[1]).chunk).toBe('');
            expect(opened(asked[2]).chunk).toBe('');
            expect(existsSync(join(REPO, 'leaked.txt'))).toBe(false);
            expect(existsSync(join(process.cwd(), 'leaked.txt'))).toBe(false);
            expect(git(REPO, 'status', '--porcelain=v1', '-z') + git(REPO, 'rev-parse', 'HEAD')).toBe(before);
        });

        it('leaves the index and working tree as they were after every kind of request', async () => {
            remember();
            const before = git(REPO, 'status', '--porcelain=v1', '-z') + git(REPO, 'ls-files', '-s');

            await askFiles();
            await askFiles({ base: 'default' });
            await askFile();
            await askFile({ path: 'src/new.ts' });

            expect(git(REPO, 'status', '--porcelain=v1', '-z') + git(REPO, 'ls-files', '-s')).toBe(before);
        });

        it('ignores a request id too long to echo', () => {
            remember();
            expect(handleDiffFilesRequest(frame('files', {}, { requestId: 'r'.repeat(129) }), send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('refuses a path that is not a string', async () => {
            remember();
            expect((await askFile({ path: 42 })).error).toBe('bad_path');
            expect((await askFile({ path: '' })).error).toBe('bad_path');
            expect((await askFile({ path: undefined })).error).toBe('bad_path');
        });

        it('refuses an offset that is not a whole non-negative number', async () => {
            remember();
            for (const offset of [-1, 1.5, '10', null]) {
                expect((await askFile({ offset })).error).toBe('bad_range');
            }
        });
    });

    describe('paging a large patch', () => {
        const manyLines = (n: number, text: (i: number) => string): string => Array.from({ length: n }, (_, i) => text(i)).join('\n') + '\n';

        const readAll = async (path: string): Promise<{ text: string; pages: number; etags: Set<string> }> => {
            let offset = 0;
            let text = '';
            let pages = 0;
            const etags = new Set<string>();
            for (;;) {
                const answer = opened(await askFile({ path, offset }));
                if (answer.chunk === undefined) throw new Error(JSON.stringify(answer));
                expect(Buffer.byteLength(JSON.stringify(answer), 'utf-8')).toBeLessThanOrEqual(24 * 1024);
                text += answer.chunk as string;
                etags.add(answer.etag as string);
                pages++;
                offset += answer.length as number;
                if (!answer.hasMore) return { text, pages, etags };
            }
        };

        it('cuts pages at the transport limit and reassembles the patch exactly', async () => {
            remember();
            write(REPO, 'big.txt', manyLines(1500, (i) => `line ${i} ${'x'.repeat(40)}`));

            const { text, pages, etags } = await readAll('big.txt');

            expect(pages).toBeGreaterThan(2);
            expect(etags.size).toBe(1);
            expect(text).toContain('+line 1499');
            expect(text.split('\n').filter((l) => l.startsWith('+line')).length).toBe(1500);
            expect(text).not.toContain('�');
        });

        it('never splits a Korean character across pages', async () => {
            remember();
            write(REPO, 'ko.txt', manyLines(1200, (i) => `줄 ${i} 가나다라마바사아자차카타파하`));

            const { text } = await readAll('ko.txt');

            expect(text).not.toContain('�');
            expect(text.split('\n').filter((l) => l.startsWith('+줄')).length).toBe(1200);
        });

        it('halves a page whose JSON escapes would overflow the sealed frame', async () => {
            remember();
            // Each quote doubles in JSON: a 16 KiB page of them is ~32 KiB sealed.
            write(REPO, 'quotes.txt', manyLines(400, () => '"'.repeat(60)));

            const { text, pages } = await readAll('quotes.txt');

            expect(pages).toBeGreaterThan(2);
            expect(text.split('\n').filter((l) => l.startsWith('+"')).length).toBe(400);
            expect(DIFF_PAGE_MAX_BYTES).toBe(16 * 1024);
        });

        it('says too_large when the patch is past what a request may read', async () => {
            remember();
            write(REPO, 'huge.txt', manyLines(100_000, () => 'y'.repeat(99)));
            expect((await askFile({ path: 'huge.txt' })).error).toBe('too_large');
        });

        it('refuses an offset past the end, or inside a character', async () => {
            remember();
            expect((await askFile({ offset: 10_000_000 })).error).toBe('bad_range');
            write(REPO, 'ko.txt', '가나다\n');
            // The patch text starts with ASCII headers, so find a mid-character offset from the full text.
            const full = opened(await askFile({ path: 'ko.txt' })).chunk as string;
            const inside = Buffer.from(full, 'utf-8').indexOf(Buffer.from('가', 'utf-8')) + 1;
            expect((await askFile({ path: 'ko.txt', offset: inside })).error).toBe('bad_range');
        });
    });

    describe('failures stay failures', () => {
        it('reports a failed seal rather than answering in the clear', async () => {
            remember();
            failSeal = true;

            const reply = await askFiles();

            expect(reply.error).toBe('encrypt_failed');
            expect(reply.encrypted).toBeUndefined();
            expect(reply).not.toHaveProperty('files');
        });

        it('rate-limits a session that asks too fast', async () => {
            remember();
            const errors: unknown[] = [];
            for (let i = 0; i < 130; i++) {
                handleDiffFilesRequest(frame('files', {}, { subscriberPublicKey: undefined }), send);
            }
            for (const reply of sent) errors.push(reply.error);
            expect(errors.filter((e) => e === 'rate_limited').length).toBeGreaterThan(0);
            expect(errors.filter((e) => e === 'e2ee_required').length).toBeGreaterThan(0);
            expect(gitRuns).toBe(0);
        });
    });
});
