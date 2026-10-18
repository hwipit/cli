/**
 * opencode's session store, read into the events the timeline draws.
 *
 * opencode keeps no transcript file. 2.x writes every session to SQLite
 * (`opencode.db`, WAL), one `session_message` row per user message and per
 * assistant step, and rewrites an assistant row in place while it streams. So
 * this file is both halves the other agents split: a reader that asks the
 * database what changed (`readOpencodeTranscript`, the `TranscriptReader`
 * behind the opencode row) and a projector for what it hands back
 * (`projectOpencodeEntries`).
 *
 * Shape measured 2026-10-10 against opencode 2.0.24 — the schema with
 * `.schema`, the JSON with `json_each` key and type counts over 3,965 rows on
 * this machine, and a scratch store written by sessions run for the purpose.
 * No conversation text was opened.
 *
 *  - `session_message(id, session_id, type, seq, time_created, time_updated,
 *    data)`, `seq` increasing per session. `type` is `user` · `assistant` ·
 *    `system` · `synthetic` · `idle` · `compaction` · `*-switched`; only the
 *    first two are drawn.
 *  - user `data`: `{ text, time: { created }, files, agents, skills }`.
 *  - assistant `data`: `{ model: { id, providerID }, content: [...], tokens:
 *    { input, output, reasoning, cache: { read, write } }, time: { created,
 *    completed?, streamed? }, finish, … }` — `time.completed` is set once the
 *    step is over. `content` items are `{ type: "text", text }`,
 *    `{ type: "reasoning", … }` and `{ type: "tool", id, name, state: { status,
 *    input, content: [{ type: "text", text }], error }, time }`; a finished
 *    call is `completed` or `error`.
 *  - 1.x wrote `session` · `message` · `part` instead. 2.x leaves those alone
 *    and this file does not read them.
 *
 * The lines the reader hands over are `TurnEvent`s already, one JSON object
 * each, so the projector only checks them. The work of deciding what is new
 * lives in `opencodeLinesOf`, which is pure and is where the tests point.
 */

import { statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';

import {
    clamp,
    MAX_EVENT_FIELD_CHARS,
    MAX_EVENT_TEXT_CHARS,
    oneLine,
    sliceSinceLastPrompt,
    TRANSCRIPT_BACKFILL_BYTES,
    type ProjectorOptions,
    type TailRead,
    type TailState,
    type TranscriptProjector,
    type TurnEvent,
} from './transcript-tail.js';

/** Where opencode 2.x keeps its store, by the rules opencode itself follows (`opencode debug paths db`, 2.0.24). */
export const opencodeDbPath = (env: NodeJS.ProcessEnv = process.env): string => {
    if (env.OPENCODE_DB && isAbsolute(env.OPENCODE_DB)) return env.OPENCODE_DB;
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
    return join(data, 'opencode', 'opencode.db');
};

/**
 * A session id as opencode mints them (`ses_` + base62, measured). The query
 * below has nowhere to bind a parameter (`sqliteJson` runs the `sqlite3`
 * binary), so an id goes into the SQL text only after it passes this.
 */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;

/**
 * The transcript "path" an opencode pane resolves to: the store and the session
 * in one string. A string because every consumer compares and logs paths, and
 * because the session changing — a new one in the same pane — has to read as
 * the path changing, which is what makes `turn-watch` start over on it.
 */
export const opencodeSourcePath = (db: string, sessionId: string): string => `${db}#${sessionId}`;

const parseSourcePath = (path: string): { db: string; sessionId: string } | null => {
    const at = path.lastIndexOf('#');
    if (at <= 0) return null;
    const sessionId = path.slice(at + 1);
    const db = path.slice(0, at);
    // The path also comes back from the recorder's state file, and goes to `sqlite3` as an argument:
    // a relative one could start with `-` and read as an option.
    return OPENCODE_SESSION_ID.test(sessionId) && isAbsolute(db) ? { db, sessionId } : null;
};

/** One `content` item, reduced in SQL to the fields drawn — a tool's input and output can be megabytes. */
export interface OpencodeItem {
    type?: string | null;
    id?: string | null;
    name?: string | null;
    text?: string | null;
    status?: string | null;
    target?: string | null;
    lines?: number | null;
    at?: number | null;
}

/** One `session_message` row as the query below returns it. */
export interface OpencodeRow {
    id: string;
    seq: number;
    type: string;
    created: number;
    completed?: number | null;
    text?: string | null;
    model?: string | null;
    out?: number | null;
    input?: number | null;
    cacheRead?: number | null;
    cacheWrite?: number | null;
    /** `error.type` of a step that failed (`provider.quota`, `aborted`, …). */
    errorType?: string | null;
    errorText?: string | null;
    items?: OpencodeItem[] | string | null;
}

/** A row the query could have returned — anything else is not drawn. */
const isRow = (value: unknown): value is OpencodeRow => {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string' && typeof row.type === 'string' && typeof row.seq === 'number' && Number.isSafeInteger(row.seq);
};

/** Rows read on the first look at a session — enough for the turn in flight and a screen above it. */
export const OPENCODE_BACKFILL_ROWS = 200;
/** Rows read per look after that. */
export const OPENCODE_ROWS_PER_READ = 500;
/** How far behind the newest row an unfinished one may hold the read position. */
export const OPENCODE_OPEN_WINDOW = 200;
/** The fewest milliseconds between two queries for one session. */
export const OPENCODE_MIN_QUERY_MS = 1_000;

/**
 * Which `state.input` key reads as "what this call is about", first match
 * wins. The keys are the ones 2.0.24's tools were seen to take (read, edit,
 * write: `filePath`/`path`; glob, grep: `pattern`; webfetch: `url`; subagent,
 * task: `description`). `command` is absent for the reason it is absent from
 * every other projector — a command line is the argument most likely to carry
 * a secret.
 */
const TARGET_KEYS = ['filePath', 'path', 'pattern', 'url', 'description'] as const;

/** Prose is cut in SQL a little above the event cap, so `clamp` still marks the cut. */
const SQL_TEXT_CHARS = MAX_EVENT_TEXT_CHARS + 1;

/**
 * The rows of one session from `from` on, or its last `OPENCODE_BACKFILL_ROWS`
 * when `from` is null. Exported for the test that pins the id check.
 */
export const opencodeRowsSql = (sessionId: string, from: number | null): string => {
    if (!OPENCODE_SESSION_ID.test(sessionId)) throw new Error('not an opencode session id');
    if (from !== null && !Number.isSafeInteger(from)) throw new Error('not a row position');
    const item = (key: string) => `json_extract(c.value, '$.${key}')`;
    const target = `substr(coalesce(${TARGET_KEYS.map((k) => item(`state.input.${k}`)).join(', ')}), 1, ${MAX_EVENT_FIELD_CHARS + 1})`;
    const lines = `(SELECT sum(length(json_extract(o.value, '$.text')) - length(replace(json_extract(o.value, '$.text'), char(10), '')) + 1)
        FROM json_each(c.value, '$.state.content') o WHERE json_extract(o.value, '$.type') = 'text')`;
    const items = `(SELECT json_group_array(json_object(
        'type', ${item('type')}, 'id', ${item('id')}, 'name', ${item('name')},
        'text', CASE WHEN ${item('type')} = 'text' THEN substr(${item('text')}, 1, ${SQL_TEXT_CHARS}) END,
        'status', ${item('state.status')}, 'target', ${target}, 'lines', ${lines}, 'at', ${item('time.created')}))
        FROM json_each(m.data, '$.content') c)`;
    const select = `SELECT m.id AS id, m.seq AS seq, m.type AS type, m.time_created AS created,
        json_extract(m.data, '$.time.completed') AS completed,
        CASE WHEN m.type = 'user' THEN substr(json_extract(m.data, '$.text'), 1, ${SQL_TEXT_CHARS}) END AS text,
        json_extract(m.data, '$.model.id') AS model,
        json_extract(m.data, '$.tokens.output') AS out,
        json_extract(m.data, '$.tokens.input') AS input,
        json_extract(m.data, '$.tokens.cache.read') AS cacheRead,
        json_extract(m.data, '$.tokens.cache.write') AS cacheWrite,
        json_extract(m.data, '$.error.type') AS errorType,
        substr(json_extract(m.data, '$.error.message'), 1, ${SQL_TEXT_CHARS}) AS errorText,
        CASE WHEN m.type = 'assistant' THEN ${items} END AS items
        FROM session_message m
        WHERE m.session_id = '${sessionId}' AND m.type IN ('user', 'assistant')`;
    return from === null
        ? `SELECT * FROM (${select} ORDER BY m.seq DESC LIMIT ${OPENCODE_BACKFILL_ROWS}) ORDER BY seq`
        : `${select} AND m.seq >= ${from} ORDER BY m.seq LIMIT ${OPENCODE_ROWS_PER_READ}`;
};

const isoOf = (ms: unknown): { at?: string } => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return {};
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? {} : { at: date.toISOString() };
};

/** The row's `content`, or null when the query handed back something that is not a list. */
const itemsOf = (row: OpencodeRow): OpencodeItem[] | null => {
    if (row.items === undefined || row.items === null) return [];
    let parsed: unknown = row.items;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    // Each item is checked field by field where it is drawn.
    return Array.isArray(parsed) ? (parsed as OpencodeItem[]) : null;
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A line the projector reads as "this kind of thing is not drawn". */
const unknownLine = (what: string): string => JSON.stringify({ unknown: what });

/**
 * What these rows add to what was already sent, and where the next read starts.
 *
 * Every piece of a row gets a key (`<seq>:<part><index>`), and a key sent once
 * is never sent again. A user row is final when written. An assistant row is
 * not: its text is sent once something follows it in the row or the row is
 * closed, a tool call once it runs, its result once the call has one, and
 * the step's token count and any error when the step is finished. A row is
 * closed when it is finished, when a later assistant step exists (opencode
 * starts one only after the last is over, so an unfinished one behind it died
 * mid-stream), or when it falls out of the `OPENCODE_OPEN_WINDOW` rows behind
 * the newest — closing is what sends a dead step's last words, which nothing
 * would otherwise send. `from` stays on the oldest row still open, so the next
 * read sees it again. `emitted` keeps only the keys at or after `from`;
 * nothing before it is read again.
 */
export const opencodeLinesOf = (
    rows: readonly OpencodeRow[],
    sent: { from: number; emitted: readonly string[] },
): { lines: string[]; from: number; emitted: string[] } => {
    const seen = new Set(sent.emitted);
    const lines: string[] = [];
    const out = (key: string, event: TurnEvent): void => {
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(JSON.stringify(event));
    };

    const once = (key: string, what: string): void => {
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(unknownLine(what));
    };

    let newest = sent.from - 1;
    let lastStep = -1;
    for (const row of rows) {
        newest = Math.max(newest, row.seq);
        if (row.type === 'assistant') lastStep = Math.max(lastStep, row.seq);
    }

    let oldestOpen: number | null = null;
    for (const row of rows) {
        const stamp = isoOf(row.created);

        if (row.type === 'user') {
            // A prompt of attachments alone has no text, and still starts a turn.
            const text = (typeof row.text === 'string' ? row.text : '').trim() || '(attachment)';
            out(`${row.seq}:p`, { kind: 'prompt', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            continue;
        }
        if (row.type !== 'assistant') continue;

        const done = typeof row.completed === 'number';
        const closed = done || row.seq < lastStep || row.seq < newest - OPENCODE_OPEN_WINDOW;
        if (!closed && oldestOpen === null) oldestOpen = row.seq;
        const items = itemsOf(row);
        if (items === null) once(`${row.seq}:x`, 'opencode content that is not a list');
        let thinking = 0;
        (items ?? []).forEach((item, i) => {
            if (!item || typeof item !== 'object') {
                once(`${row.seq}:x${i}`, 'opencode content item that is not an object');
                return;
            }
            const at = item.at !== undefined && item.at !== null ? isoOf(item.at) : stamp;
            if (item.type === 'reasoning') {
                thinking += 1;
                return;
            }
            if (item.type === 'text') {
                const text = (item.text ?? '').trim();
                const final = closed || i < (items ?? []).length - 1;
                if (text && final) out(`${row.seq}:t${i}`, { kind: 'text', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...at });
                return;
            }
            if (item.type === 'tool') {
                if (typeof item.id !== 'string' || typeof item.name !== 'string') {
                    once(`${row.seq}:x${i}`, 'opencode tool call without an id or name');
                    return;
                }
                // A call is first written while its input still streams in
                // (measured on 2.0.24: a write seen then had no path yet), and a
                // call sent once is never sent again — so wait until it runs.
                const settled = item.status === 'running' || item.status === 'completed' || item.status === 'error';
                if (!settled && !closed) return;
                const line = oneLine(typeof item.target === 'string' ? item.target : undefined);
                const target = line ? clamp(line) : undefined;
                out(`${row.seq}:u${i}`, { kind: 'tool', id: clamp(item.id), name: clamp(item.name), ...(target ? { target } : {}), ...at });
                if (item.status === 'completed' || item.status === 'error') {
                    const count = num(item.lines);
                    out(`${row.seq}:r${i}`, { kind: 'tool_result', id: clamp(item.id), ok: item.status === 'completed', ...(count ? { lines: count } : {}), ...at });
                }
                return;
            }
            once(`${row.seq}:x${i}`, `opencode content type ${typeof item.type === 'string' ? item.type : '(none)'}`);
        });
        if (done && typeof row.errorType === 'string') {
            // A failed step is finished like any other (measured: `time.completed`
            // set beside `finish: "error"`), and its error is all it has to say.
            const why = oneLine(typeof row.errorText === 'string' ? row.errorText : undefined);
            out(`${row.seq}:e`, { kind: 'text', text: clamp(`opencode stopped: ${row.errorType}${why ? ` — ${why}` : ''}`, MAX_EVENT_TEXT_CHARS), ...stamp });
        }
        if (done) {
            out(`${row.seq}:m`, {
                kind: 'msg',
                mid: clamp(row.id),
                ...(typeof row.model === 'string' ? { model: clamp(row.model) } : {}),
                out: num(row.out),
                // `input` excludes the cached prompt (measured: input 279 beside
                // cache.read 140,145), so the context is the three together.
                ctx: num(row.input) + num(row.cacheRead) + num(row.cacheWrite),
                ...(thinking ? { thinking } : {}),
                ...stamp,
            });
        }
    }

    let from = oldestOpen ?? newest + 1;
    from = Math.max(from, newest - OPENCODE_OPEN_WINDOW, sent.from);
    // A full page of finished rows behind one open row would be read again
    // forever; past the page is where the next read has to start.
    if (rows.length >= OPENCODE_ROWS_PER_READ && from <= sent.from) from = newest + 1;
    const emitted = [...seen].filter((key) => Number(key.slice(0, key.indexOf(':'))) >= from);
    return { lines, from, emitted };
};

/** What the reader keeps between reads, on `TailState.cursor`. */
interface OpencodeCursor {
    readonly session: string;
    readonly from: number;
    readonly emitted: readonly string[];
    /** The store's files as of the last query: unchanged means nothing to ask. */
    readonly stamp: string;
    readonly queriedAt: number;
}

const cursorOf = (prev: TailState | null, session: string): OpencodeCursor | null => {
    const c: unknown = prev?.cursor;
    if (!c || typeof c !== 'object') return null;
    const { session: s, from, emitted, stamp, queriedAt } = c as Record<string, unknown>;
    if (s !== session || typeof from !== 'number' || !Number.isSafeInteger(from)) return null;
    if (!Array.isArray(emitted) || typeof stamp !== 'string' || typeof queriedAt !== 'number') return null;
    return { session, from, emitted: emitted.filter((key): key is string => typeof key === 'string'), stamp, queriedAt };
};

/**
 * When a query last failed, per source path. A failure leaves no state to
 * carry the time on (the reader returns null), and without it a store that
 * cannot be read would be asked again on every 500 ms tick.
 */
const failedAt = new Map<string, number>();

export interface OpencodeReadDeps {
    /** Rows of a SQLite file, null when the read failed (`sqliteJson`). */
    query: (db: string, sql: string) => unknown[] | null;
    /** The store's files, size and mtime — any write to the session shows up in one of them. */
    stamp?: (db: string) => string | null;
    now?: () => number;
}

const fileStamp = (db: string): string | null => {
    const parts: string[] = [];
    for (const path of [db, `${db}-wal`]) {
        try {
            const s = statSync(path);
            parts.push(`${s.size}:${s.mtimeMs}`);
        } catch {
            // No WAL file is a normal state (checkpointed, or opencode not running).
            parts.push('-');
        }
    }
    return parts[0] === '-' ? null : parts.join('|');
};

/**
 * What changed in one opencode session since `prev`, or null when nothing did
 * — the store's files have not moved, the last query was under
 * `OPENCODE_MIN_QUERY_MS` ago, or the store cannot be read. The WAL moves on
 * every write by every opencode session on this machine, so the time floor is
 * what keeps a busy neighbour from turning a 500 ms poll into a `sqlite3`
 * spawn per tick.
 */
export const readOpencodeTranscript = (path: string, prev: TailState | null, deps: OpencodeReadDeps): TailRead | null => {
    const source = parseSourcePath(path);
    if (!source) return null;
    const now = deps.now ?? Date.now;
    const stamp = (deps.stamp ?? fileStamp)(source.db);
    if (stamp === null) return null;

    const cursor = cursorOf(prev, source.sessionId);
    if (cursor && cursor.stamp === stamp) return null;
    const last = Math.max(cursor?.queriedAt ?? -Infinity, failedAt.get(path) ?? -Infinity);
    if (now() - last < OPENCODE_MIN_QUERY_MS) return null;

    const rows = deps.query(source.db, opencodeRowsSql(source.sessionId, cursor ? cursor.from : null));
    if (rows === null) {
        failedAt.set(path, now());
        return null;
    }
    failedAt.delete(path);
    const next = opencodeLinesOf(rows.filter(isRow), cursor ?? { from: 0, emitted: [] });
    const state: TailState = {
        offset: next.from,
        // `agent read` says there is more above when the read was a window:
        // a backfill that came back full stands for a session longer than it.
        size: !cursor && rows.length >= OPENCODE_BACKFILL_ROWS ? TRANSCRIPT_BACKFILL_BYTES + 1 : 0,
        mtimeMs: 0,
        ino: 0,
        carry: '',
        resyncing: false,
        salvage: [],
        cursor: { session: source.sessionId, from: next.from, emitted: next.emitted, stamp, queriedAt: now() } satisfies OpencodeCursor,
    };
    return { lines: next.lines, state, bytesRead: 0, droppedLines: 0 };
};

const EVENT_KINDS = new Set(['prompt', 'text', 'tool', 'tool_result', 'msg']);

/**
 * The reader's lines back into events. They were built as events, so this
 * only refuses what is not one and names what the reader marked unknown.
 */
export const projectOpencodeEntries: TranscriptProjector = (lines, opts: ProjectorOptions = {}): TurnEvent[] => {
    const events: TurnEvent[] = [];
    for (const raw of lines) {
        let entry: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            entry = parsed as Record<string, unknown>;
        } catch {
            continue;
        }
        if (typeof entry.unknown === 'string') {
            opts.onUnknown?.(entry.unknown);
            continue;
        }
        if (typeof entry.kind === 'string' && EVENT_KINDS.has(entry.kind)) events.push(entry as TurnEvent);
    }
    return sliceSinceLastPrompt(events, opts);
};
