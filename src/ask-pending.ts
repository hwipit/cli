/**
 * The questions `hwip ask` has on the phone, kept so that one cut short can be taken up again.
 *
 * `hwip ask` blocks, and what runs it does not always wait: an agent's tool call times out, a shell is
 * closed. The question stays on the phone and the answer stays on the server, with nobody left to read
 * it — and asking again puts a second card next to the first. So each question that went up leaves a
 * record here, and the same command run again from the same place finds it and waits on that question
 * instead of sending another.
 *
 * A record holds where the answer is read and what opens it, and nothing of the wording — not the
 * buttons' ids either, which a bare `--actions` makes of their labels: the question is matched by a hash. Its file is named for the process that waits on it, so whose it is never has to be
 * read out of it. It is taken up only once that process has died — two that run side by side each ask
 * their own — and by one process only: taking is a rename to the taker's own name, which one of them
 * wins. A record is under some process's name at every moment, and no name is used twice.
 *
 * All of it is best effort. State that cannot be read or written costs the taking up, never the ask.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir, handBackToSudoUser } from './private-files.js';

/** What makes two asks the same question: the same words, asked from the same place. */
export interface AskedQuestion {
    hookId: string;
    agentDeviceId?: string;
    agentSessionName?: string;
    title: string;
    body?: string;
    actions?: { id: string; label: string }[];
    acceptsExit?: boolean;
}

/** A question on the phone: where its answer is read, what opens it, and when its window ends (ms). */
export interface PendingAsk {
    eventId: string;
    askId: string;
    deadline: number;
}

/** One question's place in the store. */
export interface PendingSlot {
    /** The question as an earlier run left it, now this process's to wait on; null when there is none to take. */
    claim(): PendingAsk | null;
    /** Keep the question this process has just put up. */
    record(ask: PendingAsk): void;
    /** The question is over: forget it. False when a record of it is still there, to be read by the next run. */
    settle(): boolean;
}

export interface PendingAsks {
    of(question: AskedQuestion): PendingSlot;
}

export interface PendingDeps {
    now: () => number;
    pid: number;
    alive: (pid: number) => boolean;
    /** Part of the match: machines that share a home folder do not share a process table. */
    host: string;
    cwd: () => string;
}

/** The first hex digits of the match that name the file: 128 bits. */
const NAME_HEX = 32;
const NONCE_HEX = 8;
const PREFIX = 'ask-pending-';
/** A record's file: the question, the pid that waits on it, and a nonce that keeps a pid used again from meeting an old name. */
const RECORD = new RegExp(`^${PREFIX}([0-9a-f]{${NAME_HEX}})\\.([1-9][0-9]*)\\.[0-9a-f]{${NONCE_HEX}}$`);
/** A file of ours that is not a record — one half written — this old belongs to a process that died at it. */
const LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000;
/** The shape of an id as it goes into a URL path and a seal: the server's event ids (`hevt_` + ULID) and ours (base64url). */
export const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface Stored extends PendingAsk {
    v: 1;
    match: string;
    hookId: string;
}

export const matchKey = (question: AskedQuestion, where: { host: string; cwd: string }): string =>
    createHash('sha256')
        .update(JSON.stringify([
            where.host,
            question.hookId,
            question.agentDeviceId ?? null,
            question.agentSessionName ?? null,
            where.cwd,
            question.title,
            question.body ?? null,
            (question.actions ?? []).map(({ id, label }) => [id, label]),
            question.acceptsExit === true,
        ]))
        .digest('hex');

/** The failure of a file that is not there. */
const isMissing = (err: unknown): err is NodeJS.ErrnoException => err instanceof Error && 'code' in err && err.code === 'ENOENT';

/** Signal 0 reaches nothing and fails for a pid that is not there (ESRCH). Any other failure — EPERM, another user's process — is of one that is. */
const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !(err instanceof Error && 'code' in err && err.code === 'ESRCH');
    }
};

/** A file is read as a record only when every field is what this module writes: the file is the user's own, and may have been touched. */
const isStored = (value: unknown): value is Stored =>
    typeof value === 'object' && value !== null
    && 'v' in value && value.v === 1
    && 'match' in value && typeof value.match === 'string'
    && 'hookId' in value && typeof value.hookId === 'string'
    && 'eventId' in value && typeof value.eventId === 'string' && ID.test(value.eventId)
    && 'askId' in value && typeof value.askId === 'string' && ID.test(value.askId)
    && 'deadline' in value && Number.isSafeInteger(value.deadline) && Number(value.deadline) > 0;

/**
 * The record at `path`: `undefined` when there is no file, `null` when what is there is not a record.
 * Throws when the file is there and cannot be read: that may pass, and is no reason to drop it.
 */
const read = (path: string): Stored | null | undefined => {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
    }
    try {
        const value: unknown = JSON.parse(raw);
        return isStored(value) ? value : null;
    } catch {
        return null;
    }
};

const remove = (path: string): void => {
    try {
        unlinkSync(path);
    } catch { /* gone already, or not ours to remove */ }
};

/** The slot of a question that cannot be placed: nothing is kept, and nothing taken up. */
const NO_SLOT: PendingSlot = { claim: () => null, record: () => undefined, settle: () => true };

export const pendingAsks = (dir: string, over: Partial<PendingDeps> = {}): PendingAsks => {
    const deps: PendingDeps = { now: Date.now, pid: process.pid, alive: processAlive, host: hostname(), cwd: () => process.cwd(), ...over };

    /** Records past their deadline or not records at all, and leftovers of processes that died mid-write. */
    const sweep = (names: string[]): void => {
        const now = deps.now();
        for (const name of names) {
            if (!name.startsWith(PREFIX)) continue;
            const path = join(dir, name);
            // Each file on its own: one that another process removes meanwhile, or that cannot be read, is passed over.
            try {
                if (!RECORD.test(name)) {
                    if (now - statSync(path).mtimeMs > LEFTOVER_MAX_AGE_MS) remove(path);
                    continue;
                }
                const kept = read(path);
                if (kept === null || (kept && kept.deadline <= now)) remove(path);
            } catch { /* left for the next sweep */ }
        }
    };

    return {
        of: (question) => {
            let match: string;
            try {
                // The directory this runs in may be gone (a removed worktree): `process.cwd()` throws then.
                match = matchKey(question, { host: deps.host, cwd: deps.cwd() });
            } catch {
                return NO_SLOT;
            }
            const tag = match.slice(0, NAME_HEX);
            /** The pid a file of this question is kept under; `undefined` for any other file. */
            const ownerOf = (name: string): number | undefined => {
                const parts = RECORD.exec(name);
                return parts && parts[1] === tag ? Number(parts[2]) : undefined;
            };
            const ownPath = (): string => join(dir, `${PREFIX}${tag}.${deps.pid}.${randomUUID().slice(0, NONCE_HEX)}`);

            return {
                claim: () => {
                    try {
                        const names = readdirSync(dir);
                        sweep(names);
                        // One listing for both: a record the sweep removed reads as not there.
                        for (const name of names) {
                            const owner = ownerOf(name);
                            // Not this question, or one a process is still waiting on. A record under this process's
                            // own pid is from before it asked anything: the pid has been used again.
                            if (owner === undefined || (owner !== deps.pid && deps.alive(owner))) continue;
                            const path = join(dir, name);
                            try {
                                const kept = read(path);
                                if (kept === undefined) continue;
                                if (kept === null || kept.match !== match || kept.hookId !== question.hookId) {
                                    remove(path);
                                    continue;
                                }
                                if (kept.deadline <= deps.now()) continue;
                                // Taken by one process only: the rename fails for every other that tries, and for
                                // this one when the record has been taken — or settled — since the look. What it
                                // moves is what was read: a name is written once and never used again.
                                renameSync(path, ownPath());
                                return { eventId: kept.eventId, askId: kept.askId, deadline: kept.deadline };
                            } catch { /* another's by now, or unreadable: the next one */ }
                        }
                        return null;
                    } catch {
                        return null;
                    }
                },
                record: (ask) => {
                    const path = ownPath();
                    const tmp = `${path}.tmp-${randomUUID()}`;
                    try {
                        // The names say which questions are open and for which processes: nobody else's to list.
                        ensurePrivateDir(dir);
                        // Written whole under another name, then moved into place: a reader never sees half of one.
                        writeFileSync(tmp, JSON.stringify({ v: 1, match, hookId: question.hookId, ...ask } satisfies Stored), { mode: 0o600, flag: 'wx' });
                        handBackToSudoUser(tmp);
                        renameSync(tmp, path);
                    } catch {
                        // The folder cannot be written: this question is not taken up again.
                        remove(tmp);
                    }
                },
                settle: () => {
                    let names: string[];
                    try {
                        names = readdirSync(dir);
                    } catch {
                        // Nothing can be listed, so nothing is there for the next run to take either.
                        return true;
                    }
                    let gone = true;
                    // By name, not by what the file says: a record that cannot be read is ended all the same.
                    for (const name of names) {
                        if (ownerOf(name) !== deps.pid) continue;
                        try {
                            unlinkSync(join(dir, name));
                        } catch (err) {
                            if (!isMissing(err)) gone = false;
                        }
                    }
                    return gone;
                },
            };
        },
    };
};
