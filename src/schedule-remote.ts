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
    validateSchedule,
    type Schedule,
    type ScheduleOutcome,
    type ScheduleWhen,
} from './schedule.js';
import { canPromptKind } from './schedule-ready.js';
import { recallRun, recallSession, sessionDirectoryExists, type KnownSession } from './session-registry.js';
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
    maxRuntimeMin: number;
    /** ISO time of the next run; null when there is none. */
    nextAt: string | null;
    last?: { outcome: ScheduleOutcome; at: string };
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

/** The schedules on this machine for the app, oldest first, prompts cut to `promptChars`. Null when the directory could not be listed or holds more than a machine may: an empty list would then be a lie. */
export const phoneScheduleList = (now: number, promptChars: number = LIST_PROMPT_CHARS): ScheduleListing | null => {
    const read = listSchedules();
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
            ...(schedule.prompt !== undefined && promptChars > 0 ? { prompt: clip(schedule.prompt, promptChars) } : {}),
            maxRuntimeMin: schedule.maxRuntimeMin,
            nextAt: isoOrNull(nextOccurrence(schedule.when, now, Date.parse(schedule.createdAt))),
            ...(last && lastAt ? { last: { outcome: last.outcome, at: lastAt } } : {}),
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
export const scheduleAnswer = (now: number, requestId: string, at: string): ScheduleAnswer => {
    for (const promptChars of PROMPT_CHARS_STEPS) {
        const listing = phoneScheduleList(now, promptChars);
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
}

export const livePhoneScheduleDeps: PhoneScheduleDeps = {
    now: Date.now,
    recall: (session, agentKind) => (agentKind === undefined ? recallSession(session) : recallRun(session, agentKind)),
    directoryExists: sessionDirectoryExists,
    canPrompt: canPromptKind,
};

const refuse = (reason: PhoneScheduleRefusal, why: string): PhoneScheduleResult => ({ ok: false, reason, why });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const CREATE_KEYS = new Set(['op', 'when', 'prompt', 'agentKind', 'maxRuntimeMin']);
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

const create = (request: Record<string, unknown>, session: string, deps: PhoneScheduleDeps): PhoneScheduleResult => {
    // Whatever else the request carries — a directory, arguments, a label — is refused, not ignored: it was meant to be used.
    const extra = Object.keys(request).find((k) => !CREATE_KEYS.has(k));
    if (extra !== undefined) return refuse('schedule_invalid', `a create carries ${extra}`);
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

/**
 * Carry out one change the phone asked for: `{ op: 'create', when, prompt, agentKind?, maxRuntimeMin? }` for the
 * recorded session `session`, or `{ op: 'remove', id }` for the schedule whose session that is. Nothing here
 * types into a session. `request` is whatever the phone sealed, so every field is checked as it is used.
 */
export const applyPhoneSchedule = (request: unknown, session: string, deps: PhoneScheduleDeps = livePhoneScheduleDeps): PhoneScheduleResult => {
    if (!isRecord(request)) return refuse('schedule_invalid', 'the request is not an object');
    try {
        if (request.op === 'create') return create(request, session, deps);
        if (request.op === 'remove') return remove(request, session);
    } catch (err) {
        // A file that would not read or write is this machine's trouble, not a mistake in the request.
        return refuse('schedule_failed', err instanceof Error ? err.message : String(err));
    }
    return refuse('schedule_invalid', 'op is neither create nor remove');
};
