/**
 * Always-on conversation recorder (I28, hwip `docs/session-history.md` §3).
 *
 * `turn-watch.ts` follows a transcript for a viewer who is looking. This reads
 * the transcript of every agent session this listener knows, with nobody
 * looking, and uploads what was said to the account so the phone can show the
 * conversation later: the same projection (`TranscriptSource.project`), the
 * same privacy line (a tool is a name, a label and counts — never its
 * arguments or output), a different lifetime. The live watcher and its ring are
 * left alone.
 *
 * What is uploaded, and how it stays correct:
 *
 * - A chunk is a page of projected events, at most 12 KB of plaintext, sealed
 *   with push envelope v1 for the account's pinned devices plus this machine
 *   (the relay is not a recipient; there is no plaintext upload at all). The
 *   sealed body carries `{sessionKey, seq, events}` so the reader can check the
 *   chunk is the one it asked for.
 * - `seq` is per session and only goes up. It starts from the clock when a
 *   session has no state (the server allows gaps), so a wiped state directory
 *   cannot collide with chunks the server already holds.
 * - Reading and uploading are decoupled by an outbox on disk. A read becomes
 *   chunks, and the chunks, the new byte offset and `seq` are written in one
 *   atomic replace; only then is anything uploaded, and an upload retries the
 *   stored bytes. A crash therefore loses nothing and, because a retry sends
 *   the same bytes under the same `seq`, duplicates nothing (the server answers
 *   a repeated chunk 200).
 * - The offset is the end of the last complete line that went out (inside a line
 *   too long to read, where that line began), so the state file holds numbers and
 *   ciphertext, never conversation text. It also names the agent kind, so a
 *   session that is gone after a restart is still read to the end of its transcript.
 * - A transcript that is not a file (opencode's SQLite store) is read by its
 *   agent's own `TranscriptReader`, and where it was read to is that reader's
 *   cursor, kept in the state file beside the offset. The cursor is the reader's
 *   to keep free of conversation text (opencode's holds row numbers and keys).
 *
 * Flush rules: events wait for 2 s of quiet, or 12 KB, or a prompt in the read
 * (a person typed — that goes out now). A transcript that changes name
 * (`/clear`, compaction, resume) keeps the session's key; events not newer than
 * the last one sent are dropped on every read of a new file until the first
 * newer one, because a new file may start with a copy of the old history.
 *
 * Every dependency that touches the world is injected, so tests run real ticks
 * on a temporary directory with a fake clock and no network.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    readTranscriptDelta,
    type TailState,
    type TranscriptProjector,
    type TranscriptReader,
    type TurnEvent,
} from './transcript-tail.js';
import type { TodoList } from './todo-fold.js';
import { pagesOf } from './turn-watch.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

/** Poll cadence for every observed session; an idle transcript costs one `stat`. */
export const RECORDER_TICK_MS = 1_000;
/** Quiet time after the last append before pending events go out. */
export const RECORDER_QUIET_MS = 2_000;
/** Plaintext bytes that flush on their own (the live frame's budget, `MAX_TURN_FRAME_BYTES`). */
export const RECORDER_FLUSH_BYTES = 12 * 1024;
/** First run on a session: only the last this-many events of the transcript. */
export const RECORDER_BACKFILL_EVENTS = 400;
/** Chunks waiting to upload, per session; past it nothing more is read until some go out. */
export const RECORDER_OUTBOX_MAX = 20;
/** Recipient slots on one chunk: the server's `deviceKeyMap` limit. */
export const RECORDER_MAX_RECIPIENTS = 50;
/** Retry backoff for a failing upload: doubles from the base up to the cap. */
export const RECORDER_BACKOFF_BASE_MS = 2_000;
export const RECORDER_BACKOFF_MAX_MS = 5 * 60_000;
/** How long a session is left alone after the server refused it (a daily cap, a bad key). */
export const RECORDER_PAUSE_MS = 60 * 60_000;
/** A reader's transcript a session has left is over once it has read as nothing new this long: a reader
 *  answers nothing also when it did not look (opencode asks its store at most once a second, and not
 *  again at once after a failed query), so one empty read says nothing. */
export const RECORDER_READER_SETTLE_MS = 3_000;
/** A session no longer in the inventory is followed this long, so its last words still go out. */
export const RECORDER_LINGER_MS = 60_000;
/** State files untouched this long, with nothing waiting, are deleted at start. */
export const RECORDER_STATE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Read-but-unsealed events held in memory; past this a read waits (the transcript keeps them). */
export const RECORDER_PENDING_MAX_BYTES = 256 * 1024;
/** How long a tick waits to learn who a chunk is sealed for; past it nothing is read this round. */
export const RECORDER_RECIPIENTS_TIMEOUT_MS = 10_000;
/** `seq` of a session with no state: seconds since the epoch × this (the server takes up to 10^12 - 1). */
export const RECORDER_SEQ_PER_SECOND = 100;

export interface RecordableSession {
    /** The transcript this session writes right now. */
    path: string;
    /** `RegisteredRemoteAgent.kind` — which projector reads it. */
    kind: string;
}

/** A pinned device's key, or this machine's own. */
export interface RecorderRecipient {
    deviceId: string;
    publicKey: string;
}

/** The push-v1 envelope of one chunk, as the server stores it. */
export interface SealedChunk {
    body: string;
    deviceKeyMap: Record<string, string>;
    senderPublicKey: string;
}

export interface OutboxChunk {
    seq: number;
    firstAt: string;
    lastAt: string;
    sealed: SealedChunk;
}

export type UploadOutcome =
    /** Stored (201) or already stored (200). */
    | { kind: 'ok' }
    /** Try again later: network, 5xx, per-minute rate limit. */
    | { kind: 'retry'; afterMs?: number; why: string }
    /** The server will not take this now (daily cap, wrong key or device): leave the session alone for a while. */
    | { kind: 'pause'; untilMs?: number; why: string; giveUpAfter?: number }
    /** The server will never take these bytes (a bad body, a `seq` already holding another): drop the chunk, or it blocks the session for good. */
    | { kind: 'drop'; why: string; conflict?: boolean };

export interface TurnRecorderDeps {
    /** Where per-session state lives (`<stateDir>/turn-recorder`). */
    dir: string;
    deviceId: () => string;
    /** The projector for an agent kind, or null when its transcript is not one this can read. */
    projectorFor: (kind: string) => TranscriptProjector | null;
    /** How an agent kind's transcript is read when it is not an append-only file (`TranscriptSource.read`); null reads the file. */
    readerFor?: (kind: string) => TranscriptReader | null;
    /** Who a chunk is sealed for. Empty = nobody could read it, so nothing is read or sent. Never rejects. */
    recipients: () => Promise<RecorderRecipient[]>;
    /** Seal one plaintext body for those recipients. Rejecting leaves everything as it was. */
    seal: (plaintext: string, recipients: RecorderRecipient[]) => Promise<SealedChunk>;
    upload: (sessionKey: string, chunk: OutboxChunk) => Promise<UploadOutcome>;
    /** False until this machine's device key is on its device record: the server takes a chunk only
     *  when it is sealed with that key. Chunks are still read and sealed meanwhile; they wait. */
    uploadReady?: () => boolean;
    /** This machine's current device public key. A stored chunk sealed with another one (the
     *  key file was lost and made anew) can never be accepted — the server wants the key on
     *  the device record — so it is dropped rather than refused for ever. */
    devicePublicKey?: () => string | null;
    /** The newest `seq` the server holds for a session, or null when it cannot be read. After a 409
     *  (the same `seq` under another body) the next chunk is numbered past it. */
    latestSeq?: (sessionKey: string) => Promise<number | null>;
    log: (message: string) => void;
    now?: () => number;
}

interface SessionState {
    v: 1;
    sessionKey: string;
    /** The transcript the offset belongs to. */
    path: string;
    /** The agent kind that wrote it, so a session that is gone after a restart can still be read to its end. */
    kind?: string;
    ino: number;
    /** End of the last complete line whose events are in a chunk. */
    offset: number;
    /** Where the agent's own reader had read to when the chunks were made (`TailState.cursor`); only a reader's transcript has one. */
    cursor?: unknown;
    /** The last `seq` handed out. */
    seq: number;
    /** Newest event time sent so far. */
    lastAt?: string;
    outbox: OutboxChunk[];
}

interface Live {
    name: string;
    sessionKey: string;
    source: RecordableSession;
    lastSeenAt: number;
    state: SessionState | null;
    stateLoaded: boolean;
    tail: TailState | null;
    /** The file `tail` and `pending` were read from. */
    tailPath: string | null;
    /** Nothing at or before this is new: set when a file may open with a copy of what was already
     *  sent, kept on every read until the first newer event shows the copy has ended. */
    dedupeAfter?: string;
    /** When the session was first seen on a reader's transcript it has left (`RECORDER_READER_SETTLE_MS`). */
    leftSince?: number;
    /** Files whose end this session has already caught up to and left. */
    finished: Set<string>;
    /** How many times in a row the server has refused the head chunk, for the ones it may refuse for ever. */
    refusals: { seq: number; count: number } | null;
    /** Chunks this session has had stored today (UTC), for the log. */
    today: { day: string; count: number };
    pending: TurnEvent[];
    pendingBytes: number;
    hasPrompt: boolean;
    lastGrowthAt: number;
    /** The first read of a file this session has not recorded before starts from the file's beginning (`dedupeAfter` drops what was sent). */
    newFile: boolean;
    busy: boolean;
    attempts: number;
    nextAttemptAt: number;
    pausedUntil: number;
    sealWarned: boolean;
    /**
     * The agent's to-do list as of the last read, whole — the projector folds the next read onto it.
     * Memory only: the state file holds ciphertext and numbers, and the list is the agent's words.
     * After a restart the first list comes with the next task change.
     */
    todo?: TodoList;
}

const stateFileOf = (dir: string, sessionKey: string): string =>
    join(dir, `${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}.json`);

const isOutboxChunk = (c: unknown): c is OutboxChunk => {
    if (!c || typeof c !== 'object') return false;
    const o = c as Record<string, unknown>;
    const s = o.sealed as Record<string, unknown> | undefined;
    return (
        Number.isSafeInteger(o.seq) && typeof o.firstAt === 'string' && typeof o.lastAt === 'string' &&
        !!s && typeof s.body === 'string' && typeof s.senderPublicKey === 'string' &&
        !!s.deviceKeyMap && typeof s.deviceKeyMap === 'object'
    );
};

/** What is on disk, or null when it is missing or not ours (a bad file is a fresh start, never a crash). */
export const readSessionState = (dir: string, sessionKey: string): SessionState | null => {
    try {
        const raw = JSON.parse(readFileSync(stateFileOf(dir, sessionKey), 'utf-8')) as Record<string, unknown>;
        if (raw.v !== 1 || raw.sessionKey !== sessionKey) return null;
        if (typeof raw.path !== 'string' || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.seq)) return null;
        const outbox = Array.isArray(raw.outbox) ? raw.outbox.filter(isOutboxChunk) : [];
        return {
            v: 1,
            sessionKey,
            path: raw.path,
            ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
            ino: typeof raw.ino === 'number' ? raw.ino : 0,
            offset: raw.offset as number,
            ...(raw.cursor !== undefined ? { cursor: raw.cursor } : {}),
            seq: raw.seq as number,
            ...(typeof raw.lastAt === 'string' ? { lastAt: raw.lastAt } : {}),
            outbox,
        };
    } catch {
        return null;
    }
};

/** One atomic replace: a reader (or the next run) sees the old state or the new one, never half. */
const writeSessionState = (dir: string, state: SessionState): void => {
    mkdirHandedBack(dir, 0o700);
    chmodSync(dir, 0o700);
    const file = stateFileOf(dir, state.sessionKey);
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    handBackToSudoUser(tmp);
    renameSync(tmp, file);
};

/**
 * Delete state files nothing has touched for a long while, nothing is waiting in, and whose
 * transcript is gone. A session that is quiet but alive keeps its state: without it the next
 * read takes the last 400 events of the transcript again and uploads them under new `seq`s.
 */
export const sweepRecorderState = (dir: string, now: number = Date.now()): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
        const file = join(dir, name);
        try {
            if (name.endsWith('.tmp')) {
                if (now - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
                continue;
            }
            if (now - statSync(file).mtimeMs <= RECORDER_STATE_TTL_MS) continue;
            const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { outbox?: unknown[]; path?: unknown };
            if (parsed.outbox?.length) continue;
            if (typeof parsed.path === 'string' && existsSync(parsed.path)) continue;
            rmSync(file, { force: true });
        } catch { /* unreadable: leave it */ }
    }
};

const TIMED_OUT = Symbol('timed out');

/** `promise`'s value, `TIMED_OUT` when it has not settled in `ms`, and `undefined` when it rejects. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT | undefined> =>
    new Promise((resolve) => {
        const timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(undefined); },
        );
    });

const eventAt = (events: readonly TurnEvent[], pick: 'first' | 'last', fallback: string): string => {
    const stamps = events.map((e) => e.at).filter((a): a is string => typeof a === 'string').sort();
    return (pick === 'first' ? stamps[0] : stamps[stamps.length - 1]) ?? fallback;
};

const eventBytes = (event: TurnEvent): number => Buffer.byteLength(JSON.stringify(event), 'utf-8') + 1;

export const createTurnRecorder = (deps: TurnRecorderDeps) => {
    const now = deps.now ?? Date.now;
    const sessions = new Map<string, Live>();
    let timer: NodeJS.Timeout | undefined;
    let noRecipientsLogged = false;
    let notReadyLogged = false;
    let projectorWarned = false;

    const sessionKeyOf = (name: string): string => `${deps.deviceId()}:${name}`;

    const loadState = (live: Live): void => {
        if (live.stateLoaded) return;
        live.stateLoaded = true;
        live.state = readSessionState(deps.dir, live.sessionKey);
    };

    const persist = (live: Live, state: SessionState): boolean => {
        try {
            writeSessionState(deps.dir, state);
            live.state = state;
            return true;
        } catch (err) {
            deps.log(`⧉ turn-recorder ${live.name}: could not write state (${err instanceof Error ? err.message : err}) — keeping the events in memory`);
            return false;
        }
    };

    const statIno = (path: string): number => {
        try { return statSync(path).ino; } catch { return 0; } // unreadable: the first read says so
    };

    /** The kind that wrote `path`: the file a session has left was written by the kind its state names,
     *  which is not always the kind of the file it writes now. */
    const kindOf = (live: Live, path: string | null): string =>
        path !== live.source.path ? live.state?.kind ?? live.source.kind : live.source.kind;

    const readerOf = (live: Live, path: string | null): TranscriptReader | null => deps.readerFor?.(kindOf(live, path)) ?? null;

    const startTail = (live: Live): void => {
        const state = live.state;
        const target = live.source.path;
        // The transcript changed name while this was not following (the listener was down):
        // what the old file gained since the last chunk is read first, so it is not lost.
        // A reader's path names no file; a session gone from its store reads as nothing, which ends it.
        const finishOld = !!state && state.path !== target && !live.finished.has(state.path)
            && (!!readerOf(live, state.path) || existsSync(state.path));
        const path = finishOld ? state.path : target;
        // Another file is another session file: its list is folded from what it says.
        if (live.tailPath && live.tailPath !== path) live.todo = undefined;
        live.tailPath = path;
        // The same name can be another file (replaced, restored): its offset means nothing.
        // A reader's path is no file, and its cursor says for itself whether it still fits what it reads.
        if (state && state.path === path && (!!readerOf(live, path) || state.ino === statIno(path))) {
            // Resume where the last chunk ended. `size`/`mtimeMs` of 0 make the
            // first read look at the file whatever it holds.
            live.tail = {
                offset: state.offset, size: 0, mtimeMs: 0, ino: state.ino, carry: '', carryBytes: 0, resyncing: false, salvage: [],
                ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
            };
            live.newFile = false;
        } else {
            live.tail = null;
            live.newFile = true;
            // A file this session has not been recorded from may open with a copy of the history already sent.
            live.dedupeAfter = state?.lastAt;
        }
    };

    /** Turn what was read into chunks, seal them, and write them to the outbox together with the new offset. */
    const flush = async (live: Live, recipients: RecorderRecipient[]): Promise<void> => {
        if (!live.pending.length || !live.tail || !live.tailPath) return;
        // Inside a line too long to read the offset is the middle of it, and a restart would parse its
        // tail as a record: resume from where that line began instead. The events read before it still go.
        const committed = live.tail.resyncing
            ? live.tail.resyncFrom
            : live.tail.offset - (live.tail.carryBytes ?? Buffer.byteLength(live.tail.carry, 'utf-8'));
        if (committed === undefined) return;
        const pages = pagesOf(live.pending);
        const base = live.state ?? {
            v: 1 as const,
            sessionKey: live.sessionKey,
            path: live.tailPath,
            ino: live.tail.ino,
            offset: 0,
            seq: Math.floor(now() / 1000) * RECORDER_SEQ_PER_SECOND,
            outbox: [],
        };
        const fallbackAt = new Date(now()).toISOString();
        const chunks: OutboxChunk[] = [];
        let seq = base.seq;
        try {
            for (const page of pages) {
                seq += 1;
                const firstAt = eventAt(page, 'first', fallbackAt);
                const lastAt = eventAt(page, 'last', fallbackAt);
                const sealed = await deps.seal(JSON.stringify({ sessionKey: live.sessionKey, seq, events: page }), recipients);
                chunks.push({ seq, firstAt, lastAt, sealed });
            }
        } catch (err) {
            if (!live.sealWarned) {
                live.sealWarned = true;
                deps.log(`⧉ turn-recorder ${live.name}: could not seal (${err instanceof Error ? err.message : err}) — will retry`);
            }
            return;
        }
        live.sealWarned = false;
        // From the events' own stamps: a chunk with none is stamped with the clock, which says nothing about the file.
        const newestAt = live.pending.map((e) => e.at).filter((a): a is string => typeof a === 'string').sort().pop();
        const next: SessionState = {
            ...base,
            path: live.tailPath,
            kind: kindOf(live, live.tailPath),
            ino: live.tail.ino,
            offset: committed,
            cursor: live.tail.cursor,
            seq,
            ...(newestAt && (!base.lastAt || newestAt > base.lastAt) ? { lastAt: newestAt } : base.lastAt ? { lastAt: base.lastAt } : {}),
            outbox: [...base.outbox, ...chunks],
        };
        if (!persist(live, next)) return;
        live.pending = [];
        live.pendingBytes = 0;
        live.hasPrompt = false;
    };

    /** The newest event time already sent or waiting: nothing at or before it is new. */
    const newestSeen = (live: Live): string | undefined => {
        let newest = live.state?.lastAt;
        for (const e of live.pending) if (e.at && (!newest || e.at > newest)) newest = e.at;
        return newest;
    };

    /** One read of `live.tailPath` into `pending`. False when there was nothing to read. */
    const readInto = (live: Live, project: TranscriptProjector): boolean => {
        const path = live.tailPath;
        if (!path) return false;
        const before = live.tail;
        const firstOfFile = live.newFile;
        const reader = readerOf(live, path);
        // A file this session has sent from is read from its start whenever its offset means nothing
        // (a new first read, a replaced file, a truncated one): `dedupeAfter` drops what was sent. A window off
        // the end would lose the head of a replacement longer than the window.
        const read = reader ? reader(path, before) : readTranscriptDelta(path, before, { fromStart: !!live.state });
        if (!read) return false;
        // A new inode or a shorter file restarts the read from a window: what that window
        // holds may already have been read. A reader's offset and size are not bytes, and it keeps its own place.
        const restarted = !reader && !!before && (read.state.ino !== before.ino || read.state.size < before.offset);
        // Set before anything can return: a restart that yields bytes but no complete line (a file truncated in
        // place, its history then written again) still has to drop that history when it comes.
        if (restarted) live.dedupeAfter = newestSeen(live);
        live.tail = read.state;
        live.newFile = false;
        // Nothing came of it — the file ends inside a multi-byte character, or only its mtime moved:
        // that is no growth and no reason to read again at once, or the quiet flush never comes.
        if (!read.bytesRead && !read.lines.length) return false;
        live.lastGrowthAt = now();
        if (!read.lines.length) return true;
        let events: TurnEvent[] = [];
        try {
            events = project(read.lines, { includeSidechain: false, todo: live.todo, onTodo: (list) => (live.todo = list) });
        } catch (err) {
            // A line this version cannot read costs that read, never the recorder.
            if (!projectorWarned) {
                projectorWarned = true;
                deps.log(`⧉ turn-recorder ${live.name}: could not read part of the transcript (${err instanceof Error ? err.message : err})`);
            }
        }
        const after = live.dedupeAfter;
        if (after) {
            // Up to the first event newer than the last one sent it is a copy — an event with no time
            // (a salvaged oversized tool result) is part of the copy too.
            let fresh = false;
            events = events.filter((e) => {
                if (!fresh && e.at && e.at > after) fresh = true;
                return fresh;
            });
            if (fresh) live.dedupeAfter = undefined;
        }
        if (firstOfFile && !live.state) events = events.slice(-RECORDER_BACKFILL_EVENTS);
        for (const event of events) {
            live.pending.push(event);
            live.pendingBytes += eventBytes(event);
            if (event.kind === 'prompt') live.hasPrompt = true;
        }
        return true;
    };

    /** Read what the transcript gained, and flush when a rule says so. */
    const produce = async (live: Live, recipients: RecorderRecipient[]): Promise<void> => {
        if ((live.state?.outbox.length ?? 0) >= RECORDER_OUTBOX_MAX) return;
        const target = live.source.path;

        // Up to a few reads per tick, so a long old file is caught up in a few ticks, not one.
        for (let reads = 0; reads < 8; reads++) {
            if (!live.tail) startTail(live);
            const project = deps.projectorFor(kindOf(live, live.tailPath));
            if (!project) return;
            if (live.pendingBytes >= RECORDER_PENDING_MAX_BYTES) break;
            const more = readInto(live, project);
            if (live.tailPath === target) {
                live.leftSince = undefined;
                break;
            }
            // Still on a file the session has left. Once it is read to its end, what it held goes
            // out against its own offset, and the session moves on to the file it writes now.
            if (more) continue;
            if (readerOf(live, live.tailPath)) {
                live.leftSince ??= now();
                if (now() - Math.max(live.leftSince, live.lastGrowthAt) < RECORDER_READER_SETTLE_MS) break;
            }
            // A line left unfinished at the end of a file that is no longer written is that file's end.
            if (live.tail?.resyncing) live.tail = { ...live.tail, resyncing: false, resyncFrom: undefined, carry: '', carryBytes: 0, salvage: [] };
            await flush(live, recipients);
            if (live.pending.length) return;
            live.finished.add(live.tailPath as string);
            live.tail = null;
            live.leftSince = undefined;
        }
        if (!live.pending.length) return;
        const quiet = now() - live.lastGrowthAt >= RECORDER_QUIET_MS;
        if (live.hasPrompt || live.pendingBytes >= RECORDER_FLUSH_BYTES || quiet) await flush(live, recipients);
    };

    /** The head chunk is done with (sent, or never to be taken): forget it in the state file. False when that could not be written. */
    const removeHead = (live: Live, state: SessionState): boolean => {
        live.attempts = 0;
        live.nextAttemptAt = 0;
        live.refusals = null;
        if (persist(live, { ...state, outbox: state.outbox.slice(1) })) return true;
        // Not recorded: do not try the next one in a tight loop.
        live.nextAttemptAt = now() + RECORDER_BACKOFF_BASE_MS;
        return false;
    };

    /** After a 409 the numbering is out of step with the server: the next chunk goes after what it holds. */
    const moveSeqPast = async (live: Live): Promise<void> => {
        const state = live.state;
        if (!state) return;
        let latest: number | null = null;
        try {
            latest = (await deps.latestSeq?.(live.sessionKey)) ?? null;
        } catch { /* the clock below */ }
        // Without an answer the clock steps over it: a state lost and rebuilt restarts there anyway.
        const past = latest ?? Math.floor(now() / 1000) * RECORDER_SEQ_PER_SECOND + RECORDER_SEQ_PER_SECOND;
        if (past > state.seq) persist(live, { ...state, seq: past });
    };

    /** Upload from the front of the outbox until it is empty, a retry is due, or the server says stop. */
    const drain = async (live: Live): Promise<void> => {
        for (;;) {
            const state = live.state;
            const head = state?.outbox[0];
            if (!state || !head) return;
            if (now() < live.pausedUntil || now() < live.nextAttemptAt) return;
            if (deps.uploadReady && !deps.uploadReady()) {
                if (!notReadyLogged) {
                    notReadyLogged = true;
                    deps.log('⧉ turn-recorder: this machine\'s device key is not registered yet — chunks wait until it is');
                }
                return;
            }
            notReadyLogged = false;
            const key = deps.devicePublicKey?.();
            if (key && head.sealed.senderPublicKey !== key) {
                deps.log(`⧉ turn-recorder ${live.name}: dropped chunk ${head.seq} — it was sealed with a device key this machine no longer has`);
                if (!removeHead(live, state)) return;
                continue;
            }
            let outcome: UploadOutcome;
            try {
                outcome = await deps.upload(live.sessionKey, head);
            } catch (err) {
                outcome = { kind: 'retry', why: err instanceof Error ? err.message : String(err) };
            }
            if (outcome.kind === 'ok') {
                if (!removeHead(live, state)) return;
                const day = new Date(now()).toISOString().slice(0, 10);
                if (live.today.day !== day) live.today = { day, count: 0 };
                live.today.count += 1;
                if (live.today.count % 100 === 0) deps.log(`⧉ turn-recorder ${live.name}: ${live.today.count} chunks sent today (UTC)`);
                continue;
            }
            if (outcome.kind === 'drop') {
                deps.log(`⧉ turn-recorder ${live.name}: dropped chunk ${head.seq} — the server will not take it (${outcome.why})`);
                if (!removeHead(live, state)) return;
                if (outcome.conflict) await moveSeqPast(live);
                continue;
            }
            if (outcome.kind === 'pause') {
                // Only a refusal that may be for ever counts, and only back to back.
                const count = outcome.giveUpAfter ? (live.refusals?.seq === head.seq ? live.refusals.count + 1 : 1) : 0;
                live.refusals = outcome.giveUpAfter ? { seq: head.seq, count } : null;
                if (outcome.giveUpAfter && count >= outcome.giveUpAfter) {
                    deps.log(`⧉ turn-recorder ${live.name}: dropped chunk ${head.seq} — the server refused it ${count} times (${outcome.why})`);
                    if (!removeHead(live, state)) return;
                    continue;
                }
                live.pausedUntil = outcome.untilMs ?? now() + RECORDER_PAUSE_MS;
                deps.log(`⧉ turn-recorder ${live.name}: the server refused chunk ${head.seq} (${outcome.why}) — paused ${Math.round((live.pausedUntil - now()) / 60_000)} min`);
                return;
            }
            live.refusals = null;
            live.attempts += 1;
            const wait = outcome.afterMs ?? Math.min(RECORDER_BACKOFF_BASE_MS * 2 ** (live.attempts - 1), RECORDER_BACKOFF_MAX_MS);
            live.nextAttemptAt = now() + wait;
            if (live.attempts === 1 || live.attempts % 10 === 0) {
                deps.log(`⧉ turn-recorder ${live.name}: upload of chunk ${head.seq} failed (${outcome.why}) — retry in ${Math.round(wait / 1000)}s`);
            }
            return;
        }
    };

    const step = async (live: Live, recipients: RecorderRecipient[]): Promise<void> => {
        if (live.busy) return;
        live.busy = true;
        try {
            loadState(live);
            await drain(live);
            if (now() < live.pausedUntil) return;
            // Nobody could open a chunk, so nothing is read: the transcript is the
            // record, and a device that pins later is sealed for from then on.
            if (!recipients.length) return;
            await produce(live, recipients);
            await drain(live);
        } catch (err) {
            deps.log(`⧉ turn-recorder ${live.name}: ${err instanceof Error ? err.message : err}`);
        } finally {
            live.busy = false;
        }
    };

    const newLive = (name: string, source: RecordableSession, at: number): Live => ({
        name,
        sessionKey: sessionKeyOf(name),
        source,
        lastSeenAt: at,
        state: null,
        stateLoaded: false,
        tail: null,
        tailPath: null,
        finished: new Set(),
        refusals: null,
        today: { day: '', count: 0 },
        pending: [],
        pendingBytes: 0,
        hasPrompt: false,
        lastGrowthAt: at,
        newFile: false,
        busy: false,
        attempts: 0,
        nextAttemptAt: 0,
        pausedUntil: 0,
        sealWarned: false,
    });

    /** The sessions to follow now: whatever the latest inventory sweep could resolve a transcript for. */
    const observe = (found: Readonly<Record<string, RecordableSession>>): void => {
        const at = now();
        for (const [name, source] of Object.entries(found)) {
            const existing = sessions.get(name);
            if (existing) {
                existing.source = source;
                existing.lastSeenAt = at;
                continue;
            }
            sessions.set(name, newLive(name, source, at));
        }
    };

    /**
     * Sessions of an earlier run that may hold more than what went out: the listener restarted (a reboot
     * ends every tmux session) and they are not in the inventory, so nothing would ever look at them
     * again. They are followed like any session — waiting chunks go out, what their transcript gained
     * since goes out too — and forgotten a minute after they are empty. Sessions with nothing
     * waiting are taken up as well: the follow resumes at the stored offset, so an unchanged
     * transcript costs one stat and no upload before the linger forgets it.
     */
    const adoptStored = (): void => {
        let names: string[];
        try { names = readdirSync(deps.dir); } catch { return; }
        const prefix = `${deps.deviceId()}:`;
        for (const file of names) {
            if (!file.endsWith('.json')) continue;
            let sessionKey: unknown;
            try { sessionKey = (JSON.parse(readFileSync(join(deps.dir, file), 'utf-8')) as { sessionKey?: unknown }).sessionKey; } catch { continue; }
            // Another machine's key (the device id changed) could not be uploaded against this record anyway.
            if (typeof sessionKey !== 'string' || !sessionKey.startsWith(prefix)) continue;
            const name = sessionKey.slice(prefix.length);
            if (!name || sessions.has(name)) continue;
            const state = readSessionState(deps.dir, sessionKey);
            if (!state) continue;
            sessions.set(name, newLive(name, { path: state.path, kind: state.kind ?? '' }, now()));
        }
    };

    /**
     * Who a chunk is sealed for. One lookup at a time, shared by every round that asks while it
     * is out: a lookup that hangs must not pile up a call a second, and gives up after a while.
     * Rounds themselves still overlap, since a session's own `busy` keeps its steps apart and one
     * slow upload must not hold the others.
     */
    let lookup: Promise<RecorderRecipient[] | typeof TIMED_OUT | undefined> | null = null;
    let lookupTimeoutLogged = false;
    const lookUpRecipients = (): Promise<RecorderRecipient[] | typeof TIMED_OUT | undefined> => {
        lookup ??= withTimeout(deps.recipients(), RECORDER_RECIPIENTS_TIMEOUT_MS).finally(() => { lookup = null; });
        return lookup;
    };

    /** One round over every followed session; sessions run side by side, one step at a time each. */
    const tick = async (): Promise<void> => {
        const at = now();
        for (const [name, live] of sessions) {
            const gone = at - live.lastSeenAt > RECORDER_LINGER_MS;
            if (gone && !live.busy && !live.pending.length && !(live.state?.outbox.length)) sessions.delete(name);
        }
        if (!sessions.size) return;
        let recipients: RecorderRecipient[] = [];
        try {
            const found = await lookUpRecipients();
            if (found === TIMED_OUT) {
                if (!lookupTimeoutLogged) {
                    lookupTimeoutLogged = true;
                    deps.log(`⧉ turn-recorder: could not learn who to seal for within ${RECORDER_RECIPIENTS_TIMEOUT_MS / 1000} s — nothing is read until it answers`);
                }
            } else {
                lookupTimeoutLogged = false;
                recipients = found ?? [];
            }
        } catch { /* none: nothing is read */ }
        if (!recipients.length && !noRecipientsLogged) {
            noRecipientsLogged = true;
            deps.log('⧉ turn-recorder: no device to seal the conversation for yet — waiting for the first one this machine trusts');
        }
        if (recipients.length) noRecipientsLogged = false;
        await Promise.all([...sessions.values()].map((live) => step(live, recipients)));
    };

    const start = (): void => {
        sweepRecorderState(deps.dir, now());
        adoptStored();
        if (timer) return;
        timer = setInterval(() => { void tick(); }, RECORDER_TICK_MS);
        // Never what keeps the daemon alive.
        timer.unref?.();
    };

    const stop = (): void => {
        if (timer) clearInterval(timer);
        timer = undefined;
    };

    return { observe, tick, start, stop, size: () => sessions.size };
};

export type TurnRecorder = ReturnType<typeof createTurnRecorder>;

/** The recipients of a chunk: this machine, then the newest pinned devices, within the server's slot limit. */
export const chooseRecipients = (
    self: RecorderRecipient | null,
    pinned: ReadonlyArray<RecorderRecipient & { pinnedAt?: string }>,
): RecorderRecipient[] => {
    // Nobody but this machine = nobody who could read it on a phone.
    if (!pinned.length) return [];
    const others = [...pinned]
        .filter((d) => d.deviceId !== self?.deviceId)
        .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''))
        .slice(0, RECORDER_MAX_RECIPIENTS - (self ? 1 : 0))
        .map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));
    return self ? [self, ...others] : others;
};
