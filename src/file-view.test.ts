/**
 * file-view against a real git. The seam is the file system and the git command line, so
 * these build throwaway repositories — hostile ones included — rather than mocking either.
 */

import { execFileSync } from 'child_process';
import {
    appendFileSync,
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { FILE_VIEW_MAX_BYTES, listTree, readBlob, TREE_PAGE_MAX_ENTRIES, visibleSet } from './file-view.js';

// A repo's own config and the user's global one must not change what these see.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const TMP = mkdtempSync(join(tmpdir(), 'hwip-file-view-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf-8' });

const write = (root: string, rel: string, data: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
};

let n = 0;
const freshDir = (label: string): string => {
    const dir = join(TMP, `${label}-${n++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
};

/** A repo on `main` with one commit holding `files`. */
const makeRepo = (files: Record<string, string> = { 'README.md': 'hello\n' }): string => {
    const root = freshDir('repo');
    git(root, 'init', '-q', '-b', 'main');
    for (const [rel, data] of Object.entries(files)) write(root, rel, data);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: seed');
    return root;
};

const commitAll = (root: string): void => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: more');
};

const treeOf = (root: string, dir: string, cursor?: string) => {
    const r = listTree(root, dir, cursor);
    if (!r.ok) throw new Error(r.error);
    return r;
};

const namesOf = (root: string, dir: string): string[] => {
    const r = treeOf(root, dir);
    return r.body === 'entries' ? r.entries.map((e) => e.name) : [];
};

const blobOf = (root: string, path: string, beforeOpen?: () => void, beforeLstat?: () => void) => {
    const r = readBlob(root, path, { beforeOpen, beforeLstat });
    if (!r.ok) throw new Error(r.error);
    return r;
};

describe('visibleSet', () => {
    it('is the tracked paths plus the untracked ones that are not ignored', () => {
        const root = makeRepo({ 'a.txt': 'a\n', '.gitignore': 'secret.txt\nbuild/\n' });
        write(root, 'new.txt', 'n\n');
        write(root, 'secret.txt', 'ignored\n');
        write(root, 'build/out.js', 'x\n');
        const set = visibleSet(root, undefined);
        if (!set.ok) throw new Error(set.error);
        expect([...set.entries.keys()].sort()).toEqual(['.gitignore', 'a.txt', 'new.txt']);
        expect(set.entries.get('a.txt')?.mode).toBe('100644');
        expect(set.entries.get('new.txt')).toEqual({});
    });

    it('narrows to a scope and still matches paths exactly', () => {
        const root = makeRepo({ 'a/b.txt': 'b\n', 'a/c.txt': 'c\n', 'z.txt': 'z\n' });
        const set = visibleSet(root, 'a');
        if (!set.ok) throw new Error(set.error);
        expect([...set.entries.keys()].sort()).toEqual(['a/b.txt', 'a/c.txt']);
        const one = visibleSet(root, 'a/b.txt');
        if (!one.ok) throw new Error(one.error);
        expect([...one.entries.keys()]).toEqual(['a/b.txt']);
    });

    it('lists a path in conflict once', () => {
        const root = makeRepo({ 'a.txt': 'base\n' });
        git(root, 'checkout', '-q', '-b', 'other');
        write(root, 'a.txt', 'other\n');
        commitAll(root);
        git(root, 'checkout', '-q', 'main');
        write(root, 'a.txt', 'main\n');
        commitAll(root);
        expect(() => git(root, 'merge', 'other')).toThrow();
        // Three stages in the index …
        expect(git(root, 'ls-files', '-s', '--', 'a.txt').trim().split('\n')).toHaveLength(3);
        // … one name for the phone.
        expect(namesOf(root, '')).toEqual(['a.txt']);
    });

    it('leaves out a name whose bytes are not UTF-8 (O1)', (ctx) => {
        const root = makeRepo({ 'ok.txt': 'ok\n' });
        try {
            writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74])]), 'x\n');
        } catch {
            // APFS refuses a name that is not valid UTF-8; there is nothing to test there.
            return ctx.skip();
        }
        expect(namesOf(root, '')).toEqual(['ok.txt']);
    });
});

describe('listTree', () => {
    it('lists the root and a subdirectory, directories as dir', () => {
        const root = makeRepo({ 'README.md': 'r\n', 'src/a.ts': 'a\n', 'src/deep/b.ts': 'b\n', 'src/deep/c.ts': 'c\n' });
        write(root, 'note.txt', 'untracked\n');
        expect(treeOf(root, '')).toEqual({
            ok: true,
            body: 'entries',
            truncated: false,
            entries: [
                { name: 'README.md', type: 'file' },
                { name: 'note.txt', type: 'file' },
                { name: 'src', type: 'dir' },
            ],
        });
        expect(treeOf(root, 'src')).toMatchObject({
            entries: [
                { name: 'a.ts', type: 'file' },
                { name: 'deep', type: 'dir' },
            ],
        });
        expect(namesOf(root, 'src/deep')).toEqual(['b.ts', 'c.ts']);
    });

    it('lists an empty root for a repository with nothing in it', () => {
        const root = freshDir('empty');
        git(root, 'init', '-q', '-b', 'main');
        expect(treeOf(root, '')).toEqual({ ok: true, body: 'entries', truncated: false, entries: [] });
    });

    it('sorts by UTF-8 bytes', () => {
        // U+FF5E sorts before U+1F600 as bytes (EF … < F0 …) but after it as UTF-16 code units.
        const root = makeRepo({ 'a.txt': '\n', 'B.txt': '\n', '\u{1F600}.txt': '\n', '\uFF5E.txt': '\n' });
        expect(namesOf(root, '')).toEqual(['B.txt', 'a.txt', '～.txt', '\u{1F600}.txt']);
    });

    it('answers absent for an ignored directory, a missing one and a file — the three look alike', () => {
        const root = makeRepo({ '.gitignore': 'build/\n', 'a.txt': 'a\n' });
        write(root, 'build/out.js', 'x\n');
        const absent = { ok: true, body: 'absent' };
        expect(listTree(root, 'build')).toEqual(absent);
        expect(listTree(root, 'nope')).toEqual(absent);
        expect(listTree(root, 'a.txt')).toEqual(absent);
    });

    it('refuses a path the rules refuse, and says bad_path', () => {
        const root = makeRepo();
        for (const dir of ['../x', '/etc', 'a/.git', 'a//b', 'a/']) expect(listTree(root, dir)).toEqual({ ok: false, error: 'bad_path' });
    });

    it('pages 501 entries in two pages, none missing and none twice', () => {
        const root = makeRepo({ 'seed.txt': 's\n' });
        const names = Array.from({ length: 500 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
        for (const name of names) write(root, `many/${name}`, 'x\n');
        write(root, 'many/zzz-last.txt', 'x\n');
        const first = treeOf(root, 'many');
        if (first.body !== 'entries') throw new Error('absent');
        expect(first.entries).toHaveLength(TREE_PAGE_MAX_ENTRIES);
        expect(first.truncated).toBe(true);
        expect(first.cursor).toBe('f499.txt');
        const second = treeOf(root, 'many', first.cursor);
        if (second.body !== 'entries') throw new Error('absent');
        expect(second.entries.map((e) => e.name)).toEqual(['zzz-last.txt']);
        expect(second.truncated).toBe(false);
        expect(second.cursor).toBeUndefined();
        expect([...first.entries, ...second.entries].map((e) => e.name)).toEqual([...names, 'zzz-last.txt']);
    });

    it('shows a symlink as a symlink, a gitlink and a nested repository as submodule', () => {
        const root = makeRepo({ 'a.txt': 'a\n' });
        symlinkSync('a.txt', join(root, 'link'));
        git(root, 'add', 'link');
        const other = makeRepo({ 'x.txt': 'x\n' });
        const commit = git(other, 'rev-parse', 'HEAD').trim();
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},vendored`);
        const nested = join(root, 'nested');
        mkdirSync(nested);
        git(nested, 'init', '-q', '-b', 'main');
        write(root, 'nested/inside.txt', 'inside\n');
        const types = Object.fromEntries(
            (treeOf(root, '') as { entries: Array<{ name: string; type: string }> }).entries.map((e) => [e.name, e.type]),
        );
        expect(types).toEqual({ 'a.txt': 'file', link: 'symlink', nested: 'submodule', vendored: 'submodule' });
        // Neither is entered.
        expect(listTree(root, 'nested')).toEqual({ ok: true, body: 'absent' });
        expect(listTree(root, 'vendored')).toEqual({ ok: true, body: 'absent' });
    });

    it('shows an ignored path that is tracked anyway (git add -f)', () => {
        const root = makeRepo({ '.gitignore': 'dist/\n', 'a.txt': 'a\n' });
        write(root, 'dist/forced.js', 'f\n');
        write(root, 'dist/other.js', 'o\n');
        git(root, 'add', '-f', 'dist/forced.js');
        expect(namesOf(root, '')).toEqual(['.gitignore', 'a.txt', 'dist']);
        expect(namesOf(root, 'dist')).toEqual(['forced.js']);
    });

    it('answers absent for a directory a symlink replaced since it was tracked', () => {
        const root = makeRepo({ 'd/x.txt': 'x\n' });
        const outside = freshDir('outside');
        write(outside, 'x.txt', 'OUTSIDE SECRET\n');
        rmSync(join(root, 'd'), { recursive: true });
        symlinkSync(outside, join(root, 'd'));
        expect(listTree(root, 'd')).toEqual({ ok: true, body: 'absent' });
    });

    it('still lists a tracked file that was deleted (the phone overlays the D)', () => {
        const root = makeRepo({ 'gone.txt': 'g\n', 'kept.txt': 'k\n' });
        rmSync(join(root, 'gone.txt'));
        expect(namesOf(root, '')).toEqual(['gone.txt', 'kept.txt']);
    });
});

describe('readBlob', () => {
    it('reads a tracked file, an untracked one, and one in a repository with no commit', () => {
        const root = makeRepo({ 'src/a.txt': 'tracked\n' });
        write(root, 'src/new.txt', 'untracked\n');
        expect(blobOf(root, 'src/a.txt')).toEqual({ ok: true, body: 'text', text: 'tracked\n', masked: 0 });
        expect(blobOf(root, 'src/new.txt')).toMatchObject({ body: 'text', text: 'untracked\n' });
        const fresh = freshDir('fresh');
        git(fresh, 'init', '-q', '-b', 'main');
        write(fresh, 'first.txt', 'one\n');
        expect(blobOf(fresh, 'first.txt')).toMatchObject({ body: 'text', text: 'one\n' });
    });

    it('reads the working tree, not HEAD (D3)', () => {
        const root = makeRepo({ 'a.txt': 'committed\n' });
        write(root, 'a.txt', 'edited\n');
        expect(blobOf(root, 'a.txt')).toMatchObject({ text: 'edited\n' });
    });

    it('says bad_path to a spelling the rules refuse, before it asks git anything', () => {
        const root = makeRepo();
        for (const path of ['', '../x', '/etc/passwd', '.git/config', 'sub/.GIT/HEAD', 'a\u0000b'])
            expect(readBlob(root, path)).toEqual({ ok: false, error: 'bad_path' });
    });

    it('answers absent for an ignored file, a missing one and a directory', () => {
        const root = makeRepo({ '.gitignore': '.env\nbuild/\n', 'dir/a.txt': 'a\n' });
        write(root, '.env', 'API_KEY=hunter2hunter2\n');
        write(root, 'build/o.js', 'x\n');
        for (const path of ['.env', 'build/o.js', 'nope.txt', 'dir', 'dir/nope.txt'])
            expect(blobOf(root, path)).toEqual({ ok: true, body: 'absent' });
    });

    it('answers absent for a tracked file that was deleted', () => {
        const root = makeRepo({ 'a.txt': 'a\n' });
        rmSync(join(root, 'a.txt'));
        expect(blobOf(root, 'a.txt')).toEqual({ ok: true, body: 'absent' });
    });

    it('shows a file git add -f tracks although it is ignored', () => {
        const root = makeRepo({ '.gitignore': 'forced.txt\n' });
        write(root, 'forced.txt', 'forced\n');
        expect(blobOf(root, 'forced.txt')).toEqual({ ok: true, body: 'absent' });
        git(root, 'add', '-f', 'forced.txt');
        expect(blobOf(root, 'forced.txt')).toMatchObject({ body: 'text', text: 'forced\n' });
    });

    describe('symlinks', () => {
        it('shows the target string of a symlink and never what it points at', () => {
            const outside = freshDir('outside');
            write(outside, 'secret.txt', 'OUTSIDE SECRET\n');
            const root = makeRepo({ 'inside.txt': 'inside\n' });
            symlinkSync(join(outside, 'secret.txt'), join(root, 'out-file'));
            symlinkSync(outside, join(root, 'out-dir'));
            symlinkSync('inside.txt', join(root, 'in-repo'));
            commitAll(root);
            expect(blobOf(root, 'out-file')).toEqual({ ok: true, body: 'symlink', target: join(outside, 'secret.txt') });
            expect(blobOf(root, 'out-dir')).toEqual({ ok: true, body: 'symlink', target: outside });
            expect(blobOf(root, 'in-repo')).toEqual({ ok: true, body: 'symlink', target: 'inside.txt' });
            // Through the directory symlink there is no path at all.
            expect(blobOf(root, 'out-dir/secret.txt')).toEqual({ ok: true, body: 'absent' });
            expect(listTree(root, 'out-dir')).toEqual({ ok: true, body: 'absent' });
        });

        it('answers absent when a directory on the way became a symlink', () => {
            const outside = freshDir('outside');
            write(outside, 'x.txt', 'OUTSIDE SECRET\n');
            const root = makeRepo({ 'd/x.txt': 'x\n' });
            rmSync(join(root, 'd'), { recursive: true });
            symlinkSync(outside, join(root, 'd'));
            expect(blobOf(root, 'd/x.txt')).toEqual({ ok: true, body: 'absent' });
        });

        it('works when the repository itself sits under a symlinked directory', () => {
            const real = makeRepo({ 'a/b.txt': 'b\n' });
            const alias = join(freshDir('alias'), 'repo-link');
            symlinkSync(real, alias);
            expect(blobOf(alias, 'a/b.txt')).toMatchObject({ body: 'text', text: 'b\n' });
        });
    });

    describe('submodules', () => {
        it('shows the commit of a gitlink and enters nothing', () => {
            const other = makeRepo({ 'x.txt': 'x\n' });
            const commit = git(other, 'rev-parse', 'HEAD').trim();
            const root = makeRepo();
            git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},vendored`);
            expect(blobOf(root, 'vendored')).toEqual({ ok: true, body: 'submodule', commit });
            expect(blobOf(root, 'vendored/x.txt')).toEqual({ ok: true, body: 'absent' });
        });

        it('shows a nested repository as a submodule without a commit, and runs nothing in it', (ctx) => {
            const root = makeRepo();
            const nested = join(root, 'nested');
            mkdirSync(nested);
            git(nested, 'init', '-q', '-b', 'main');
            write(root, 'nested/inside.txt', 'inside\n');
            const marker = join(TMP, `ran-${n++}`);
            const script = join(TMP, `fsm-${n++}.sh`);
            writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`, { mode: 0o755 });
            git(nested, 'config', 'core.fsmonitor', script);
            git(nested, 'status', '--short');
            // Without this, the test proves nothing about the git it runs on.
            if (!existsSync(marker)) return ctx.skip();
            rmSync(marker);
            expect(blobOf(root, 'nested')).toEqual({ ok: true, body: 'submodule' });
            expect(blobOf(root, 'nested/inside.txt')).toEqual({ ok: true, body: 'absent' });
            listTree(root, '');
            expect(existsSync(marker)).toBe(false);
        });
    });

    describe('names that stay unread (D4) and filters (V9)', () => {
        it('filters a tracked .env and key files, ignoring case, but not .env.example', () => {
            const root = makeRepo({
                '.env': 'A=1\n',
                '.env.local': 'A=1\n',
                '.env.example': 'A=\n',
                '.env.sample': 'A=\n',
                'config/server.pem': 'pem\n',
                'k.KEY': 'k\n',
                'keys.p12': 'p\n',
                'keys.pfx': 'p\n',
                'app.keystore': 'p\n',
                '.ssh/id_rsa': 'p\n',
                '.ssh/id_rsa.pub': 'p\n',
                '.ssh/id_ed25519': 'p\n',
                'Credentials.json': 'p\n',
                'environment.ts': 'fine\n',
            });
            for (const path of ['.env', '.env.local', 'config/server.pem', 'k.KEY', 'keys.p12', 'keys.pfx', 'app.keystore', '.ssh/id_rsa'])
                expect(blobOf(root, path)).toEqual({ ok: true, body: 'filtered' });
            for (const path of ['.ssh/id_rsa.pub', '.ssh/id_ed25519', 'Credentials.json'])
                expect(blobOf(root, path)).toEqual({ ok: true, body: 'filtered' });
            for (const path of ['.env.example', '.env.sample', 'environment.ts']) expect(blobOf(root, path)).toMatchObject({ body: 'text' });
            // Listed, though not read.
            expect(namesOf(root, '')).toContain('.env');
        });

        it('filters a file a filter= attribute names, from the working tree attributes', () => {
            const root = makeRepo({ 'plain.txt': 'plain\n', 'secret.dat': 'CIPHERTEXT\n', '.gitattributes': '*.dat filter=crypt\n' });
            expect(blobOf(root, 'secret.dat')).toEqual({ ok: true, body: 'filtered' });
            expect(blobOf(root, 'plain.txt')).toMatchObject({ body: 'text' });
        });

        it('filters a file the base revision attributed a filter to, even after the attribute is removed', () => {
            const root = makeRepo({ 'secret.dat': 'CIPHERTEXT\n', '.gitattributes': '*.dat filter=crypt\n' });
            write(root, '.gitattributes', '');
            expect(blobOf(root, 'secret.dat')).toEqual({ ok: true, body: 'filtered' });
        });

        it('says git_failed when info/attributes hides the filter', () => {
            const root = makeRepo({ 'secret.dat': 'x\n', '.gitattributes': '*.dat filter=crypt\n' });
            write(root, '.git/info/attributes', '*.dat -filter\n');
            expect(readBlob(root, 'secret.dat')).toEqual({ ok: false, error: 'git_failed' });
        });
    });

    describe('what the repository would run', () => {
        const scriptIn = (name: string, body = ''): { path: string; marker: string } => {
            const marker = join(TMP, `ran-${n++}`);
            const path = join(TMP, `${name}-${n++}.sh`);
            writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n${body}\n`, { mode: 0o755 });
            return { path, marker };
        };

        // V-1: ls-files and check-attr do not run a clean filter or a file system monitor.
        const everything = (root: string, paths: string[]): void => {
            listTree(root, '');
            for (const dir of ['sub']) listTree(root, dir);
            for (const path of paths) readBlob(root, path);
        };

        it('does not run core.fsmonitor', (ctx) => {
            const root = makeRepo({ 'a.txt': 'one\n', 'sub/b.txt': 'b\n' });
            const { path, marker } = scriptIn('fsm', 'cat >/dev/null');
            git(root, 'config', 'core.fsmonitor', path);
            write(root, 'a.txt', 'two\n');
            git(root, 'diff', '--name-status', 'HEAD');
            if (!existsSync(marker)) return ctx.skip();
            rmSync(marker);
            everything(root, ['a.txt', 'sub/b.txt', 'nope.txt']);
            expect(existsSync(marker)).toBe(false);
        });

        it('does not run a clean filter', (ctx) => {
            const root = makeRepo({ 'a.txt': 'one\n', 'sub/b.txt': 'b\n', '.gitattributes': '*.txt filter=pwn\n' });
            const { path, marker } = scriptIn('clean', 'cat');
            git(root, 'config', 'filter.pwn.clean', path);
            git(root, 'config', 'filter.pwn.required', 'true');
            write(root, 'a.txt', 'two\n');
            git(root, 'diff', 'HEAD', '--', 'a.txt');
            if (!existsSync(marker)) return ctx.skip();
            rmSync(marker);
            everything(root, ['a.txt', 'sub/b.txt']);
            expect(existsSync(marker)).toBe(false);
        });
    });

    it.skipIf(process.getuid?.() === 0)('reports a file system failure instead of calling the file absent', () => {
        const root = makeRepo({ 'locked/a.txt': 'a\n' });
        chmodSync(join(root, 'locked'), 0o000);
        try {
            expect(readBlob(root, 'locked/a.txt')).toEqual({ ok: false, error: 'git_failed' });
        } finally {
            chmodSync(join(root, 'locked'), 0o755);
        }
    });

    describe('files that are not plain text', () => {
        it('does not stop on a FIFO', () => {
            const root = makeRepo();
            execFileSync('mkfifo', [join(root, 'pipe')]);
            expect(blobOf(root, 'pipe')).toEqual({ ok: true, body: 'absent' });
        });

        it('says absent when a regular file turns into a FIFO between the check and the open', () => {
            const root = makeRepo({ 'a.txt': 'a\n' });
            const result = blobOf(root, 'a.txt', () => {
                rmSync(join(root, 'a.txt'));
                execFileSync('mkfifo', [join(root, 'a.txt')]);
            });
            expect(result).toEqual({ ok: true, body: 'absent' });
        });

        it('filters a hard link (D5), whichever side of the link it is', () => {
            const outside = freshDir('outside');
            write(outside, 'secret.txt', 'OUTSIDE SECRET\n');
            const root = makeRepo({ 'a.txt': 'a\n' });
            linkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
            linkSync(join(root, 'a.txt'), join(root, 'twin.txt'));
            for (const path of ['linked.txt', 'a.txt', 'twin.txt']) expect(blobOf(root, path)).toEqual({ ok: true, body: 'filtered' });
        });

        it('reads exactly 1 MiB and refuses one byte more without reading it', () => {
            const root = makeRepo();
            write(root, 'exact.txt', 'a'.repeat(FILE_VIEW_MAX_BYTES));
            write(root, 'over.txt', 'a'.repeat(FILE_VIEW_MAX_BYTES + 1));
            expect(blobOf(root, 'exact.txt')).toMatchObject({ body: 'text' });
            expect(readBlob(root, 'over.txt')).toEqual({ ok: false, error: 'too_large' });
        });

        it('refuses a file that grew past 1 MiB after it was listed', () => {
            const root = makeRepo({ 'grow.txt': 'small\n' });
            const result = readBlob(root, 'grow.txt', { beforeOpen: () => appendFileSync(join(root, 'grow.txt'), 'a'.repeat(FILE_VIEW_MAX_BYTES)) });
            expect(result).toEqual({ ok: false, error: 'too_large' });
        });

        it('calls a file with a NUL in its first 8,000 bytes binary and sends its size only', () => {
            const root = makeRepo();
            write(root, 'bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0a, 0x1a]));
            write(root, 'late-nul.txt', `${'a'.repeat(8000)}\0tail`);
            expect(blobOf(root, 'bin.dat')).toEqual({ ok: true, body: 'binary', size: 6 });
            // Past the probe it is text as far as git's own rule goes.
            expect(blobOf(root, 'late-nul.txt')).toMatchObject({ body: 'text' });
        });
    });

    describe('a file swapped under the reader (V7 ⑤)', () => {
        it('shows nothing when the file became a symlink between the check and the open', () => {
            const outside = freshDir('outside');
            write(outside, 'secret.txt', 'OUTSIDE SECRET\n');
            const root = makeRepo({ 'a.txt': 'a\n' });
            const result = blobOf(root, 'a.txt', () => {
                rmSync(join(root, 'a.txt'));
                symlinkSync(join(outside, 'secret.txt'), join(root, 'a.txt'));
            });
            expect(result).toEqual({ ok: true, body: 'absent' });
        });

        it('shows nothing when a directory on the way became a symlink after the walk and before the lstat', () => {
            const outside = freshDir('outside');
            write(outside, 'x.txt', 'OUTSIDE SECRET\n');
            const root = makeRepo({ 'd/x.txt': 'x\n' });
            const result = blobOf(root, 'd/x.txt', undefined, () => {
                rmSync(join(root, 'd'), { recursive: true });
                symlinkSync(outside, join(root, 'd'));
            });
            expect(result).toEqual({ ok: true, body: 'absent' });
        });

        it('shows nothing when another file took its place', () => {
            const root = makeRepo({ 'a.txt': 'a\n' });
            write(root, 'other.txt', 'OTHER\n');
            const result = blobOf(root, 'a.txt', () => renameSync(join(root, 'other.txt'), join(root, 'a.txt')));
            expect(result).toEqual({ ok: true, body: 'absent' });
        });
    });

    describe('secrets in the text (V10)', () => {
        it('masks the whole text and counts what it masked', () => {
            const root = makeRepo({ 'env.sh': 'echo hi\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nexport X=1\n' });
            const r = blobOf(root, 'env.sh');
            if (r.body !== 'text') throw new Error(r.body);
            expect(r.text).not.toContain('sk-abcdef');
            expect(r.text).toContain('echo hi');
            expect(r.masked).toBeGreaterThan(0);
        });

        it('masks a key block as a whole', () => {
            const body = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 40 }, () => 'A'.repeat(64)), '-----END RSA PRIVATE KEY-----', ''].join('\n');
            const root = makeRepo({ 'notes.md': `${'x'.repeat(16 * 1024 - 100)}\n${body}` });
            const r = blobOf(root, 'notes.md');
            if (r.body !== 'text') throw new Error(r.body);
            expect(r.text).not.toContain('A'.repeat(64));
            expect(r.masked).toBeGreaterThan(0);
        });
    });

    // V-3 (design: unverified ③). macOS keeps the bytes a name was created with; with
    // precomposeUnicode off git stores them as typed, and the name it lists must open.
    describe('a decomposed unicode name', () => {
        const nfd = 'é.txt';
        it.skipIf(process.platform !== 'darwin')('lists a name that readBlob opens when core.precomposeUnicode is off', () => {
            const root = freshDir('nfd');
            git(root, 'init', '-q', '-b', 'main');
            git(root, 'config', 'core.precomposeUnicode', 'false');
            write(root, nfd, 'nfd content\n');
            git(root, 'add', '-A');
            git(root, 'commit', '-q', '-m', 'chore: nfd');
            const listed = namesOf(root, '');
            expect(listed).toHaveLength(1);
            expect(blobOf(root, listed[0])).toMatchObject({ body: 'text', text: 'nfd content\n' });
        });
    });
});
