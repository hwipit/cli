/**
 * Starts scheduled sessions on time (F8). The listener calls `tick(now)` on a timer; everything the tick touches
 * outside this file (the clock, tmux, `hwip <agent> --detach`, the state file) comes in through `deps`, so a
 * fake clock and fakes drive every case in the tests.
 *
 * What a tick decides, per schedule: how many due times passed since its cursor, whether the newest is still
 * worth running (`GRACE_MS`; older ones are `missed` and never run late), and whether the session may start.
 * The cursor is written before anything is launched, so a listener killed in between skips that run instead of
 * starting it twice.
 */

import { occurrencesBetween, scheduleAnchor, type Schedule, type ScheduleList, type ScheduleOutcome, type ScheduleRunState, type ScheduleStateFile } from './schedule.js';

/** How often the listener ticks. */
export const TICK_MS = 30_000;
/** A due time older than this when the tick sees it (the machine slept, the listener was down) is missed, not run. */
export const GRACE_MS = 120_000;
/** After a launch exits 0, how long before the session has to be there. */
export const START_CHECK_MS = 2_000;
/** A launch that has not exited by then is given up on. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** The same for `--wt`: the launch first makes the worktree (`git worktree add`, and whatever its hooks do), which a big repo does not finish in 30 s. */
export const LAUNCH_WT_TIMEOUT_MS = 120_000;
/** After a push that did not go out, how long until the next try; doubled on every failure up to the cap. */
export const PUSH_RETRY_MS = TICK_MS;
export const PUSH_RETRY_MAX_MS = 30 * 60_000;
/** How often the listener polls sessions that are waiting for their prompt (only while one is). */
export const PROMPT_POLL_MS = 5_000;
/**
 * How long after the start a session may take to become ready for its prompt; later, the prompt is given up on. Ready
 * takes two polls in a row on the same idle screen (`schedule-ready.ts`), so the earliest prompt goes one poll after
 * the session is idle, and a retry after a failed inject two polls later.
 */
export const PROMPT_WAIT_MS = 90_000;
/** A report that has waited this long for a push that would not go through is dropped, not sent as news. */
const PENDING_MAX_MS = 24 * 60 * 60 * 1000;
/** Scheduled sessions running at once. */
export const MAX_RUNNING = 3;
/** The part of a launch's stderr that goes to the log. */
const STDERR_LOG_CHARS = 200;

/** First non-empty line of `text`, control characters out, cut to `STDERR_LOG_CHARS` — one log line, whatever the child wrote. */
const firstLogLine = (text: string): string => {
    const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    return line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, STDERR_LOG_CHARS);
};

export type LaunchResult = { ok: true } | { ok: false; error: string };

/** What became of a push: `retry` is worth another try later; `rejected` is the server's no (4xx, a quota among them), which trying again cannot change. */
export type NotifyOutcome = 'sent' | 'retry' | 'rejected';

/**
 * What a failed push means for trying again. Only the server saying no to this very push is final: a 4xx (a daily
 * limit among them). The client's own timeout (reported as 408), a proxy asking for credentials (407) and a page that
 * is not the API's (a captive portal) are the network failing, and the push is worth sending again when it is back.
 */
export const notifyFailureOutcome = (e: unknown): Exclude<NotifyOutcome, 'sent'> => {
    const { code, status } = (typeof e === 'object' && e !== null ? e : {}) as { code?: unknown; status?: unknown };
    if (code === 'TIMEOUT' || code === 'INVALID_RESPONSE') return 'retry';
    if (typeof status !== 'number' || status === 407 || status === 408) return 'retry';
    return status >= 400 && status < 500 ? 'rejected' : 'retry';
};

export interface ScheduleRunnerDeps {
    listSchedules: () => ScheduleList;
    readState: () => ScheduleStateFile;
    /** Replaces the state file atomically; false when it could not. */
    writeState: (state: ScheduleStateFile) => boolean;
    sessionExists: (session: string) => boolean;
    /** The session is known to be over. Not the same as `!sessionExists`: when tmux cannot be asked, nobody knows. */
    sessionEnded: (session: string) => boolean;
    directoryExists: (cwd: string) => boolean;
    /** The `hwip` subcommand that starts an agent kind; undefined for a kind the table does not have. */
    subcommandFor: (kind: string) => string | undefined;
    /** Runs `hwip <args>` in `cwd` and resolves when it has exited, or gives up after `timeoutMs`. */
    launch: (args: string[], cwd: string, timeoutMs: number) => Promise<LaunchResult>;
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
    /** Whether a prompt can ever be typed into this kind of agent: its detection rules can say `idle` (see `schedule-ready.ts`). */
    canPrompt: (agentKind: string) => boolean;
    /** The agent in `session` is up and its rules say it is idle: the screen is not a dialog or a task in progress. */
    ready: (session: string, agentKind: string) => boolean;
    /** Types `prompt` into the session and submits it; false when it was not delivered (rate limit, no pane, …). */
    inject: (session: string, prompt: string) => boolean;
    /** Asks the session to end the way a phone's exit request does (the agent's quit command, then signals). It never kills the tmux session. */
    endSession: (session: string) => void;
    /** Tells the person (title, body). */
    notify: (title: string, body: string) => Promise<NotifyOutcome>;
    /** The wall clock (default `Date.now`); a launch takes seconds, and the schedules after it are judged by the time it ends. */
    clock?: () => number;
}

/** How each result that is not `started` reads in the push, as "<label> · <reason> <count>회". */
const REASON_TEXT: Record<Exclude<ScheduleOutcome, 'started'>, string> = {
    missed: '놓침',
    overlap: '이미 실행 중이라 건너뜀',
    busy: '동시 실행 한도라 건너뜀',
    start_failed: '시작 실패',
    missing_directory: '폴더 없음',
    unknown_agent: '알 수 없는 에이전트',
    prompt_undelivered: '할 일 입력 못 함',
    prompt_unsupported: '할 일 입력 불가(이 에이전트는 입력 준비를 판정할 규칙이 없음)',
    capped: '실행 시간 초과',
};

/** The push title for each result: what kind of news it is. A report that mixes kinds gets the general one. */
const SKIPPED = '예약 건너뜀';
const PROMPT_NOT_TYPED = '예약 할 일 입력 못 함';
const TITLE_OF: Record<Exclude<ScheduleOutcome, 'started'>, string> = {
    missed: SKIPPED,
    overlap: SKIPPED,
    busy: SKIPPED,
    start_failed: SKIPPED,
    missing_directory: SKIPPED,
    unknown_agent: SKIPPED,
    prompt_undelivered: PROMPT_NOT_TYPED,
    prompt_unsupported: PROMPT_NOT_TYPED,
    capped: '예약 실행 시간 초과',
};
const MIXED_TITLE = '예약 알림';

/** Adds `count` of `outcome` to what the person has not been told yet. */
const addPending = (st: ScheduleRunState, outcome: Exclude<ScheduleOutcome, 'started'>, count: number, now: number): void => {
    const pending = (st.pending ??= { since: now, counts: {} });
    pending.counts[outcome] = (pending.counts[outcome] ?? 0) + count;
};

/**
 * The arguments of `hwip` that start `schedule`'s session. One array element per argument, never a string for a shell:
 * `agentArgs` are passed on as typed, whatever they contain.
 */
export const launchArgs = (schedule: Schedule, subcommand: string): string[] => [
    subcommand,
    '--detach',
    '--label',
    schedule.label,
    ...(schedule.wt !== undefined ? ['--wt', schedule.wt] : []),
    ...(schedule.agentArgs ?? []),
];

export interface ScheduleRunner {
    /** Starts what is due, then looks after the sessions already running. Every `TICK_MS`. */
    tick: (now: number) => Promise<void>;
    /** Looks after the running sessions only (their prompt, their runtime cap). Every `PROMPT_POLL_MS`; does nothing while no prompt is waiting. */
    poll: (now: number) => Promise<void>;
}

/** One push worth of news: what to say and, per schedule, how much of its `pending` that covers. */
interface Report {
    title: string;
    body: string;
    told: { id: string; counts: Partial<Record<ScheduleOutcome, number>> }[];
}

interface Loaded {
    schedules: Schedule[];
    state: Record<string, ScheduleRunState>;
    /** The state differs from the file. */
    dirty: boolean;
    save: () => boolean;
}

export const createScheduleRunner = (deps: ScheduleRunnerDeps): ScheduleRunner => {
    // A launch can take seconds; a tick (or poll) that finds the last one still going does nothing.
    let working = false;
    // A push is on its way (the state is not held while it is): no second one is started until it has been settled.
    let pushing = false;
    // Pushes that went out, to be taken off `pending` the next time the state is loaded. Only in memory: a listener that
    // stops in between tells the same news once more (at least once, never lost).
    let sentReports: Report['told'][] = [];

    let lastListNote = '';
    // After a push failed: when the next try may go out, and how long the wait after that one will be.
    let nextPushAt = 0;
    let retryAfter = PUSH_RETRY_MS;

    const clock = deps.clock ?? Date.now;

    // Time spent launching other sessions while a session waits for its prompt is not the session's wait: a `--wt` launch
    // holds the listener for up to two minutes, during which nobody can look at the others. `launchedMs` is what all launches
    // took so far; a started session remembers its value, and only what came after counts as excused. In memory: after a
    // restart nothing is excused, which is right — the listener was down.
    let launchedMs = 0;
    const launchedBefore = new Map<string, number>();
    // Sessions already asked to end for their runtime cap, so a state file that cannot be written does not ask again every tick.
    const cappedAsked = new Set<string>();

    const load = (tickNow: number): Loaded => {
        const { schedules, unreadable, incomplete } = deps.listSchedules();
        const file = deps.readState();
        const previous = file.schedules;
        if (file.damaged) deps.log('! schedules: the state file was not readable; schedules without a record start from now');
        // Said once per change, not every tick: files that cannot be run are skipped, and the person should be able to find out why.
        const listNote = unreadable > 0 || incomplete ? `${unreadable} schedule file${unreadable === 1 ? '' : 's'} skipped (unreadable, unsafe or over the limit)${incomplete ? '; the list may be incomplete' : ''}` : '';
        if (listNote !== lastListNote) {
            lastListNote = listNote;
            if (listNote) deps.log(`! schedules: ${listNote}`);
        }
        const state: Record<string, ScheduleRunState> = {};
        for (const schedule of schedules) {
            // No record of a schedule in a damaged file may mean "nothing ran" or "the record was lost": start from now, so
            // neither a pile of old runs is counted as missed nor a run that already happened is started again.
            // An edit restarts the count: the times before it belong to the schedule as it was.
            const prior = previous[schedule.id];
            const anchor = scheduleAnchor(schedule);
            state[schedule.id] = { ...prior, cursor: Math.max(prior?.cursor ?? (file.damaged ? tickNow : anchor), anchor) };
        }
        // A state entry whose schedule file is gone is dropped — but only when the list is whole: a file that could not be
        // read this time is still there, and losing its cursor would repeat or miscount runs. A session that ended on its own is no longer running.
        const listWhole = unreadable === 0 && !incomplete;
        if (!listWhole) for (const id of Object.keys(previous)) state[id] ??= previous[id]!;
        let dirty = file.damaged === true || Object.keys(previous).some((id) => !(id in state));
        // A schedule only ever runs in its own session. A record that names another one is not ours: it would count against
        // the limit and, at the cap, have that other session asked to end.
        for (const schedule of schedules) {
            const st = state[schedule.id]!;
            if (st.running && st.running.session !== schedule.session) {
                deps.log(`! schedules: ${schedule.id} had a running record for ${st.running.session}, not ${schedule.session}; dropped`);
                delete st.running;
                dirty = true;
            }
        }
        for (const st of Object.values(state)) {
            if (st.running && deps.sessionEnded(st.running.session)) {
                delete st.running;
                dirty = true;
            }
        }
        for (const told of sentReports) {
            for (const { id, counts } of told) {
                const pending = state[id]?.pending;
                if (!pending) continue;
                for (const outcome of Object.keys(counts) as ScheduleOutcome[]) {
                    const left = (pending.counts[outcome] ?? 0) - (counts[outcome] ?? 0);
                    if (left > 0) pending.counts[outcome] = left;
                    else delete pending.counts[outcome];
                }
                if (Object.keys(pending.counts).length === 0) delete state[id]!.pending;
            }
            dirty = true;
        }
        if (sentReports.length > 0) {
            sentReports = [];
            pushing = false;
        }
        const save = (): boolean => {
            const saved = deps.writeState({ v: 1, schedules: state });
            if (!saved) deps.log('! schedules: could not write the state file');
            return saved;
        };
        return { schedules, state, dirty, save };
    };

    const run = async (tickNow: number): Promise<Report | null> => {
        const tickStart = clock();
        const loaded = load(tickNow);
        const { schedules, state, save } = loaded;
        // Every due time is judged (and its cursor written) before the first launch: a `--wt` launch takes minutes, and the
        // schedules after it must not be judged late, and so missed, by the time it took.
        const toStart: { schedule: Schedule; st: ScheduleRunState; before: ScheduleRunState; at: number }[] = [];
        for (const schedule of schedules) {
            const st = state[schedule.id]!;
            const now = tickNow + (clock() - tickStart);
            const due = occurrencesBetween(schedule.when, st.cursor, now, scheduleAnchor(schedule));
            if (due.count === 0 || due.latest === null) continue;
            const runs = now - due.latest <= GRACE_MS;
            const missed = runs ? due.count - 1 : due.count;
            const before = structuredClone(st);
            st.cursor = due.latest;
            // Before anything is launched: a run whose cursor is not on disk must not start.
            if (missed > 0) {
                st.last = { outcome: 'missed', at: now };
                addPending(st, 'missed', missed, now);
            }
            if (!save()) {
                state[schedule.id] = before;
                continue;
            }
            loaded.dirty = false;
            if (missed > 0) deps.log(`schedule ${schedule.id} (${schedule.label}): missed ${missed} run${missed === 1 ? '' : 's'}`);
            if (runs) toStart.push({ schedule, st, before, at: now });
        }
        for (const { schedule, st, before, at: now } of toStart) {
            // A prompt is only ever typed when the agent's own rules can tell idle from a dialog; otherwise the session still starts, without it.
            const typable = schedule.prompt === undefined || deps.canPrompt(schedule.agentKind);
            const launchStart = clock();
            const outcome = await start(schedule, st, state, typable, () => tickNow + (clock() - tickStart));
            launchedMs += clock() - launchStart;
            const running = st.running;
            if (outcome === 'started' && running) launchedBefore.set(`${running.session}@${running.startedAt}`, launchedMs);
            st.last = { outcome, at: now };
            deps.log(`schedule ${schedule.id} (${schedule.label}): ${outcome}`);
            if (outcome === 'started' && !typable) {
                st.last = { outcome: 'prompt_unsupported', at: now };
                addPending(st, 'prompt_unsupported', 1, now);
                deps.log(`schedule ${schedule.id} (${schedule.label}): ${schedule.agentKind} has no rule that says idle, so its prompt is not typed`);
            }
            // A session still running (or no room) stays the same for every run until it ends: the first of such a streak is news.
            const repeat = (outcome === 'overlap' || outcome === 'busy') && before.last?.outcome === outcome;
            if (outcome !== 'started' && !repeat) addPending(st, outcome, 1, now);
            saveNow(loaded);
        }
        supervise(loaded, tickNow + (clock() - tickStart));
        return collectReport(loaded, tickNow + (clock() - tickStart));
    };

    /**
     * What has piled up, as one push for all schedules; null when there is nothing (or a push is still on its way).
     * Reports older than 24 h are dropped on the way. `pending` is only taken off once the push has gone out (`tick`).
     */
    const collectReport = (loaded: Loaded, now: number): Report | null => {
        const { schedules, state } = loaded;
        const lines: string[] = [];
        const told: Report['told'] = [];
        const titles = new Set<string>();
        let dropped = 0;
        for (const schedule of schedules) {
            const st = state[schedule.id]!;
            if (!st.pending) continue;
            if (now - st.pending.since > PENDING_MAX_MS) {
                delete st.pending;
                dropped += 1;
                loaded.dirty = true;
                continue;
            }
            const { counts } = st.pending;
            const reasons = (Object.keys(REASON_TEXT) as (keyof typeof REASON_TEXT)[])
                .filter((outcome) => counts[outcome])
                .map((outcome) => `${REASON_TEXT[outcome]} ${counts[outcome]}회`);
            if (reasons.length === 0) {
                delete st.pending;
                loaded.dirty = true;
                continue;
            }
            lines.push(`${schedule.label} · ${reasons.join(', ')}`);
            for (const outcome of Object.keys(counts) as (keyof typeof TITLE_OF)[]) if (counts[outcome]) titles.add(TITLE_OF[outcome]);
            told.push({ id: schedule.id, counts: { ...counts } });
        }
        if (dropped > 0) deps.log(`schedules: dropped the unsent report of ${dropped} schedule${dropped === 1 ? '' : 's'} older than 24 h`);
        if (loaded.dirty) loaded.save();
        if (lines.length === 0 || pushing) return null;
        pushing = true;
        return { title: titles.size === 1 ? [...titles][0]! : MIXED_TITLE, body: lines.join('\n'), told };
    };

    // Prompts typed whose "done" could not be written (`session@startedAt`); in memory, so only for this listener's life.
    const delivered = new Set<string>();

    // Whether any running session is still waiting for its prompt: `poll` costs nothing while none is.
    let watching = true;

    /** Delivers the prompts of running sessions and ends those past their runtime cap, then saves what changed. */
    const supervise = (loaded: Loaded, now: number): void => {
        const { schedules, state } = loaded;
        for (const schedule of schedules) {
            const st = state[schedule.id]!;
            const running = st.running;
            if (!running) continue;
            const label = `schedule ${schedule.id} (${schedule.label})`;
            // Asked to end once; it stays counted until it is gone (below), whatever it does with the request.
            if (running.capped) continue;

            if (now - running.startedAt > schedule.maxRuntimeMin * 60_000) {
                // Asking is all it does: a session that does not end stays, counts against `MAX_RUNNING`, and the next due time says overlap (D11).
                running.capped = true;
                running.promptPending = false;
                const cappedKey = `${running.session}@${running.startedAt}`;
                // Once per session: when the state file cannot be written, the next tick finds it uncapped again and must not ask or tell again.
                if (!cappedAsked.has(cappedKey)) {
                    cappedAsked.add(cappedKey);
                    deps.endSession(running.session);
                    st.last = { outcome: 'capped', at: now };
                    deps.log(`${label}: capped after ${schedule.maxRuntimeMin} min, asked ${running.session} to end`);
                    addPending(st, 'capped', 1, now);
                }
                saveNow(loaded);
                continue;
            }
            if (!running.promptPending) continue;
            if (schedule.prompt === undefined) {
                // The prompt was taken out of the schedule after the session started: nothing is left to wait for.
                running.promptPending = false;
                loaded.dirty = true;
                continue;
            }
            const deliveredKey = `${running.session}@${running.startedAt}`;
            if (delivered.has(deliveredKey)) {
                // Typed, but the state saying so could not be written then: never type it twice.
                running.promptPending = false;
                loaded.dirty = true;
                continue;
            }

            // A prompt that waited too long (or a listener that was down while it waited) is not typed late into whatever the screen shows now.
            const excused = launchedMs - (launchedBefore.get(deliveredKey) ?? launchedMs);
            const late = now - running.startedAt - excused > PROMPT_WAIT_MS;
            if (!late && deps.ready(running.session, schedule.agentKind)) {
                if (deps.inject(running.session, schedule.prompt)) {
                    running.promptPending = false;
                    launchedBefore.delete(deliveredKey);
                    deps.log(`${label}: prompt delivered`);
                    // On disk right away: the work after this (other schedules, a push) must not be able to make a restart type it again.
                    if (!saveNow(loaded)) delivered.add(deliveredKey);
                }
                continue; // not delivered (rate limit …): the next poll tries again
            }
            if (late) {
                running.promptPending = false;
                launchedBefore.delete(deliveredKey);
                st.last = { outcome: 'prompt_undelivered', at: now };
                addPending(st, 'prompt_undelivered', 1, now);
                deps.log(`${label}: ${running.session} was not ready for its prompt in time`);
                saveNow(loaded);
            }
        }
        watching = Object.values(state).some((st) => st.running?.promptPending);
        if (loaded.dirty) loaded.save();
    };

    /** Writes the state now; what a failed write leaves behind is still `dirty`, for the save at the end. */
    const saveNow = (loaded: Loaded): boolean => {
        loaded.dirty = !loaded.save();
        return !loaded.dirty;
    };

    const start = async (
        schedule: Schedule,
        st: ScheduleRunState,
        state: Record<string, ScheduleRunState>,
        typable: boolean,
        at: () => number,
    ): Promise<ScheduleOutcome> => {
        if (deps.sessionExists(schedule.session)) return 'overlap';
        if (Object.values(state).filter((other) => other.running).length >= MAX_RUNNING) return 'busy';
        if (!deps.directoryExists(schedule.cwd)) return 'missing_directory';
        const subcommand = deps.subcommandFor(schedule.agentKind);
        if (subcommand === undefined) return 'unknown_agent';

        const launched = await deps.launch(launchArgs(schedule, subcommand), schedule.cwd, schedule.wt !== undefined ? LAUNCH_WT_TIMEOUT_MS : LAUNCH_TIMEOUT_MS);
        if (!launched.ok) {
            deps.log(`schedule ${schedule.id}: launch failed: ${firstLogLine(launched.error)}`);
            return 'start_failed';
        }
        await deps.sleep(START_CHECK_MS);
        if (!deps.sessionExists(schedule.session)) {
            deps.log(`schedule ${schedule.id}: the launch exited 0 but ${schedule.session} is not there`);
            return 'start_failed';
        }
        st.running = { session: schedule.session, startedAt: at(), promptPending: schedule.prompt !== undefined && typable };
        return 'started';
    };

    // One of tick and poll at a time: both read the state file, change it and write it back.
    const exclusive = async <T>(work: () => T | Promise<T>): Promise<T | undefined> => {
        if (working) return undefined;
        working = true;
        try {
            return await work();
        } finally {
            working = false;
        }
    };

    // The push goes out after the tick has let go of the state: it can take a minute, and nothing else should wait for that.
    const tick = async (now: number): Promise<void> => {
        const report = await exclusive(() => run(now));
        if (!report) return;
        if (now < nextPushAt) {
            // The last push failed and its retry is not due yet: the news waits in `pending`.
            pushing = false;
            return;
        }
        let outcome: NotifyOutcome = 'retry';
        try {
            outcome = await deps.notify(report.title, report.body);
        } catch (e) {
            deps.log(`! schedules: could not notify: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (outcome === 'retry') {
            pushing = false;
            nextPushAt = now + retryAfter;
            deps.log(`! schedules: the push did not go out; it is tried again in ${Math.round(retryAfter / 1000)} s`);
            retryAfter = Math.min(retryAfter * 2, PUSH_RETRY_MAX_MS);
            return;
        }
        if (outcome === 'rejected') deps.log('! schedules: the server refused the push; it is not sent again');
        retryAfter = PUSH_RETRY_MS;
        nextPushAt = 0;
        sentReports.push(report.told);
    };
    const poll = async (now: number): Promise<void> => {
        await exclusive(() => {
            if (watching) supervise(load(now), now);
        });
    };

    return { tick, poll };
};
