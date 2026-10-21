/**
 * What a session WAS, kept so it can be started again.
 *
 * tmux is the only record of a live session, and it forgets one the moment it
 * ends — which is exactly when the phone wants it back. So the listener writes
 * down what it saw while the session was alive: where it ran and which agent it
 * ran, keyed by the tmux name the phone already addresses it by **and** the
 * agent that ran under it — tmux hands the same name out again, and one row per
 * name meant the next occupant erased the last one's record (`runKey`).
 *
 * This file is the whitelist that makes remote resume safe. A resume request
 * carries a session NAME and nothing else; the directory and the binary come
 * from here, from what this machine observed itself. Nothing a phone (or a
 * relay posing as one) sends can point the daemon at another directory or
 * another program.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { removeTurnRing } from './turn-ring.js';
import { stateDir } from './gate.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import type { ProviderNameSource } from './session-title.js';

export interface KnownSession {
    /** tmux session name — the key the phone addresses. */
    name: string;
    /** Pane cwd while it was alive. Where a resume starts the agent again. */
    cwd: string;
    /** RemoteAgent `kind` (claude/codex/…), resolved to a binary at resume time. */
    agentKind: string;
    project?: string;
    label?: string;
    /**
     * Which run of the name this was (hwip docs/session-runs.md): tmux
     * `session_created` in epoch seconds, as a decimal string. Absent from
     * entries written before runs were recorded.
     */
    runId?: string;
    /** When that run started (ISO) — the same instant as `runId`. */
    startedAt?: string;
    /**
     * The agent's own id for the conversation this run last had, as the sweep
     * read it off the live pane — what a resume picks back up. Absent for an
     * agent whose id this machine cannot read, and in files written before it.
     */
    agentSessionId?: string;
    /**
     * The later tmux sessions this run went on in (`session_created`, as
     * `runId`): the same conversation carried on after an `exit` is the same
     * run (`continuedRunId`). Absent for a run that has had one tmux session.
     */
    tmuxRunIds?: string[];
    /**
     * The last name the agent gave this run (Claude's ai-title or `/rename`,
     * …) and who gave it, as the sweep read them: what the phone calls the run
     * once it has ended (hwip docs/session-runs.md Q39). Absent for a run never
     * named, and in files written before it.
     */
    providerSessionName?: string;
    providerSessionNameSource?: ProviderNameSource;
    /** Last time this machine saw the session running. */
    lastSeenAt: string;
}

/**
 * Ceiling on remembered sessions. tmux names come from a small reused pool
 * (`hwip-<project>`, `-2`, …), so this holds far more distinct projects than it
 * looks; the cap only stops the file from growing without bound on a machine
 * that has run agents for years.
 */
export const MAX_KNOWN_SESSIONS = 100;
/** Runs kept per name: a slot reused all day would otherwise fill the file with one project. */
export const MAX_RUNS_PER_NAME = 10;
/** Forgotten after this long unseen — a directory from months ago is more
 *  likely to have moved than to be what the user meant. */
export const KNOWN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const registryPath = (): string => join(stateDir(), 'known-sessions.json');

const isNameSource = (v: unknown): v is ProviderNameSource => v === 'user' || v === 'auto';

/** A run's name as the file holds it: a name that is not a string goes, and with it its source; a source that is not one goes alone. */
const withReadableName = (e: KnownSession): KnownSession => {
    const { providerSessionName: name, providerSessionNameSource: source, ...rest } = e;
    if (typeof name !== 'string' || name === '') return rest;
    return { ...rest, providerSessionName: name, ...(isNameSource(source) ? { providerSessionNameSource: source } : {}) };
};

const isTmuxRunIds = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((id) => typeof id === 'string'));

const readAll = (): KnownSession[] => {
    try {
        const raw = readFileSync(registryPath(), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Written by this process, but a half-written or hand-edited file must
        // not take the listener down — keep the rows that still make sense.
        return parsed.filter(
            (e): e is KnownSession =>
                !!e &&
                typeof e === 'object' &&
                typeof (e as KnownSession).name === 'string' &&
                typeof (e as KnownSession).cwd === 'string' &&
                typeof (e as KnownSession).agentKind === 'string' &&
                typeof (e as KnownSession).lastSeenAt === 'string' &&
                ((e as KnownSession).runId === undefined || typeof (e as KnownSession).runId === 'string') &&
                isTmuxRunIds((e as KnownSession).tmuxRunIds),
        ).map(withReadableName);
    } catch {
        return [];
    }
};

const writeAll = (entries: KnownSession[]): void => {
    const path = registryPath();
    try {
        mkdirHandedBack(dirname(path), 0o700);
        // 0600: it names the user's project directories, which is not something
        // every account on the machine needs to read.
        writeFileSync(path, JSON.stringify(entries, null, 2), { mode: 0o600 });
        handBackToSudoUser(path);
    } catch {
        // A registry that cannot be written costs the resume affordance, not
        // the daemon — every other path keeps working.
    }
};

/**
 * What makes two sightings the same remembered run: the tmux name, the agent
 * that was running under it, AND the tmux session it ran in (`runId`).
 *
 * Keyed by name alone, a `hwip cc` in a project erased whatever pi had done in
 * the same slot — the ended run left no row to resume and no row to read, and
 * the past list silently answered with the newest occupant instead. tmux hands
 * a name back out; the record of what ran under it is not the name's to lose.
 *
 * NUL rather than a printable separator: a project directory can be called
 * almost anything, and a name holding the separator must not be able to forge
 * another run's key.
 *
 * The run id splits two sittings of the same agent in the same slot: closing
 * `hwip cc` and starting it again is a new conversation, and the record of the
 * first is a past session of its own. An entry without one (written before
 * runs were recorded) keys as the empty run.
 */
export const runKey = (name: string, agentKind: string, runId?: string): string =>
    `${name}\u0000${agentKind}\u0000${runId ?? ''}`;

/** Sessions this machine has seen, newest first, expired ones dropped. */
export const knownSessions = (now: number = Date.now()): KnownSession[] =>
    readAll()
        .filter((e) => now - Date.parse(e.lastSeenAt) < KNOWN_SESSION_TTL_MS)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

/** No run asked for, or that run. */
const ofRun = (e: KnownSession, runId: string | undefined): boolean => runId === undefined || e.runId === runId;

/** One remembered session, or null when this machine never saw that name.
 *  The newest run under that name — which is the one a bare resume means.
 *  With `runId`, that run of the name and nothing else (Q46). */
export const recallSession = (name: string, now: number = Date.now(), runId?: string): KnownSession | null =>
    knownSessions(now).find((e) => e.name === name && ofRun(e, runId)) ?? null;

/**
 * One specific run: the newest under this name that ran THIS agent.
 *
 * A tmux name is a slot several agents pass through, so "resume hwip-web" is
 * ambiguous the moment the slot has held both pi and claude. The phone knows
 * which row was tapped and says so; this is how that answer is honoured.
 * Null when this machine never saw that agent under that name — the caller
 * decides whether to fall back to the newest run or refuse.
 *
 * With `runId`, that run of the name and nothing else (docs/session-runs.md
 * Q46): the earlier-runs fold asks for one conversation, and the newest run is
 * a different one.
 */
export const recallRun = (
    name: string,
    agentKind: string,
    now: number = Date.now(),
    runId?: string,
): KnownSession | null =>
    knownSessions(now).find((e) => e.name === name && e.agentKind === agentKind && ofRun(e, runId)) ?? null;

/** tmux sessions remembered per run: an `exit` and `-c` every few minutes all day stays a short list. */
export const MAX_TMUX_RUNS_PER_RUN = 10;

/**
 * Agents whose own resume is measured to keep the conversation id: Claude Code 2.1.300's `-c`, opencode 2.0.29's
 * `-c`, pi 1.2.0's `-c`, Codex 0.163.0's `resume --last`, Gemini 0.46.0's `--resume latest` and Hermes 0.20.0's
 * `-c` (2026-10-20). Cursor's was not measured (signed out) and the others are not installed here.
 */
const CONTINUING_KINDS: ReadonlySet<string> = new Set(['claude', 'opencode', 'pi', 'codex', 'gemini', 'hermes']);

/**
 * Which run the tmux session `tmuxRunId` of `name` is (hwip docs/session-runs.md §3).
 *
 * Its own, unless it carries on an earlier run: it was already joined to one
 * (a sweep or a listener restart since), or the agent's conversation
 * `conversationId` is the one an earlier run of the same name and agent last
 * had. A tmux session that has had a conversation of its own stays its own run
 * — a fresh start `/resume`d into an old conversation keeps what it wrote first.
 */
export const continuedRunId = (
    entries: readonly KnownSession[],
    name: string,
    agentKind: string,
    tmuxRunId: string,
    conversationId: string | null | undefined,
): string => {
    const ofName = entries.filter((e) => e.name === name && e.agentKind === agentKind && e.runId);
    const joined = ofName.find((e) => e.runId !== tmuxRunId && e.tmuxRunIds?.includes(tmuxRunId));
    if (joined?.runId) return joined.runId;
    if (!conversationId || !CONTINUING_KINDS.has(agentKind)) return tmuxRunId;
    if (ofName.some((e) => e.runId === tmuxRunId && e.agentSessionId)) return tmuxRunId;
    const earlier = ofName
        .filter((e) => e.agentSessionId === conversationId && Number(e.runId) < Number(tmuxRunId))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    return earlier?.runId ?? tmuxRunId;
};

/** The run going on in tmux session `tmuxRunId` of `name`: the one it was joined to, else its own. */
export const runOfTmuxSession = (name: string, tmuxRunId: string, now: number = Date.now()): string =>
    knownSessions(now).find((e) => e.name === name && e.tmuxRunIds?.includes(tmuxRunId))?.runId ?? tmuxRunId;

let readOnly = false;

/**
 * Make this process a reader of the registry: `rememberSessions` writes nothing from here on. For the
 * CLI commands that look at the sweep (`hwip agent list|read`) — the file is the listener's resume
 * whitelist, written in place (not renamed over), so a second writer can leave the listener's reader a
 * half-written file. Never called in the listener's own process, which stays the one writer.
 */
export const keepRegistryUntouched = (): void => {
    readOnly = true;
};

/**
 * Write down the sessions running right now, replacing what was known about
 * each. Called from the inventory sweep, so the record follows a session that
 * moves directory or changes agent rather than pinning its first sighting.
 *
 * A session with no readable cwd is skipped rather than remembered without
 * one: an entry that cannot say where to start the agent is not a resume
 * target, only a row that would fail when tapped.
 */
export const rememberSessions = (
    live: Array<{
        name: string;
        cwd: string | null;
        agentKind: string;
        project?: string | null;
        label?: string | null;
        runId?: string;
        startedAt?: string;
        /** The tmux session it runs in; one other than `runId` means the run goes on in it (`continuedRunId`). */
        tmuxRunId?: string;
        /**
         * The conversation a resume may pick up. Absent: not readable this
         * sweep, so the run keeps the one it had. Null: read, but not this
         * run's alone to resume — the run forgets it.
         */
        agentSessionId?: string | null;
        /** The name the agent gives the run now, and who gave it. None this sweep: the run keeps the one it had. */
        providerSessionName?: string | null;
        providerSessionNameSource?: ProviderNameSource;
    }>,
    now: number = Date.now(),
): void => {
    if (readOnly) return;
    const usable = live.filter((s) => !!s.name && !!s.cwd);
    if (usable.length === 0) return;
    const seenAt = new Date(now).toISOString();
    const byRun = new Map(knownSessions(now).map((e) => [runKey(e.name, e.agentKind, e.runId), e]));
    for (const s of usable) {
        // The entry this run had before runs were recorded: same slot and agent,
        // no run, seen while this run was already going. It is this run, not a
        // past one, and would otherwise be reported as one.
        if (s.runId && s.startedAt) {
            const before = byRun.get(runKey(s.name, s.agentKind));
            if (before && before.lastSeenAt >= s.startedAt) byRun.delete(runKey(s.name, s.agentKind));
        }
        // Carried on in a new tmux session: what an earlier sweep wrote under that session is this run.
        const continued = !!s.runId && !!s.tmuxRunId && s.tmuxRunId !== s.runId;
        if (continued) byRun.delete(runKey(s.name, s.agentKind, s.tmuxRunId));
        const key = runKey(s.name, s.agentKind, s.runId);
        // A sweep that could not read the id — the agent has not written its
        // record yet — keeps the one this run already had. Keyed by run and
        // directory, so neither another agent taking the name nor the same
        // agent started elsewhere under it inherits a conversation.
        const prev = byRun.get(key);
        const keepPrev = s.agentSessionId === undefined && prev?.cwd === s.cwd;
        const agentSessionId = s.agentSessionId || (keepPrev ? prev?.agentSessionId : undefined);
        // A run keeps its first start whichever tmux session it goes on in.
        const startedAt = continued ? prev?.startedAt ?? s.startedAt : s.startedAt;
        const tmuxRunIds = continued && s.tmuxRunId
            ? [...(prev?.tmuxRunIds ?? []).filter((id) => id !== s.tmuxRunId), s.tmuxRunId].slice(-MAX_TMUX_RUNS_PER_RUN)
            : prev?.tmuxRunIds;
        // The run's name is the last one read: a sweep that read none (the
        // agent has not titled it yet, or its record was unreadable) does not
        // take it away.
        const named = s.providerSessionName
            ? { providerSessionName: s.providerSessionName, providerSessionNameSource: s.providerSessionNameSource }
            : prev;
        byRun.set(key, {
            name: s.name,
            cwd: s.cwd as string,
            agentKind: s.agentKind,
            ...(s.project ? { project: s.project } : {}),
            ...(s.label ? { label: s.label } : {}),
            ...(s.runId ? { runId: s.runId } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(agentSessionId ? { agentSessionId } : {}),
            ...(tmuxRunIds?.length ? { tmuxRunIds } : {}),
            ...(named?.providerSessionName ? { providerSessionName: named.providerSessionName } : {}),
            ...(named?.providerSessionName && named.providerSessionNameSource ? { providerSessionNameSource: named.providerSessionNameSource } : {}),
            lastSeenAt: seenAt,
        });
    }
    const perName = new Map<string, number>();
    const entries = [...byRun.values()]
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .filter((e) => {
            const n = (perName.get(e.name) ?? 0) + 1;
            perName.set(e.name, n);
            return n <= MAX_RUNS_PER_NAME;
        })
        .slice(0, MAX_KNOWN_SESSIONS);
    writeAll(entries);
};

/**
 * Forget one session, by name. Returns false when this machine never knew it.
 *
 * This is what deleting a past session means on the machine that ran it: the
 * entry leaves the file, so the phone stops being offered the session AND —
 * since this file is the resume whitelist — stops being able to start it.
 * That is the intended pair, not a side effect.
 *
 * It stays forgotten: `rememberSessions` only writes down sessions that are
 * running, so nothing re-adds an entry for a session that has ended. Running
 * that name again is what brings it back, which is also the only way back.
 */
export type ForgetOutcome =
    /** This machine never had a record under that name. */
    | 'unknown'
    /** Registry entry and chat scrollback both gone. */
    | 'forgotten'
    /** Registry entry gone, but the scrollback file would not delete. */
    | 'scrollback_kept';

/** `nameRunning`: a run of this name is going right now, so its scrollback stays whether or not the registry has written that run down yet. */
export const forgetSession = (name: string, agentKind?: string, runId?: string, nameRunning = false): ForgetOutcome => {
    const entries = readAll();
    // With a kind, only that agent's runs go — the phone deletes the row it is
    // looking at, and a name that held both pi and claude shows two rows. With a
    // run as well, only that one run. Without a kind (an older phone, which
    // sends none), the name goes entirely: that is what the request meant when a
    // name could only mean one run.
    const doomed = (e: KnownSession): boolean =>
        e.name === name && (!agentKind || e.agentKind === agentKind) && (!runId || e.runId === runId);
    const kept = entries.filter((e) => !doomed(e));
    if (kept.length === entries.length) return 'unknown';
    // The chat's scrollback for that session goes with it. Forgetting a session
    // everywhere except the one file that holds a day of its prompts and tool
    // targets is not forgetting it — and a failure to delete that file has to
    // reach the person who asked, not stay in a swallowed catch.
    //
    // Except while another run still answers to the name: the scrollback is per
    // NAME, so deleting the pi row would take the claude row's history with it.
    // The record is gone either way; the file waits for the last run to go.
    const nameStillHeld = nameRunning || kept.some((e) => e.name === name);
    writeAll(kept);
    if (nameStillHeld) return 'forgotten';
    return removeTurnRing(name) ? 'forgotten' : 'scrollback_kept';
};

/**
 * What the caller was able to find out about a name. `unknown` is not a
 * synonym for ended: it is the terminal failing to answer at all — no tmux to
 * run, or no server behind the socket it resolved — and a sweep that deletes on
 * `ended` must not delete on that. Deciding this is the caller's job; this
 * module owns the file, not the terminal.
 */
export type SessionLiveness = 'running' | 'ended' | 'unknown';

/** What one sweep did. `scrollbackKept` is a subset of `forgotten`: the row is
 *  gone either way, and these are the ones whose chat history stayed behind. */
export type EndedSweep = {
    forgotten: string[];
    scrollbackKept: string[];
    kept: string[];
    unreachable: string[];
};

/**
 * Forget every remembered name that no longer runs, and report each side.
 *
 * The unit is the NAME, not the run: `forgetSession(name)` takes every run of
 * the name, and a name tmux still holds is one the next inventory sweep writes
 * straight back — so a name with a live run is left alone, its ended runs
 * included. Each name is judged, deleted and reported once, however many runs
 * sit under it.
 */
export const forgetEnded = (
    liveness: (name: string) => SessionLiveness,
    now: number = Date.now(),
): EndedSweep => {
    const names = [...new Set(knownSessions(now).map((e) => e.name))];
    const sweep: EndedSweep = { forgotten: [], scrollbackKept: [], kept: [], unreachable: [] };
    for (const name of names) {
        const state = liveness(name);
        if (state === 'running') sweep.kept.push(name);
        else if (state === 'unknown') sweep.unreachable.push(name);
        else sweep.forgotten.push(name);
    }
    if (sweep.forgotten.length === 0) return sweep;

    // One read and one write for the whole sweep. Calling `forgetSession` per
    // name would rewrite the file once per name — N chances for the daemon's
    // inventory sweep to write in between and put a deleted row back.
    const doomed = new Set(sweep.forgotten);
    writeAll(readAll().filter((e) => !doomed.has(e.name)));
    // Every run of these names has gone, so — unlike `forgetSession`, which
    // spares a ring another run still answers to — each ring goes with them.
    for (const name of sweep.forgotten) {
        if (!removeTurnRing(name)) sweep.scrollbackKept.push(name);
    }
    return sweep;
};

/** Whether the registry knows this name — the resume whitelist check. */
export const isKnownSession = (name: string, now: number = Date.now()): boolean =>
    recallSession(name, now) !== null;

/** Test seam: the file this module reads and writes. */
export const knownSessionsPath = registryPath;

/** True when the recorded directory still exists to start an agent in. */
export const sessionDirectoryExists = (entry: KnownSession): boolean => existsSync(entry.cwd);
