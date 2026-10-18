import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFile } from './replace-file.js';

// A write that fails half way (a full disk) cannot be made to happen on a real file system here, so
// `writeFileSync` is wrapped: `failWith` decides what a call does, and the real one is what it may call.
type Write = typeof writeFileSync;
const hooks = vi.hoisted(() => ({
    failWith: null as null | ((real: Write, args: Parameters<Write>) => void),
}));
vi.mock('fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('fs')>();
    return {
        ...real,
        writeFileSync: ((...args: Parameters<Write>) => (hooks.failWith ? hooks.failWith(real.writeFileSync, args) : real.writeFileSync(...args))) as Write,
        // The in-place path writes at position 0 of an fd; a hook that fails writes runs in the
        // same write terms, with its own writes landing at 0 as well.
        writeSync: ((fd: number, data: string, position: number | null, encoding: BufferEncoding): number => {
            if (hooks.failWith) {
                const atZero = ((path: unknown, chunk: unknown) => real.writeSync(path as number, String(chunk), 0, 'utf8')) as unknown as Write;
                hooks.failWith(atZero, [fd, String(data), {}] as unknown as Parameters<Write>);
                return Buffer.byteLength(String(data));
            }
            return real.writeSync(fd, data, position, encoding);
        }) as typeof real.writeSync,
        // The temp file is created with O_CREAT|O_EXCL|O_NOFOLLOW, not a write: a hook that simulates
        // the create failing runs here in write terms, as it did when the create was a write.
        openSync: ((...args: [unknown, unknown?, unknown?]) => {
            const [p] = args;
            if (typeof p === 'string' && p.endsWith('.tmp') && hooks.failWith) {
                try {
                    hooks.failWith(real.writeFileSync, [p, '', { mode: 0o600, flag: 'wx' }] as unknown as Parameters<Write>);
                } catch (err) {
                    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
                        try {
                            real.rmSync(p, { force: true });
                        } catch {
                            /* the hook's own error is the one to report */
                        }
                    }
                    throw err;
                }
            }
            return (real.openSync as (...a: unknown[]) => number)(...args);
        }) as typeof real.openSync,
    };
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-replace-file-failed-'));
});

afterEach(() => {
    hooks.failWith = null;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
});

describe('replaceFile when the write fails', () => {
    // C126: `created` was only set after the write, so a temp file the write had made and then failed on stayed behind.
    it('leaves no temp file behind when the write fails after the file was created', () => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, 'old\n');
        hooks.failWith = (real, [path, data, options]) => {
            real(path, String(data).slice(0, 2), options); // the first bytes land, then the disk is full
            throw errno('ENOSPC');
        };

        expect(() => replaceFile(file, 'new content\n')).toThrow(/ENOSPC/);
        hooks.failWith = null;

        expect(readdirSync(dir)).toEqual(['settings.json']);
        expect(readFileSync(file, 'utf-8')).toBe('old\n');
    });

    it('does not remove a file that was already there under the temp name (EEXIST)', () => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, 'old\n');
        let theirs = '';
        hooks.failWith = (real, [path]) => {
            theirs = String(path);
            real(theirs, 'someone else\n');
            throw errno('EEXIST');
        };

        expect(() => replaceFile(file, 'new\n')).toThrow(/EEXIST/);
        hooks.failWith = null;

        expect(readFileSync(theirs, 'utf-8')).toBe('someone else\n');
    });

    // The in-place path (a directory that takes no new files): its put-back of the old bytes.
    describe('in place', () => {
        const refuseTempFile = (real: Write, args: Parameters<Write>, inPlace: (real: Write, args: Parameters<Write>) => void): void => {
            if (String(args[0]).endsWith('.tmp')) throw errno('EACCES');
            inPlace(real, args);
        };

        it('puts the old bytes back when the write fails half way', () => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, '{"mine":true}\n');
            hooks.failWith = (real, args) =>
                refuseTempFile(real, args, (write, [path, data, options]) => {
                    // The first call over the file is the new content: it lands in part, then fails; the put-back is real.
                    if (String(data) === '{"hwip":true}\n') {
                        write(path, '{"hw', options);
                        throw errno('ENOSPC');
                    }
                    write(path, data, options);
                });

            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(/ENOSPC/);
            hooks.failWith = null;

            expect(readFileSync(file, 'utf-8')).toBe('{"mine":true}\n');
        });

        it('says so when the old bytes cannot be put back either', () => {
            const file = join(dir, 'settings.json');
            writeFileSync(file, '{"mine":true}\n');
            hooks.failWith = (real, args) =>
                refuseTempFile(real, args, () => {
                    throw errno('ENOSPC');
                });

            expect(() => replaceFile(file, '{"hwip":true}\n')).toThrow(/old content could not be put back/);
        });
    });
});
