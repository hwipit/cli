import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangedError, replaceFile } from './replace-file.js';

// C149 ④: the temp file is created without following a link at its end, and what is renamed is
// checked to still be that file. A fixed `randomBytes` makes the temp name predictable.
vi.mock('crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('crypto')>();
    return { ...real, randomBytes: (n: number) => Buffer.alloc(n, 0xab) };
});

const TMP_SUFFIX = `.${'ab'.repeat(6)}.tmp`;

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-replace-tmp-guard-'));
});

afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
});

describe('replaceFile temp file', () => {
    it('does not follow a link put where the temp file was, and writes nothing through it', () => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, 'old\n');
        const victim = join(dir, 'victim');
        writeFileSync(victim, 'theirs\n');
        symlinkSync(victim, `${file}${TMP_SUFFIX}`);

        expect(() => replaceFile(file, 'new\n')).toThrow(/EEXIST/);
        expect(readFileSync(victim, 'utf-8')).toBe('theirs\n');
        expect(readFileSync(file, 'utf-8')).toBe('old\n');
        expect(lstatSync(`${file}${TMP_SUFFIX}`).isSymbolicLink()).toBe(true);
    });

    it('refuses the rename when the temp file gained a second name in between', async () => {
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const real = await importOriginal<typeof import('fs')>();
            return {
                ...real,
                lstatSync: ((path: unknown, options?: unknown) => {
                    const st = (real.lstatSync as (p: unknown, o?: unknown) => object)(path, options);
                    if (typeof path === 'string' && path.endsWith('.tmp')) {
                        return new Proxy(st, {
                            get: (target, prop, receiver) => {
                                if (prop === 'nlink') return 2;
                                const value = Reflect.get(target, prop, receiver);
                                return typeof value === 'function' ? value.bind(target) : value;
                            },
                        });
                    }
                    return st;
                }) as typeof real.lstatSync,
            };
        });
        const { replaceFile: guarded, FileChangedError: FreshChanged } = await import('./replace-file.js');
        const file = join(dir, 'settings.json');

        expect(() => guarded(file, 'new\n')).toThrow(FreshChanged);
        expect(readdirSync(dir)).toEqual([]);
        vi.doUnmock('fs');
    });
});
