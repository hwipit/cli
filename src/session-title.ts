/**
 * The latest value a session transcript states for something — Claude Code's
 * `ai-title`, pi's `session_info` name — kept current without re-reading the
 * file every report cycle.
 *
 * The listener resolves every session's name every ~5 s, and a transcript runs
 * to tens of megabytes. So each file is read the way the chat tail reads it:
 * the last `TRANSCRIPT_BACKFILL_BYTES` once, then only what was appended, and
 * nothing at all while the file is unchanged. The value is what the newest
 * matching line said; a chunk with no matching line leaves it as it was.
 */
import { readTranscriptDelta, type TailRead, type TailState } from './transcript-tail.js';

/** Who named a session: someone in the agent (`/rename`, `/name`), or the agent itself. */
export type ProviderNameSource = 'user' | 'auto';

/** A session name as an agent reports it. No `source` when the agent's store does not say. */
export interface ProviderName {
    readonly name: string;
    readonly source?: ProviderNameSource;
}

interface Watched<T> {
    readonly tail: TailState;
    readonly value: T | undefined;
}

/**
 * How many transcripts one watch remembers. The listener never says that a
 * session is gone, so the watch bounds itself instead: far above the sessions
 * one machine runs at once, and a dropped file only costs one backfill read.
 */
const DEFAULT_CAPACITY = 64;

export const createTailWatch = <T,>(
    pick: (line: string) => T | undefined,
    read: (path: string, prev: TailState | null) => TailRead | null = readTranscriptDelta,
    capacity = DEFAULT_CAPACITY,
) => {
    // Map order is insertion order; re-inserting on every read makes the first
    // key the least recently read.
    const files = new Map<string, Watched<T>>();

    const remember = (path: string, entry: Watched<T>): void => {
        files.delete(path);
        files.set(path, entry);
        if (files.size <= capacity) return;
        const oldest = files.keys().next().value;
        if (oldest !== undefined) files.delete(oldest);
    };

    return {
        read: (path: string): T | undefined => {
            const prev = files.get(path);
            const delta = read(path, prev?.tail ?? null);
            if (!delta) {
                if (prev) remember(path, prev);
                return prev?.value;
            }
            // A new inode, or a file cut below where we were, is another file:
            // the reader restarted it, and the old value described what is gone.
            const restarted = prev !== undefined
                && (delta.state.ino !== prev.tail.ino || delta.state.size < prev.tail.offset);
            let value = restarted ? undefined : prev?.value;
            for (const line of delta.lines) {
                const picked = pick(line);
                if (picked !== undefined) value = picked;
            }
            remember(path, { tail: delta.state, value });
            return value;
        },
        size: (): number => files.size,
        has: (path: string): boolean => files.has(path),
    };
};


/**
 * The title out of a Claude Code `{"type":"ai-title","aiTitle":"…"}` line.
 * The substring test runs first so the other few thousand lines of a
 * transcript are never handed to `JSON.parse`.
 */
export const claudeAiTitleOf = (line: string): string | undefined => {
    if (!line.includes('"ai-title"')) return undefined;
    try {
        const entry = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
        if (entry.type !== 'ai-title' || typeof entry.aiTitle !== 'string') return undefined;
        return entry.aiTitle.trim() || undefined;
    } catch {
        return undefined; // a torn or foreign line — the next title will do
    }
};
