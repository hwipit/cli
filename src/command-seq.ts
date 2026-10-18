import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

/**
 * The number a sealed command carries (`cmd.n`): the listener takes only a number greater than the
 * last it saw from that sender, so every process on this machine that sends as this machine — the
 * CLI and any number of MCP servers — has to draw from one counter. It is a file with a single
 * line, `~/.hwip/command-seq`, read and rewritten under an exclusive lock file beside it.
 *
 * `n = max(last + 1, now)`: the clock keeps numbers moving forward when the file is lost, which
 * would otherwise start over at 1 and have every listener drop the new commands as replays. This is
 * the formula the phone uses for its own counter (`PeerPins.nextCommand`).
 *
 * The MCP server carries a copy of this file; the file's name, its one-line format and the lock's
 * name are the contract between them.
 */

export type CommandSeqRefusal =
    /** The lock could not be taken: another sender holds it. */
    | 'lock'
    /** The counter could not be read, or written, or no longer fits a number. */
    | 'io';

export interface CommandSeqDeps {
    /** Where the counter lives. Default `~/.hwip`. */
    dir?: string;
    /** The clock, in ms since the epoch. */
    now?: () => number;
    /** Wait between tries for the lock. */
    sleep?: (ms: number) => Promise<void>;
}

const FILE = 'command-seq';
const LOCK = 'command-seq.lock';
/** 40 tries 50 ms apart: two seconds, then the send is refused. */
const LOCK_TRIES = 40;
const LOCK_RETRY_MS = 50;
/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 5000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One try at the lock: its release when taken, 'held' when someone else has it, 'failed' when it cannot be made at all.
 * The lock holds a token only its taker knows, and the release removes the file only while it still holds that token:
 * a holder that was stopped for longer than `LOCK_STALE_MS` (a laptop asleep) finds its lock cleared and perhaps taken
 * again, and must not remove the new holder's.
 */
const tryLock = (path: string): (() => void) | 'held' | 'failed' => {
    const token = randomBytes(8).toString('hex');
    let fd: number;
    try {
        fd = openSync(path, 'wx', 0o600);
    } catch (err) {
        // err.code is how node names a failed open. Nothing was created, so nothing here is ours to remove.
        return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'held' : 'failed';
    }
    try {
        writeSync(fd, token);
    } catch {
        try {
            unlinkSync(path); // created but not written (disk full): no later sender should wait on an empty lock
        } catch { /* gone already */ }
        return 'failed';
    } finally {
        closeSync(fd);
    }
    handBackToSudoUser(path);
    return () => {
        try {
            if (readFileSync(path, 'utf-8') === token) unlinkSync(path);
        } catch { /* gone already: nothing is held */ }
    };
};

/**
 * The lock file's own age says whether anyone is still behind it. A stale one is moved aside under a name of its own
 * and only then checked and removed: a plain unlink by path could remove a lock another waiter had just made. If what
 * was moved is not the file that was seen, it was a live lock; it goes back unless yet another has been made since.
 */
const removeIfStale = (path: string): void => {
    try {
        const seen = statSync(path);
        if (Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return;
        const aside = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
        renameSync(path, aside);
        try {
            const moved = statSync(aside);
            if (moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs) {
                try {
                    linkSync(aside, path);
                } catch { /* someone made a lock since: theirs stands */ }
            }
        } finally {
            unlinkSync(aside);
        }
    } catch { /* taken, or removed, by someone else in between */ }
};

/** The last number handed out: 0 when there is no file or it holds no number, null when it cannot be read or is out of range. */
const readLast = (path: string): number | null => {
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; // err.code is how node names a missing file
    }
    const line = text.trim();
    if (!/^\d+$/.test(line)) return 0;
    const last = Number(line);
    return Number.isSafeInteger(last) ? last : null;
};

/** Read, add, write: runs with the lock held, and without a pause, so callers in one process never overlap. */
const draw = (dir: string, now: () => number): number | { refused: CommandSeqRefusal } => {
    const path = join(dir, FILE);
    const last = readLast(path);
    if (last === null) return { refused: 'io' };
    const n = Math.max(last + 1, Math.floor(now()));
    if (!Number.isSafeInteger(n)) return { refused: 'io' };
    // Random name, exclusive create, then rename: a reader never sees half a line.
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, `${n}\n`, { mode: 0o600, flag: 'wx' });
        handBackToSudoUser(temp);
        renameSync(temp, path);
    } catch {
        try {
            unlinkSync(temp);
        } catch { /* never made */ }
        return { refused: 'io' };
    }
    return n;
};

export const nextCommandNumber = async (deps: CommandSeqDeps = {}): Promise<number | { refused: CommandSeqRefusal }> => {
    const dir = deps.dir ?? join(homedir(), '.hwip');
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    try {
        mkdirHandedBack(dir, 0o700);
    } catch {
        return { refused: 'io' };
    }
    const lock = join(dir, LOCK);
    for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
        const taken = tryLock(lock);
        if (taken === 'failed') return { refused: 'io' };
        if (typeof taken === 'function') {
            try {
                return draw(dir, now);
            } finally {
                taken();
            }
        }
        removeIfStale(lock);
        await sleep(LOCK_RETRY_MS);
    }
    return { refused: 'lock' };
};
