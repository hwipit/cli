/**
 * Background commands a Claude Code session is running (`Bash` with
 * `run_in_background: true`), read off its transcript.
 *
 * The phone shows them above the composer and can stop one. Measured
 * 2026-11-11 (Claude Code 2.x, `hwip cc`):
 *
 * - The launch is an assistant `tool_use` named `Bash` whose input has
 *   `run_in_background: true` and a `description` Claude wrote for it.
 * - Its `tool_result` reads `Command running in background with ID: <id>.
 *   Output is being written to: <path>` and carries the id again on
 *   `toolUseResult.backgroundTaskId`.
 * - The end is a `<task-notification>` naming the id. Current builds write it
 *   the moment the task ends — mid-turn too — as a `queue-operation`
 *   (`operation: enqueue`) and a `queued_command` attachment; earlier ones as
 *   a user turn with `origin.kind: 'task-notification'`. All three are read.
 *
 * Only the harness's own records count as an end: a tool result that prints
 * a notice (a session reading a transcript) carries the words but is not an
 * event. The command line is never kept — it is what a secret would be typed
 * into; the description is what the phone shows.
 *
 * A session whose Claude died never writes the notice, and the task's process
 * may be gone with it. So a running task also needs a live writer on its
 * output file, asked at most once per `BACKGROUND_TASK_PROBE_MS` for all of a
 * session's tasks together.
 */
import { existsSync, realpathSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';

import { TASK_END, TASK_ID } from './subagent-transcripts.js';
import { readTranscriptDelta, type TailState } from './transcript-tail.js';

/** How often a session's tasks have their output writers checked. */
export const BACKGROUND_TASK_PROBE_MS = 15_000;

/** Most tasks one session keeps — a runaway loop of launches cannot grow the listener without bound. */
export const MAX_BACKGROUND_TASKS = 50;

/** Longest description kept; Claude writes a few words. */
const MAX_DESCRIPTION_CHARS = 200;

export interface BackgroundTask {
    readonly id: string;
    readonly description: string | null;
    /** When the launch result was written, or null when the line had no stamp. */
    readonly startedAt: string | null;
    /** Where Claude Code writes the task's output, exactly as the transcript said. */
    readonly outputPath: string;
}

/**
 * Which of `paths` some process still has open, or null when that cannot be
 * told (no `lsof`, a timeout). Null keeps every task: not knowing is not dead.
 */
export type WriterProbe = (paths: readonly string[]) => ReadonlySet<string> | null;

export interface BackgroundTaskState {
    tail: TailState | null;
    /** Background launches whose result has not been read yet: tool_use id → description. */
    readonly launches: Map<string, string | null>;
    /** Running tasks by id, in launch order. */
    readonly running: Map<string, BackgroundTask>;
    /** When writers were last checked; -Infinity before the first check. */
    probedAt: number;
}

export const initialBackgroundTaskState = (): BackgroundTaskState => ({
    tail: null,
    launches: new Map(),
    running: new Map(),
    probedAt: Number.NEGATIVE_INFINITY,
});

const STARTED = /Command running in background with ID: ([A-Za-z0-9]{1,32})\. Output is being written to: (\S+?\.output)\b/;

type Entry = {
    type?: unknown;
    timestamp?: unknown;
    operation?: unknown;
    content?: unknown;
    origin?: { kind?: unknown };
    attachment?: { commandMode?: unknown; prompt?: unknown };
    message?: { content?: unknown };
    toolUseResult?: { backgroundTaskId?: unknown };
};

const textOf = (content: unknown): string | null => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const texts = content.flatMap((b: { type?: unknown; text?: unknown }) =>
        b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []);
    return texts.length > 0 ? texts.join('\n') : null;
};

/** The notice text of a harness record that reports a task ending, or null. */
const noticeOf = (entry: Entry): string | null => {
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue') return typeof entry.content === 'string' ? entry.content : null;
    if (entry.type === 'attachment' && entry.attachment?.commandMode === 'task-notification') {
        return typeof entry.attachment.prompt === 'string' ? entry.attachment.prompt : null;
    }
    if (entry.type === 'user' && entry.origin?.kind === 'task-notification') return textOf(entry.message?.content);
    return null;
};

const fold = (state: BackgroundTaskState, line: string): void => {
    // Cheap reject: every line the session writes passes through here.
    if (!line.includes('run_in_background') && !line.includes('in background with ID') && !line.includes('<task-notification>')) return;
    let entry: Entry;
    try {
        entry = JSON.parse(line) as Entry;
    } catch {
        return;
    }
    const notice = noticeOf(entry);
    if (notice !== null) {
        const id = TASK_END.test(notice) ? TASK_ID.exec(notice)?.[1] : undefined;
        if (id) state.running.delete(id);
        return;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
        if (entry.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') {
            const input = block.input as { run_in_background?: unknown; description?: unknown } | undefined;
            if (input?.run_in_background !== true) continue;
            const description = typeof input.description === 'string' && input.description.trim()
                ? input.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
                : null;
            state.launches.set(block.id, description);
        } else if (entry.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            if (!state.launches.has(block.tool_use_id)) continue;
            const description = state.launches.get(block.tool_use_id) ?? null;
            state.launches.delete(block.tool_use_id);
            const match = STARTED.exec(textOf(block.content) ?? '');
            if (!match) continue;
            const structured = entry.toolUseResult?.backgroundTaskId;
            const id = typeof structured === 'string' && structured === match[1] ? structured : match[1]!;
            if (state.running.size >= MAX_BACKGROUND_TASKS) continue;
            state.running.set(id, {
                id,
                description,
                startedAt: typeof entry.timestamp === 'string' ? entry.timestamp : null,
                outputPath: match[2]!,
            });
        }
    }
};

const realPathOrSelf = (p: string): string => {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
};

const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof'];

/**
 * `lsof -F n -- <paths>`: one `n<name>` line per open file. lsof exits 1 when
 * any one of the paths is open nowhere — still an answer, printed for the
 * rest; a spawn failure, a timeout or another status is no answer.
 */
export const lsofWriters: WriterProbe = (paths) => {
    const bin = LSOF_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!bin || paths.length === 0) return null;
    const r = spawnSync(bin, ['-F', 'n', '--', ...paths], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    return openAmong(paths, r.stdout);
};

/** An answer that resolves later: what the phone's requests use on the main thread. */
export type AsyncWriterProbe = (paths: readonly string[]) => Promise<ReadonlySet<string> | null>;

/**
 * `lsofWriters` without blocking: the main thread serves the socket, and a
 * synchronous spawn there delays frames and pongs (inventory-offload.ts).
 */
export const lsofWritersAsync: AsyncWriterProbe = (paths) => {
    const bin = LSOF_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!bin || paths.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
        execFile(bin, ['-F', 'n', '--', ...paths], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS }, (err, stdout) => {
            // Exit 1 is still an answer (one path open nowhere); a timeout, a spawn failure or another status is none.
            const code = (err as { code?: unknown } | null)?.code;
            resolve(!err || code === 1 ? openAmong(paths, stdout) : null);
        });
    });
};

const LSOF_TIMEOUT_MS = 3_000;

/** Which of `paths` lsof's `-F n` output names. lsof names a file by its real path (/tmp is /private/tmp on macOS). */
const openAmong = (paths: readonly string[], stdout: string): ReadonlySet<string> => {
    const open = new Set<string>();
    for (const row of stdout.split('\n')) if (row.startsWith('n')) open.add(row.slice(1));
    return new Set(paths.filter((p) => open.has(p) || open.has(realPathOrSelf(p))));
};

/**
 * Fold what the transcript appended since the last call, then drop tasks
 * whose output nobody writes any more (at most once per probe window).
 * Returns the running tasks in launch order.
 */
export const trackBackgroundTasks = (
    transcriptPath: string,
    state: BackgroundTaskState,
    opts: { probe?: WriterProbe; now?: number } = {},
): BackgroundTask[] => {
    const read = readTranscriptDelta(transcriptPath, state.tail);
    if (read) {
        state.tail = read.state;
        for (const line of read.lines) fold(state, line);
    }
    const now = opts.now ?? Date.now();
    if (state.running.size > 0 && now - state.probedAt >= BACKGROUND_TASK_PROBE_MS) {
        state.probedAt = now;
        const tasks = [...state.running.values()];
        const open = (opts.probe ?? lsofWriters)(tasks.map((t) => t.outputPath));
        if (open) for (const t of tasks) if (!open.has(t.outputPath)) state.running.delete(t.id);
    }
    return [...state.running.values()];
};

/** A Claude session's running background commands, with the pane they run under (what Stop checks ancestry against). */
export interface SessionBackgroundTasks {
    readonly tasks: readonly BackgroundTask[];
    readonly panePid: number | null;
}

/**
 * The main thread's copy of the last sweep's tasks. The sweep may run on the
 * inventory worker, whose module state the main thread cannot see, so the
 * result travels back on `CollectResult` and lands here — the phone's
 * requests are answered from this.
 */
let tasksBySession = new Map<string, SessionBackgroundTasks>();

export const recordBackgroundTasks = (bySession: Record<string, SessionBackgroundTasks> | null | undefined): void => {
    tasksBySession = new Map(Object.entries(bySession ?? {}));
};

/** The session's running background commands as of the last sweep; null when it has none. */
export const backgroundTasksFor = (sessionName: string): SessionBackgroundTasks | null => tasksBySession.get(sessionName) ?? null;
