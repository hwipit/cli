/**
 * The lock every writer of `~/.hwip/trusted-devices.json` holds while it re-reads and rewrites the file.
 *
 * The listener, `hwip trust`, `hwip notify`, `hwip ask`, `hwip agent send` and the MCP server all pin
 * devices now, and the listener keeps the sealed-command numbers (`commands`, `commandKeys`) in the
 * same file: a writer that read the file before another one saved would put the old numbers back and
 * let a command be typed again. The lock is `trusted-devices.lock` beside the file, created with
 * `wx`; the MCP server follows the same protocol (cli and mcp-server agree on it).
 */

import { closeSync, openSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

/** A lock older than this was left by a process that died. */
const STALE_MS = 10_000;
/** How long a writer waits for a lock that is held. */
const DEFAULT_WAIT_MS = 1_000;
const POLL_MS = 20;

export const trustLockPath = (trustPath: string): string => `${trustPath.replace(/\.json$/, '')}.lock`;

export const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const ageOf = (lock: string): number | null => {
    try {
        return Date.now() - statSync(lock).mtimeMs;
    } catch {
        return null;
    }
};

export type Locked<T> = { locked: true; value: T } | { locked: false };

/**
 * Run `fn` with the lock held. `locked: false` means the lock could not be had — held by someone for
 * longer than `waitMs`, or the folder cannot hold one — and `fn` did not run. The caller decides what
 * that costs: a pin is skipped and the send goes on, a command number is not taken.
 */
export const withTrustLock = <T>(trustPath: string, fn: () => T, opts: { waitMs?: number } = {}): Locked<T> => {
    const lock = trustLockPath(trustPath);
    const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
    let brokeStale = false;
    try {
        mkdirHandedBack(dirname(lock), 0o700);
    } catch {
        return { locked: false };
    }
    for (;;) {
        try {
            const fd = openSync(lock, 'wx', 0o600);
            try {
                writeSync(fd, `${process.pid} ${Date.now()}\n`);
            } catch {
                // An empty lock nobody owns would hold every writer off until it goes stale.
                rmSync(lock, { force: true });
                return { locked: false };
            } finally {
                closeSync(fd);
            }
            handBackToSudoUser(lock);
            break;
        } catch (err) {
            // `err.code` is how node names a lock that is already there: the cast reads that and nothing else
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { locked: false };
            const age = ageOf(lock);
            // Looked at again right before the unlink: narrows, does not close, the window in which another waiter broke this
            // one and took a fresh lock (the critical sections are short sync file I/O, so it is rare).
            if (!brokeStale && age !== null && age > STALE_MS && (ageOf(lock) ?? 0) > STALE_MS) {
                brokeStale = true;
                try { unlinkSync(lock); } catch { /* someone else broke it first */ }
                continue;
            }
            if (Date.now() >= deadline) return { locked: false };
            sleepSync(POLL_MS);
        }
    }
    try {
        return { locked: true, value: fn() };
    } finally {
        rmSync(lock, { force: true });
    }
};
