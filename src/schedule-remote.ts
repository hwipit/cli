/**
 * What the phone sees and says about schedules (F8 slices 06 and 07). The decisions live here so
 * `listener.ts` only wires them: this file reads the schedule files and the runner's state, and
 * takes the phone's words at face value for nothing.
 */

import { basename } from 'node:path';
import {
    addSchedule,
    defaultMaxRuntimeMin,
    listSchedules,
    nextOccurrence,
    readScheduleState,
    removeSchedule,
    scheduleAnchor,
    updateSchedule,
    validateSchedule,
    type Schedule,
    type ScheduleOutcome,
    type ScheduleWhen,
    type UncheckedScheduleChange,
} from './schedule.js';
import { canPromptKind } from './schedule-ready.js';
import {
    liveSessionOfRun,
    recallRun,
    recallSession,
    registryUnreadable,
    runOfTmuxSession,
    sessionDirectoryExists,
    type KnownSession,
    type TmuxRuns,
} from './session-registry.js';
import { liveRunIdOf, liveSessionNames } from './tmux-liveness.js';
import { safeBasename, tmuxSessionName } from './wrapper.js';

/** One schedule as the app lists it. No directory path and no agent arguments: the phone never names or reads either. */
export interface PhoneScheduleItem {
    id: string;
    source: 'cli' | 'phone';
    agentKind: string;
    /** The directory's name, not its path. */
    project: string;
    session: string;
    when: ScheduleWhen;
    prompt?: string;
    /**
     * The phone cannot change the prompt: what is here is not all of it (cut, or left out for room), or the schedule has
     * agent arguments the computer gave. The app shows it and leaves it to `hwip schedule edit`.
     */
    promptLocked?: true;
    maxRuntimeMin: number;
    /** ISO time of the next run; null when there is none. */
    nextAt: string | null;
    last?: { outcome: ScheduleOutcome; at: string };
    /** `session`: it types into the run `runId` instead of starting a session (`Schedule.target`). */
    target?: 'session';
    runId?: string;
    /** The run a session target types into is over: nothing will be typed until it is removed. Absent when it is not, or tmux could not say. */
    sessionEnded?: true;
}

/** The longest prompt the list carries; the full text is in the file on this machine. */
export const LIST_PROMPT_CHARS = 500;

/** The sealed list must fit one relay frame (cf. `DIFF_SEALED_MAX_BYTES`), counted in UTF-8 bytes. */
export const LIST_MAX_BYTES = 24 * 1024;

/** Prompt lengths tried in turn until the list fits; the last drops prompts altogether. */
const PROMPT_CHARS_STEPS = [LIST_PROMPT_CHARS, 200, 80, 0] as const;

/** `text` cut to `max` UTF-16 units with an ellipsis, minus a surrogate pair the cut would split. */
const clip = (text: string, max: number): string => {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const last = cut.charCodeAt(cut.length - 1);
    return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
};

const listedPrompt = (schedule: Schedule, max: number): Pick<PhoneScheduleItem, 'prompt' | 'promptLocked'> => {
    const { prompt } = schedule;
    const listed = prompt !== undefined && max > 0 ? clip(prompt, max) : undefined;
    const locked = listed !== prompt || schedule.agentArgs !== undefined;
    return { ...(listed === undefined ? {} : { prompt: listed }), ...(locked ? { promptLocked: true } : {}) };
};

const isoOrNull = (ms: number | null): string | null => {
    if (ms === null) return null;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** What `phoneScheduleList` found: the schedules it could read, and how many files it could not. */
export interface ScheduleListing {
    schedules: PhoneScheduleItem[];
    /** Files that were there but unreadable or invalid (`hwip schedule` says so on stderr). */
    unreadable: number;
}

/** tmux as `liveSessionOfRun` asks it, each question answered once: one list answer asks for the names once, and each name once. */
const askingOnce = (tmux: TmuxRuns): TmuxRuns => {
    let names: string[] | null | undefined;
    const runs = new Map<string, string | null | undefined>();
    return {
        names: () => (names === undefined ? (names = tmux.names()) : names),
        runIdOf: (name) => {
            if (!runs.has(name)) runs.set(name, tmux.runIdOf(name));
            return runs.get(name);
        },
    };
};

const liveTmuxRuns: TmuxRuns = { names: liveSessionNames, runIdOf: liveRunIdOf };

/** What the list says about a session target's run: only `ended` is news (the app shows "session ended"). */
const targetFields = (schedule: Schedule, now: number, tmux: TmuxRuns): Pick<PhoneScheduleItem, 'target' | 'runId' | 'sessionEnded'> => {
    if (schedule.target !== 'session' || schedule.runId === undefined) return {};
    const where = liveSessionOfRun(schedule.runId, schedule.session, tmux, now, Date.parse(schedule.createdAt));
    return { target: 'session', runId: schedule.runId, ...(where === 'ended' ? { sessionEnded: true as const } : {}) };
};

/**
 * The schedules on this machine for the app, oldest first, prompts cut to `promptChars`. Null when the directory could
 * not be listed or holds more than a machine may: an empty list would then be a lie.
 */
export const phoneScheduleList = (now: number, promptChars: number = LIST_PROMPT_CHARS, tmux: TmuxRuns = liveTmuxRuns): ScheduleListing | null => {
    const read = listSchedules();
    const asked = askingOnce(tmux);
    if (read.incomplete) return null;
    const state = readScheduleState().schedules;
    const schedules = read.schedules.map((schedule): PhoneScheduleItem => {
        const last = state[schedule.id]?.last;
        const lastAt = last ? isoOrNull(last.at) : null;
        return {
            id: schedule.id,
            source: schedule.source,
            agentKind: schedule.agentKind,
            project: basename(schedule.cwd),
            session: schedule.session,
            when: schedule.when,
            ...listedPrompt(schedule, promptChars),
            maxRuntimeMin: schedule.maxRuntimeMin,
            nextAt: isoOrNull(nextOccurrence(schedule.when, now, scheduleAnchor(schedule))),
            ...(last && lastAt ? { last: { outcome: last.outcome, at: lastAt } } : {}),
            ...targetFields(schedule, now, asked),
        };
    });
    return { schedules, unreadable: read.unreadable };
};

/** The answer to a list request: what the app reads (the sealed text) and the list in it, or why there is none. */
export type ScheduleAnswer =
    | { ok: true; listing: ScheduleListing; sealed: string }
    | { ok: false; error: 'read_failed' | 'too_large' };

/**
 * The list as one answer. The text that gets sealed names the request and the time it answers, so a relay
 * cannot hand an older sealed list back as the answer to a newer request. Prompts are cut shorter, step by
 * step, until the answer fits a frame; it is an error only when even the list without prompts does not.
 */
export const scheduleAnswer = (now: number, requestId: string, at: string, tmux: TmuxRuns = liveTmuxRuns): ScheduleAnswer => {
    const once = askingOnce(tmux);
    for (const promptChars of PROMPT_CHARS_STEPS) {
        const listing = phoneScheduleList(now, promptChars, once);
        if (!listing) return { ok: false, error: 'read_failed' };
        const { schedules, unreadable } = listing;
        const sealed = JSON.stringify({ v: 1, requestId, at, schedules, ...(unreadable > 0 ? { unreadable } : {}) });
        if (Buffer.byteLength(sealed) <= LIST_MAX_BYTES) return { ok: true, listing, sealed };
    }
    return { ok: false, error: 'too_large' };
};

// ── What the phone asks to change ────────────────────────────────────

/** The reasons a phone's schedule request is not carried out; they are `agent.command.refused` codes (`command-refusal.ts`). */
export type PhoneScheduleRefusal = 'schedule_invalid' | 'schedule_limit' | 'schedule_failed' | 'unknown_session';

export type PhoneScheduleResult = { ok: true } | { ok: false; reason: PhoneScheduleRefusal; why: string };

export interface PhoneScheduleDeps {
    now: () => number;
    /** The newest run of that tmux name (of that agent, when given) this machine recorded. */
    recall: (session: string, agentKind?: string) => KnownSession | null;
    directoryExists: (entry: KnownSession) => boolean;
    /** Whether the agent can be typed a prompt by a schedule (`schedule-ready.ts`). */
    canPrompt: (agentKind: string) => boolean;
    /** The run tmux session `session` holds now; null when it is not running, undefined when tmux did not answer. */
    currentRun: (session: string) => string | null | undefined;
    /** This machine's record of run `runId` of `session` at `now`; `unreadable` when the record file would not read. */
    recallRunOf: (session: string, runId: string, now: number) => KnownSession | null | 'unreadable';
}

export const livePhoneScheduleDeps: PhoneScheduleDeps = {
    now: Date.now,
    recall: (session, agentKind) => (agentKind === undefined ? recallSession(session) : recallRun(session, agentKind)),
    directoryExists: sessionDirectoryExists,
    canPrompt: canPromptKind,
    currentRun: (session) => {
        const tmuxRun = liveRunIdOf(session);
        return typeof tmuxRun === 'string' ? runOfTmuxSession(session, tmuxRun) : tmuxRun;
    },
    recallRunOf: (session, runId, now) => recallSession(session, now, runId) ?? (registryUnreadable() ? 'unreadable' : null),
};

const refuse = (reason: PhoneScheduleRefusal, why: string): PhoneScheduleResult => ({ ok: false, reason, why });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const CREATE_KEYS = new Set(['op', 'when', 'prompt', 'agentKind', 'maxRuntimeMin', 'target']);
/** Stands in for the run time while the rest of a request is checked; the shortest `validateSchedule` takes. */
const SHORTEST_RUN_MIN = 5;

/** The fields every schedule made from a phone request has, whatever the request says: all but `id` come from this machine's record. */
const fromRecord = (entry: KnownSession, id: string, now: number): Omit<Schedule, 'when' | 'maxRuntimeMin'> => ({
    v: 1,
    id,
    createdAt: new Date(now).toISOString(),
    source: 'phone',
    agentKind: entry.agentKind,
    cwd: entry.cwd,
    label: `sched-${id}`,
    session: `${tmuxSessionName(safeBasename(entry.cwd))}-sched-${id}`,
});

/**
 * A create with `target: 'session'`: the schedule types into the addressed session instead of starting one. The run is
 * the one the session holds now — this machine's word, not the phone's — and the agent and directory are that run's
 * record. It has no runtime cap: a run time in the request (the apps always send one) is ignored.
 */
const createIntoSession = (request: Record<string, unknown>, session: string, deps: PhoneScheduleDeps): PhoneScheduleResult => {
    const { when, prompt, agentKind } = request;
    if (agentKind !== undefined) return refuse('schedule_invalid', 'a create into a session takes the agent the session runs');
    const runId = deps.currentRun(session);
    if (runId === undefined) return refuse('schedule_failed', 'tmux did not give the run of that session');
    if (runId === null) return refuse('unknown_session', 'the session is not running');
    const now = deps.now();
    const entry = deps.recallRunOf(session, runId, now);
    if (entry === 'unreadable') return refuse('schedule_failed', 'the record of sessions would not read');
    if (!entry) return refuse('unknown_session', 'no record of the run that session holds');
    if (!deps.canPrompt(entry.agentKind)) return refuse('schedule_invalid', `${entry.agentKind} cannot take a scheduled prompt`);

    const checked = validateSchedule({
        v: 1, id: 'aaaaaa', createdAt: new Date(now).toISOString(), source: 'phone', agentKind: entry.agentKind, cwd: entry.cwd,
        label: 'sched-aaaaaa', session, target: 'session', runId, when, prompt, maxRuntimeMin: SHORTEST_RUN_MIN,
    });
    if (!checked.ok) return refuse('schedule_invalid', checked.error);
    // Kept for the file's shape: a session target's run time bounds nothing.
    const runtime = defaultMaxRuntimeMin(checked.value.when);
    const added = addSchedule((id) => ({ ...checked.value, id, label: `sched-${id}`, maxRuntimeMin: runtime }));
    if (added.ok) return { ok: true };
    return refuse(added.failure === 'limit' ? 'schedule_limit' : added.failure === 'io' ? 'schedule_failed' : 'schedule_invalid', added.error);
};

const create = (request: Record<string, unknown>, session: string, deps: PhoneScheduleDeps): PhoneScheduleResult => {
    // Whatever else the request carries — a directory, arguments, a label — is refused, not ignored: it was meant to be used.
    const extra = Object.keys(request).find((k) => !CREATE_KEYS.has(k));
    if (extra !== undefined) return refuse('schedule_invalid', `a create carries ${extra}`);
    if (request.target !== undefined && request.target !== 'session') return refuse('schedule_invalid', "target is 'session' or absent");
    if (request.target === 'session') return createIntoSession(request, session, deps);
    const { when, prompt, agentKind, maxRuntimeMin } = request;
    if (agentKind !== undefined && typeof agentKind !== 'string') return refuse('schedule_invalid', 'agentKind is not text');

    // Directory and agent are what this machine recorded for the session, never what the phone says.
    const entry = deps.recall(session, agentKind);
    // The session name is in the clear, so not knowing it can be told as it is. A session known under other agents only
    // is read off sealed text (the agent the request named), so it goes out as a bad request.
    if (!entry) {
        const knownUnderAnother = agentKind !== undefined && deps.recall(session) !== null;
        return knownUnderAnother ? refuse('schedule_invalid', 'that agent never ran under that session name') : refuse('unknown_session', 'no recorded session by that name');
    }
    if (!deps.directoryExists(entry)) return refuse('unknown_session', 'the recorded directory is gone');
    if (!deps.canPrompt(entry.agentKind)) return refuse('schedule_invalid', `${entry.agentKind} cannot take a scheduled prompt`);

    const now = deps.now();
    const checked = validateSchedule({ ...fromRecord(entry, 'aaaaaa', now), when, prompt, maxRuntimeMin: maxRuntimeMin ?? SHORTEST_RUN_MIN });
    if (!checked.ok) return refuse('schedule_invalid', checked.error);
    const runtime = typeof maxRuntimeMin === 'number' ? maxRuntimeMin : defaultMaxRuntimeMin(checked.value.when);
    const added = addSchedule((id) => ({ ...checked.value, ...fromRecord(entry, id, now), maxRuntimeMin: runtime }));
    if (added.ok) return { ok: true };
    return refuse(added.failure === 'limit' ? 'schedule_limit' : added.failure === 'io' ? 'schedule_failed' : 'schedule_invalid', added.error);
};

const remove = (request: Record<string, unknown>, session: string): PhoneScheduleResult => {
    if (Object.keys(request).some((k) => k !== 'op' && k !== 'id')) return refuse('schedule_invalid', 'a remove carries only an id');
    const { id } = request;
    if (typeof id !== 'string') return refuse('schedule_invalid', 'a remove needs an id');
    // The push names the schedule's own session, so a request for one schedule cannot remove another.
    const read = listSchedules();
    // A list that is not all of them cannot say a schedule is not there: that is this machine's trouble, not the request's.
    if (read.incomplete) return refuse('schedule_failed', 'the schedules could not be listed');
    const target = read.schedules.find((schedule) => schedule.id === id);
    if (!target || target.session !== session) return refuse('schedule_invalid', 'no such schedule for that session');
    // Gone by the time it is removed (the person, or `hwip schedule rm`, was first) is the state asked for.
    const removed = removeSchedule(id);
    return removed === 'invalid' ? refuse('schedule_invalid', 'not a schedule id') : { ok: true };
};

const UPDATE_KEYS = new Set(['op', 'id', 'when', 'prompt', 'maxRuntimeMin']);

const update = (request: Record<string, unknown>, session: string, deps: PhoneScheduleDeps): PhoneScheduleResult => {
    const extra = Object.keys(request).find((k) => !UPDATE_KEYS.has(k));
    if (extra !== undefined) return refuse('schedule_invalid', `an update carries ${extra}`);
    const { id, when, prompt, maxRuntimeMin } = request;
    if (typeof id !== 'string') return refuse('schedule_invalid', 'an update needs an id');
    const read = listSchedules();
    if (read.incomplete) return refuse('schedule_failed', 'the schedules could not be listed');
    // As for a remove: the push names the schedule's own session, so it cannot change another one.
    const target = read.schedules.find((schedule) => schedule.id === id);
    if (!target || target.session !== session) return refuse('schedule_invalid', 'no such schedule for that session');
    // A prompt the list cut is left out by the app, so a missing one keeps the file's whole text.
    // Arguments the computer gave (a permissions bypass, say) were chosen for its own prompt: the phone cannot put another under them.
    if (prompt !== undefined && target.agentArgs !== undefined) return refuse('schedule_invalid', 'a schedule with agent arguments takes its prompt from hwip schedule edit');
    // As `hwip schedule edit`: a prompt of spaces would be typed as nothing.
    if (typeof prompt === 'string' && prompt.trim() === '') return refuse('schedule_invalid', 'the prompt is empty');
    if (prompt !== undefined && !deps.canPrompt(target.agentKind)) return refuse('schedule_invalid', 'that agent cannot take a scheduled prompt');
    // Unchecked here: `updateSchedule` validates the whole schedule they make before it writes.
    const change: UncheckedScheduleChange = {};
    if (when !== undefined) change.when = when;
    if (prompt !== undefined) change.prompt = prompt;
    // The apps always send a run time; a session target has none to change, and keeps the one in its file.
    if (maxRuntimeMin !== undefined && target.target !== 'session') change.maxRuntimeMin = maxRuntimeMin;
    const updated = updateSchedule(id, change, deps.now());
    if (updated.ok) return { ok: true };
    // Gone between the list and the write is the same as never there for this session.
    return refuse(updated.failure === 'io' ? 'schedule_failed' : 'schedule_invalid', updated.error);
};

/**
 * Carry out one change the phone asked for: `{ op: 'create', when, prompt, agentKind?, maxRuntimeMin? }` for the
 * recorded session `session` (or `{ op: 'create', target: 'session', when, prompt }` to type into it), `{ op: 'update', id, when?, prompt?, maxRuntimeMin? }` or `{ op: 'remove', id }` for the
 * schedule whose session that is. Nothing here
 * types into a session. `request` is whatever the phone sealed, so every field is checked as it is used.
 */
export const applyPhoneSchedule = (request: unknown, session: string, deps: PhoneScheduleDeps = livePhoneScheduleDeps): PhoneScheduleResult => {
    if (!isRecord(request)) return refuse('schedule_invalid', 'the request is not an object');
    try {
        if (request.op === 'create') return create(request, session, deps);
        if (request.op === 'update') return update(request, session, deps);
        if (request.op === 'remove') return remove(request, session);
    } catch (err) {
        // A file that would not read or write is this machine's trouble, not a mistake in the request.
        return refuse('schedule_failed', err instanceof Error ? err.message : String(err));
    }
    return refuse('schedule_invalid', 'op is not create, update or remove');
};
