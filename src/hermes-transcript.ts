/**
 * Hermes' session store, read into the events the timeline draws.
 *
 * Hermes keeps no transcript file: every conversation is rows of `messages` in
 * `~/.hermes/state.db` (SQLite). Like opencode's, the row behind this agent
 * carries a reader of its own (`readHermesTranscript`, a `TranscriptReader`)
 * and a projector for what it hands back (`projectHermesEntries`).
 *
 * Shape measured 2026-11-01 against hermes 0.20.0 (schema_version 25), with
 * `.schema` and the writer, `hermes_state.py`:
 *
 *  - `messages(id INTEGER AUTOINCREMENT, session_id, role, content,
 *    tool_call_id, tool_calls, tool_name, timestamp REAL, active, compacted, …)`.
 *    `timestamp` is **seconds** since the epoch, as a REAL.
 *  - Rows are inserted once and never rewritten (the only UPDATEs touch
 *    `display_*` and flip `active`/`compacted` when a conversation is rewound or
 *    compressed), so `id` is a safe cursor: a row read is final.
 *  - `role` is `user` · `assistant` · `tool`. An assistant row that calls tools
 *    has `tool_calls`, a JSON array of `{ id, type: "function", function: {
 *    name, arguments } }` where `arguments` is itself a JSON **string**; each
 *    call is answered by a `tool` row whose `tool_call_id` is that `id`.
 *
 * Only rows with `active = 1` are drawn — a rewound turn is not part of the
 * conversation any more.
 */

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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

/**
 * A Hermes session id (`<YYYYMMDD>_<HHMMSS>_<hash>`, measured). The query has
 * nowhere to bind a parameter (`sqliteJson` runs the `sqlite3` binary), so an
 * id goes into the SQL text only after it passes this.
 */
export const HERMES_SESSION_ID = /^[A-Za-z0-9_-]{1,96}$/;

/** The transcript "path" a Hermes pane resolves to: the store and the session in one string. */
export const hermesSourcePath = (db: string, sessionId: string): string => `${db}#${sessionId}`;

const parseSourcePath = (path: string): { db: string; sessionId: string } | null => {
    const at = path.lastIndexOf('#');
    if (at <= 0) return null;
    const sessionId = path.slice(at + 1);
    const db = path.slice(0, at);
    // The path also comes back from the recorder's state file and goes to `sqlite3` as an argument:
    // a relative one could start with `-` and read as an option.
    return HERMES_SESSION_ID.test(sessionId) && isAbsolute(db) ? { db, sessionId } : null;
};

/** One tool call of an assistant row, reduced in SQL to the fields drawn. */
export interface HermesTool {
    id?: string | null;
    name?: string | null;
    target?: string | null;
}

/** One `messages` row as the query below returns it. */
export interface HermesRow {
    id: number;
    role: string;
    /** Seconds since the epoch. */
    ts?: number | null;
    text?: string | null;
    /** Assistant rows: the calls, as a JSON array (string) or already parsed. */
    tools?: HermesTool[] | string | null;
    /** `tool` rows: the id of the call answered. */
    callId?: string | null;
    /** `tool` rows: line count of the output. */
    lines?: number | null;
}

const isRow = (value: unknown): value is HermesRow => {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'number' && Number.isSafeInteger(row.id) && typeof row.role === 'string';
};

/** Rows read on the first look at a session. */
export const HERMES_BACKFILL_ROWS = 200;
/** Rows read per look after that. */
export const HERMES_ROWS_PER_READ = 500;
/** The fewest milliseconds between two queries for one session. */
export const HERMES_MIN_QUERY_MS = 1_000;

/**
 * Which tool argument reads as "what this call is about", first match wins.
 * `command` and `cmd` are absent on purpose: a command line is the argument
 * most likely to carry a secret.
 */
const TARGET_KEYS = ['path', 'file_path', 'pattern', 'query', 'url', 'image_url', 'name'] as const;

const SQL_TEXT_CHARS = MAX_EVENT_TEXT_CHARS + 1;

/**
 * The rows of one session from message id `from` on, or its last
 * `HERMES_BACKFILL_ROWS` when `from` is null. Read-only; exported for the test
 * that pins the id check.
 */
export const hermesRowsSql = (sessionId: string, from: number | null): string => {
    if (!HERMES_SESSION_ID.test(sessionId)) throw new Error('not a hermes session id');
    if (from !== null && !Number.isSafeInteger(from)) throw new Error('not a row position');
    const args = `json_extract(c.value, '$.function.arguments')`;
    const arg = (key: string) => `CASE WHEN json_valid(${args}) THEN json_extract(${args}, '$.${key}') END`;
    const target = `substr(coalesce(${TARGET_KEYS.map(arg).join(', ')}), 1, ${MAX_EVENT_FIELD_CHARS + 1})`;
    const tools = `CASE WHEN m.role = 'assistant' AND m.tool_calls IS NOT NULL AND json_valid(m.tool_calls)
        THEN (SELECT json_group_array(json_object('id', coalesce(json_extract(c.value, '$.id'), json_extract(c.value, '$.call_id')),
            'name', json_extract(c.value, '$.function.name'), 'target', ${target}))
            FROM json_each(m.tool_calls) c) END`;
    const select = `SELECT m.id AS id, m.role AS role, m.timestamp AS ts,
        CASE WHEN m.role IN ('user', 'assistant') THEN substr(m.content, 1, ${SQL_TEXT_CHARS}) END AS text,
        ${tools} AS tools,
        CASE WHEN m.role = 'tool' THEN m.tool_call_id END AS callId,
        CASE WHEN m.role = 'tool' THEN length(m.content) - length(replace(m.content, char(10), '')) + 1 END AS lines
        FROM messages m
        WHERE m.session_id = '${sessionId}' AND m.role IN ('user', 'assistant', 'tool') AND coalesce(m.active, 1) = 1`;
    return from === null
        ? `SELECT * FROM (${select} ORDER BY m.id DESC LIMIT ${HERMES_BACKFILL_ROWS}) ORDER BY id`
        : `${select} AND m.id >= ${from} ORDER BY m.id LIMIT ${HERMES_ROWS_PER_READ}`;
};

const isoOfSeconds = (seconds: unknown): { at?: string } => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return {};
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? {} : { at: date.toISOString() };
};

const toolsOf = (row: HermesRow): HermesTool[] | null => {
    if (row.tools === undefined || row.tools === null) return [];
    let parsed: unknown = row.tools;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    return Array.isArray(parsed) ? (parsed as HermesTool[]) : null;
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const unknownLine = (what: string): string => JSON.stringify({ unknown: what });

/** Rows → one JSON event per line (what the projector reads back), in row order. */
export const hermesLinesOf = (rows: readonly HermesRow[]): string[] => {
    const lines: string[] = [];
    const warned = new Set<string>();
    const once = (key: string, what: string): void => {
        if (warned.has(key)) return;
        warned.add(key);
        lines.push(unknownLine(what));
    };
    for (const row of rows) {
        const at = isoOfSeconds(row.ts);
        if (row.role === 'user') {
            const text = (typeof row.text === 'string' ? row.text : '').trim();
            if (text) lines.push(JSON.stringify({ kind: 'prompt', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...at }));
            continue;
        }
        if (row.role === 'assistant') {
            const text = (typeof row.text === 'string' ? row.text : '').trim();
            if (text) lines.push(JSON.stringify({ kind: 'text', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...at }));
            const tools = toolsOf(row);
            if (tools === null) once(`${row.id}:x`, 'hermes tool_calls that are not a list');
            for (const tool of tools ?? []) {
                if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string' || typeof tool.name !== 'string') {
                    once(`${row.id}:x`, 'hermes tool call without an id or name');
                    continue;
                }
                const line = oneLine(typeof tool.target === 'string' ? tool.target : undefined);
                const target = line ? clamp(line) : undefined;
                lines.push(JSON.stringify({ kind: 'tool', id: clamp(tool.id), name: clamp(tool.name), ...(target ? { target } : {}), ...at }));
            }
            continue;
        }
        if (row.role === 'tool') {
            if (typeof row.callId !== 'string' || !row.callId) {
                once(`${row.id}:x`, 'hermes tool result without a call id');
                continue;
            }
            const count = num(row.lines);
            lines.push(JSON.stringify({ kind: 'tool_result', id: clamp(row.callId), ok: true, ...(count ? { lines: count } : {}), ...at }));
        }
    }
    return lines;
};

/** What the reader keeps between reads, on `TailState.cursor`. */
interface HermesCursor {
    readonly session: string;
    /** The next message id to ask for. */
    readonly from: number;
    /** The store's files as of the last query: unchanged means nothing to ask. */
    readonly stamp: string;
    readonly queriedAt: number;
}

const cursorOf = (prev: TailState | null, session: string): HermesCursor | null => {
    const c: unknown = prev?.cursor;
    if (!c || typeof c !== 'object') return null;
    const { session: s, from, stamp, queriedAt } = c as Record<string, unknown>;
    if (s !== session || typeof from !== 'number' || !Number.isSafeInteger(from)) return null;
    if (typeof stamp !== 'string' || typeof queriedAt !== 'number') return null;
    return { session, from, stamp, queriedAt };
};

/** When a query last failed, per source path — so an unreadable store is not asked on every tick. */
const failedAt = new Map<string, number>();

export interface HermesReadDeps {
    /** Rows of a SQLite file, null when the read failed (`sqliteJson`). */
    query: (db: string, sql: string) => unknown[] | null;
    /** The store's files, size and mtime — any write shows up in one of them. */
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
            parts.push('-');
        }
    }
    return parts[0] === '-' ? null : parts.join('|');
};

/**
 * What was added to one Hermes session since `prev`, or null when nothing was —
 * the store's files have not moved, the last query was under
 * `HERMES_MIN_QUERY_MS` ago, or the store cannot be read. The WAL moves on every
 * write by every session on the machine, so the time floor is what keeps a busy
 * neighbour from turning a 500 ms poll into a `sqlite3` spawn per tick.
 */
export const readHermesTranscript = (path: string, prev: TailState | null, deps: HermesReadDeps): TailRead | null => {
    const source = parseSourcePath(path);
    if (!source) return null;
    const now = deps.now ?? Date.now;
    const stamp = (deps.stamp ?? fileStamp)(source.db);
    if (stamp === null) return null;

    const cursor = cursorOf(prev, source.sessionId);
    if (cursor && cursor.stamp === stamp) return null;
    const last = Math.max(cursor?.queriedAt ?? -Infinity, failedAt.get(path) ?? -Infinity);
    if (now() - last < HERMES_MIN_QUERY_MS) return null;

    const raw = deps.query(source.db, hermesRowsSql(source.sessionId, cursor ? cursor.from : null));
    if (raw === null) {
        failedAt.set(path, now());
        return null;
    }
    failedAt.delete(path);
    const rows = raw.filter(isRow);
    const newest = rows.reduce((max, r) => Math.max(max, r.id), cursor ? cursor.from - 1 : 0);
    const state: TailState = {
        offset: newest,
        // `agent read` says there is more above when the read was a window.
        size: !cursor && rows.length >= HERMES_BACKFILL_ROWS ? TRANSCRIPT_BACKFILL_BYTES + 1 : 0,
        mtimeMs: 0,
        ino: 0,
        carry: '',
        resyncing: false,
        salvage: [],
        cursor: { session: source.sessionId, from: newest + 1, stamp, queriedAt: now() } satisfies HermesCursor,
    };
    return { lines: hermesLinesOf(rows), state, bytesRead: 0, droppedLines: 0 };
};

const EVENT_KINDS = new Set(['prompt', 'text', 'tool', 'tool_result']);

/** The reader's lines back into events; names what the reader marked unknown. */
export const projectHermesEntries: TranscriptProjector = (lines, opts: ProjectorOptions = {}): TurnEvent[] => {
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
