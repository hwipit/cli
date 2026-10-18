/**
 * The context a sealed question could carry: what the session changed (git diff) and what its terminal shows,
 * masked and held to one size. Nothing here sends anything. The git half runs against a real git, like
 * session-diff.test.ts; the compose half is pure and gets its inputs by hand.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    ASK_CONTEXT_MAX_BYTES,
    ASK_CONTEXT_SCREEN_LINES,
    ASK_CONTEXT_SCREEN_MAX_BYTES,
    ASK_CONTEXT_SUMMARY_FILES,
    askContextBytes,
    composeAskContext,
    gatherAskContext,
    type AskContextInput,
    ASK_CONTEXT_SUMMARY_MAX_BYTES,
} from './ask-context.js';
import type { DiffFileEntry } from './session-diff.js';

// A repo's own config and the user's global one must not change what these see.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SK = `sk-${'abcDEF123456'.repeat(3)}`;

const file = (path: string, extra: Partial<DiffFileEntry> = {}): DiffFileEntry => ({ path, status: 'M', added: 1, removed: 0, ...extra });
const patch = (path: string, body = '+added line'): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n context\n${body}\n`;

const compose = (over: Partial<AskContextInput> = {}) =>
    composeAskContext({ files: [], patchOf: () => null, screen: null, ...over });

describe('composeAskContext: the summary', () => {
    it('counts files and lines, and lists each changed file', () => {
        const ctx = compose({
            files: [file('a.ts', { added: 3, removed: 1 }), file('b.ts', { status: 'A', added: 5 }), file('c.png', { binary: true, added: 0 })],
        });

        expect(ctx.summary).toMatchObject({ files: 3, added: 8, removed: 1, moreFiles: 0 });
        expect(ctx.summary.listed).toEqual([
            { path: 'a.ts', status: 'M', added: 3, removed: 1 },
            { path: 'b.ts', status: 'A', added: 5, removed: 0 },
            { path: 'c.png', status: 'M', added: 0, removed: 0, binary: true },
        ]);
    });

    it('lists at most ASK_CONTEXT_SUMMARY_FILES files and says how many more there are', () => {
        const files = Array.from({ length: ASK_CONTEXT_SUMMARY_FILES + 7 }, (_, i) => file(`f${String(i).padStart(3, '0')}.ts`));

        const ctx = compose({ files });

        expect(ctx.summary.files).toBe(files.length);
        expect(ctx.summary.listed).toHaveLength(ASK_CONTEXT_SUMMARY_FILES);
        expect(ctx.summary.moreFiles).toBe(7);
    });

    it('is empty and says so for no files and no screen', () => {
        const ctx = compose();

        expect(ctx.summary).toMatchObject({ files: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } });
        expect(ctx.original).toEqual({ diff: '', screen: '' });
    });

    it('cuts a very long path in the list, by bytes, and stays small for the longest paths allowed', () => {
        const ctx = compose({ files: Array.from({ length: 30 }, (_, i) => file(`${'文'.repeat(2000)}${i}.ts`, { added: 12345, removed: 6789 })) });

        expect(Buffer.byteLength(ctx.summary.listed[0].path)).toBeLessThan(140);
        expect(Buffer.byteLength(JSON.stringify(ctx.summary))).toBeLessThanOrEqual(4 * 1024);
    });

    it('keeps a path of exactly the limit as it is, and cuts one a byte over', () => {
        const pathsOf = (...paths: string[]) => compose({ files: paths.map((p) => file(p)) }).summary.listed.map((f) => f.path);
        const exact = ['x'.repeat(128), `${'한'.repeat(42)}ab`, '😀'.repeat(32)];
        expect(exact.map((p) => Buffer.byteLength(p))).toEqual([128, 128, 128]);

        expect(pathsOf(...exact)).toEqual(exact);
        for (const over of [pathsOf('x'.repeat(129))[0]!, pathsOf('한'.repeat(43))[0]!]) {
            expect(over.endsWith('…')).toBe(true);
            expect(Buffer.byteLength(over)).toBeLessThanOrEqual(128);
        }
    });

    it('cuts a path between characters: never inside a surrogate pair', () => {
        for (const path of ['😀'.repeat(33), `a${'😀'.repeat(40)}`, `${'x'.repeat(124)}😀😀`]) {
            const [shown] = compose({ files: [file(path)] }).summary.listed.map((f) => f.path);

            expect(Buffer.from(shown!, 'utf8').toString('utf8')).toBe(shown); // a lone surrogate would come back as U+FFFD
            expect(shown!.endsWith('…')).toBe(true);
            expect(Buffer.byteLength(shown!)).toBeLessThanOrEqual(128);
        }
        expect(compose({ files: [file('😀'.repeat(33))] }).summary.listed[0]!.path).toBe(`${'😀'.repeat(31)}…`);
        // ASCII fills the room to the byte: 125 bytes and the 3-byte mark make 128.
        expect(compose({ files: [file('x'.repeat(129))] }).summary.listed[0]!.path).toBe(`${'x'.repeat(125)}…`);
    });

    it('drops listed files from the end, into moreFiles, until the summary is within 4096 bytes', () => {
        // A control character costs six bytes in JSON: twenty such paths are far over the limit on their own.
        const files = Array.from({ length: 25 }, (_, i) => file(`${'\u0001'.repeat(120)}${i}`, { added: 1, removed: 1 }));

        const ctx = compose({ files });

        expect(ASK_CONTEXT_SUMMARY_MAX_BYTES).toBe(4096);
        expect(Buffer.byteLength(JSON.stringify(ctx.summary))).toBeLessThanOrEqual(4096);
        expect(ctx.summary.listed.length).toBeGreaterThan(0);
        expect(ctx.summary.listed.length).toBeLessThan(20);
        expect(ctx.summary.files).toBe(25);
        expect(ctx.summary.listed.length + ctx.summary.moreFiles).toBe(25);
        // One more file would not have fit.
        const next = { ...ctx.summary, listed: [...ctx.summary.listed, ctx.summary.listed[0]!] };
        expect(Buffer.byteLength(JSON.stringify(next))).toBeGreaterThan(4096);
    });

    it('is small enough to ride inside a sealed body', () => {
        const files = Array.from({ length: 500 }, (_, i) => file(`some/deep/dir/${'x'.repeat(60)}${i}.ts`, { added: 12345, removed: 6789 }));

        const ctx = compose({ files });

        expect(Buffer.byteLength(JSON.stringify(ctx.summary))).toBeLessThanOrEqual(4 * 1024);
    });
});

describe('composeAskContext: the diff', () => {
    it('puts the patches of the changed files in order', () => {
        const ctx = compose({
            files: [file('a.ts'), file('b.ts')],
            patchOf: (path) => ({ text: patch(path), masked: 0 }),
        });

        expect(ctx.original.diff).toBe(patch('a.ts') + patch('b.ts'));
        expect(ctx.summary.cut.diff).toBe(false);
    });

    it('keeps a file with no patch (binary, filtered) in the list and out of the diff', () => {
        const ctx = compose({
            files: [file('a.ts'), file('logo.png', { binary: true })],
            patchOf: (path) => (path === 'a.ts' ? { text: patch(path), masked: 0 } : { text: '', masked: 0 }),
        });

        expect(ctx.original.diff).toBe(patch('a.ts'));
        expect(ctx.summary.listed.map((f) => f.path)).toEqual(['a.ts', 'logo.png']);
        expect(ctx.summary.cut.diff).toBe(false);
    });

    it('sums the masked spots of the patches it uses', () => {
        const ctx = compose({
            files: [file('a.ts'), file('b.ts')],
            patchOf: (path) => ({ text: patch(path, '+key = ***'), masked: path === 'a.ts' ? 2 : 1 }),
        });

        expect(ctx.summary.masked).toBe(3);
    });

    it('says the diff was cut when git listed more files than it returns', () => {
        const ctx = compose({ files: [file('a.ts')], truncated: true, patchOf: (path) => ({ text: patch(path), masked: 0 }) });

        expect(ctx.summary.cut.diff).toBe(true);
    });

    it('holds the whole value to ASK_CONTEXT_MAX_BYTES and cuts a patch at a line, naming the cut', () => {
        const long = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n');
        const ctx = compose({
            files: [file('big.ts'), file('after.ts')],
            patchOf: (path) => ({ text: patch(path, long), masked: 0 }),
        });

        expect(askContextBytes(ctx)).toBeLessThanOrEqual(ASK_CONTEXT_MAX_BYTES);
        expect(ctx.summary.cut.diff).toBe(true);
        expect(ctx.original.diff.startsWith('diff --git a/big.ts')).toBe(true);
        expect(ctx.original.diff).not.toContain('after.ts');
        // The cut falls between lines: every line kept is a whole line of the patch (or the marker).
        const kept = ctx.original.diff.split('\n').filter((l) => l.startsWith('+line '));
        expect(kept.every((l) => /^\+line \d+ x{40}$/.test(l))).toBe(true);
        expect(ctx.original.diff.trimEnd().endsWith('[hwip: cut]')).toBe(true);
        // The file that did not fit stays in the summary.
        expect(ctx.summary.listed.map((f) => f.path)).toEqual(['big.ts', 'after.ts']);
    });

    it('stays within the cap when JSON escaping makes the text longer than its bytes', () => {
        // Newlines and quotes cost two bytes each once serialized.
        const noisy = Array.from({ length: 6000 }, () => '+"""""""""""""""""""').join('\n');
        const ctx = compose({ files: [file('q.ts')], patchOf: (path) => ({ text: patch(path, noisy), masked: 0 }) });

        expect(askContextBytes(ctx)).toBeLessThanOrEqual(ASK_CONTEXT_MAX_BYTES);
    });

    it('asks for no more patches once the room is used up', () => {
        const long = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n');
        const asked: string[] = [];
        compose({
            files: Array.from({ length: 150 }, (_, i) => file(`f${i}.ts`)),
            patchOf: (path) => {
                asked.push(path);
                return { text: patch(path, long), masked: 0 };
            },
        });

        expect(asked.length).toBeLessThan(5);
    });
});

describe('composeAskContext: the screen', () => {
    it('keeps the last lines of the screen and not the blank rows under them', () => {
        const rows = Array.from({ length: 100 }, (_, i) => `row ${i}`);
        const ctx = compose({ screen: `${rows.join('\n')}\n\n\n   \n` });

        const kept = ctx.original.screen.split('\n');
        expect(kept).toHaveLength(ASK_CONTEXT_SCREEN_LINES);
        expect(kept[0]).toBe('row 40');
        expect(kept.at(-1)).toBe('row 99');
        expect(ctx.summary.screenLines).toBe(ASK_CONTEXT_SCREEN_LINES);
        // 40 rows scrolled out of what is kept: the receiver is told the screen holds less than there was.
        expect(ctx.summary.cut.screen).toBe(true);
    });

    it('keeps the newest line, cut, when that one line is over the budget', () => {
        // Under the length the mask reads whole lines to, over the byte budget: three bytes a character.
        const ctx = compose({ screen: `old\n${'€'.repeat(3000)}` });

        expect(ctx.original.screen.startsWith('€€€')).toBe(true);
        expect(Buffer.byteLength(ctx.original.screen)).toBeLessThanOrEqual(ASK_CONTEXT_SCREEN_MAX_BYTES);
        expect(ctx.summary.cut.screen).toBe(true);
    });

    it('hides a token at the head of a line, in a sentence, and an assignment', () => {
        const ctx = compose({ screen: [GH, `export it: ${SK} now`, 'password=hunter2hunter2', 'plain line'].join('\n') });

        expect(ctx.original.screen).toBe('***\nexport it: *** now\npassword=***\nplain line');
        expect(ctx.summary.masked).toBe(3);
    });

    it('does not treat a line that looks like a diff header as one', () => {
        const ctx = compose({ screen: ['diff --git a/x b/x', `${GH}`, '@@ -1 +1 @@ x', '\\ no newline', `+${SK}`].join('\n') });

        expect(ctx.original.screen).not.toContain(GH);
        expect(ctx.original.screen).not.toContain(SK);
        expect(ctx.original.screen.split('\n')[0]).toBe('diff --git a/x b/x');
        expect(ctx.original.screen).toContain('@@ -1 +1 @@ x');
        expect(ctx.original.screen).toContain('\\ no newline');
    });

    it('hides the body of a key block whose BEGIN line scrolled out of the kept lines', () => {
        const body = Array.from({ length: 70 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(3, '0')}`);
        const ctx = compose({ screen: ['-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----', 'done'].join('\n') });

        expect(ctx.original.screen).not.toContain('MIIEvQ');
        expect(ctx.original.screen.endsWith('done')).toBe(true);
    });

    it('holds the screen to ASK_CONTEXT_SCREEN_MAX_BYTES by dropping its oldest lines whole', () => {
        const rows = Array.from({ length: 60 }, (_, i) => `${i} ${'y'.repeat(300)}`);
        const ctx = compose({ screen: rows.join('\n') });

        expect(Buffer.byteLength(ctx.original.screen)).toBeLessThanOrEqual(ASK_CONTEXT_SCREEN_MAX_BYTES);
        expect(ctx.summary.cut.screen).toBe(true);
        expect(ctx.original.screen.split('\n').every((l) => /^\d+ y{300}$/.test(l))).toBe(true);
        expect(ctx.original.screen.split('\n').at(-1)).toBe(rows.at(-1));
    });

    it('says nothing was cut for a short screen', () => {
        expect(compose({ screen: 'one\ntwo' }).summary.cut.screen).toBe(false);
    });

    it('treats a missing screen as no screen', () => {
        const ctx = compose({ screen: null });

        expect(ctx.original.screen).toBe('');
        expect(ctx.summary.screenLines).toBe(0);
    });
});

describe('composeAskContext: purity', () => {
    it('gives the same value for the same input and leaves the input alone', () => {
        const files = [file('a.ts')];
        const input: AskContextInput = { files, patchOf: (path) => ({ text: patch(path), masked: 0 }), screen: `${GH}\nok` };
        const before = JSON.stringify({ files, screen: input.screen });

        const first = composeAskContext(input);
        const second = composeAskContext(input);

        expect(second).toEqual(first);
        expect(JSON.stringify({ files, screen: input.screen })).toBe(before);
    });
});

describe('gatherAskContext: against a real git', () => {
    const TMP = mkdtempSync(join(tmpdir(), 'hwip-ask-context-'));
    afterAll(() => rmSync(TMP, { recursive: true, force: true }));

    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf-8' });
    const write = (root: string, rel: string, data: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), data);
    };
    let n = 0;
    const makeRepo = (files: Record<string, string> = { 'README.md': 'hello\n' }): string => {
        const root = join(TMP, `repo-${n++}`);
        mkdirSync(root, { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        for (const [rel, data] of Object.entries(files)) write(root, rel, data);
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'chore: seed');
        return root;
    };

    it('gathers the uncommitted changes against HEAD, new files included', () => {
        const root = makeRepo({ 'a.txt': 'one\ntwo\n' });
        write(root, 'a.txt', 'one\nTWO\n');
        write(root, 'new.txt', 'fresh\n');

        const ctx = gatherAskContext(root, null);

        expect(ctx).not.toBeNull();
        expect(ctx!.summary.listed.map((f) => f.path)).toEqual(['a.txt', 'new.txt']);
        expect(ctx!.original.diff).toContain('+TWO');
        expect(ctx!.original.diff).toContain('+fresh');
        expect(ctx!.summary.diff).toBe('ok');
    });

    it('leaves out a file git ignores: not in the list, the diff or the counts', () => {
        const root = makeRepo({ '.gitignore': '.env\n', 'a.txt': 'one\n' });
        write(root, '.env', `API_TOKEN=${GH}\nDB_PASSWORD=hunter2hunter2\n`);
        write(root, 'a.txt', 'one\ntwo\n');

        const ctx = gatherAskContext(root, null)!;

        expect(ctx.summary.listed.map((f) => f.path)).toEqual(['a.txt']);
        expect(JSON.stringify(ctx)).not.toContain('.env');
        expect(JSON.stringify(ctx)).not.toContain(GH);
        expect(JSON.stringify(ctx)).not.toContain('hunter2');
    });

    it('masks a secret in a changed line: at the head of a line, in a sentence, over several lines', () => {
        const root = makeRepo({ 'notes.md': 'start\n' });
        write(root, 'notes.md', ['start', GH, `use ${SK} here`, 'password=hunter2hunter2'].join('\n') + '\n');

        const ctx = gatherAskContext(root, null)!;

        expect(ctx.original.diff).not.toContain(GH);
        expect(ctx.original.diff).not.toContain(SK);
        expect(ctx.original.diff).not.toContain('hunter2');
        expect(ctx.original.diff).toContain('+***');
        expect(ctx.summary.masked).toBeGreaterThanOrEqual(3);
    });

    it('masks the screen it is given too', () => {
        const root = makeRepo();
        write(root, 'README.md', 'hello\nmore\n');

        const ctx = gatherAskContext(root, `$ echo ${GH}\n${SK}\n`)!;

        expect(ctx.original.screen).toBe('$ echo ***\n***');
        expect(ctx.summary.masked).toBe(2);
    });

    it('reports a repository with nothing changed and no screen as nothing', () => {
        expect(gatherAskContext(makeRepo(), null)).toBeNull();
        expect(gatherAskContext(makeRepo(), '  \n\n')).toBeNull();
    });

    it('gives the screen alone when the directory is not in a repository', () => {
        const dir = join(TMP, 'not-a-repo');
        mkdirSync(dir, { recursive: true });

        const ctx = gatherAskContext(dir, 'build failed\n')!;

        expect(ctx.original.screen).toBe('build failed');
        expect(ctx.original.diff).toBe('');
        expect(ctx.summary.diff).toBe('no_repo');
        expect(gatherAskContext(dir, null)).toBeNull();
    });

    it('works in a repository with no commit yet', () => {
        const root = join(TMP, `repo-${n++}`);
        mkdirSync(root, { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        write(root, 'first.txt', 'hi\n');

        const ctx = gatherAskContext(root, null);

        expect(ctx?.original.diff).toContain('+hi');
    });

    it('falls back to the screen alone when git cannot answer', () => {
        const ctx = gatherAskContext('/definitely/not/a/dir', 'still here', {
            repoRootOf: () => '/x',
            collectDiffFiles: () => ({ ok: false, error: 'git_failed' }),
            collectFilePatch: () => ({ ok: false, error: 'git_failed' }),
        })!;

        expect(ctx.summary.diff).toBe('failed');
        expect(ctx.original.screen).toBe('still here');
    });

    it('stops asking git for patches once it has spent its time, and says the diff is cut', () => {
        let clock = 0;
        const asked: string[] = [];
        const ctx = gatherAskContext('/x', null, {
            repoRootOf: () => '/x',
            collectDiffFiles: () => ({ ok: true, files: [file('a.ts'), file('b.ts'), file('c.ts')], truncated: false }),
            collectFilePatch: (_root, _base, path) => {
                asked.push(path);
                clock += 4_000;
                return { ok: true, text: patch(path), masked: 0 };
            },
            now: () => clock,
        })!;

        expect(asked).toEqual(['a.ts', 'b.ts']);
        expect(ctx.summary.cut.diff).toBe(true);
        expect(ctx.summary.listed.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });

    it('does not throw for a patch git could not give: the file stays in the list', () => {
        const ctx = gatherAskContext('/x', null, {
            repoRootOf: () => '/x',
            collectDiffFiles: () => ({ ok: true, files: [file('a.ts'), file('b.ts')], truncated: false }),
            collectFilePatch: (_root, _base, path) => (path === 'a.ts' ? { ok: false, error: 'git_failed' } : { ok: true, text: patch(path), masked: 0 }),
        })!;

        expect(ctx.summary.listed.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
        expect(ctx.original.diff).toBe(patch('b.ts'));
    });
});
