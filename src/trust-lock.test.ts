import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustLockPath, withTrustLock } from './trust-lock.js';

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-lock-'));
    path = join(dir, 'trusted-devices.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('trust file lock', () => {
    it('should name the lock beside the file, trusted-devices.lock', () => {
        expect(trustLockPath(path)).toBe(join(dir, 'trusted-devices.lock'));
    });

    it('should run the function with the lock held and remove the lock afterwards', () => {
        const seen: boolean[] = [];
        const result = withTrustLock(path, () => {
            seen.push(existsSync(trustLockPath(path)));
            return 7;
        });
        expect(result).toEqual({ locked: true, value: 7 });
        expect(seen).toEqual([true]);
        expect(existsSync(trustLockPath(path))).toBe(false);
    });

    it('should write the process id and a timestamp into the lock', () => {
        let body = '';
        withTrustLock(path, () => { body = readFileSync(trustLockPath(path), 'utf-8'); });
        expect(body).toMatch(new RegExp(`^${process.pid} \\d+\\n$`));
    });

    it('should remove the lock and rethrow when the function throws', () => {
        expect(() => withTrustLock(path, () => { throw new Error('boom'); })).toThrow('boom');
        expect(existsSync(trustLockPath(path))).toBe(false);
    });

    it('should give up without running the function when a fresh lock is held past the wait', () => {
        writeFileSync(trustLockPath(path), '1 1\n');
        let ran = false;
        const result = withTrustLock(path, () => { ran = true; }, { waitMs: 60 });
        expect(result).toEqual({ locked: false });
        expect(ran).toBe(false);
        expect(existsSync(trustLockPath(path))).toBe(true);
    });

    it('should break a lock older than the stale age and run', () => {
        const lock = trustLockPath(path);
        writeFileSync(lock, '1 1\n');
        const old = new Date(Date.now() - 11_000);
        utimesSync(lock, old, old);
        expect(withTrustLock(path, () => 'ran', { waitMs: 60 })).toEqual({ locked: true, value: 'ran' });
        expect(existsSync(lock)).toBe(false);
    });

    it('should not take a lock that is younger than the stale age', () => {
        const lock = trustLockPath(path);
        writeFileSync(lock, '1 1\n');
        const recent = new Date(Date.now() - 9_000);
        utimesSync(lock, recent, recent);
        expect(withTrustLock(path, () => 'ran', { waitMs: 60 })).toEqual({ locked: false });
    });

    it('should report not locked when the folder cannot hold a lock', () => {
        const blocked = join(dir, 'file-not-folder');
        writeFileSync(blocked, '');
        expect(withTrustLock(join(blocked, 'trusted-devices.json'), () => 'ran', { waitMs: 20 })).toEqual({ locked: false });
    });
});
