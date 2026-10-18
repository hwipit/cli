/**
 * Claude Code subagents — the ones that never get a tmux pane.
 *
 * `listener.ts` finds a subagent by looking for an extra pane of a session
 * (pi splits one off per subagent). Claude Code's `Agent` tool runs its
 * subagents in-process instead: no pane, no process of their own, nothing the
 * pane sweep can see. What they do leave is a transcript, beside the parent's:
 *
 *   ~/.claude/projects/<project>/<sessionId>.jsonl          ← parent
 *   ~/.claude/projects/<project>/<sessionId>/subagents/
 *       agent-<agentId>.jsonl                               ← one per subagent
 *
 * So this module is the pane sweep's counterpart for a source that is a
 * directory of files rather than a list of panes. It returns the same thing the
 * sweep returns — rows the phone can show — and nothing about what a row means
 * changes: `<parent>.<n>` is still a view-only wire name, still never a tmux
 * target (see `subagentParentOf` in the app's shared package).
 *
 * Everything here is Claude Code's private layout, measured on 2.1.268, not a
 * published contract. The one state that proves it moved — the parent says it
 * launched a subagent, the directory is not there — is logged once, because
 * the alternative failure is this feature vanishing in silence.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
    initialTailState,
    projectTranscriptEntries,
    readTranscriptDelta,
    type TailState,
} from './transcript-tail.js';

/** How recently a subagent transcript must have grown to count as working. */
export const SUBAGENT_WORKING_MS = 15_000;

/**
 * How long a quiet subagent stays on the roster.
 *
 * A finished subagent leaves its file behind forever — a session directory
 * holds a dozen of them within a day (measured) — so "the file exists" cannot
 * be what puts a chip on the phone. Recent activity is.
 */
export const SUBAGENT_LIVE_MS = 5 * 60_000;

/**
 * How long a subagent stays ADDRESSABLE after it goes quiet — longer than it
 * stays on the roster, because the two answer different questions.
 *
 * A chip is "is this worth showing"; an address is "can a viewer still read
 * this". Dropping the address on the roster's clock closes the screen of
 * whoever is reading it: the watcher asks whether the session still exists,
 * the answer comes from this map, and a subagent thinking for five minutes
 * (a long Bash, a long tool chain) would take its own reader down with it.
 */
export const SUBAGENT_ADDRESSABLE_MS = 60 * 60_000;

/**
 * How far a subagent's last write may trail the parent's record of its end and
 * still belong to the run that ended.
 *
 * The final flush lands after the notice: measured 2026-09-14 over 572 ended
 * subagents, 20 wrote after their end record, all within 42 ms. The other three
 * that did came 153 s or more later — resumed work, which must not read as
 * ended. A second sits far from both.
 */
export const SUBAGENT_END_SLACK_MS = 1_000;

/**
 * How much subagent transcript one sweep reads, in total, before it stops and
 * lets the next sweep carry on. A first sight reads from the top (the count and
 * the start have to be the subagent's own, not a window's), and transcripts
 * reach megabytes — so a very large one, or many sessions' worth after a
 * restart, is caught up over a few sweeps instead of one long stall, and a count
 * only rises toward the true one meanwhile. A caller that sweeps several
 * sessions passes one shared `catchUp` so the total holds across all of them.
 */
export const SUBAGENT_CATCH_UP_BYTES = 4 * 1024 * 1024;

/** What is left of a sweep's read budget; shared by every scan that gets the same object. */
export interface CatchUpBudget {
    bytes: number;
}

/**
 * How often a file that has been quiet past `SUBAGENT_ADDRESSABLE_MS` is
 * looked at again. It cannot be on the roster, so the sweep has no use for its
 * mtime — except to notice that it was written to, which a resumed subagent
 * does (measured, see `SUBAGENT_END_SLACK_MS`). A minute late is fine for that;
 * a stat of every old file every few seconds is not, once a long session's
 * directory holds hundreds of them.
 */
export const SUBAGENT_STALE_RECHECK_MS = 60_000;

/** Rows one session may contribute. The switcher is a strip of chips, not a list. */
export const MAX_SUBAGENT_ROWS = 5;

/** Quiet-but-addressable subagents kept beyond the live ones, so a viewer
 *  reading one is not cut off the moment newer subagents crowd the roster. */
const MAX_ADDRESSABLE_EXTRA = 5;

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

export interface SubagentRow {
    /** Wire name: `<parent>.<n>`, the shape the server reads as view-only. */
    readonly name: string;
    /** Recent enough to belong on the roster. A row that is not live is still
     *  addressable — see `SUBAGENT_ADDRESSABLE_MS`. */
    readonly live: boolean;
    readonly agentId: string;
    readonly label: string;
    readonly transcriptPath: string;
    readonly lastActivityAt: string;
    readonly working: boolean;
    /**
     * Calls the subagent has made — the phone's only measure of how much is
     * happening inside a session that has gone quiet.
     *
     * Counted from the top of its transcript the first time it is seen, then
     * incrementally, so a listener that restarts mid-subagent shows the same
     * number it did before. A transcript too large for one sweep is read over
     * several (`SUBAGENT_CATCH_UP_BYTES`) and reports a lower bound meanwhile.
     */
    readonly toolCount: number;
    /** Its first stamped event, or null while it has written nothing worth timing. Null rather than the file's mtime: a fresh
     *  file would otherwise claim a duration it never ran for. */
    readonly startedAt: string | null;
}

/** What has been read out of one subagent's transcript so far. */
interface Progress {
    tail: TailState | null;
    toolCount: number;
    startedAt: string | null;
}

/**
 * What must survive between sweeps, per parent session.
 *
 * `order` is the reason this is not a pure function: a subagent's number is
 * whatever it got the first time it was seen. Numbering by anything read off
 * the filesystem — mtime, readdir order — renumbers live chips underneath the
 * viewer as other subagents come and go.
 */
export interface SubagentScanState {
    readonly order: Map<string, number>;
    readonly labels: Map<string, string>;
    /** Per subagent, by agentId: where its transcript was last read to, and
     *  what had been counted by then. Incremental for the same reason the
     *  parent's scan is — these files reach megabytes and this runs every sweep. */
    readonly progress: Map<string, Progress>;
    /** Per subagent, by agentId: when the parent was last told it ended. */
    readonly endedAt: Map<string, number>;
    /** Per subagent file, by agentId: the mtime last read and when. A file quiet
     *  past `SUBAGENT_ADDRESSABLE_MS` is trusted for `SUBAGENT_STALE_RECHECK_MS`
     *  rather than stat'd on every sweep. */
    readonly seen: Map<string, { mtimeMs: number; checkedAt: number }>;
    tail: TailState | null;
    nextNumber: number;
    launchSeen: boolean;
    driftLogged: boolean;
}

export const initialSubagentScanState = (): SubagentScanState => ({
    order: new Map(),
    labels: new Map(),
    progress: new Map(),
    endedAt: new Map(),
    seen: new Map(),
    tail: initialTailState(),
    nextNumber: 1,
    launchSeen: false,
    driftLogged: false,
});

const SUBAGENT_DIR = 'subagents';

/** Where Claude Code keeps this session's subagent transcripts. */
export const subagentDirFor = (parentTranscriptPath: string): string =>
    join(dirname(parentTranscriptPath), basename(parentTranscriptPath, '.jsonl'), SUBAGENT_DIR);

/**
 * Whether a transcript is a subagent's own — which decides whether its sidechain
 * entries are internals to hide or the whole content to show.
 *
 * Asked of the PATH rather than the session name: a name says what the phone
 * calls a row, the directory says what Claude Code wrote, and the projection
 * cares about the second.
 */
export const isSubagentTranscriptPath = (transcriptPath: string): boolean =>
    basename(dirname(transcriptPath)) === SUBAGENT_DIR;

/**
 * Watch the parent for the one thing the transcript directory cannot say: that
 * a subagent was launched at all. That is what separates "this session never
 * spawned" from "Claude Code stopped writing where we look" (see the drift log
 * below).
 *
 * An `Agent` tool call is the signal — both spawn kinds make one, while the
 * launch record (`toolUseResult.agentId`) is written only for the async ones.
 * It is not every spawn: measured 2026-09-13 over every session on this
 * machine, 33 of the 137 sessions that have subagent transcripts never called
 * `Agent` in the parent (a skill or a teammate spawned them). Those sessions
 * keep working; they just cannot report layout drift, which is a diagnostic.
 *
 * Incremental on purpose — a parent transcript reaches megabytes, and this runs
 * every sweep. `readTranscriptDelta` returns null when the file has not moved,
 * which is the normal case and costs nothing.
 */
const isAgentToolUse = (line: string): boolean => {
    // Cheap reject first: parsing every line of a megabyte transcript to find
    // one tool call would undo what the incremental read is for. The substring
    // alone is not the answer — a transcript that merely QUOTES this code (a
    // review of this file, say) contains it as prose.
    if (!line.includes('"name":"Agent"')) return false;
    let entry: { message?: { content?: unknown } };
    try {
        entry = JSON.parse(line);
    } catch {
        return false;
    }
    const content = entry.message?.content;
    return Array.isArray(content)
        && content.some((block) => block?.type === 'tool_use' && block?.name === 'Agent');
};

/** The four ways Claude Code reports a background subagent stopping — measured
 *  2026-09-14 over every parent transcript on this machine (787 completed, 12
 *  failed, 12 killed, 2 stopped, nothing else). */
const TASK_END = /<status>(?:completed|failed|killed|stopped)<\/status>/;
const TASK_ID = /<task-id>([^<]{1,200})<\/task-id>/;

/**
 * The subagent a parent line says has ended, and when — or null.
 *
 * Two shapes, one per spawn kind. A background subagent's end arrives as a user
 * turn the harness writes (`origin.kind: 'task-notification'`) naming it by
 * `<task-id>`; a foreground one's is its `Agent` call returning, with the
 * agent id on `toolUseResult`. The async LAUNCH record carries an agent id too,
 * which is why the status is part of the match and not only the id.
 *
 * Both marks are the harness's own fields, never text: the parent's reply
 * quoting a notice — which is what a session reporting its subagent's result
 * does — carries the words but neither `origin` nor `toolUseResult`.
 */
const subagentEndOf = (line: string): { agentId: string; at: number } | null => {
    // Cheap reject, as in `isAgentToolUse`: this reads every line the parent writes.
    if (!line.includes('<task-notification>') && !line.includes('"status":"completed"')) return null;
    let entry: {
        timestamp?: unknown;
        origin?: { kind?: unknown };
        message?: { content?: unknown };
        toolUseResult?: { status?: unknown; agentId?: unknown };
    };
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof entry.timestamp !== 'string') return null;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) return null;
    const result = entry.toolUseResult;
    if (result?.status === 'completed' && typeof result.agentId === 'string') return { agentId: result.agentId, at };
    const content = entry.message?.content;
    if (entry.origin?.kind !== 'task-notification' || typeof content !== 'string' || !TASK_END.test(content)) return null;
    const agentId = TASK_ID.exec(content)?.[1];
    return agentId ? { agentId, at } : null;
};

/**
 * Fold what the parent appended since the last sweep: whether it launched a
 * subagent (until it has), and which subagents it was told have ended.
 *
 * Read every sweep, not only until the launch is seen, because the end notice
 * comes later. Still costs a stat on a sweep where the parent has not moved.
 * The first read opens a window off the end (`TRANSCRIPT_BACKFILL_BYTES`), so an
 * end older than that window is not seen — that subagent leaves the roster on
 * `SUBAGENT_LIVE_MS` instead, as every subagent did before this signal.
 */
const absorbParentDelta = (parentTranscriptPath: string, state: SubagentScanState): void => {
    const read = readTranscriptDelta(parentTranscriptPath, state.tail);
    if (!read) return;
    state.tail = read.state;
    if (!state.launchSeen) state.launchSeen = read.lines.some(isAgentToolUse);
    for (const line of read.lines) {
        const end = subagentEndOf(line);
        // The latest notice wins: a resumed subagent ends again.
        if (end && end.at > (state.endedAt.get(end.agentId) ?? -Infinity)) state.endedAt.set(end.agentId, end.at);
    }
};

/**
 * The subagent's own label, from the sidecar Claude Code writes beside its
 * transcript (`agent-<id>.meta.json`).
 *
 * Measured 2026-09-13 over every session on this machine — 823 subagent
 * transcripts, 823 sidecars, `agentType` on all of them and `description` on
 * 817 — while the parent's launch record covers only the async spawns (53%).
 * So the sidecar is the source, and the parent is read for nothing but the
 * fact that a spawn happened.
 */
const readSidecarLabel = (transcriptPath: string): string | null => {
    let meta: { description?: unknown; agentType?: unknown };
    try {
        meta = JSON.parse(readFileSync(`${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`, 'utf-8'));
    } catch {
        return null;
    }
    for (const value of [meta.description, meta.agentType]) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
};

/**
 * The label for one subagent, cached once found. A positional fallback is NOT
 * cached: the sidecar is written beside the transcript, so a scan that caught a
 * subagent in its first moments can still learn its name on the next sweep.
 */
const rememberLabel = (state: SubagentScanState, agentId: string, transcriptPath: string, number: number): string => {
    const label = readSidecarLabel(transcriptPath);
    if (!label) return `Agent ${number}`;
    state.labels.set(agentId, label);
    return label;
};

/**
 * Read what a subagent has appended since the last sweep, and fold it into the
 * running count.
 *
 * Its own transcript is entirely sidechain entries — that is what makes it a
 * subagent's file — so the projection is told to keep them, exactly as
 * `turn-watch` does when it tails one of these for a viewer.
 */
const advanceProgress = (state: SubagentScanState, agentId: string, path: string, budget: CatchUpBudget): Progress => {
    let progress = state.progress.get(agentId) ?? { tail: initialTailState(), toolCount: 0, startedAt: null };
    // Until caught up or out of budget: the usual sweep reads a few lines and
    // stops after one pass, a first sight of a big file takes several.
    while (budget.bytes > 0) {
        const read = readTranscriptDelta(path, progress.tail, { fromStart: true });
        if (!read) break;
        // A new inode at the same path is a different file, and a file now shorter
        // than where this read had got to was cut in place; everything counted off
        // the old one describes work this one never did.
        const restarted = progress.tail !== null
            && (read.state.ino !== progress.tail.ino || read.state.size < progress.tail.offset);
        const events = projectTranscriptEntries(read.lines, { includeSidechain: true });
        const firstStamp = events.find((event) => event.at)?.at ?? null;
        progress = {
            tail: read.state,
            toolCount: (restarted ? 0 : progress.toolCount) + events.filter((event) => event.kind === 'tool').length,
            startedAt: restarted ? firstStamp : (progress.startedAt ?? firstStamp),
        };
        state.progress.set(agentId, progress);
        // Nothing consumed means the read stopped short of a character boundary
        // (a write caught mid-sequence): leave it for the next sweep.
        if (read.bytesRead === 0) break;
        budget.bytes -= read.bytesRead;
        if (read.state.offset >= read.state.size) break;
    }
    return progress;
};

interface AgentFile {
    readonly agentId: string;
    readonly path: string;
    readonly mtimeMs: number;
}

/** `null` ONLY when the directory is not there; `'unreadable'` when it could not
 *  be listed for any other reason — reported as its own failure rather than as
 *  the layout having moved, and never taken as "the subagents are gone".
 *
 *  A file is stat'd when it is new to this scan, when it was recently active
 *  (its mtime is what orders the roster), or when a quiet one is due another look
 *  (`SUBAGENT_STALE_RECHECK_MS`). Every other file — the long tail of subagents
 *  that finished hours ago — is taken from the last stat. */
const readAgentFiles = (
    dir: string,
    state: SubagentScanState,
    now: number,
    log?: (message: string) => void,
): AgentFile[] | null | 'unreadable' => {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        log?.(`! ${dir}: unreadable (${(err as Error).message}) — subagents of this session stay hidden`);
        return 'unreadable';
    }
    const files: AgentFile[] = [];
    const present = new Set<string>();
    for (const name of names) {
        const agentId = AGENT_FILE.exec(name)?.[1];
        if (!agentId) continue;
        present.add(agentId);
        const path = join(dir, name);
        const known = state.seen.get(agentId);
        if (known && now - known.mtimeMs > SUBAGENT_ADDRESSABLE_MS && known.checkedAt <= now && now - known.checkedAt < SUBAGENT_STALE_RECHECK_MS) {
            files.push({ agentId, path, mtimeMs: known.mtimeMs });
            continue;
        }
        try {
            const mtimeMs = statSync(path).mtimeMs;
            state.seen.set(agentId, { mtimeMs, checkedAt: now });
            files.push({ agentId, path, mtimeMs });
        } catch {
            // Vanished between readdir and stat: a subagent file is never
            // rewritten, so this is a deletion, not a race worth reporting.
            present.delete(agentId);
        }
    }
    for (const agentId of state.seen.keys()) if (!present.has(agentId)) state.seen.delete(agentId);
    return files;
};

/**
 * Drop what was kept about subagents that are off the roster for good: the file
 * is gone, or has been quiet past `SUBAGENT_ADDRESSABLE_MS`. The maps are keyed
 * by agentId and a session can run for days, so without this each holds a
 * finished subagent's entry for as long as the session lives. A subagent that
 * resumes after that is simply seen anew — read from the top, so its count is
 * still its own. `seen` keeps the quiet ones: it is what spares them a stat.
 */
const forgetDormant = (state: SubagentScanState, files: readonly AgentFile[], now: number): void => {
    const active = new Set(files.filter((file) => now - file.mtimeMs <= SUBAGENT_ADDRESSABLE_MS).map((file) => file.agentId));
    for (const map of [state.order, state.labels, state.progress, state.endedAt] as const) {
        for (const agentId of map.keys()) if (!active.has(agentId)) map.delete(agentId);
    }
};

/**
 * The live subagents of one Claude Code session, in chip order (by number).
 *
 * `state` is mutated — it belongs to the caller and lives as long as the
 * session does, which is what keeps a chip's number and label stable across
 * sweeps.
 */
export const scanSubagents = (
    parentName: string,
    parentTranscriptPath: string,
    state: SubagentScanState,
    opts: { now?: number; log?: (message: string) => void; reserved?: ReadonlySet<number>; catchUp?: CatchUpBudget } = {},
): SubagentRow[] => {
    const now = opts.now ?? Date.now();
    const catchUp = opts.catchUp ?? { bytes: SUBAGENT_CATCH_UP_BYTES };
    absorbParentDelta(parentTranscriptPath, state);

    const dir = subagentDirFor(parentTranscriptPath);
    const files = readAgentFiles(dir, state, now, opts.log);
    // A listing that failed says nothing about the subagents: keep every number
    // and count, and show nothing this sweep, as before.
    if (files === 'unreadable') return [];
    if (!files) {
        forgetDormant(state, [], now);
        state.seen.clear();
        // No directory. Only surprising once the parent has said it launched
        // something — before that, this is every session that never spawned.
        if (state.launchSeen && !state.driftLogged) {
            state.driftLogged = true;
            opts.log?.(`! ${parentName}: launched a subagent but ${dir} does not exist — Claude Code layout changed?`);
        }
        return [];
    }
    forgetDormant(state, files, now);

    const kept = files
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .filter((file) => now - file.mtimeMs <= SUBAGENT_ADDRESSABLE_MS)
        .slice(0, MAX_SUBAGENT_ROWS + MAX_ADDRESSABLE_EXTRA)
        // The roster is the most recent few; everything else kept here is an
        // address for a viewer who is already inside one of them.
        .map((file, index) => {
            const endedAt = state.endedAt.get(file.agentId);
            // Ended unless it wrote again after the notice — a resumed subagent
            // is working again, and the notice describes the run before.
            const ended = endedAt !== undefined && file.mtimeMs <= endedAt + SUBAGENT_END_SLACK_MS;
            return {
                ...file,
                ended,
                live: !ended && index < MAX_SUBAGENT_ROWS && now - file.mtimeMs <= SUBAGENT_LIVE_MS,
            };
        });

    // Numbered in activity order, then handed back in number order: the cut
    // above keeps the subagents worth showing, and this keeps the chips from
    // swapping places under the viewer every time one of them writes a line.
    const rows = kept.map((file) => {
        // A pane subagent of the same session owns its pane id as a number
        // (`hwip-x.48`), and two rows with one name is a switcher showing the
        // wrong transcript. Checked on every sweep, not only when the number is
        // first handed out: pane ids keep being created, so a number that was
        // free can stop being free — and a chip that renumbers beats two chips
        // that are the same session name.
        let number = state.order.get(file.agentId);
        if (number === undefined || opts.reserved?.has(number)) {
            while (opts.reserved?.has(state.nextNumber)) state.nextNumber++;
            number = state.nextNumber++;
            state.order.set(file.agentId, number);
        }
        // Only a row the phone shows is read: an addressable one that has gone
        // quiet is read the moment it writes again and becomes live. Its last
        // count, if it had one, stands in the meantime.
        const progress = file.live
            ? advanceProgress(state, file.agentId, file.path, catchUp)
            : state.progress.get(file.agentId) ?? { tail: initialTailState(), toolCount: 0, startedAt: null };
        return {
            number,
            name: `${parentName}.${number}`,
            agentId: file.agentId,
            toolCount: progress.toolCount,
            startedAt: progress.startedAt,
            label: state.labels.get(file.agentId) ?? rememberLabel(state, file.agentId, file.path, number),
            transcriptPath: file.path,
            lastActivityAt: new Date(file.mtimeMs).toISOString(),
            live: file.live,
            working: !file.ended && now - file.mtimeMs <= SUBAGENT_WORKING_MS,
        };
    });
    return rows.sort((a, b) => a.number - b.number).map(({ number: _number, ...row }) => row);
};
