/**
 * session-diff against a real git. The seam is the git command line, so these
 * build throwaway repositories rather than mocking `spawnSync`.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    branchState,
    collectDiffFiles,
    collectFilePatch,
    DIFF_MAX_FILES,
    DIFF_PAGE_MAX_BYTES,
    filteredPaths,
    filterOverrides,
    gitIn,
    pagePatch,
    repoRootOf,
    resolveBase,
} from './session-diff.js';

// A repo's own config and the user's global one must not change what these see.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const TMP = mkdtempSync(join(tmpdir(), 'hwip-session-diff-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf-8' });

const write = (root: string, rel: string, data: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
};

let n = 0;
/** A repo on `main` with one commit holding `files`. */
const makeRepo = (files: Record<string, string> = { 'README.md': 'hello\n' }): string => {
    const root = join(TMP, `repo-${n++}`);
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    for (const [rel, data] of Object.entries(files)) write(root, rel, data);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: seed');
    return root;
};

const filesOf = (root: string, base: 'head' | 'default' = 'head') => {
    const r = collectDiffFiles(root, base);
    if (!r.ok) throw new Error(`collectDiffFiles failed: ${r.error}`);
    return r;
};
const patchOf = (root: string, path: string, base: 'head' | 'default' = 'head'): string => {
    const r = collectFilePatch(root, base, path);
    if (!r.ok) throw new Error(`collectFilePatch failed: ${r.error}`);
    return r.text;
};

describe('collectDiffFiles', () => {
    let root: string;
    beforeEach(() => {
        root = makeRepo({ 'a.txt': 'one\ntwo\n', 'gone.txt': 'bye\n', 'keep.txt': 'same\n' });
    });

    it('lists modified, deleted, staged-new and untracked files with line counts', () => {
        write(root, 'a.txt', 'one\nTWO\nthree\n');
        rmSync(join(root, 'gone.txt'));
        write(root, 'staged.txt', 'x\ny\n');
        git(root, 'add', 'staged.txt');
        write(root, 'fresh.txt', 'a\nb\nc\n');

        const { files, truncated } = filesOf(root);
        expect(truncated).toBe(false);
        expect(files).toEqual([
            { path: 'a.txt', status: 'M', added: 2, removed: 1 },
            { path: 'fresh.txt', status: '?', added: 3, removed: 0 },
            { path: 'gone.txt', status: 'D', added: 0, removed: 1 },
            { path: 'staged.txt', status: 'A', added: 2, removed: 0 },
        ]);
    });

    it('lists nothing for a clean tree', () => {
        expect(filesOf(root).files).toEqual([]);
    });

    // Regression: the old reader parsed `git status --porcelain` without -z, which
    // quotes and octal-escapes such paths (`"\355\225\234…"`).
    it('returns paths with Korean, spaces and quotes verbatim', () => {
        const names = ['한글 파일.txt', 'a "quoted" name.txt', 'dir with space/내용.md', "it's.txt"];
        for (const name of names) write(root, name, 'line\n');
        const paths = filesOf(root).files.map((f) => f.path);
        expect(paths.sort()).toEqual([...names].sort());
        for (const name of names) expect(patchOf(root, name)).toContain('+line');
    });

    it('reports a tracked Korean path that changed', () => {
        write(root, '한글.txt', 'a\n');
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'chore: korean');
        write(root, '한글.txt', 'a\nb\n');
        expect(filesOf(root).files).toEqual([{ path: '한글.txt', status: 'M', added: 1, removed: 0 }]);
    });

    it('does not list or show a .gitignore d file', () => {
        write(root, '.gitignore', '.env\nbuild/\n');
        git(root, 'add', '.gitignore');
        git(root, 'commit', '-q', '-m', 'chore: ignore');
        write(root, '.env', 'SECRET=1\n');
        write(root, 'build/out.js', 'x\n');
        write(root, 'visible.txt', 'v\n');

        expect(filesOf(root).files.map((f) => f.path)).toEqual(['visible.txt']);
        expect(patchOf(root, '.env')).toBe('');
        expect(patchOf(root, 'build/out.js')).toBe('');
    });

    it('shows a tracked file even when an ignore rule would match it', () => {
        write(root, 'tracked.log', 'a\n');
        git(root, 'add', '-f', 'tracked.log');
        git(root, 'commit', '-q', '-m', 'chore: log');
        write(root, '.gitignore', '*.log\n');
        write(root, 'tracked.log', 'a\nb\n');
        expect(filesOf(root).files.map((f) => f.path)).toContain('tracked.log');
    });

    it('reports a rename as a delete and an add', () => {
        git(root, 'mv', 'a.txt', 'b.txt');
        const { files } = filesOf(root);
        expect(files.map((f) => `${f.status} ${f.path}`)).toEqual(['D a.txt', 'A b.txt']);
    });

    it('marks a binary change and counts nothing for it', () => {
        write(root, 'img.bin', Buffer.from([0, 1, 2, 3, 0]));
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'chore: bin');
        write(root, 'img.bin', Buffer.from([0, 9, 9, 9, 0]));
        write(root, 'new.bin', Buffer.from([0, 0, 1]));
        const files = filesOf(root).files;
        expect(files.find((f) => f.path === 'img.bin')).toMatchObject({ status: 'M', binary: true });
        expect(files.find((f) => f.path === 'new.bin')).toMatchObject({ status: '?', binary: true });
    });

    it('counts a final line with no newline', () => {
        write(root, 'tail.txt', 'a\nb');
        expect(filesOf(root).files).toEqual([{ path: 'tail.txt', status: '?', added: 2, removed: 0 }]);
    });

    it('caps the list and says it was cut', () => {
        for (let i = 0; i < DIFF_MAX_FILES + 5; i++) write(root, `f/${String(i).padStart(4, '0')}.txt`, 'x\n');
        const { files, truncated } = filesOf(root);
        expect(files).toHaveLength(DIFF_MAX_FILES);
        expect(truncated).toBe(true);
    });

    it('has no commit to compare with in a fresh repository: everything is new', () => {
        const fresh = join(TMP, `fresh-${n++}`);
        mkdirSync(fresh, { recursive: true });
        git(fresh, 'init', '-q', '-b', 'main');
        write(fresh, 'a.txt', 'a\n');
        git(fresh, 'add', 'a.txt');
        write(fresh, 'b.txt', 'b\n');
        expect(filesOf(fresh).files.map((f) => `${f.status} ${f.path}`)).toEqual(['A a.txt', '? b.txt']);
        expect(patchOf(fresh, 'a.txt')).toContain('+a');
    });
});

describe('resolveBase', () => {
    it('head is the HEAD commit id', () => {
        const root = makeRepo();
        const head = git(root, 'rev-parse', 'HEAD').trim();
        expect(resolveBase(root, 'head')).toEqual({ ok: true, rev: head });
    });

    it('default is where the branch left main, and what the branch committed shows against it', () => {
        const root = makeRepo({ 'a.txt': 'base\n' });
        const fork = git(root, 'rev-parse', 'HEAD').trim();
        git(root, 'checkout', '-q', '-b', 'feature');
        write(root, 'a.txt', 'base\nfeature\n');
        git(root, 'commit', '-q', '-am', 'feat: feature');
        write(root, 'b.txt', 'uncommitted\n');

        expect(resolveBase(root, 'default')).toEqual({ ok: true, rev: fork, baseName: 'main' });
        expect(filesOf(root, 'head').files.map((f) => f.path)).toEqual(['b.txt']);
        expect(filesOf(root, 'default').files.map((f) => `${f.status} ${f.path}`)).toEqual(['M a.txt', '? b.txt']);
        expect(filesOf(root, 'default').baseName).toBe('main');
    });

    it('prefers origin/HEAD when the clone has one', () => {
        const upstream = makeRepo({ 'a.txt': 'one\n' });
        git(upstream, 'branch', '-m', 'trunk');
        const clone = join(TMP, `clone-${n++}`);
        execFileSync('git', ['clone', '-q', upstream, clone]);
        git(clone, 'checkout', '-q', '-b', 'work');
        write(clone, 'a.txt', 'one\ntwo\n');
        git(clone, 'commit', '-q', '-am', 'feat: two');
        const r = resolveBase(clone, 'default');
        expect(r).toMatchObject({ ok: true, baseName: 'trunk' });
    });

    it('falls back to master when there is no main', () => {
        const root = makeRepo();
        git(root, 'branch', '-m', 'master');
        expect(resolveBase(root, 'default')).toMatchObject({ ok: true, baseName: 'master' });
    });

    it('says no_default_branch when the repo has none, and keeps the head tab usable', () => {
        const root = makeRepo();
        git(root, 'branch', '-m', 'develop');
        expect(resolveBase(root, 'default')).toEqual({ ok: false, error: 'no_default_branch' });
        expect(collectDiffFiles(root, 'default')).toEqual({ ok: false, error: 'no_default_branch' });
        expect(collectDiffFiles(root, 'head').ok).toBe(true);
    });

    it('says no_default_branch when the histories are unrelated', () => {
        const root = makeRepo();
        git(root, 'checkout', '-q', '--orphan', 'island');
        write(root, 'x.txt', 'x\n');
        git(root, 'add', 'x.txt');
        git(root, 'commit', '-q', '-m', 'chore: island');
        expect(resolveBase(root, 'default')).toEqual({ ok: false, error: 'no_default_branch' });
    });

    it('only ever hands git an object id as the revision', () => {
        const root = makeRepo();
        git(root, 'branch', '-m', 'master');
        const r = resolveBase(root, 'default');
        expect(r.ok && /^[0-9a-f]{40,64}$/.test(r.rev)).toBe(true);
    });

    describe('when git prints something it should not', () => {
        // A `git` ahead of the real one on PATH that answers the two questions
        // resolveBase trusts with whatever the test says, and forwards the rest.
        const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
        let shimDir: string;
        let savedPath: string | undefined;
        beforeEach(() => {
            shimDir = mkdtempSync(join(TMP, 'shim-'));
            savedPath = process.env.PATH;
            process.env.PATH = `${shimDir}:${savedPath}`;
        });
        afterEach(() => {
            process.env.PATH = savedPath;
        });
        const shim = (symbolic: string, verifyOut: string): string => {
            const log = join(shimDir, 'calls.log');
            writeFileSync(
                join(shimDir, 'git'),
                `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  *symbolic-ref*) printf '%s\\n' '${symbolic}'; exit 0;;
  *rev-parse*--verify*) printf '%s\\n' '${verifyOut}'; exit 0;;
esac
exec ${realGit} "$@"
`,
                { mode: 0o755 },
            );
            return log;
        };
        const called = (log: string): string => (existsSync(log) ? readFileSync(log, 'utf-8') : '');

        it('never passes a symbolic-ref answer outside refs/remotes/ back to git', () => {
            const root = makeRepo();
            git(root, 'branch', '-m', 'develop');
            const log = shim('--output=/tmp/x', 'f'.repeat(40));
            expect(resolveBase(root, 'default')).toEqual({ ok: false, error: 'no_default_branch' });
            expect(called(log)).not.toContain('--output');
        });

        it('rejects a revision that is not a bare object id', () => {
            const root = makeRepo();
            const log = shim('refs/remotes/origin/main', '--output=/tmp/x');
            expect(resolveBase(root, 'head')).toEqual({ ok: true, rev: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
            expect(resolveBase(root, 'default')).toEqual({ ok: false, error: 'no_default_branch' });
            expect(called(log)).not.toMatch(/merge-base .*--output/);
        });
    });
});

describe('collectFilePatch', () => {
    it('returns the unified diff of a tracked change, and an addition for a new file', () => {
        const root = makeRepo({ 'a.txt': 'one\ntwo\n' });
        write(root, 'a.txt', 'one\nTWO\n');
        write(root, 'new.txt', 'hello\n');
        expect(patchOf(root, 'a.txt')).toContain('-two\n+TWO\n');
        const added = patchOf(root, 'new.txt');
        expect(added).toContain('new file mode');
        expect(added).toContain('+hello');
    });

    it('is empty for an unchanged file and for a path git has never heard of', () => {
        const root = makeRepo();
        expect(patchOf(root, 'README.md')).toBe('');
        expect(patchOf(root, 'nope.txt')).toBe('');
    });

    it('takes a path as a name, not as a pattern or a flag', () => {
        const root = makeRepo({ 'a.txt': 'x\n', 'b.txt': 'x\n' });
        write(root, 'a.txt', 'y\n');
        write(root, 'b.txt', 'y\n');
        write(root, 'c.txt', 'new\n');
        expect(patchOf(root, '*.txt')).toBe('');
        expect(patchOf(root, ':(top)a.txt')).toBe('');
        expect(collectFilePatch(root, 'head', '')).toEqual({ ok: false, error: 'bad_path' });
        expect(collectFilePatch(root, 'head', '/etc/passwd')).toEqual({ ok: false, error: 'bad_path' });
        expect(collectFilePatch(root, 'head', 'a\0b')).toEqual({ ok: false, error: 'bad_path' });
    });

    it('opens a file whose name starts with a dash', () => {
        const root = makeRepo();
        write(root, '-x.txt', 'dash\n');
        expect(filesOf(root).files.map((f) => f.path)).toEqual(['-x.txt']);
        expect(patchOf(root, '-x.txt')).toContain('+dash');
    });

    it('shows an untracked symlink as its target path, never the target content', () => {
        const root = makeRepo();
        const outside = join(TMP, `outside-${n++}.txt`);
        writeFileSync(outside, 'top secret\n');
        symlinkSync(outside, join(root, 'link.txt'));
        // git diffs a symlink as its target PATH, never the target file's content.
        const patch = patchOf(root, 'link.txt');
        expect(patch).toContain(outside);
        expect(patch).not.toContain('top secret');
    });

    // Regression: Node's spawnSync defaults to a 1 MiB buffer; past it the old code
    // saw a null status and reported a generic git failure.
    it('reports a patch past the buffer as too_large, not as a git failure', () => {
        const root = makeRepo({ 'big.txt': 'seed\n' });
        write(root, 'big.txt', 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(90_000));
        expect(collectFilePatch(root, 'head', 'big.txt')).toEqual({ ok: false, error: 'too_large' });
    });

    it('serves a patch between 1 MiB and the cap, which the default buffer would have lost', () => {
        const root = makeRepo({ 'mid.txt': 'seed\n' });
        write(root, 'mid.txt', ('z'.repeat(99) + '\n').repeat(15_000));
        expect(patchOf(root, 'mid.txt').length).toBeGreaterThan(1024 * 1024 - 1);
    });
});

describe('collectFilePatch — masking', () => {
    it('masks before paging and reports how many spots', () => {
        const root = makeRepo();
        write(root, 'cfg.ts', 'export const password = "correct-horse-battery";\nexport const ok = 1;\n');
        const r = collectFilePatch(root, 'head', 'cfg.ts');
        expect(r.ok && r.masked).toBe(1);
        expect(r.ok && r.text).toContain('+export const password = "***";');
        expect(r.ok && r.text).not.toContain('correct-horse');
    });

    it('keeps a key block that straddles a page boundary out of every page', () => {
        const root = makeRepo();
        const body = Array.from({ length: 400 }, (_, i) => `${'A'.repeat(60)}${i}`).join('\n');
        write(root, 'key.pem', `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`);
        const r = collectFilePatch(root, 'head', 'key.pem');
        if (!r.ok) throw new Error(r.error);
        const pages: string[] = [];
        for (let offset = 0; ; ) {
            const page = pagePatch(r.text, offset, 512);
            if (!page.ok) throw new Error(page.error);
            pages.push(page.chunk);
            offset += page.length;
            if (!page.hasMore) break;
        }
        expect(pages.length).toBeGreaterThan(3);
        expect(pages.join('')).not.toContain('AAAAAAAAAA');
        expect(r.masked).toBe(1);
    });

    it('is zero for a clean patch and for an empty one', () => {
        const root = makeRepo();
        write(root, 'plain.txt', 'nothing here\n');
        expect(collectFilePatch(root, 'head', 'plain.txt')).toMatchObject({ ok: true, masked: 0 });
        expect(collectFilePatch(root, 'head', 'README.md')).toEqual({ ok: true, text: '', masked: 0 });
    });
});

describe('collectFilePatch — tracked files and hunk headers', () => {
    it('masks the patch of a tracked file too, not only a new one', () => {
        const root = makeRepo({ 'cfg.ts': 'export const a = 1;\n' });
        write(root, 'cfg.ts', 'export const a = 1;\nexport const password = "correct-horse-battery";\n');
        const r = collectFilePatch(root, 'head', 'cfg.ts');
        expect(r.ok && r.masked).toBe(1);
        expect(r.ok && r.text).toContain('+export const password = "***";');
        expect(r.ok && r.text).not.toContain('correct-horse');
    });

    it('masks the line git copies into the hunk header', () => {
        const key = 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456';
        const lines = [key, '# one', '# two', '# three', '# four', '# five', 'let x = 1;', 'let y = 2;'];
        const root = makeRepo({ 'env.sh': `${lines.join('\n')}\n` });
        write(root, 'env.sh', `${lines.join('\n').replace('let y = 2;', 'let y = 3;')}\n`);
        // The unmasked patch, from git itself, does carry the key in a header.
        expect(git(root, 'diff', 'HEAD', '--', 'env.sh')).toMatch(/^@@ .* @@ API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456$/m);
        const r = collectFilePatch(root, 'head', 'env.sh');
        if (!r.ok) throw new Error(r.error);
        expect(r.text).not.toContain('sk-abcdef');
        expect(r.text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@ API_KEY=\*\*\*$/m);
        expect(r.masked).toBeGreaterThan(0);
    });
});

describe('what a repository\'s own config would run', () => {
    // The repo is not trusted: the agent may have cloned it from anywhere. A config key that
    // names a command must not make the listener run it.
    const scriptIn = (name: string, body = ''): { path: string; marker: string } => {
        const marker = join(TMP, `ran-${n++}`);
        const path = join(TMP, `${name}-${n++}.sh`);
        writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n${body}\n`, { mode: 0o755 });
        return { path, marker };
    };

    it('does not run core.fsmonitor', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n' });
        const { path, marker } = scriptIn('fsm', 'cat >/dev/null');
        git(root, 'config', 'core.fsmonitor', path);
        write(root, 'a.txt', 'two\n');
        git(root, 'diff', '--name-status', 'HEAD');
        // Without this, the test proves nothing about the git it runs on.
        if (!existsSync(marker)) return ctx.skip();
        rmSync(marker);
        expect(filesOf(root).files.map((f) => f.path)).toEqual(['a.txt']);
        patchOf(root, 'a.txt');
        patchOf(root, 'b-new.txt');
        expect(existsSync(marker)).toBe(false);
    });

    it('does not run a clean filter', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': '*.txt filter=pwn\n' });
        const { path, marker } = scriptIn('clean', 'cat');
        git(root, 'config', 'filter.pwn.clean', path);
        git(root, 'config', 'filter.pwn.required', 'true');
        write(root, 'a.txt', 'two\n');
        git(root, 'diff', 'HEAD', '--', 'a.txt');
        if (!existsSync(marker)) return ctx.skip();
        rmSync(marker);
        // The file is under a filter: it is listed without a patch (see 'a file under a filter').
        expect(filesOf(root).files).toEqual([{ path: 'a.txt', status: 'M', added: 0, removed: 0, binary: true }]);
        expect(patchOf(root, 'a.txt')).toBe('');
        expect(existsSync(marker)).toBe(false);
    });

    it('does not run a process filter', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': '*.txt filter=pwn\n' });
        const { path, marker } = scriptIn('process');
        git(root, 'config', 'filter.pwn.process', path);
        write(root, 'a.txt', 'two\n');
        try {
            git(root, 'diff', 'HEAD', '--', 'a.txt');
        } catch {
            // A filter that speaks no protocol may fail the run; the marker is what counts.
        }
        if (!existsSync(marker)) return ctx.skip();
        rmSync(marker);
        collectDiffFiles(root, 'head');
        collectFilePatch(root, 'head', 'a.txt');
        expect(existsSync(marker)).toBe(false);
    });

    it('does not run an external diff driver', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n' });
        const { path, marker } = scriptIn('external', 'echo EXTERNAL');
        git(root, 'config', 'diff.external', path);
        write(root, 'a.txt', 'two\n');
        write(root, 'c.txt', 'new\n');
        git(root, 'diff', 'HEAD');
        if (!existsSync(marker)) return ctx.skip();
        rmSync(marker);
        expect(patchOf(root, 'a.txt')).toContain('+two');
        expect(patchOf(root, 'c.txt')).toContain('+new');
        expect(filesOf(root).files.map((f) => f.path)).toEqual(['a.txt', 'c.txt']);
        expect(existsSync(marker)).toBe(false);
    });

    it('does not run a textconv filter', (ctx) => {
        const root = makeRepo({ 'a.dat': 'one\n', '.gitattributes': '*.dat diff=conv\n' });
        const { path, marker } = scriptIn('textconv', 'cat "$1"');
        git(root, 'config', 'diff.conv.textconv', path);
        write(root, 'a.dat', 'two\n');
        git(root, 'diff', 'HEAD');
        if (!existsSync(marker)) return ctx.skip();
        rmSync(marker);
        expect(patchOf(root, 'a.dat')).toContain('+two');
        expect(existsSync(marker)).toBe(false);
    });

    it('refuses, rather than runs, a filter it cannot blank', () => {
        const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': '*.txt filter=a=b\n' });
        const { path, marker } = scriptIn('odd', 'cat');
        git(root, 'config', 'filter.a=b.clean', path);
        write(root, 'a.txt', 'two\n');
        expect(collectDiffFiles(root, 'head')).toEqual({ ok: false, error: 'git_failed' });
        expect(collectFilePatch(root, 'head', 'a.txt')).toEqual({ ok: false, error: 'git_failed' });
        expect(existsSync(marker)).toBe(false);
    });

    it('refuses, rather than lists nothing to blank, when git does not answer the filter question', () => {
        const root = makeRepo({ 'a.txt': 'one\n' });
        expect(filterOverrides(root)).toEqual([]);
        // A deadline already past is a git that did not answer: not "no filters".
        expect(filterOverrides(root, Date.now() - 1)).toBeNull();
        expect(filteredPaths(root, ['a.txt'], git(root, 'rev-parse', 'HEAD').trim(), Date.now() - 1)).toBeNull();
    });

    it('does not run a filter named by an untracked file, and shows that file no patch', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': '*.sec filter=pwn\n' });
        const { path, marker } = scriptIn('clean', 'cat');
        git(root, 'config', 'filter.pwn.clean', path);
        write(root, 'new.sec', 'PLAINTEXT-SECRET-LINE\n');
        // Staging the file is what shows this git runs the filter at all.
        git(root, 'add', 'new.sec');
        if (!existsSync(marker)) return ctx.skip();
        git(root, 'rm', '-q', '--cached', 'new.sec');
        rmSync(marker, { force: true });
        const listed = JSON.stringify(filesOf(root));
        expect(listed).toContain('new.sec');
        expect(listed).not.toContain('PLAINTEXT-SECRET-LINE');
        expect(patchOf(root, 'new.sec')).toBe('');
        expect(existsSync(marker)).toBe(false);
    });

    it('does not run a textconv filter or external driver on an untracked file either', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': '*.dat diff=conv\n' });
        const conv = scriptIn('textconv', 'cat "$1"');
        const external = scriptIn('external', 'echo EXTERNAL');
        git(root, 'config', 'diff.conv.textconv', conv.path);
        git(root, 'config', 'diff.external', external.path);
        write(root, 'new.dat', 'fresh\n');
        try {
            git(root, 'diff', '--no-index', '--', '/dev/null', 'new.dat');
        } catch {
            // `diff --no-index` exits 1 when the files differ; the markers say whether this git runs either one here.
        }
        if (!existsSync(conv.marker) && !existsSync(external.marker)) return ctx.skip();
        rmSync(conv.marker, { force: true });
        rmSync(external.marker, { force: true });
        expect(patchOf(root, 'new.dat')).toContain('+fresh');
        expect(existsSync(conv.marker)).toBe(false);
        expect(existsSync(external.marker)).toBe(false);
    });
});

describe('a file under a filter', () => {
    // git-crypt, transcrypt and LFS keep the working tree readable and the repository ciphertext
    // (or a pointer). A diff that does not run the filter would send every line as added.
    const PLAIN = 'DB_PASSWORD_LINE=zebra-apple-mango-9\n';
    const filterRepo = (): string => {
        const root = makeRepo({ 'normal.txt': 'x\n' });
        // A text cipher (transcrypt) and a pointer (LFS), both as clean filters.
        const cipher = join(TMP, `cipher-${n++}.sh`);
        writeFileSync(cipher, '#!/bin/sh\nbase64\n', { mode: 0o755 });
        const pointer = join(TMP, `pointer-${n++}.sh`);
        writeFileSync(pointer, '#!/bin/sh\nprintf \'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize 1\\n\' "$(shasum -a 256 | cut -d" " -f1)"\n', { mode: 0o755 });
        write(root, '.gitattributes', 'crypt.env filter=crypt\nbig.json filter=lfs\ndir/sub.env filter=crypt\n');
        git(root, 'config', 'filter.crypt.clean', cipher);
        git(root, 'config', 'filter.lfs.clean', pointer);
        git(root, 'config', 'filter.lfs.required', 'true');
        write(root, 'crypt.env', PLAIN);
        write(root, 'big.json', PLAIN);
        write(root, 'dir/sub.env', PLAIN);
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'chore: add filtered files');
        return root;
    };
    const FILTERED = ['crypt.env', 'big.json', 'dir/sub.env'];
    const everything = (root: string, base: 'head' | 'default' = 'head'): string =>
        JSON.stringify([filesOf(root, base), ...FILTERED.map((f) => patchOf(root, f, base))]);
    /** Every way a request can name the filtered files, with what comes back. */
    const requested = (root: string, base: 'head' | 'default' = 'head'): string =>
        JSON.stringify(['.', 'dir', 'dir/', './crypt.env', ...FILTERED].map((p) => collectFilePatch(root, base, p)));
    const edit = (root: string): void => {
        for (const f of FILTERED) write(root, f, PLAIN + 'extra=line-two\n');
    };

    it('is listed without a patch when only touched', () => {
        const root = filterRepo();
        const later = new Date(Date.now() + 5000);
        for (const f of ['crypt.env', 'big.json']) utimesSync(join(root, f), later, later);
        const files = filesOf(root).files;
        for (const f of files) expect(f).toMatchObject({ added: 0, removed: 0, binary: true });
        expect(everything(root)).not.toContain('zebra-apple-mango');
        expect(patchOf(root, 'crypt.env')).toBe('');
    });

    it('is listed without a patch when one line changed', () => {
        const root = filterRepo();
        write(root, 'crypt.env', PLAIN + 'extra=line-two\n');
        write(root, 'big.json', PLAIN + 'extra=line-two\n');
        write(root, 'normal.txt', 'y\n');
        const files = filesOf(root).files;
        // A filtered file nobody edited may be listed too (its stat is dirty, and it reads as changed without its filter).
        expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['big.json', 'crypt.env', 'normal.txt']));
        for (const f of files.filter((f) => f.path !== 'normal.txt')) expect(f).toMatchObject({ added: 0, removed: 0, binary: true });
        expect(files.find((f) => f.path === 'normal.txt')).toMatchObject({ added: 1, removed: 1 });
        expect(everything(root)).not.toContain('zebra-apple-mango');
        expect(everything(root)).not.toContain('line-two');
        expect(patchOf(root, 'normal.txt')).toContain('+y');
    });

    it('answers bad_path, with no plaintext, to a path that is a directory or another spelling of files', () => {
        const root = filterRepo();
        edit(root);
        for (const path of ['.', 'dir', 'dir/', './crypt.env', 'dir/../crypt.env', 'dir/./sub.env']) {
            const r = collectFilePatch(root, 'head', path);
            expect(r, path).toEqual({ ok: false, error: 'bad_path' });
        }
        expect(requested(root)).not.toContain('zebra-apple-mango');
        // Untracked files in a directory give nothing either.
        write(root, 'fresh/new.sec', PLAIN);
        expect(patchOf(root, 'fresh')).toBe('');
        expect(patchOf(root, 'crypt.env')).toBe('');
        // Git reads a trailing slash as a directory that is not there: nothing comes back.
        expect(patchOf(root, 'crypt.env/')).toBe('');
    });

    // The working tree's attributes alone are not the whole answer: the stored side of the diff was made with the base's.
    const attributeEdits: Array<[string, (root: string) => void, 'head' | 'default']> = [
        ['a filter line removed from an uncommitted .gitattributes', (r) => write(r, '.gitattributes', 'unrelated.txt text\n'), 'head'],
        ['.gitattributes deleted', (r) => rmSync(join(r, '.gitattributes')), 'head'],
        ['-filter and !filter appended', (r) => write(r, '.gitattributes', 'crypt.env -filter\nbig.json !filter\ndir/sub.env -filter\n'), 'head'],
        [
            'the attributes removed in a commit on the branch, compared with the default branch',
            (r) => {
                git(r, 'checkout', '-q', '-b', 'feature');
                write(r, '.gitattributes', 'unrelated.txt text\n');
                git(r, 'commit', '-q', '-am', 'chore: drop attributes');
            },
            'default',
        ],
    ];
    for (const [name, change, base] of attributeEdits) {
        it(`still gives no patch when ${name}`, () => {
            const root = filterRepo();
            change(root);
            edit(root);
            expect(everything(root, base), name).not.toContain('zebra-apple-mango');
            expect(everything(root, base), name).not.toContain('line-two');
            expect(filesOf(root, base).files.filter((f) => FILTERED.includes(f.path)).every((f) => f.binary === true)).toBe(true);
        });
    }

    it('refuses a repository whose info/attributes unsets a filter, which hides it on both sides', () => {
        const root = filterRepo();
        edit(root);
        write(root, '.git/info/attributes', '* -filter\n');
        for (const result of [collectDiffFiles(root, 'head'), collectFilePatch(root, 'head', 'crypt.env')]) {
            expect(result).toEqual({ ok: false, error: 'git_failed' });
        }
        // Any other line there is none of its business.
        write(root, '.git/info/attributes', '*.md text\n# a filter is described here\n');
        expect(patchOf(root, 'crypt.env')).toBe('');
    });

    it('does not take its attributes from an inherited GIT_ATTR_SOURCE', () => {
        // The filter is named only in the working tree: an inherited source (here: the empty tree) would hide it.
        const root = makeRepo({ 'a.txt': 'one\n' });
        write(root, '.gitattributes', '*.txt filter=pwn\n');
        git(root, 'config', 'filter.pwn.clean', 'cat');
        write(root, 'a.txt', 'PLAIN-two\n');
        const emptyTree = git(root, 'hash-object', '-t', 'tree', '/dev/null').trim();
        const before = process.env.GIT_ATTR_SOURCE;
        process.env.GIT_ATTR_SOURCE = emptyTree;
        try {
            expect(filesOf(root).files.find((f) => f.path === 'a.txt')).toEqual({ path: 'a.txt', status: 'M', added: 0, removed: 0, binary: true });
            expect(patchOf(root, 'a.txt')).toBe('');
        } finally {
            if (before === undefined) delete process.env.GIT_ATTR_SOURCE;
            else process.env.GIT_ATTR_SOURCE = before;
        }
    });

    it('refuses a driver named like an attribute state, which check-attr cannot tell apart', () => {
        for (const name of ['set', 'unset', 'unspecified']) {
            const root = makeRepo({ 'a.txt': 'one\n', '.gitattributes': `*.txt filter=${name}\n` });
            git(root, 'config', `filter.${name}.clean`, 'cat');
            write(root, 'a.txt', 'two\n');
            expect(collectDiffFiles(root, 'head'), name).toEqual({ ok: false, error: 'git_failed' });
            expect(collectFilePatch(root, 'head', 'a.txt'), name).toEqual({ ok: false, error: 'git_failed' });
        }
    });

    // A git that answers everything but one question: a wrapper that fails the git commands whose arguments say so.
    const withGitFailing = <T>(match: string, run: () => T): T => {
        const real = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
        const bin = join(TMP, `fakegit-${n++}`);
        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in ${match}) exit 2;; esac; done\nexec '${real}' "$@"\n`, { mode: 0o755 });
        const before = process.env.PATH;
        process.env.PATH = `${bin}:${before}`;
        try {
            return run();
        } finally {
            process.env.PATH = before;
        }
    };

    it('answers git_failed, not a patch, when git cannot say what the attributes are', () => {
        const root = filterRepo();
        edit(root);
        withGitFailing('check-attr', () => {
            expect(collectDiffFiles(root, 'head')).toEqual({ ok: false, error: 'git_failed' });
            expect(collectFilePatch(root, 'head', 'crypt.env')).toEqual({ ok: false, error: 'git_failed' });
            expect(collectFilePatch(root, 'head', 'normal.txt')).toEqual({ ok: false, error: 'git_failed' });
        });
    });

    it('answers git_failed when git is too old to read attributes from a revision', () => {
        const root = filterRepo();
        edit(root);
        withGitFailing('--source=*', () => {
            expect(collectDiffFiles(root, 'head')).toEqual({ ok: false, error: 'git_failed' });
            expect(collectFilePatch(root, 'head', 'crypt.env')).toEqual({ ok: false, error: 'git_failed' });
        });
    });

    it('reads attributes per path: a name, set, unset and unspecified', () => {
        const root = makeRepo({ 'a.txt': 'x\n' });
        write(root, '.gitattributes', '*.n filter=x\n*.s filter\n*.u -filter\n');
        const paths = ['a.n', 'a.s', 'a.u', 'a.txt', 'dir/문서 1.n'];
        const rev = git(root, 'rev-parse', 'HEAD').trim();
        expect(filteredPaths(root, paths, rev)).toEqual(new Set(['a.n', 'a.s', 'dir/문서 1.n']));
        expect(filteredPaths(root, [], rev)).toEqual(new Set());
    });
});

describe('what the listener lets git inherit or reach', () => {
    const scriptIn = (name: string, body = ''): { path: string; marker: string } => {
        const marker = join(TMP, `ran-${n++}`);
        const path = join(TMP, `${name}-${n++}.sh`);
        writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n${body}\n`, { mode: 0o755 });
        return { path, marker };
    };
    const withEnv = <T>(vars: Record<string, string>, run: () => T): T => {
        const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
        Object.assign(process.env, vars);
        try {
            return run();
        } finally {
            for (const [k, v] of Object.entries(before)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    };

    it('reads the repository it was asked about, not the one GIT_DIR and GIT_WORK_TREE name', () => {
        const asked = makeRepo({ 'a.txt': 'one\n' });
        const other = makeRepo({ 'b.txt': 'other\n' });
        write(asked, 'a.txt', 'two\n');
        write(other, 'b.txt', 'changed\n');
        withEnv({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }, () => {
            expect(repoRootOf(asked)?.endsWith(asked.slice(asked.lastIndexOf('/')))).toBe(true);
            expect(filesOf(asked).files.map((f) => f.path)).toEqual(['a.txt']);
            expect(patchOf(asked, 'a.txt')).toContain('+two');
        });
    });

    it('does not run the GIT_EXTERNAL_DIFF program or take config from GIT_CONFIG_*', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n' });
        const external = scriptIn('external', 'echo EXTERNAL');
        const fsm = scriptIn('fsm', 'cat >/dev/null');
        write(root, 'a.txt', 'two\n');
        const vars = {
            GIT_EXTERNAL_DIFF: external.path,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.fsmonitor',
            GIT_CONFIG_VALUE_0: fsm.path,
        };
        withEnv(vars, () => git(root, 'diff', 'HEAD'));
        if (!existsSync(external.marker) && !existsSync(fsm.marker)) return ctx.skip();
        rmSync(external.marker, { force: true });
        rmSync(fsm.marker, { force: true });
        withEnv(vars, () => {
            expect(patchOf(root, 'a.txt')).toContain('+two');
            expect(filesOf(root).files.map((f) => f.path)).toEqual(['a.txt']);
        });
        expect(existsSync(external.marker)).toBe(false);
        expect(existsSync(fsm.marker)).toBe(false);
    });

    it('does not enter a repository nested as a submodule', (ctx) => {
        const root = makeRepo({ 'a.txt': 'one\n' });
        const nested = join(root, 'sub');
        mkdirSync(nested);
        git(nested, 'init', '-q', '-b', 'main');
        write(nested, 's.txt', 'a\n');
        git(nested, 'add', '-A');
        git(nested, 'commit', '-q', '-m', 'chore: seed');
        git(root, 'add', 'sub');
        git(root, 'commit', '-q', '-m', 'chore: add sub');
        const fsm = scriptIn('subfsm', 'cat >/dev/null');
        git(nested, 'config', 'core.fsmonitor', fsm.path);
        write(nested, 's.txt', 'b\n');
        git(root, 'diff', 'HEAD');
        if (!existsSync(fsm.marker)) return ctx.skip();
        rmSync(fsm.marker);
        expect(filesOf(root).files).toEqual([]);
        expect(patchOf(root, 'sub')).toBe('');
        expect(existsSync(fsm.marker)).toBe(false);
    });

    it('does not run a partial clone\'s uploadpack to fetch a missing object', (ctx) => {
        const source = makeRepo({ 'f.txt': 'a\nb\n' });
        git(source, 'config', 'uploadpack.allowFilter', 'true');
        git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
        const clone = (): { root: string; marker: string } => {
            const root = join(TMP, `partial-${n++}`);
            execFileSync('git', ['clone', '-q', '--no-local', '--filter=blob:none', '--no-checkout', `file://${source}`, root]);
            const { path, marker } = scriptIn('uploadpack');
            git(root, 'config', 'remote.origin.uploadpack', path);
            git(root, 'read-tree', 'HEAD');
            write(root, 'f.txt', 'a\nb\nc\n');
            return { root, marker };
        };
        const control = clone();
        try {
            git(control.root, 'diff', 'HEAD');
        } catch {
            // The stand-in is not an upload-pack: the fetch fails; the marker is what counts.
        }
        if (!existsSync(control.marker)) return ctx.skip();
        const guarded = clone();
        collectDiffFiles(guarded.root, 'head');
        collectFilePatch(guarded.root, 'head', 'f.txt');
        expect(existsSync(guarded.marker)).toBe(false);
    });
});

describe('pagePatch', () => {
    // Regression: slicing the bytes and decoding each slice turned a Korean
    // character that straddled the page boundary into U+FFFD on both pages.
    it('never splits a multi-byte character across pages', () => {
        const text = '가'.repeat(30); // 90 bytes
        const pages: string[] = [];
        let offset = 0;
        for (let i = 0; i < 40; i++) {
            const page = pagePatch(text, offset, 10);
            if (!page.ok) throw new Error(page.error);
            pages.push(page.chunk);
            offset += page.length;
            if (!page.hasMore) break;
        }
        expect(pages.join('')).toBe(text);
        expect(pages.join('')).not.toContain('�');
        for (const p of pages) expect(p).toMatch(/^가*$/);
    });

    it('moves a character that would straddle the default page boundary whole to the next page', () => {
        const text = 'a'.repeat(DIFF_PAGE_MAX_BYTES - 1) + '한' + 'b';
        const first = pagePatch(text, 0);
        const second = first.ok && pagePatch(text, first.length);
        expect(first).toMatchObject({ ok: true, length: DIFF_PAGE_MAX_BYTES - 1, hasMore: true });
        expect(first.ok && first.chunk).toBe('a'.repeat(DIFF_PAGE_MAX_BYTES - 1));
        expect(second && second.ok && second.chunk).toBe('한b');
    });

    it('handles four-byte characters', () => {
        const text = '😀'.repeat(10);
        let offset = 0;
        let out = '';
        for (;;) {
            const page = pagePatch(text, offset, 6);
            if (!page.ok) throw new Error(page.error);
            out += page.chunk;
            offset += page.length;
            if (!page.hasMore) break;
        }
        expect(out).toBe(text);
    });

    it('refuses an offset that lands inside a character, past the end, or off the integers', () => {
        expect(pagePatch('가나', 1)).toEqual({ ok: false, error: 'bad_range' });
        expect(pagePatch('가나', 7)).toEqual({ ok: false, error: 'bad_range' });
        expect(pagePatch('abc', -1)).toEqual({ ok: false, error: 'bad_range' });
        expect(pagePatch('abc', 1.5)).toEqual({ ok: false, error: 'bad_range' });
    });

    it('reports totals, hasMore and an etag that follows the whole patch', () => {
        const a = pagePatch('hello world', 0, 5);
        const b = pagePatch('hello world', 5, 5);
        const changed = pagePatch('hello there', 0, 5);
        expect(a).toMatchObject({ ok: true, chunk: 'hello', length: 5, total: 11, hasMore: true });
        expect(b).toMatchObject({ ok: true, chunk: ' worl', hasMore: true });
        expect(a.ok && b.ok && a.etag).toBe(b.ok && b.etag);
        expect(a.ok && a.etag).toMatch(/^[0-9a-f]{16}$/);
        expect(changed.ok && a.ok && changed.etag).not.toBe(a.ok && a.etag);
    });

    it('answers an empty patch and an offset at the very end', () => {
        expect(pagePatch('', 0)).toMatchObject({ ok: true, chunk: '', total: 0, hasMore: false });
        expect(pagePatch('abc', 3)).toMatchObject({ ok: true, chunk: '', hasMore: false });
    });
});

describe('gitIn / repoRootOf', () => {
    it('finds the repository from a subdirectory, and none outside one', () => {
        const root = makeRepo();
        mkdirSync(join(root, 'sub'));
        expect(repoRootOf(join(root, 'sub'))).toBe(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim());
        const plain = join(TMP, `plain-${n++}`);
        mkdirSync(plain);
        expect(repoRootOf(plain)).toBeNull();
    });

    it('does not start git once the request deadline has passed', () => {
        const root = makeRepo();
        expect(gitIn(root, ['rev-parse', 'HEAD'], Date.now() - 1)).toMatchObject({ status: null, tooLarge: false });
        expect(gitIn(root, ['rev-parse', 'HEAD'], Date.now() + 5000).status).toBe(0);
    });

    it('stops a git that hangs at the deadline instead of waiting for it', () => {
        const root = makeRepo();
        const shimDir = mkdtempSync(join(TMP, 'hang-'));
        writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexec sleep 8\n', { mode: 0o755 });
        const saved = process.env.PATH;
        process.env.PATH = `${shimDir}:${saved}`;
        try {
            const started = Date.now();
            const r = gitIn(root, ['rev-parse', 'HEAD'], Date.now() + 300);
            expect(Date.now() - started).toBeLessThan(4000);
            expect(r.status).toBeNull();
            expect(r.stdout).toBe('');
        } finally {
            process.env.PATH = saved;
        }
    });
});

describe('branchState', () => {
    const later = () => Date.now() + 10_000;

    it('names the branch HEAD is on', () => {
        expect(branchState(makeRepo(), later())).toEqual({ head: 'main' });
    });

    it('says detached, with no branch name', () => {
        const root = makeRepo();
        git(root, 'checkout', '-q', '--detach');
        expect(branchState(root, later())).toEqual({ detached: true });
    });

    it('leaves out the upstream and the counts when the branch follows nothing', () => {
        const root = makeRepo();
        git(root, 'checkout', '-q', '-b', 'topic');
        expect(branchState(root, later())).toEqual({ head: 'topic' });
    });

    it('counts commits ahead of and behind the upstream', () => {
        const root = makeRepo();
        const remote = join(TMP, `remote-${n++}.git`);
        git(TMP, 'init', '-q', '--bare', '-b', 'main', remote);
        git(root, 'remote', 'add', 'origin', remote);
        git(root, 'push', '-q', '-u', 'origin', 'main');
        git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: behind');
        git(root, 'push', '-q', 'origin', 'main');
        git(root, 'reset', '-q', '--hard', 'HEAD~1');
        git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: ahead one');
        git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: ahead two');
        git(root, 'fetch', '-q', 'origin');
        expect(branchState(root, later())).toEqual({ head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    });

    it('leaves out the upstream when the configured one was never fetched', () => {
        const root = makeRepo();
        git(root, 'config', 'branch.main.remote', 'origin');
        git(root, 'config', 'branch.main.merge', 'refs/heads/main');
        // `@{upstream}` cannot resolve a remote-tracking ref that was never fetched.
        expect(branchState(root, later())).toEqual({ head: 'main' });
    });

    it('has nothing to say before the first commit', () => {
        const root = join(TMP, `empty-${n++}`);
        mkdirSync(root, { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        expect(branchState(root, later())).toBeUndefined();
    });

    it('does not start git once the budget is spent', () => {
        expect(branchState(makeRepo(), Date.now() - 1)).toBeUndefined();
    });
});

describe('collectDiffFiles branch', () => {
    it('carries the branch next to the files', () => {
        const root = makeRepo();
        write(root, 'new.txt', 'x\n');
        const listing = filesOf(root);
        expect(listing.branch).toEqual({ head: 'main' });
        expect(listing.files.map((f) => f.path)).toEqual(['new.txt']);
    });

    it('lists the files and omits the branch before the first commit', () => {
        const root = join(TMP, `unborn-${n++}`);
        mkdirSync(root, { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        write(root, 'new.txt', 'x\n');
        // `rev-parse --abbrev-ref HEAD` fails with no commit, so the band is left out and the list is not.
        const listing = filesOf(root);
        expect(listing.branch).toBeUndefined();
        expect(listing.files.map((f) => f.path)).toEqual(['new.txt']);
    });
});
