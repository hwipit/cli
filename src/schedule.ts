/**
 * Scheduled sessions (F8): what a schedule is, when it comes due, and the files it lives in.
 *
 * A schedule is one file, `<stateDir>/schedules/<id>.json` (0600). `hwip schedule` writes and
 * deletes them, the listener only reads them, and nothing reads-then-rewrites a file, so the two
 * never lose each other's change. What the listener has done about each one lives in its own file
 * (`schedule-state.json`, `schedule-runner.ts`).
 *
 * Everything here is pure or touches only that directory. The clock is a parameter.
 */

import { randomInt } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { stateDir } from './gate.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { replaceFile } from './replace-file.js';

export type ScheduleWhen =
    | { kind: 'daily'; at: string; days: number[] }
    | { kind: 'every'; minutes: number };

export interface Schedule {
    v: 1;
    /** Lowercase base36, 6 characters. It becomes a file name, so nothing else is accepted. */
    id: string;
    createdAt: string;
    /** Set by `updateSchedule` when an edit changes `when`: the schedule counts its runs from here, not from `createdAt` (see `scheduleAnchor`). */
    updatedAt?: string;
    source: 'cli' | 'phone';
    /** `REMOTE_AGENTS` kind. Checked against the table when it runs, not here: a hand-edited file is the runner's to refuse. */
    agentKind: string;
    cwd: string;
    /** Passed to `hwip <agent> --label`; the default is `sched-<id>`. */
    label: string;
    /** The tmux session the launch will create, worked out when the schedule is made. */
    session: string;
    /** `--wt <branch>`. From the command line only. */
    wt?: string;
    /** Arguments after `--`. From the command line only. */
    agentArgs?: string[];
    prompt?: string;
    when: ScheduleWhen;
    maxRuntimeMin: number;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isErrno = (err: unknown, code: string): boolean => err instanceof Error && 'code' in err && err.code === code;

const fail = <T>(error: string): Checked<T> => ({ ok: false, error });

export const MAX_SCHEDULES = 20;
const MIN_EVERY_MIN = 15;
const MAX_EVERY_MIN = 366 * 24 * 60;
const MAX_PROMPT_CHARS = 4000;
const DEFAULT_MAX_RUNTIME_MIN = 120;

/** How long a session may run when nobody said: two hours, and never longer than the period of an `every` schedule. */
export const defaultMaxRuntimeMin = (when: ScheduleWhen): number =>
    Math.min(DEFAULT_MAX_RUNTIME_MIN, when.kind === 'every' ? when.minutes : DEFAULT_MAX_RUNTIME_MIN);
const MIN_MAX_RUNTIME_MIN = 5;
const MAX_MAX_RUNTIME_MIN = 1440;
const MAX_AGENT_ARGS = 64;
const MAX_ARG_CHARS = 4000;
/** A schedule file is a few hundred bytes; one this big was not written by `addSchedule`. */
const MAX_FILE_BYTES = 256 * 1024;

// ── When ─────────────────────────────────────────────────────────────

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_NUMBER: Readonly<Record<string, number>> = Object.fromEntries(DAY_NAMES.map((name, day) => [name, day]));
export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
const AT_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseDays = (raw: string): Checked<number[]> => {
    const word = raw.trim().toLowerCase();
    if (word === 'daily') return { ok: true, value: [...ALL_DAYS] };
    if (word === 'weekdays') return { ok: true, value: [...WEEKDAYS] };
    const picked = new Set<number>();
    for (const part of word.split(',')) {
        const day = Object.hasOwn(DAY_NUMBER, part.trim()) ? DAY_NUMBER[part.trim()] : undefined;
        if (day === undefined) return fail(`--days takes daily, weekdays or day names like mon,wed,fri (got '${raw}')`);
        picked.add(day);
    }
    return { ok: true, value: [...picked].sort((a, b) => a - b) };
};

/** `<N>m` or `<N>h` as minutes; `example` is what the error shows for a value that is neither. */
export const parseDuration = (raw: string, flag: string, example: string): Checked<number> => {
    const match = /^(\d{1,7})([mh])$/.exec(raw.trim().toLowerCase());
    if (!match) return fail(`${flag} takes minutes or hours like ${example} (got '${raw}')`);
    return { ok: true, value: Number(match[1]) * (match[2] === 'h' ? 60 : 1) };
};

const parseEvery = (raw: string): Checked<number> => {
    const duration = parseDuration(raw, '--every', '30m or 2h');
    if (!duration.ok) return duration;
    const minutes = duration.value;
    if (minutes < MIN_EVERY_MIN) return fail(`--every must be at least ${MIN_EVERY_MIN}m`);
    if (minutes > MAX_EVERY_MIN) return fail('--every must be at most 366 days');
    return { ok: true, value: minutes };
};

/** `--at HH:MM [--days …]` or `--every <N>m|<N>h`, not both and not neither. */
export const parseWhen = (input: { at?: string; days?: string; every?: string }): Checked<ScheduleWhen> => {
    const { at, days, every } = input;
    if (every !== undefined) {
        if (at !== undefined || days !== undefined) return fail('--every cannot be combined with --at or --days');
        const minutes = parseEvery(every);
        return minutes.ok ? { ok: true, value: { kind: 'every', minutes: minutes.value } } : minutes;
    }
    if (at === undefined) return fail(days === undefined ? 'give --at HH:MM (with --days) or --every <N>m' : '--days needs --at HH:MM');
    if (!AT_TIME.test(at.trim())) return fail(`--at takes a 24-hour local time like 09:00 (got '${at}')`);
    const parsed = parseDays(days ?? 'daily');
    return parsed.ok ? { ok: true, value: { kind: 'daily', at: at.trim(), days: parsed.value } } : parsed;
};

export interface Occurrences {
    count: number;
    /** The last one in the span, ms since the epoch. */
    latest: number | null;
}

/** The longest stretch `occurrencesBetween` walks day by day. */
const MAX_WALK_MS = 400 * 24 * 60 * 60 * 1000;

/** How many whole periods of an `every` schedule lie between its anchor and `t`. */
const periodsSince = (anchor: number, period: number, t: number): number => Math.max(0, Math.floor((t - anchor) / period));

/** Local midnight of the day `step` days after the day `from` falls on. Built from the calendar date, so a day that is 23 or 25 hours long is still one step. */
const dayAfter = (from: number, step: number): Date => {
    const first = new Date(from);
    return new Date(first.getFullYear(), first.getMonth(), first.getDate() + step);
};

/**
 * The local time of day of a `daily` schedule on `day`, or null when it does not run on that weekday. Built from the
 * calendar date and the clock time, so a time the clocks skip runs once at the moved time and a repeated one once.
 */
const timeOnDay = (when: Extract<ScheduleWhen, { kind: 'daily' }>, day: Date): number | null => {
    if (!when.days.includes(day.getDay())) return null;
    const [hour, minute] = when.at.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
};

/**
 * The times a schedule comes due in `(after, until]`.
 *
 * `every` is arithmetic from `anchor` (when the schedule was made; the anchor itself is not a run),
 * so a machine that slept for a day counts its misses without looping. `daily` walks local dates and
 * builds each time with the local-time constructor, which settles the two DST cases the way the
 * spec says: a time the clock skips (spring) happens once, at the instant JS moves it to, and a time
 * the clock repeats (fall) happens once, the first time round.
 */
export const occurrencesBetween = (when: ScheduleWhen, after: number, until: number, anchor: number): Occurrences => {
    // A cursor read from a damaged state file may not be a number; the day walk below would never end on one.
    if (!Number.isFinite(after) || !Number.isFinite(until) || until <= after) return { count: 0, latest: null };
    if (when.kind === 'every') {
        const period = when.minutes * 60_000;
        const upTo = periodsSince(anchor, period, until);
        const count = upTo - periodsSince(anchor, period, after);
        return { count, latest: count > 0 ? anchor + upTo * period : null };
    }
    let count = 0;
    let latest: number | null = null;
    // A cursor from a hand-edited file may lie millennia back; a year and more of days is all that is ever counted.
    const from = Math.max(after, until - MAX_WALK_MS);
    for (let step = 0; ; step++) {
        const day = dayAfter(from, step);
        if (day.getTime() > until) break;
        const at = timeOnDay(when, day);
        if (at === null || at <= from || at > until) continue;
        count += 1;
        latest = at;
    }
    return { count, latest };
};

/** The first time after `after` the schedule comes due; null for a `daily` with no days (a file `validateSchedule` would refuse). */
export const nextOccurrence = (when: ScheduleWhen, after: number, anchor: number): number | null => {
    if (when.kind === 'every') {
        const period = when.minutes * 60_000;
        return anchor + (periodsSince(anchor, period, after) + 1) * period;
    }
    for (let step = 0; step <= 8; step++) {
        const at = timeOnDay(when, dayAfter(after, step));
        if (at !== null && at > after) return at;
    }
    return null;
};

// ── Validation ───────────────────────────────────────────────────────

const SCHEDULE_ID = /^[a-z0-9]{6}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENT_KIND = /^[A-Za-z0-9_-]{1,32}$/;
const KEYS = new Set(['v', 'id', 'createdAt', 'updatedAt', 'source', 'agentKind', 'cwd', 'label', 'session', 'wt', 'agentArgs', 'prompt', 'when', 'maxRuntimeMin']);

export const isScheduleId = (value: unknown): value is string => typeof value === 'string' && SCHEDULE_ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const noControl = (text: string): boolean => !/[\u0000-\u001f\u007f]/.test(text);

/**
 * A session this feature may type into or end: a `hwip-` tmux session name. tmux reads `:` and `.` in a `-t` target
 * as syntax (and `;` separates commands); `tmuxSessionName` never leaves one in a session name.
 */
const isSessionName = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith('hwip-') && value.length <= 256 && noControl(value) && !/[:.;]/.test(value);

const isInt = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const checkWhen = (raw: unknown): string | null => {
    if (!isRecord(raw)) return 'when must be an object';
    if (raw.kind === 'every') {
        if (Object.keys(raw).some((k) => k !== 'kind' && k !== 'minutes')) return 'when has a field it does not know';
        return isInt(raw.minutes, MIN_EVERY_MIN, MAX_EVERY_MIN) ? null : `when.minutes must be a whole number of at least ${MIN_EVERY_MIN}`;
    }
    if (raw.kind !== 'daily') return "when.kind must be 'daily' or 'every'";
    if (Object.keys(raw).some((k) => k !== 'kind' && k !== 'at' && k !== 'days')) return 'when has a field it does not know';
    if (typeof raw.at !== 'string' || !AT_TIME.test(raw.at)) return 'when.at must be HH:MM';
    const days = raw.days;
    const wellFormed = Array.isArray(days) && days.length > 0 && days.every((d) => isInt(d, 0, 6)) && new Set(days).size === days.length;
    return wellFormed ? null : 'when.days must be distinct day numbers 0 to 6';
};

/**
 * Whether `input` is a schedule this machine will run. The file reader, `hwip schedule add` and (in
 * the remote PR) the phone's request all pass through here, so a limit lives in one place. Unknown
 * fields are an error: a field nobody checks is a field that gets read later.
 */
export const validateSchedule = (input: unknown): Checked<Schedule> => {
    if (!isRecord(input)) return fail('a schedule must be an object');
    const unknownKey = Object.keys(input).find((k) => !KEYS.has(k));
    if (unknownKey !== undefined) return fail(`schedule has a field it does not know: ${unknownKey}`);
    const { v, id, createdAt, updatedAt, source, agentKind, cwd, label, session, wt, agentArgs, prompt, when, maxRuntimeMin } = input;

    if (v !== 1) return fail('schedule.v must be 1');
    if (!isScheduleId(id)) return fail('schedule.id must be 6 lowercase letters or digits');
    if (typeof createdAt !== 'string' || createdAt.length > 40 || !Number.isFinite(Date.parse(createdAt))) return fail('schedule.createdAt must be a date');
    if (updatedAt !== undefined && (typeof updatedAt !== 'string' || updatedAt.length > 40 || !Number.isFinite(Date.parse(updatedAt)))) return fail('schedule.updatedAt must be a date');
    // Before the schedule existed, it would count runs from a time it was not there for.
    if (typeof updatedAt === 'string' && Date.parse(updatedAt) < Date.parse(createdAt)) return fail('schedule.updatedAt cannot be before createdAt');
    if (source !== 'cli' && source !== 'phone') return fail("schedule.source must be 'cli' or 'phone'");
    if (typeof agentKind !== 'string' || !AGENT_KIND.test(agentKind)) return fail('schedule.agentKind is not an agent kind');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || !noControl(cwd)) return fail('schedule.cwd must be an absolute path');
    if (typeof label !== 'string' || !LABEL.test(label)) return fail('schedule.label may hold letters, digits, - and _ (63 after the first character)');
    if (!isSessionName(session)) return fail('schedule.session must be a hwip- tmux session name');

    if (wt !== undefined && (typeof wt !== 'string' || wt === '' || wt.startsWith('-') || wt.length > 200 || !noControl(wt))) return fail('schedule.wt must be a branch name');
    if (agentArgs !== undefined) {
        const wellFormed = Array.isArray(agentArgs) && agentArgs.length <= MAX_AGENT_ARGS
            && agentArgs.every((a) => typeof a === 'string' && a.length <= MAX_ARG_CHARS && !a.includes('\0'));
        if (!wellFormed) return fail(`schedule.agentArgs must be at most ${MAX_AGENT_ARGS} strings of at most ${MAX_ARG_CHARS} characters`);
    }
    // `hwip <agent> --detach --label … --wt …` reads its own flags first and stops at the first word that is not one:
    // an agent argument that opens like one would be taken for the wrapper's.
    if (Array.isArray(agentArgs) && typeof agentArgs[0] === 'string' && /^--(detach|label|wt)(=|$)/.test(agentArgs[0])) {
        return fail('schedule.agentArgs cannot start with --detach, --label or --wt');
    }
    if (source === 'phone' && (wt !== undefined || agentArgs !== undefined)) return fail('a schedule from the phone carries no wt or agentArgs');

    if (prompt !== undefined && (typeof prompt !== 'string' || prompt === '' || prompt.length > MAX_PROMPT_CHARS || prompt.includes('\0'))) {
        return fail(`schedule.prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
    }
    if (source === 'phone' && prompt === undefined) return fail('a schedule from the phone needs a prompt');

    const badWhen = checkWhen(when);
    if (badWhen) return fail(badWhen);
    const checkedWhen = when as ScheduleWhen; // checkWhen accepted its shape
    if (!isInt(maxRuntimeMin, MIN_MAX_RUNTIME_MIN, MAX_MAX_RUNTIME_MIN)) return fail(`schedule.maxRuntimeMin must be ${MIN_MAX_RUNTIME_MIN} to ${MAX_MAX_RUNTIME_MIN}`);
    if (checkedWhen.kind === 'every' && maxRuntimeMin > checkedWhen.minutes) return fail('schedule.maxRuntimeMin cannot be longer than the --every period');

    // Every field of `Schedule` was checked above; `input` is a record, which TypeScript cannot narrow field by field.
    return { ok: true, value: input as unknown as Schedule };
};

// ── Files ────────────────────────────────────────────────────────────

export const schedulesDir = (): string => join(stateDir(), 'schedules');

const schedulePath = (id: string): string => join(schedulesDir(), `${id}.json`);

const newScheduleId = (): string =>
    Array.from({ length: 6 }, () => randomInt(36).toString(36)).join('');

export interface ScheduleList {
    schedules: Schedule[];
    /** `.json` files that could not be read or did not pass `validateSchedule`. */
    unreadable: number;
    /** The directory could not be listed, or holds more than `MAX_SCHEDULES`: what is in `schedules` is not everything there is. */
    incomplete?: true;
}

const readOne = (id: string): Schedule | null => {
    try {
        const path = schedulePath(id);
        // Only the user's own regular file: a link could point anywhere, and a file others can write is not the user's word.
        const info = lstatSync(path);
        if (!info.isFile() || (info.mode & 0o022) !== 0) return null;
        if (info.size > MAX_FILE_BYTES) return null;
        const checked = validateSchedule(JSON.parse(readFileSync(path, 'utf8')));
        return checked.ok && checked.value.id === id ? checked.value : null;
    } catch {
        return null;
    }
};

export const listSchedules = (): ScheduleList => {
    let names: string[];
    try {
        names = readdirSync(schedulesDir());
    } catch (e) {
        // No directory yet is just no schedules; any other failure means the list is unknown.
        return isErrno(e, 'ENOENT') ? { schedules: [], unreadable: 0 } : { schedules: [], unreadable: 0, incomplete: true };
    }
    const schedules: Schedule[] = [];
    let unreadable = 0;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        const schedule = isScheduleId(id) ? readOne(id) : null;
        if (schedule) schedules.push(schedule);
        else unreadable += 1;
    }
    schedules.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // `addSchedule` stops at the limit, but files can arrive by hand: the oldest are kept, the rest are not run.
    if (schedules.length > MAX_SCHEDULES) {
        unreadable += schedules.length - MAX_SCHEDULES;
        schedules.length = MAX_SCHEDULES;
        return { schedules, unreadable, incomplete: true };
    }
    return { schedules, unreadable };
};

/** `failure`: `limit` — `MAX_SCHEDULES` are already there; `io` — the directory or file could not be made. Absent: the schedule itself was refused. */
export type AddResult = { ok: true; schedule: Schedule } | { ok: false; error: string; failure?: 'limit' | 'io' };

const ID_ATTEMPTS = 8;

/**
 * Write a new schedule. `make` gets the id so the label and session name that contain it can be
 * built first. The file is created exclusively: an id that is taken is never overwritten, a new one
 * is drawn.
 */
export const addSchedule = (make: (id: string) => Schedule, newId: () => string = newScheduleId): AddResult => {
    const { schedules, unreadable } = listSchedules();
    if (schedules.length + unreadable >= MAX_SCHEDULES) {
        return { ok: false, error: `there are already ${MAX_SCHEDULES} schedules; remove one with 'hwip schedule rm <id>'`, failure: 'limit' };
    }
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
        const id = newId();
        const schedule = make(id);
        const checked = validateSchedule(schedule);
        if (!checked.ok) return { ok: false, error: checked.error };
        if (schedule.id !== id) return { ok: false, error: 'schedule.id is not the id it was made for' };
        try {
            mkdirHandedBack(schedulesDir(), 0o700);
        } catch (err) {
            return { ok: false, error: `could not create ${schedulesDir()}: ${err instanceof Error ? err.message : String(err)}`, failure: 'io' };
        }
        try {
            const path = schedulePath(id);
            writeFileSync(path, `${JSON.stringify(schedule, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            handBackToSudoUser(path);
            return { ok: true, schedule };
        } catch (err) {
            if (isErrno(err, 'EEXIST')) continue;
            return { ok: false, error: `could not write the schedule: ${err instanceof Error ? err.message : String(err)}`, failure: 'io' };
        }
    }
    return { ok: false, error: 'could not find a free schedule id', failure: 'io' };
};

/** What an edit may change. Everything else — the session, the directory, the agent — is what the schedule is. */
export interface ScheduleChange {
    when?: ScheduleWhen;
    prompt?: string;
    maxRuntimeMin?: number;
}

/** A change as it arrives from outside (the phone): its values are checked with the schedule they make. */
export type UncheckedScheduleChange = { [K in keyof ScheduleChange]?: unknown };

/** `missing` — no such schedule; `invalid` — the id or the changed schedule was refused; `io` — the file could not be written. */
export type UpdateResult = { ok: true; schedule: Schedule } | { ok: false; error: string; failure: 'missing' | 'invalid' | 'io' };

/**
 * Change a schedule in place. The result passes `validateSchedule` before it is written, and is written whole (a
 * listener reading it at the same time sees the old file or the new one). A new `when` sets `updatedAt` to `now`:
 * the runner counts the edited schedule's runs from then, so the times it had before are neither run nor counted as
 * missed. A change of the prompt or the run time only keeps the count where it was — an hourly run stays on its hour.
 */
export const updateSchedule = (id: string, change: UncheckedScheduleChange, now: number): UpdateResult => {
    if (!isScheduleId(id)) return { ok: false, error: 'not a schedule id', failure: 'invalid' };
    if (change.when === undefined && change.prompt === undefined && change.maxRuntimeMin === undefined) {
        return { ok: false, error: 'nothing to change', failure: 'invalid' };
    }
    const current = readOne(id);
    if (!current) return { ok: false, error: `no schedule ${id}`, failure: 'missing' };
    // The same time sent again (an app sends the sheet's) is not a new one: the count stays where it was.
    const retimed = change.when !== undefined && JSON.stringify(change.when) !== JSON.stringify(current.when);
    const checked = validateSchedule({ ...current, ...change, ...(retimed ? { updatedAt: new Date(now).toISOString() } : {}) });
    if (!checked.ok) return { ok: false, error: checked.error, failure: 'invalid' };
    try {
        replaceFile(schedulePath(id), `${JSON.stringify(checked.value, null, 2)}\n`, undefined, 0o600);
        return { ok: true, schedule: checked.value };
    } catch (err) {
        return { ok: false, error: `could not write the schedule: ${err instanceof Error ? err.message : String(err)}`, failure: 'io' };
    }
};

/** The time a schedule's runs are counted from: its last edit, else its creation. */
export const scheduleAnchor = (schedule: Schedule): number => Date.parse(schedule.updatedAt ?? schedule.createdAt);

/** `invalid` means the id could not name a schedule file; nothing was touched. */
export type RemoveResult = 'removed' | 'missing' | 'invalid';

export const removeSchedule = (id: string): RemoveResult => {
    if (!isScheduleId(id)) return 'invalid';
    try {
        unlinkSync(schedulePath(id));
        return 'removed';
    } catch (err) {
        if (isErrno(err, 'ENOENT')) return 'missing';
        throw err;
    }
};

// ── What the listener has done ───────────────────────────────────────

const SCHEDULE_OUTCOMES = [
    'started', 'missed', 'overlap', 'busy', 'start_failed', 'missing_directory', 'unknown_agent', 'prompt_undelivered', 'prompt_unsupported', 'capped',
] as const;
export type ScheduleOutcome = (typeof SCHEDULE_OUTCOMES)[number];

/** Per schedule, in `schedule-state.json`. Only the listener writes it (`schedule-runner.ts`); `hwip schedule list` reads it. */
export interface ScheduleRunState {
    /** Time (ms) up to which due times have been dealt with; the next tick counts from here. */
    cursor: number;
    /** `capped`: the runtime cap passed and the session was asked to end; it keeps counting as running until it is gone. */
    running?: { session: string; startedAt: number; promptPending: boolean; capped?: true };
    last?: { outcome: ScheduleOutcome; at: number };
    /** Results not yet told to the person, by reason, and when the first of them was added. */
    pending?: { since: number; counts: Partial<Record<ScheduleOutcome, number>> };
}

export interface ScheduleStateFile {
    v: 1;
    schedules: Record<string, ScheduleRunState>;
    /** Set by `readScheduleState` only: the file is there but was not (all) readable, so the cursors in it are not to be trusted as complete. */
    damaged?: true;
}

export const scheduleStatePath = (): string => join(stateDir(), 'schedule-state.json');

const isOutcome = (value: unknown): value is ScheduleOutcome => SCHEDULE_OUTCOMES.some((outcome) => outcome === value);

/** A time as a Date holds it, so `new Date(value)` of anything read back cannot throw. */
const isNumber = (value: unknown): value is number => typeof value === 'number' && Math.abs(value) <= 8.64e15;

const readRunState = (raw: unknown): ScheduleRunState | null => {
    if (!isRecord(raw) || !isNumber(raw.cursor)) return null;
    const state: ScheduleRunState = { cursor: raw.cursor };
    const { running, last, pending } = raw;
    if (isRecord(running) && isSessionName(running.session) && isNumber(running.startedAt) && typeof running.promptPending === 'boolean') {
        state.running = { session: running.session, startedAt: running.startedAt, promptPending: running.promptPending, ...(running.capped === true ? { capped: true as const } : {}) };
    }
    if (isRecord(last) && isOutcome(last.outcome) && isNumber(last.at)) state.last = { outcome: last.outcome, at: last.at };
    if (isRecord(pending) && isNumber(pending.since) && isRecord(pending.counts)) {
        const counts: Partial<Record<ScheduleOutcome, number>> = {};
        for (const [reason, count] of Object.entries(pending.counts)) {
            if (isOutcome(reason) && isInt(count, 1, Number.MAX_SAFE_INTEGER)) counts[reason] = count;
        }
        if (Object.keys(counts).length > 0) state.pending = { since: pending.since, counts };
    }
    return state;
};

/**
 * The state file, tolerant of everything: a missing file reads as nothing done yet, an unreadable or damaged one
 * as what could be read plus `damaged`, so the listener does not take "nothing recorded" for "nothing happened".
 */
export const readScheduleState = (): ScheduleStateFile => {
    const state: ScheduleStateFile = { v: 1, schedules: {} };
    try {
        const path = scheduleStatePath();
        if (statSync(path).size > MAX_FILE_BYTES) return { ...state, damaged: true };
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!isRecord(raw) || !isRecord(raw.schedules)) return { ...state, damaged: true };
        for (const [id, entry] of Object.entries(raw.schedules)) {
            const runState = isScheduleId(id) ? readRunState(entry) : null;
            if (runState) state.schedules[id] = runState;
            else state.damaged = true;
        }
    } catch (e) {
        if (!isErrno(e, 'ENOENT')) state.damaged = true;
    }
    return state;
};

/** Replaces the state file atomically (0600). False when it could not be written; nothing is half-written. */
export const writeScheduleState = (state: ScheduleStateFile): boolean => {
    try {
        replaceFile(scheduleStatePath(), `${JSON.stringify(state)}\n`, undefined, 0o600);
        return true;
    } catch {
        return false;
    }
};
