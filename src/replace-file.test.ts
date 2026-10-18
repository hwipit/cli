import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    chmodSync,
    lstatSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    mkdirSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangedError, NotWritableError, replaceFile } from './replace-file.js';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-replace-file-'));
});

afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
});

describe('replaceFile', () => {
    it('creates a missing file and its directory', () => {
        const file = join(dir, 'a', 'b', 'settings.json');
        replaceFile(file, '{}\n');
        expect(readFileSync(file, 'utf-8')).toBe('{}\n');
    });

    // Root writes into a 0o500 directory and a 0o444 file anyway, so none of the permission failures below happen.
    describe.skipIf(process.getuid?.() === 0)('without permission', () => {
        // C119: the rename needs no write permission on the file, so a file its owner made read-only was replaced silently.
        it.each([0o444, 0o400])('stops at a read-only file (%o), names it and leaves it as it was', (mode) => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, '{"mine":true}\n');
            chmodSync(file, mode);
            const before = statSync(file);

            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(NotWritableError);
            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(file);
            expect(() => replaceFile(file, '{"hwip":true}\n', '{"mine":true}\n', 0o600)).toThrow(NotWritableError);
            expect(readFileSync(file, 'utf-8')).toBe('{"mine":true}\n');
            expect(statSync(file).ino).toBe(before.ino);
            expect(statSync(file).mode & 0o777).toBe(mode);
            expect(readdirSync(dir)).toEqual(['settings.json']);
        });

        it('stops at a read-only file behind a symlink, and keeps the link', () => {
            const real = join(dir, 'real.json');
            writeFileSync(real, 'mine\n');
            chmodSync(real, 0o444);
            const link = join(dir, 'link.json');
            symlinkSync(real, link);

            expect(() => replaceFile(link, 'new\n')).toThrow(link);
            expect(readFileSync(real, 'utf-8')).toBe('mine\n');
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
        });

        // C120: before the temp-file write, a file the user can write in a directory they cannot was written in place.
        it('writes a writable file in place when its directory takes no new entries', () => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, '{"mine":true}\n');
            chmodSync(file, 0o664);
            const before = statSync(file);
            chmodSync(dir, 0o500);

            replaceFile(file, '{"hwip":true}\n', '{"mine":true}\n');

            expect(readFileSync(file, 'utf-8')).toBe('{"hwip":true}\n');
            expect(statSync(file).ino).toBe(before.ino);
            expect(statSync(file).mode & 0o777).toBe(0o664);
            expect(readdirSync(dir)).toEqual(['settings.json']);
        });

        it('still refuses to drop another writer\'s change when it writes in place', () => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, '{"theirs":true}\n');
            chmodSync(dir, 0o500);

            expect(() => replaceFile(file, '{"hwip":true}\n', '{"mine":true}\n')).toThrow(FileChangedError);
            expect(readFileSync(file, 'utf-8')).toBe('{"theirs":true}\n');
        });

        it('takes the mode asked for before it puts anything in a file it writes in place', () => {
            const file = join(dir, 'config.json');
            writeFileSync(file, '{}\n');
            chmodSync(file, 0o644);
            chmodSync(dir, 0o500);

            replaceFile(file, '{"key":"secret"}\n', '{}\n', 0o600);

            expect(readFileSync(file, 'utf-8')).toBe('{"key":"secret"}\n');
            expect(statSync(file).mode & 0o777).toBe(0o600);
        });

        it('creates nothing in a directory that takes no new entries, and names the file', () => {
            const file = join(dir, 'settings.json');
            chmodSync(dir, 0o500);

            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(NotWritableError);
            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(file);
            expect(readdirSync(dir)).toEqual([]);
        });

        it('stops at a read-only file in a read-only directory', () => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, 'mine\n');
            chmodSync(file, 0o444);
            chmodSync(dir, 0o500);

            expect(() => replaceFile(file, 'new\n')).toThrow(NotWritableError);
            expect(readFileSync(file, 'utf-8')).toBe('mine\n');
        });
    });

    it('leaves no temp file behind', () => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, 'old\n');
        replaceFile(file, 'new\n');
        expect(readdirSync(dir)).toEqual(['settings.json']);
    });

    it.each([0o600, 0o664])('keeps the file mode %o, past the umask', (mode) => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, 'old\n');
        chmodSync(file, mode);
        replaceFile(file, 'new\n');
        expect(statSync(file).mode & 0o777).toBe(mode);
    });

    it('writes through a symlink and keeps the link', () => {
        // Dotfile managers link ~/.cursor/hooks.json into a repo; replacing the
        // link with a plain file would cut the user's settings off from it.
        const real = join(dir, 'real.json');
        const link = join(dir, 'link.json');
        writeFileSync(real, 'old\n');
        symlinkSync(real, link);
        replaceFile(link, 'new\n');
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, 'utf-8')).toBe('new\n');
    });

    it('writes the file a dangling symlink points at, and keeps the link', () => {
        const real = join(dir, 'real.json');
        const link = join(dir, 'link.json');
        symlinkSync('real.json', link);
        replaceFile(link, 'new\n');
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, 'utf-8')).toBe('new\n');
    });

    // C108: a link to a link to a file that is not there yet was followed one step, so the write
    // replaced the middle link with a plain file and cut the chain.
    it('follows a chain of dangling symlinks to the end, and keeps every link', () => {
        const real = join(dir, 'real.json');
        const middle = join(dir, 'middle.json');
        const link = join(dir, 'link.json');
        symlinkSync('real.json', middle);
        symlinkSync('middle.json', link);

        replaceFile(link, 'new\n');

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(lstatSync(middle).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, 'utf-8')).toBe('new\n');
        expect(readdirSync(dir).sort()).toEqual(['link.json', 'middle.json', 'real.json']);
    });

    it('follows a chain whose links sit in different directories (a dotfiles repo)', () => {
        mkdirSync(join(dir, 'repo', 'cursor'), { recursive: true });
        mkdirSync(join(dir, 'home'), { recursive: true });
        const real = join(dir, 'repo', 'cursor', 'hooks.json');
        symlinkSync('../repo/cursor/hooks.json', join(dir, 'home', 'staged.json'));
        symlinkSync(join(dir, 'home', 'staged.json'), join(dir, 'hooks.json'));

        replaceFile(join(dir, 'hooks.json'), 'new\n');

        expect(lstatSync(join(dir, 'hooks.json')).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(dir, 'home', 'staged.json')).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, 'utf-8')).toBe('new\n');
    });

    it('refuses a symlink loop instead of replacing a link with a file', () => {
        const a = join(dir, 'a.json');
        const b = join(dir, 'b.json');
        symlinkSync('b.json', a);
        symlinkSync('a.json', b);

        expect(() => replaceFile(a, 'new\n')).toThrow(/too many|loop/i);

        expect(lstatSync(a).isSymbolicLink()).toBe(true);
        expect(lstatSync(b).isSymbolicLink()).toBe(true);
        expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
    });

    // `..` in a link is read from where the link really is, not from the path it was reached by.
    it('reads a relative link from the directory it really sits in, when that directory is itself a link', () => {
        mkdirSync(join(dir, 'else', 'h'), { recursive: true });
        symlinkSync('../repo/x.json', join(dir, 'else', 'h', 'link.json'));
        symlinkSync(join(dir, 'else', 'h'), join(dir, 'home'));
        symlinkSync('home/link.json', join(dir, 'top.json'));

        replaceFile(join(dir, 'top.json'), 'new\n');

        expect(readFileSync(join(dir, 'else', 'repo', 'x.json'), 'utf-8')).toBe('new\n');
        expect(readdirSync(dir).sort()).toEqual(['else', 'home', 'top.json']);
        expect(lstatSync(join(dir, 'top.json')).isSymbolicLink()).toBe(true);
    });

    it('follows as many links as the kernel does, and refuses the next one', () => {
        const chain = (links: number): string => {
            for (let i = 0; i < links; i++) symlinkSync(i === links - 1 ? 'end.json' : `l${i + 1}.json`, join(dir, `l${i}.json`));
            return join(dir, 'l0.json');
        };

        replaceFile(chain(40), 'new\n');
        expect(readFileSync(join(dir, 'end.json'), 'utf-8')).toBe('new\n');
    });

    it('refuses a chain of 41 links', () => {
        for (let i = 0; i < 41; i++) symlinkSync(i === 40 ? 'end.json' : `l${i + 1}.json`, join(dir, `l${i}.json`));

        expect(() => replaceFile(join(dir, 'l0.json'), 'new\n')).toThrow(/too many links/);
        expect(readdirSync(dir)).not.toContain('end.json');
    });
});
