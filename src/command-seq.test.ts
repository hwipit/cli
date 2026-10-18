import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextCommandNumber } from './command-seq.js';

const run = promisify(execFile);

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-command-seq-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const fixedClock = (ms: number) => () => ms;
const noWait = async (): Promise<void> => {};

describe('nextCommandNumber', () => {
    it('should count up on every call', async () => {
        const a = await nextCommandNumber({ dir, now: fixedClock(1000) });
        const b = await nextCommandNumber({ dir, now: fixedClock(1000) });
        const c = await nextCommandNumber({ dir, now: fixedClock(1000) });

        expect([a, b, c]).toEqual([1000, 1001, 1002]);
    });

    it('should keep the counter as one line of digits, private to its owner', async () => {
        await nextCommandNumber({ dir, now: fixedClock(1234) });

        const file = join(dir, 'command-seq');
        expect(readFileSync(file, 'utf-8')).toBe('1234\n');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).sort()).toEqual(['command-seq']);
    });

    it('should hand out different numbers to fifty calls at once', async () => {
        const numbers = await Promise.all(Array.from({ length: 50 }, () => nextCommandNumber({ dir, now: fixedClock(5), sleep: noWait })));

        expect(numbers.every((n) => typeof n === 'number')).toBe(true);
        expect(new Set(numbers).size).toBe(50);
    });

    it('should hand out different numbers to two processes drawing from one file', async () => {
        const bundle = join(dir, 'bundle.mjs');
        buildSync({ entryPoints: [join(import.meta.dirname, 'command-seq.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
        const home = mkdtempSync(join(tmpdir(), 'hwip-command-seq-shared-'));
        const script = `import { nextCommandNumber } from ${JSON.stringify(bundle)};
            const out = [];
            for (let i = 0; i < 20; i += 1) out.push(await nextCommandNumber({ dir: ${JSON.stringify(home)}, now: () => 1 }));
            console.log(JSON.stringify(out));`;
        try {
            const [one, two] = await Promise.all([
                run(process.execPath, ['--input-type=module', '-e', script]),
                run(process.execPath, ['--input-type=module', '-e', script]),
            ]);

            const all = [...JSON.parse(one.stdout), ...JSON.parse(two.stdout)] as unknown[];
            expect(all.every((n) => typeof n === 'number')).toBe(true);
            expect(new Set(all).size).toBe(40);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 30000);

    it('should stay above every earlier number after the file is lost', async () => {
        const before = await nextCommandNumber({ dir, now: fixedClock(1000) });
        rmSync(join(dir, 'command-seq'));

        const after = await nextCommandNumber({ dir, now: fixedClock(2000) });

        expect(typeof before === 'number' && typeof after === 'number' && after > before).toBe(true);
    });

    it('should keep counting up when the clock goes back', async () => {
        const a = await nextCommandNumber({ dir, now: fixedClock(9000) });
        const b = await nextCommandNumber({ dir, now: fixedClock(100) });

        expect(a).toBe(9000);
        expect(b).toBe(9001);
    });

    it('should read a counter that holds no number as zero', async () => {
        writeFileSync(join(dir, 'command-seq'), 'garbage\n');

        expect(await nextCommandNumber({ dir, now: fixedClock(7) })).toBe(7);
    });

    it('should refuse a counter too large to be a number', async () => {
        writeFileSync(join(dir, 'command-seq'), `${'9'.repeat(30)}\n`);

        expect(await nextCommandNumber({ dir, now: fixedClock(7) })).toEqual({ refused: 'io' });
    });

    it('should refuse when the counter cannot be read', async () => {
        mkdirSync(join(dir, 'command-seq')); // a folder where the file should be

        expect(await nextCommandNumber({ dir, now: fixedClock(7) })).toEqual({ refused: 'io' });
        expect(existsSync(join(dir, 'command-seq.lock'))).toBe(false);
    });

    it('should refuse when the counter cannot be written, and let go of the lock', async () => {
        chmodSync(dir, 0o500);
        try {
            if (process.getuid?.() === 0) return; // root writes anywhere: nothing to show
            const outcome = await nextCommandNumber({ dir, now: fixedClock(7), sleep: noWait });

            expect(outcome).toEqual({ refused: 'io' });
        } finally {
            chmodSync(dir, 0o700);
        }
        expect(existsSync(join(dir, 'command-seq.lock'))).toBe(false);
    });

    it('should give up after two seconds of waiting on a lock someone holds', async () => {
        writeFileSync(join(dir, 'command-seq.lock'), '');
        const waits: number[] = [];

        const outcome = await nextCommandNumber({ dir, now: fixedClock(7), sleep: async (ms) => { waits.push(ms); } });

        expect(outcome).toEqual({ refused: 'lock' });
        expect(waits.reduce((a, b) => a + b, 0)).toBe(2000);
        expect(existsSync(join(dir, 'command-seq'))).toBe(false);
        expect(existsSync(join(dir, 'command-seq.lock'))).toBe(true); // not ours to remove
    });

    it('should clear a lock left behind more than five seconds ago', async () => {
        const lock = join(dir, 'command-seq.lock');
        writeFileSync(lock, '');
        const old = new Date(Date.now() - 10_000);
        utimesSync(lock, old, old);

        const outcome = await nextCommandNumber({ dir, now: fixedClock(42), sleep: noWait });

        expect(outcome).toBe(42);
        expect(existsSync(lock)).toBe(false);
    });

    it('should leave alone a lock that someone else took while this call was drawing', async () => {
        const lock = join(dir, 'command-seq.lock');
        // The clock is read with the lock held: here another process clears it as stale and takes its own.
        const n = await nextCommandNumber({ dir, now: () => { writeFileSync(lock, 'another-holders-token'); return 11; } });

        expect(n).toBe(11);
        expect(readFileSync(lock, 'utf-8')).toBe('another-holders-token');
    });

    it('should let go of the lock when the clock throws', async () => {
        await expect(nextCommandNumber({ dir, now: () => { throw new Error('clock'); } })).rejects.toThrow('clock');

        expect(existsSync(join(dir, 'command-seq.lock'))).toBe(false);
    });
});
