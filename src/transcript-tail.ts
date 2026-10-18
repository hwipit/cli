/**
 * Claude Code session transcript (`~/.claude/projects/<hash>/<uuid>.jsonl`) →
 * the small events the agent chat timeline draws.
 *
 * Two pure pieces, deliberately split: reading bytes off a growing file, and
 * deciding what of it is worth putting on the wire. Neither touches the socket,
 * so both are testable without tmux, WebSocket, or a clock.
 *
 * Everything here is sized by what a real transcript actually contains, measured
 * 2026-09-08 over 1443 files in `~/.claude/projects`: the largest file was
 * 75.9 MB (p90 1.1 MB) and the longest single line 915,292 bytes. Those two
 * numbers are why the reader starts near the end and refuses oversized lines
 * before parsing them — a tail that starts at byte 0, or that hands a ~1 MB
 * string to `JSON.parse` and only then decides to drop it, has already paid the
 * cost the cap exists to avoid.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

import { applyTodoEntry, type TodoItem, type TodoList } from './todo-fold.js';

/**
 * How far back from the end of the file the first read starts.
 *
 * Not zero: a fresh viewer that sees nothing until the *next* tool call is a
 * blank screen for whoever just picked up their phone mid-turn. Not the whole
 * file either — that is up to 75.9 MB. A fixed window from the end costs the
 * same on an 8 KB transcript and a 76 MB one.
 */
export const TRANSCRIPT_BACKFILL_BYTES = 256 * 1024;

/** Ceiling on one tick's read, so a burst of appends cannot be swallowed whole. */
export const MAX_TAIL_BYTES_PER_TICK = 256 * 1024;

/**
 * A line longer than this is abandoned unparsed, the reader skipping to the next
 * newline. The measured worst case is a 915 KB `tool_result`, whose body this
 * module drops anyway — buffering one to completion would be paying megabytes to
 * learn a tool id.
 */
export const MAX_TRANSCRIPT_LINE_CHARS = 1024 * 1024;

/**
 * Ceiling on a tool's label — its name, and the short string saying what it
 * acted on. A path or a one-line description; anything longer is a runaway
 * input, not a label.
 */
export const MAX_EVENT_FIELD_CHARS = 512;

/**
 * Ceiling on prose — what the agent wrote, and what the person asked.
 *
 * Deliberately far above the label cap: 512 characters is a filename, and
 * applying it here cut every reply off mid-sentence. 5000 is what the
 * completion push already carries for the same text (`hwip-stop.sh`), so the
 * live lane and the push that replaces it agree on how much of a reply is
 * worth sending.
 */
export const MAX_EVENT_TEXT_CHARS = 5000;

/**
 * Where the reader is in one file.
 *
 * `size`/`mtimeMs` are the skip check: when neither moved there is nothing to
 * read, and the tick returns without allocating. Since idle is this watcher's
 * normal state, that check is what keeps it off the GC's back.
 */
export interface TailState {
    readonly offset: number;
    readonly size: number;
    readonly mtimeMs: number;
    /** Which file this offset belongs to. A new inode is a new file at the same path. */
    readonly ino: number;
    /** Bytes after the last newline seen — an incomplete line, held for the next tick. */
    readonly carry: string;
    /**
     * How many bytes of the FILE `carry` stands for. Not `Buffer.byteLength(carry)`: a
     * byte that is not valid UTF-8 decodes to U+FFFD, three bytes when written back, so
     * the length of the string says nothing about the offset the line began at.
     */
    readonly carryBytes?: number;
    /** Inside an oversized line: discard bytes until the next newline. */
    readonly resyncing: boolean;
    /** While `resyncing`: the offset where the oversized line began — the last place a restart can safely resume. */
    readonly resyncFrom?: number;
    /** tool_result ids read off the head of the oversized line being skipped, reported when it ends. */
    readonly salvage: readonly string[];
    /**
     * Where a `TranscriptReader` that is not reading a file is, in its own
     * terms (opencode's: a row position in its database). Opaque to everything
     * but the reader that wrote it; the file tailer never sets it.
     */
    readonly cursor?: unknown;
}

export interface TailRead {
    /** Whole lines, in file order. Never includes a partial line. */
    readonly lines: string[];
    readonly state: TailState;
    readonly bytesRead: number;
    /** Lines abandoned for exceeding MAX_TRANSCRIPT_LINE_CHARS. */
    readonly droppedLines: number;
}

/**
 * How much of `buffer[0..read)` ends on a UTF-8 character boundary.
 *
 * A sequence is at most 4 bytes, so at most 3 trailing bytes can belong to a
 * character whose remainder has not arrived. Walk back over continuation bytes
 * (`10xxxxxx`) to the lead byte and ask how long its character should be; if the
 * buffer holds all of it, the read is already complete.
 */
const completeUtf8Length = (buffer: Buffer, read: number): number => {
    for (let back = 1; back <= 3 && back <= read; back++) {
        const byte = buffer[read - back]!;
        if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation — keep walking
        const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return back >= width ? read : read - back;
    }
    return read;
};

/**
 * No state yet. `null` rather than a sentinel-filled record: "never read this
 * file" and "read it and got nothing" are different, and an out-of-band value
 * that has to stay below every real offset is a trap for the next `>=`.
 */
export const initialTailState = (): TailState | null => null;

/*
 * An oversized line is dropped, but not its verdict. The line is almost always
 * a tool_result carrying a screenshot, and without a result its call spins as
 * running in the viewer forever. The ids sit at the head of the line, before
 * the payload (measured on real screenshot results, 2026-09-12), so the head is
 * read for ids and a content-free stand-in takes the line's place. The tail is
 * read for `is_error`; a failure flagged anywhere else reads as ok — a wrong
 * verdict on a rare case, against a spinner that never stops. Nothing in
 * between is kept.
 */
const SALVAGE_HEAD_CHARS = 16 * 1024;
const SALVAGE_TAIL_CHARS = 4 * 1024;

const salvageIdsOf = (head: string): string[] =>
    head.includes('"tool_result"')
        ? [...head.slice(0, SALVAGE_HEAD_CHARS).matchAll(/"tool_use_id":"([^"\\]{1,200})"/g)].map((m) => m[1]!)
        : [];

/** A transcript line with just the verdicts, for the projection to read like any other. */
const salvagedLine = (ids: readonly string[], tail: string): string =>
    JSON.stringify({
        type: 'user',
        message: {
            role: 'user',
            content: ids.map((id) => ({
                type: 'tool_result',
                tool_use_id: id,
                ...(/"is_error":\s*true/.test(tail.slice(-SALVAGE_TAIL_CHARS)) ? { is_error: true } : {}),
            })),
        },
    });

/**
 * Read what was appended since `prev`, or `null` when there is nothing to do —
 * the file is unreadable, or neither its size nor its mtime moved.
 *
 * `null` is the common case (an idle session) and is deliberately allocation
 * free: no buffer, no string, no array.
 */
export const readTranscriptDelta = (
    path: string,
    prev: TailState | null,
    opts: { fromStart?: boolean } = {},
): TailRead | null => {
    let stat;
    try {
        stat = statSync(path);
    } catch {
        return null;
    }

    const { size, mtimeMs, ino } = stat;

    // Caught up AND untouched. `offset >= size` matters on its own: a tick that
    // stopped at MAX_TAIL_BYTES_PER_TICK leaves bytes behind on a file that has
    // not changed since, and skipping there would strand them until the next
    // append. `ino` matters here too, not only below: a replacement that matched
    // the old size and mtime would otherwise skip out before the rotation check
    // downstream ever ran.
    if (prev && prev.offset >= size && size === prev.size && mtimeMs === prev.mtimeMs && ino === prev.ino) {
        return null;
    }

    // A new inode at the same path is a different file, and a file that shrank
    // below the offset was truncated in place. Size alone misses the first case:
    // a replacement that happens to be longer than the old read position reads as
    // an ordinary append, and the offset then points into the middle of a record
    // that was never there.
    //
    // Neither covers a `/clear`, which writes a file under a *different* name —
    // the old one simply stops growing. Following that means re-resolving the
    // session id, which is the caller's job (`turn-watch` re-resolves on a
    // cadence) because only it knows which session this path was for.
    //
    // Either way — first attach or rotation — everything remembered about the old
    // contents is meaningless, so the read restarts from a window off the end.
    const restart = !prev || size < prev.offset || ino !== prev.ino;

    // `fromStart` is for a caller that counts rather than shows: a window off the
    // end is right for a viewer who wants the latest screen, and wrong for a total.
    const start = restart ? (opts.fromStart ? 0 : Math.max(0, size - TRANSCRIPT_BACKFILL_BYTES)) : prev.offset;
    // A window that starts mid-line yields a fragment of a record that began
    // before it, so that fragment is dropped rather than parsed.
    const truncatedStart = restart && start > 0;
    const carry = restart ? '' : prev.carry;
    const carryBytesBefore = restart ? 0 : prev.carryBytes ?? Buffer.byteLength(prev.carry, 'utf-8');
    let resyncing = restart ? false : prev.resyncing;
    let resyncFrom = restart ? undefined : prev.resyncFrom;
    let salvage = restart ? [] : prev.salvage;

    const want = Math.min(size - start, MAX_TAIL_BYTES_PER_TICK);
    if (want <= 0) {
        return {
            lines: [],
            state: { offset: start, size, mtimeMs, ino, carry, carryBytes: carryBytesBefore, resyncing, ...(resyncFrom !== undefined ? { resyncFrom } : {}), salvage },
            bytesRead: 0,
            droppedLines: 0,
        };
    }

    const buffer = Buffer.allocUnsafe(want);
    let read = 0;
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        read = readSync(fd, buffer, 0, want, start);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }

    // A tick that stops at MAX_TAIL_BYTES_PER_TICK can land inside a multi-byte
    // character. Decoding to that boundary turns both halves into U+FFFD, and the
    // line then fails JSON.parse and vanishes without even being counted as
    // dropped — a silent hole that only shows up on non-ASCII transcripts under
    // bursty appends. Back the read up to the last complete sequence instead; the
    // bytes are not lost, the next tick starts on them.
    const usable = read < want ? read : completeUtf8Length(buffer, read);
    const chunk = buffer.toString('utf8', 0, usable);
    const lines: string[] = [];
    let droppedLines = 0;
    let pending = carry;
    let cursor = 0;

    while (cursor <= chunk.length) {
        const nl = chunk.indexOf('\n', cursor);
        if (nl === -1) {
            pending += chunk.slice(cursor);
            break;
        }

        const complete = pending + chunk.slice(cursor, nl);
        cursor = nl + 1;
        pending = '';

        if (resyncing) {
            // This newline ends the oversized line; the next one starts clean.
            resyncing = false;
            if (salvage.length) lines.push(salvagedLine(salvage, complete));
            salvage = [];
            continue;
        }
        if (complete.length > MAX_TRANSCRIPT_LINE_CHARS) {
            droppedLines += 1;
            const ids = salvageIdsOf(complete.slice(0, SALVAGE_HEAD_CHARS));
            if (ids.length) lines.push(salvagedLine(ids, complete));
            continue;
        }
        lines.push(complete);
    }

    // The window began mid-line, so whatever came before the first newline is a
    // fragment of a record that started before `start`.
    if (truncatedStart && lines.length > 0) lines.shift();

    // The bytes of the file `pending` stands for: back to the last newline of this read, or past the whole read when it had none.
    const lastNewline = usable > 0 ? buffer.lastIndexOf(0x0a, usable - 1) : -1;
    let pendingBytes = lastNewline >= 0 ? usable - lastNewline - 1 : carryBytesBefore + usable;

    if (pending.length > MAX_TRANSCRIPT_LINE_CHARS) {
        // Still no newline and already past the cap — stop growing the buffer and
        // discard bytes until the line ends. Holding it to completion would cost
        // megabytes for a record whose body never reaches the wire anyway.
        droppedLines += 1;
        // Already resyncing means this is the middle of the same line, not its head.
        if (!resyncing) {
            salvage = salvageIdsOf(pending.slice(0, SALVAGE_HEAD_CHARS));
            // The line began where the held bytes begin: the last offset a restart may resume from.
            resyncFrom = start + usable - pendingBytes;
        }
        pending = '';
        pendingBytes = 0;
        resyncing = true;
    }

    return {
        lines,
        state: { offset: start + usable, size, mtimeMs, ino, carry: pending, carryBytes: pendingBytes, resyncing, ...(resyncing && resyncFrom !== undefined ? { resyncFrom } : {}), salvage },
        bytesRead: usable,
        droppedLines,
    };
};

// ── projection ───────────────────────────────────────────────────────────────

/**
 * What the timeline draws. Stateless by design: a `tool_result` arrives as its
 * own event rather than mutating an earlier one, because the call it answers is
 * routinely in a previous tick's batch — merging by `id` is the viewer's job,
 * and it is the only side that holds the whole turn.
 */
/**
 * `at` is the transcript entry's own timestamp, carried so the viewer can place
 * a live turn among the pushes in time order instead of parking the whole live
 * block below them — where a message sent while reading lands above the turn it
 * answers.
 */
export type TurnEvent = { at?: string } & (
    | { kind: 'tool'; id: string; name: string; target?: string; add?: number; del?: number }
    | { kind: 'tool_result'; id: string; ok: boolean; lines?: number }
    | { kind: 'text'; text: string }
    | { kind: 'prompt'; text: string }
    | { kind: 'msg'; mid: string; model?: string; out: number; ctx: number; thinking?: number }
    | { kind: 'todo'; items: TodoItem[]; total?: number; done?: number }
);

/*
 * Safe metadata — numbers about the work, never the work. `add`/`del` are the
 * lines an edit changed, `lines` how long a result was, and `msg` one API
 * message's token usage, model and thinking-block count. None of it can carry a
 * secret, which is the bar every field on this wire has to clear.
 *
 * `msg` is merged per projection call only. Claude Code writes each content
 * block of a message as its own line and repeats the message's final usage on
 * every one (measured 2026-09-12: 109 of 154 messages in one session spanned
 * several lines), so a message split across two ticks reaches the viewer twice
 * with the same numbers, and the viewer keeps one by `mid`. Holding the seen ids
 * on the watcher instead would grow with the session.
 *
 * `todo` is the exception to "numbers only": the agent's to-do list, whole, with
 * each task's own words. Those words are the agent's, of the same standing as a
 * `text` reply, and travel the same way (sealed for a viewer with a key, in the
 * clear for one without). `total` and `done` are there only when the list was
 * cut to `MAX_TODO_ITEMS`: how many tasks it really has, and how many of those
 * are finished — the cut can take open tasks too, so the kept items cannot say.
 */

/**
 * What a projector is told about the read it is projecting.
 *
 * Both flags are about the *read*, not about any one format, but only
 * `sinceLastPrompt` means something to every agent: it is "this is a backfill,
 * keep the turn still in flight". `includeSidechain` is Claude Code's word for
 * its in-process subagents, and an agent with no such concept ignores it. A
 * projector ignoring an option its format has no notion of is the contract, not
 * an oversight — do not read an unused field here as a missed case.
 */
export interface ProjectorOptions {
    sinceLastPrompt?: boolean;
    includeSidechain?: boolean;
    /**
     * Told the name of each entry the projector skipped because it does not
     * know the shape — a vendor format change otherwise thins the timeline
     * without a word (C70). Called per skipped entry; the caller dedupes.
     */
    onUnknown?: (what: string) => void;
    /**
     * The to-do list as it stood before these lines. A projector that folds a
     * list (Claude Code's task tools) starts from it and emits a `todo` event
     * only when the list changed. The caller holds it between reads, because a
     * projector holds nothing.
     */
    todo?: TodoList;
    /**
     * Told the list, whole and uncut, when these lines changed it — what the
     * caller passes back as `todo` next time. The event itself is cut to the
     * wire's budget and so cannot stand in for it.
     */
    onTodo?: (list: TodoList) => void;
}

/**
 * One agent's transcript format, reduced to the events the timeline draws.
 *
 * Pure by contract: lines in, events out, no filesystem and no clock. That is
 * what lets `readTranscriptDelta` above stay the single tailer for every agent
 * whose transcript is an append-only text log — the bytes are the same problem
 * for all of them, and only the shape of a line differs.
 */
export type TranscriptProjector = (lines: readonly string[], opts?: ProjectorOptions) => TurnEvent[];

/**
 * A transcript and the projector that can read it, resolved together.
 *
 * They travel as one because they are one answer: a path with no projector is a
 * file nothing can parse, which reaches a viewer as an empty timeline — strictly
 * worse than the honest `no_transcript` it would replace. Resolving them apart
 * would also mean two `detectRemoteAgent` lookups per recheck, on a path that is
 * uncached and blocking (see `TurnWatchDeps.resolveTranscript`).
 */
export interface TranscriptSource {
    readonly path: string;
    readonly project: TranscriptProjector;
    /**
     * How to read `path`, when it is not an append-only file. Absent for every
     * agent that writes one — `readTranscriptDelta` reads those. opencode keeps
     * its sessions in SQLite, so its row carries a reader of its own and its
     * `path` names a session in the database rather than a file.
     */
    readonly read?: TranscriptReader;
}

/**
 * What was added to a transcript since `prev`, or null when nothing was —
 * `readTranscriptDelta`'s contract, for a transcript that is not a file.
 */
export type TranscriptReader = (path: string, prev: TailState | null) => TailRead | null;

/** One read of a source, through its own reader when it has one. */
export const readSource = (source: TranscriptSource, prev: TailState | null): TailRead | null =>
    source.read ? source.read(source.path, prev) : readTranscriptDelta(source.path, prev);

/** Edits larger than this are counted, not diffed: splitting them into lines
 *  is the one allocation here that scales with what the agent wrote. */
export const EDIT_DIFF_MAX_CHARS = 64 * 1024;

/** Lines in `text`, counted without splitting it. A trailing newline ends the last line rather than starting another. */
const countLines = (text: string): number => {
    if (!text) return 0;
    let lines = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
    return text.endsWith('\n') ? lines - 1 : lines;
};

/** Lines one edit removed and added, once the lines it merely quoted around the change are dropped. */
const editDelta = (before: string, after: string): { add: number; del: number } => {
    if (before.length + after.length > EDIT_DIFF_MAX_CHARS) return { add: countLines(after), del: countLines(before) };
    const a = before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    return { add: endB - start, del: endA - start };
};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `add`/`del` for a call that writes a file, or nothing for any other call. */
const lineChangesOf = (name: string, input: unknown): { add?: number; del?: number } => {
    if (!input || typeof input !== 'object') return {};
    const record = input as Record<string, unknown>;
    if (name === 'Write') {
        const content = str(record.content);
        return content ? { add: countLines(content) } : {};
    }
    let edits: Record<string, unknown>[];
    if (name === 'Edit') {
        // `replace_all` edits every occurrence; the input names the change
        // once, so it counts once — a low count, never a made-up one.
        edits = [record];
    } else if (name === 'MultiEdit' && Array.isArray(record.edits)) {
        edits = (record.edits as unknown[]).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
    } else {
        return {};
    }
    let add = 0;
    let del = 0;
    for (const edit of edits) {
        const before = str(edit.old_string);
        const after = str(edit.new_string);
        if (before === undefined || after === undefined) continue;
        const delta = editDelta(before, after);
        add += delta.add;
        del += delta.del;
    }
    return add || del ? { add, del } : {};
};

/** Lines of a result's text — a string, or the text blocks of a block list. Images and the like count as nothing. */
/**
 * How long a tool result was, from either shape a result body takes: a bare
 * string, or blocks with a `text` field. Exported for the same reason as
 * `clamp` — the shape is not one agent's vocabulary, and `lines` means the same
 * number on the wire whoever produced it.
 */
export const resultLinesOf = (content: unknown): number => {
    if (typeof content === 'string') return countLines(content);
    if (!Array.isArray(content)) return 0;
    let lines = 0;
    for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
            lines += countLines(str((block as Record<string, unknown>).text) ?? '');
        }
    }
    return lines;
};

/**
 * One line, always.
 *
 * A label is not a paragraph: a tool argument that runs to hundreds of
 * characters with newlines in it renders as a wall where a row's label belongs.
 * Applied by the projectors that need it rather than inside `targetFrom`,
 * because that helper feeds Claude's projector too and the Spec requires a
 * Claude timeline to stay byte-identical.
 */
export const oneLine = (target: string | undefined): string | undefined => target?.replace(/\s+/g, ' ');

/**
 * The backfill window, applied the same way by every projector.
 *
 * This is about `TurnEvent` and `ProjectorOptions`, not about any one agent's
 * vocabulary — unlike the per-format helpers beside it, which are deliberately
 * not shared. Every projector ends with this call, and a fourth one should too.
 */
export const sliceSinceLastPrompt = (events: TurnEvent[], opts: ProjectorOptions): TurnEvent[] => {
    if (!opts.sinceLastPrompt) return events;
    // Scanned backwards rather than by mapping to kinds and taking the last
    // index: the map allocates a whole array to find one number.
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].kind === 'prompt') return events.slice(i);
    }
    return events;
};

/**
 * Ceilings on a `todo` event: tasks kept, and characters per task. 30 tasks of
 * 100 Hangul characters each is under 10KB of JSON, inside the 12KB frame
 * (`MAX_TURN_FRAME_BYTES` in `turn-watch`), which sends an oversized event whole
 * rather than cutting it.
 */
export const MAX_TODO_ITEMS = 30;
export const MAX_TODO_TEXT_CHARS = 100;

/**
 * The `todo` event for a list. Over `MAX_TODO_ITEMS`, finished tasks go first,
 * oldest first — what is left to do is what the phone is watching for — and
 * `total` · `done` keep the real counts.
 */
export const todoEventOf = (list: TodoList, at: string | undefined): Extract<TurnEvent, { kind: 'todo' }> => {
    let items = list.items;
    if (items.length > MAX_TODO_ITEMS) {
        let surplus = items.length - MAX_TODO_ITEMS;
        items = items.filter((item) => {
            if (surplus > 0 && item.status === 'completed') {
                surplus--;
                return false;
            }
            return true;
        });
        items = items.slice(0, MAX_TODO_ITEMS);
    }
    return {
        kind: 'todo',
        items: items.map((item) => ({ ...item, text: clamp(item.text, MAX_TODO_TEXT_CHARS) })),
        ...(list.items.length > items.length
            ? { total: list.items.length, done: list.items.filter((item) => item.status === 'completed').length }
            : {}),
        ...(at ? { at } : {}),
    };
};

/** A usable number, or 0 — token counts are the one place a missing field must not become `NaN` on the wire. */
export const finiteNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** The `msg` for an assistant entry, or null when it carries no usable usage. */
const messageMetaOf = (entry: Record<string, unknown>, at: string | undefined): Extract<TurnEvent, { kind: 'msg' }> | null => {
    if (entry.type !== 'assistant') return null;
    const message = entry.message;
    if (!message || typeof message !== 'object') return null;
    const record = message as Record<string, unknown>;
    const mid = str(record.id);
    const usage = record.usage;
    const model = str(record.model);
    // `<synthetic>` is Claude Code standing in for the API (an error, an
    // interruption) — no model ran, and its zeroed usage would read as one did.
    if (!mid || !usage || typeof usage !== 'object' || model === '<synthetic>') return null;
    const u = usage as Record<string, unknown>;
    return {
        kind: 'msg',
        mid: clamp(mid),
        ...(model ? { model: clamp(model) } : {}),
        out: finiteNumber(u.output_tokens),
        ctx: finiteNumber(u.input_tokens) + finiteNumber(u.cache_read_input_tokens) + finiteNumber(u.cache_creation_input_tokens),
        ...(at ? { at } : {}),
    };
};

/**
 * Which input field reads as "what this call is about". Ordered, first match
 * wins: `description` leads because it is the sentence a human wrote about the
 * call, which is exactly what a collapsed timeline row wants.
 *
 * `command` is deliberately absent. It would only ever be reached for a Bash
 * call with no `description`, and measured over the 60 most recent transcripts
 * that is 0 of 2985 calls — while a command line is the single field here most
 * likely to carry a secret (an `Authorization` header, a token in a URL, a
 * profile name). Zero measured value against the worst downside on the list.
 *
 * This list is Claude Code's vocabulary. Another agent names its inputs
 * differently, so a second agent means a second projector, not a longer list —
 * see the note on `projectTranscriptEntries`.
 */
const TARGET_KEYS = ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'skill'] as const;

/**
 * Cut one field to the wire's budget. Exported because every projector shares
 * the same 12KB frame ceiling (`MAX_TURN_FRAME_BYTES` in `turn-watch`), so a
 * second projector with its own idea of "long enough" would be a second way to
 * overflow the one transport.
 */
export const clamp = (value: string, max = MAX_EVENT_FIELD_CHARS): string => {
    if (value.length <= max) return value;
    const cut = value.slice(0, max);
    // A UTF-16 slice can strand a high surrogate at the edge (e.g. an emoji
    // straddling the budget) — back off one unit so the wire never carries
    // a lone surrogate. Length stays within budget either way.
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * First of `keys` that holds a non-blank string, clamped — the loop every
 * projector needs, without the key list every projector has to choose for
 * itself. The keys stay the caller's: they are that agent's vocabulary, and
 * merging them into one list is exactly what the `TARGET_KEYS` note forbids.
 */
export const targetFrom = (input: unknown, keys: readonly string[]): string | undefined => {
    if (!input || typeof input !== 'object') return undefined;
    const record = input as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return clamp(value.trim());
    }
    return undefined;
};

const targetOf = (input: unknown): string | undefined => targetFrom(input, TARGET_KEYS);

const contentBlocks = (entry: Record<string, unknown>): Record<string, unknown>[] => {
    const message = entry.message;
    if (!message || typeof message !== 'object') return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
};

/**
 * A user entry whose content is a plain string is something the person typed.
 * One carrying an array of `tool_result` blocks is the harness answering the
 * model, and counting it as a prompt would cut every turn into fragments —
 * the same distinction `plugin/hooks/hwip-stop.sh` draws to scope a turn.
 */
/**
 * Harness plumbing that Claude Code writes into the conversation as if a person
 * had said it: background-task notifications, injected reminders, the caveat
 * wrapper around a slash command's own output.
 *
 * Dropping these is not cosmetic. A `<task-notification>` rendered as a prompt
 * bubble puts internal ids, tool-use ids and whatever a tool reported on a
 * phone screen, attributed to the user — and there is no bound on what a future
 * notification carries.
 */
const SYNTHETIC_BLOCKS = /<(task-notification|system-reminder|local-command-caveat|local-command-stdout|command-message|command-name|command-args)>[\s\S]*?<\/\1>/g;

/** `<command-name>/simplify</command-name>` — the one wrapper worth keeping, as what it names. */
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;

/**
 * Whether this entry is a person speaking.
 *
 * `origin.kind` is the honest answer where Claude Code writes it: `human` for
 * both a typed message and a slash command, something else for everything the
 * harness injects. Absent — an older version — it falls through to the tag
 * check below, so a build that does not stamp provenance still cannot leak a
 * notification it happens to phrase as a user turn.
 */
const isHumanTurn = (entry: Record<string, unknown>): boolean => {
    if (entry.promptSource === 'system') return false;
    const origin = entry.origin;
    if (origin && typeof origin === 'object') {
        const kind = (origin as Record<string, unknown>).kind;
        if (typeof kind === 'string') return kind === 'human';
    }
    return true;
};

/**
 * What Claude Code writes as a user message when the person presses Esc: the
 * whole text of the message is exactly this, in one of two forms (measured in
 * local transcripts: a single text block, no `origin`, not `isMeta`, so nothing
 * but the text tells it from a typed message). It says something happened to
 * the turn; it is not something the person said.
 *
 * Matched against the whole text only. A continuation summary or a message
 * that quotes the marker inside longer text is a person's or the harness's own
 * prose and stays.
 */
const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;

const promptTextOf = (entry: Record<string, unknown>): string | null => {
    const text = typedTextOf(entry);
    return text !== null && INTERRUPT_MARKER.test(text) ? null : text;
};

const typedTextOf = (entry: Record<string, unknown>): string | null => {
    if (entry.type !== 'user' || entry.isMeta) return null;
    if (!isHumanTurn(entry)) return null;
    const message = entry.message;
    if (!message || typeof message !== 'object') return null;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return nonEmpty(stripAttachmentMarkers(content));
    // An array is usually the harness answering the model, but the same shape
    // carries what a person typed when they attached something — the prompt
    // arrives as text blocks beside the attachment. Take those; a message with
    // no text block at all is a pure tool_result carrier and not a prompt.
    if (!Array.isArray(content)) return null;
    const text = content
        .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && b.type === 'text')
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('\n')
        .trim();
    return text ? nonEmpty(stripAttachmentMarkers(text)) : null;
};

/**
 * Drop the `[Image: source: /abs/path]` markers Claude Code substitutes for an
 * attached image.
 *
 * They are a local filesystem path and nothing else: useless on the phone, which
 * cannot open it, and a directory listing of this machine if it goes anywhere
 * else. The attachment itself is not on this wire — showing that one exists is a
 * separate feature, not a reason to ship the path.
 */
const stripAttachmentMarkers = (text: string): string => {
    const command = text.match(COMMAND_NAME)?.[1]?.trim();
    const body = text.replace(SYNTHETIC_BLOCKS, '');
    // A slash command is a person's turn, and its name is the whole of what they
    // said — the wrapper around it is not.
    const withCommand = command ? `${command}\n${body}` : body;
    return withCommand.replace(/\[Image:[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n');
};

/** Trimmed, or null when nothing survived — a message that was only an attachment. */
const nonEmpty = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed ? trimmed : null;
};

/**
 * Turn raw JSONL lines into wire events.
 *
 * Nothing a tool read or wrote survives this function: only the tool's name, a
 * short label for what it acted on, whether it worked, and numbers about it —
 * lines changed, result length, a message's tokens and model. That is the whole
 * privacy story of the feature — the transcript holds file contents and command
 * output, and this is the one place that decides none of it leaves the machine.
 *
 * `sinceLastPrompt` is for the backfill window: finished turns already exist in
 * the chat as their completion pushes, so replaying them would double every
 * message. Only the turn still in flight is new information.
 *
 * The prompt a person typed IS carried, unlike anything a tool read or wrote.
 * It is their own words, it is the same class of content the completion push
 * already sends, and without it the timeline is a list of tool names with no
 * record of what was asked.
 *
 * Everything here — the block shapes, the entry types, `TARGET_KEYS` — is Claude
 * Code's transcript format. Supporting another agent (pi, Codex) means a
 * projector of its own alongside this one, satisfying `TranscriptProjector` and
 * reached the way `REMOTE_AGENTS` already reaches per-agent session resolvers:
 * `RemoteAgent.projectTranscript`, resolved together with the path as a
 * `TranscriptSource`. `turn-watch` calls whichever projector it is handed and
 * knows about none of them by name.
 */
export const projectTranscriptEntries: TranscriptProjector = (lines, opts = {}): TurnEvent[] => {
    const events: TurnEvent[] = [];
    // One `msg` per API message in this batch, kept where it first appeared.
    const messages = new Map<string, Extract<TurnEvent, { kind: 'msg' }>>();
    let todo = opts.todo;
    let todoAt: string | undefined;

    for (const raw of lines) {
        let entry: Record<string, unknown>;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            entry = parsed as Record<string, unknown>;
        } catch {
            continue;
        }

        // A subagent's own tool calls belong to the Task/Agent call that spawned
        // it, which the parent transcript already shows as one row — unless this
        // IS the subagent's transcript, where every line is a sidechain and
        // dropping them leaves a viewer watching an empty file.
        if (entry.isSidechain && !opts.includeSidechain) continue;

        const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

        const folded = applyTodoEntry(todo, entry);
        if (folded !== todo) {
            todo = folded;
            // An entry with no time keeps the last one seen: `afterRingTail` cuts by `at`.
            todoAt = at ?? todoAt;
        }

        const prompt = promptTextOf(entry);
        if (prompt !== null) {
            events.push({ kind: 'prompt', text: clamp(prompt, MAX_EVENT_TEXT_CHARS), ...(at ? { at } : {}) });
            continue;
        }

        const blocks = contentBlocks(entry);
        const meta = messageMetaOf(entry, at);
        if (meta) {
            const thinking = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
            const seen = messages.get(meta.mid);
            if (seen) {
                // Same message, later line: usage is repeated, thinking is not.
                Object.assign(seen, { out: meta.out, ctx: meta.ctx });
                if (thinking) seen.thinking = (seen.thinking ?? 0) + thinking;
            } else {
                if (thinking) meta.thinking = thinking;
                messages.set(meta.mid, meta);
                events.push(meta);
            }
        }

        for (const block of blocks) {
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                const target = targetOf(block.input);
                events.push({
                    kind: 'tool',
                    id: block.id,
                    name: clamp(block.name),
                    ...(target ? { target } : {}),
                    ...lineChangesOf(block.name, block.input),
                    ...(at ? { at } : {}),
                });
                continue;
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const lines = resultLinesOf(block.content);
                events.push({
                    kind: 'tool_result',
                    id: block.tool_use_id,
                    ok: block.is_error !== true,
                    ...(lines ? { lines } : {}),
                    ...(at ? { at } : {}),
                });
                continue;
            }
            // Prose, only from the model. A user entry reaching here has already
            // been offered to `promptTextOf`; treating its text blocks as
            // assistant output is how an attachment marker ends up rendered as
            // the agent's own words.
            if (
                entry.type === 'assistant' &&
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text.trim()
            ) {
                events.push({ kind: 'text', text: clamp(block.text, MAX_EVENT_TEXT_CHARS), ...(at ? { at } : {}) });
            }
            // `thinking` falls through on purpose — the timeline shows what the
            // agent did, not what it considered. Only its count leaves, on `msg`.
        }
    }

    // One `todo` per read, after everything else: a read that moves five tasks
    // sends the list once, and being last it outlives `sliceSinceLastPrompt` —
    // a list made before the latest prompt is still the session's list.
    if (todo && todo !== opts.todo) {
        events.push(todoEventOf(todo, todoAt));
        opts.onTodo?.(todo);
    }

    return sliceSinceLastPrompt(events, opts);
};
