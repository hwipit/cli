import { describe, expect, it } from 'vitest';
import {
    createScheduleRunner,
    GRACE_MS,
    ONCE_GRACE_MS,
    LAUNCH_TIMEOUT_MS,
    LAUNCH_WT_TIMEOUT_MS,
    launchArgs,
    MAX_RUNNING,
    notifyFailureOutcome,
    PROMPT_POLL_MS,
    PROMPT_WAIT_MS,
    SESSION_QUIET_MS,
    SESSION_WAIT_MS,
    START_CHECK_MS,
    type LaunchResult,
    type ScheduleRunnerDeps,
} from './schedule-runner.js';
import type { Schedule, ScheduleRunState, ScheduleStateFile } from './schedule.js';

const T0 = Date.UTC(2026, 9, 9, 0, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const schedule = (id: string, over: Partial<Schedule> = {}): Schedule => ({
    v: 1,
    id,
    createdAt: new Date(T0).toISOString(),
    source: 'cli',
    agentKind: 'claude',
    cwd: '/work/app',
    label: `sched-${id}`,
    session: `hwip-app-sched-${id}`,
    when: { kind: 'every', minutes: 15 },
    maxRuntimeMin: 15,
    ...over,
});

interface World {
    deps: ScheduleRunnerDeps;
    runner: ReturnType<typeof createScheduleRunner>;
    schedules: Schedule[];
    state: ScheduleStateFile;
    sessions: Set<string>;
    launched: { args: string[]; cwd: string }[];
    events: string[];
    logs: string[];
    /** What the fake pane does: `ready` is what `deps.ready` answers, `injectOk` whether a prompt is accepted. */
    pane: { ready: boolean; injectOk: boolean };
    typed: { session: string; prompt: string }[];
    ended: string[];
    notes: { title: string; body: string }[];
    removed: string[];
    /** Where each run is (`deps.sessionOfRun`); a run not here has ended. */
    runs: Map<string, { name: string } | 'ended' | 'unknown'>;
    /** What `deps.lastClientActivity` answers (ms), for every session. */
    activity: number | null | undefined;
}

const world = (
    schedules: Schedule[],
    over: Partial<ScheduleRunnerDeps> & { launchResult?: LaunchResult; sessionAppears?: boolean; state?: ScheduleStateFile } = {},
): World => {
    const w: World = {
        schedules,
        state: over.state ?? { v: 1, schedules: {} },
        sessions: new Set(),
        launched: [],
        events: [],
        logs: [],
        pane: { ready: false, injectOk: true },
        typed: [],
        ended: [],
        notes: [],
        removed: [],
        runs: new Map(),
        activity: null,
        deps: undefined as never,
        runner: undefined as never,
    };
    const { launchResult = { ok: true }, sessionAppears = true, state: _state, ...rest } = over;
    w.deps = {
        listSchedules: () => ({ schedules: w.schedules, unreadable: 0 }),
        readState: () => structuredClone(w.state),
        writeState: (state) => {
            w.events.push('write');
            w.state = structuredClone(state);
            return true;
        },
        sessionExists: (session) => w.sessions.has(session),
        sessionEnded: (session) => !w.sessions.has(session),
        directoryExists: () => true,
        subcommandFor: (kind) => (kind === 'claude' ? 'cc' : undefined),
        launch: async (args, cwd) => {
            w.events.push('launch');
            w.launched.push({ args, cwd });
            if (launchResult.ok && sessionAppears) {
                const label = args[args.indexOf('--label') + 1]!;
                const found = w.schedules.find((s) => s.label === label);
                if (found) w.sessions.add(found.session);
            }
            return launchResult;
        },
        sleep: async () => undefined,
        log: (line) => w.logs.push(line),
        // Real time passing during a test would move `startedAt` by a millisecond here and there.
        clock: () => 0,
        canPrompt: () => true,
        ready: () => w.pane.ready,
        inject: (session, prompt) => {
            if (w.pane.injectOk) w.typed.push({ session, prompt });
            return w.pane.injectOk;
        },
        endSession: (session) => { w.ended.push(session); },
        notify: async (title, body) => {
            w.notes.push({ title, body });
            return 'sent';
        },
        sessionOfRun: (runId) => w.runs.get(runId) ?? 'ended',
        lastClientActivity: () => w.activity,
        removeSchedule: (id) => {
            w.removed.push(id);
            w.schedules = w.schedules.filter((s) => s.id !== id);
            return 'removed';
        },
        ...rest,
    };
    w.runner = createScheduleRunner(w.deps);
    return w;
};

const last = (w: World, id: string): string | undefined => w.state.schedules[id]?.last?.outcome;

describe('a due schedule', () => {
    it('is launched once as `hwip <agent> --detach --label …` in its directory, and recorded as running', async () => {
        const w = world([schedule('aaaaaa')]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(w.launched).toEqual([{ args: ['cc', '--detach', '--label', 'sched-aaaaaa'], cwd: '/work/app' }]);
        expect(last(w, 'aaaaaa')).toBe('started');
        expect(w.state.schedules.aaaaaa).toMatchObject({
            cursor: T0 + 15 * MIN,
            running: { session: 'hwip-app-sched-aaaaaa', startedAt: T0 + 15 * MIN + 10_000, promptPending: false },
        });
        // The same time does not come due again.
        await w.runner.tick(T0 + 15 * MIN + 40_000);
        expect(w.launched).toHaveLength(1);
    });

    it('is not launched before its first time, and a new schedule does not count times before it was made', async () => {
        const w = world([schedule('aaaaaa', { when: { kind: 'every', minutes: 30 } })]);
        await w.runner.tick(T0 + 29 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.state.schedules).toEqual({});
    });

    it('writes the cursor before it launches', async () => {
        const w = world([schedule('aaaaaa')]);
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.events.slice(0, 2)).toEqual(['write', 'launch']);
    });

    it('is not launched twice when the listener died between writing the cursor and launching', async () => {
        const w = world([schedule('aaaaaa')], { launch: async () => { throw new Error('killed'); } });
        await expect(w.runner.tick(T0 + 15 * MIN)).rejects.toThrow('killed');
        expect(w.state.schedules.aaaaaa!.cursor).toBe(T0 + 15 * MIN);
        const again = world([schedule('aaaaaa')], { state: w.state });
        await again.runner.tick(T0 + 15 * MIN + 30_000);
        expect(again.launched).toEqual([]);
    });

    it('is not launched when the cursor cannot be written', async () => {
        const w = world([schedule('aaaaaa')], { writeState: () => false });
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.logs.join('\n')).toContain('could not write the state file');
    });

    it('keeps an agent argument that looks like shell as one argument', () => {
        expect(launchArgs(schedule('aaaaaa', { agentArgs: ['; rm -rf ~', '$(id)'] }), 'cc')).toEqual([
            'cc', '--detach', '--label', 'sched-aaaaaa', '; rm -rf ~', '$(id)',
        ]);
    });

    it('passes --wt after the label and before the agent arguments', () => {
        expect(launchArgs(schedule('aaaaaa', { wt: 'feat/x', agentArgs: ['--model', 'opus'] }), 'cc')).toEqual([
            'cc', '--detach', '--label', 'sched-aaaaaa', '--wt', 'feat/x', '--model', 'opus',
        ]);
    });
});

describe('missed runs', () => {
    it('runs a time 119 s late and skips one 121 s late', async () => {
        const late = world([schedule('aaaaaa')]);
        await late.runner.tick(T0 + 15 * MIN + 119_000);
        expect(late.launched).toHaveLength(1);

        const later = world([schedule('aaaaaa')]);
        await later.runner.tick(T0 + 15 * MIN + GRACE_MS + 1_000);
        expect(later.launched).toEqual([]);
        expect(last(later, 'aaaaaa')).toBe('missed');
        expect(later.logs.join('\n')).toContain('missed 1 run');
        expect(later.state.schedules.aaaaaa!.cursor).toBe(T0 + 15 * MIN);
    });

    it('counts all 32 times of an 8 h sleep in one tick and starts none of them late', async () => {
        const w = world([schedule('aaaaaa')]);
        await w.runner.tick(T0 + 8 * HOUR + 200_000);
        expect(w.launched).toEqual([]);
        expect(w.logs.join('\n')).toContain('missed 32 runs');
        // And not again on the next tick.
        w.logs.length = 0;
        await w.runner.tick(T0 + 8 * HOUR + 230_000);
        expect(w.logs.join('\n')).not.toContain('missed');
    });

    it('starts the newest of a pile when it is still fresh, and counts the rest as missed', async () => {
        const w = world([schedule('aaaaaa')]);
        await w.runner.tick(T0 + 8 * HOUR + 30_000);
        expect(w.launched).toHaveLength(1);
        expect(w.logs.join('\n')).toContain('missed 31 runs');
    });
});

describe('skipping a run', () => {
    it('does not launch over a live session, and says overlap', async () => {
        const w = world([schedule('aaaaaa')]);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.launched).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('overlap');
    });

    it(`says busy for the ${MAX_RUNNING + 1}th running session`, async () => {
        const ids = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd'];
        const state: ScheduleStateFile = { v: 1, schedules: {} };
        for (const id of ids.slice(0, MAX_RUNNING)) {
            state.schedules[id] = { cursor: T0, running: { session: `hwip-app-sched-${id}`, startedAt: T0, promptPending: false } };
        }
        const w = world(ids.map((id) => schedule(id)), { state });
        for (const id of ids.slice(0, MAX_RUNNING)) w.sessions.add(`hwip-app-sched-${id}`);
        // The first three have a live session too, so they overlap; the fourth is the one over the limit.
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.launched).toEqual([]);
        expect(last(w, 'dddddd')).toBe('busy');
        expect(ids.slice(0, MAX_RUNNING).map((id) => last(w, id))).toEqual(['overlap', 'overlap', 'overlap']);
    });

    it('forgets a running session that has ended, so it no longer counts', async () => {
        const state: ScheduleStateFile = { v: 1, schedules: {
            aaaaaa: { cursor: T0, running: { session: 'hwip-app-sched-aaaaaa', startedAt: T0, promptPending: false } },
        } };
        const w = world([schedule('aaaaaa', { when: { kind: 'every', minutes: 60 } })], { state });
        await w.runner.tick(T0 + 20 * MIN);
        expect(w.state.schedules.aaaaaa!.running).toBeUndefined();
    });

    it('says missing_directory for a directory that is gone', async () => {
        const w = world([schedule('aaaaaa')], { directoryExists: () => false });
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.launched).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('missing_directory');
    });

    it('does not run a hand-edited agent kind that is not in the table', async () => {
        const w = world([schedule('aaaaaa', { agentKind: 'nonesuch' })]);
        await w.runner.tick(T0 + 15 * MIN);
        expect(w.launched).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('unknown_agent');
    });
});

describe('a launch that does not come up', () => {
    it('is start_failed when the launch exits non-zero, and logs the first 200 characters of its error', async () => {
        const w = world([schedule('aaaaaa')], { launchResult: { ok: false, error: `claude: command not found ${'x'.repeat(500)}` } });
        await w.runner.tick(T0 + 15 * MIN);
        expect(last(w, 'aaaaaa')).toBe('start_failed');
        const line = w.logs.find((l) => l.includes('launch failed'))!;
        expect(line).toContain('command not found');
        expect(line.length).toBeLessThan(260);
        expect(w.state.schedules.aaaaaa!.running).toBeUndefined();
    });

    it(`is start_failed when the launch exits 0 but there is no session ${START_CHECK_MS} ms later`, async () => {
        const sleeps: number[] = [];
        const w = world([schedule('aaaaaa')], { sessionAppears: false, sleep: async (ms) => { sleeps.push(ms); } });
        await w.runner.tick(T0 + 15 * MIN);
        expect(sleeps).toEqual([START_CHECK_MS]);
        expect(last(w, 'aaaaaa')).toBe('start_failed');
    });
});

describe('the state file', () => {
    it('drops the state of a schedule whose file is gone', async () => {
        const state: ScheduleStateFile = { v: 1, schedules: { gone00: { cursor: T0 } } };
        const w = world([], { state });
        await w.runner.tick(T0 + HOUR);
        expect(w.state.schedules).toEqual({});
    });

    it('starts a schedule from its creation time', async () => {
        const w = world([schedule('aaaaaa', { createdAt: new Date(T0 + 5 * HOUR).toISOString() })]);
        await w.runner.tick(T0 + 5 * HOUR + 10 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.logs.join('\n')).not.toContain('missed');
    });
});

describe('ticks', () => {
    it('does nothing while the last tick is still launching', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const w = world([schedule('aaaaaa'), schedule('bbbbbb')], {
            launch: async (args, cwd) => {
                w0.launched.push({ args, cwd });
                await gate;
                return { ok: true };
            },
        });
        const w0 = w;
        const first = w.runner.tick(T0 + 15 * MIN);
        await w.runner.tick(T0 + 15 * MIN + 1_000);
        expect(w.launched).toHaveLength(1);
        release();
        await first;
        expect(w.launched).toHaveLength(2);
    });

    it('keeps what it had on the state it reads back', async () => {
        const state: ScheduleStateFile = { v: 1, schedules: { aaaaaa: { cursor: T0 + 15 * MIN, last: { outcome: 'started', at: T0 } satisfies ScheduleRunState['last'] } } };
        const w = world([schedule('aaaaaa')], { state });
        await w.runner.tick(T0 + 15 * MIN + 1_000);
        expect(w.launched).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('started');
    });
});

describe('a state file or schedule list that cannot be trusted', () => {
    const withCursor: ScheduleStateFile = { v: 1, schedules: { aaaaaa: { cursor: T0 + 15 * MIN }, bbbbbb: { cursor: T0 } } };

    it('keeps the state of a schedule while some schedule file could not be read', async () => {
        const w = world([schedule('aaaaaa')], { state: withCursor, listSchedules: () => ({ schedules: [schedule('aaaaaa')], unreadable: 1 }) });
        await w.runner.tick(T0 + 15 * MIN + 1_000);
        expect(w.state.schedules.bbbbbb).toEqual({ cursor: T0 });
    });

    it('keeps the state of every schedule while the directory could not be listed', async () => {
        const w = world([], { state: withCursor, listSchedules: () => ({ schedules: [], unreadable: 0, incomplete: true }) });
        await w.runner.tick(T0 + HOUR);
        expect(w.state.schedules).toEqual(withCursor.schedules);
    });

    it('starts a schedule that has no record from now when the state file was damaged, not from its creation', async () => {
        const w = world([schedule('aaaaaa')], { state: { v: 1, schedules: {}, damaged: true } });
        await w.runner.tick(T0 + 8 * HOUR + 14 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.state.schedules.aaaaaa!.cursor).toBe(T0 + 8 * HOUR + 14 * MIN);
        expect(w.state.schedules.aaaaaa!.last).toBeUndefined();
        expect(w.logs.join('\n')).toContain('state file was not readable');
        // The next time then runs as usual.
        await w.runner.tick(T0 + 8 * HOUR + 15 * MIN + 5_000);
        expect(w.launched).toHaveLength(1);
    });
});

describe('time passing during a tick', () => {
    // A `--wt` launch can take two minutes. Every due time is judged first, so the schedules after it are not judged late by it.
    const slowWorld = (schedules: Schedule[]) => {
        let clockNow = 0;
        const w: World = world(schedules, {
            clock: () => clockNow,
            launch: async (args, cwd) => {
                w.events.push('launch');
                w.launched.push({ args, cwd });
                const label = args[args.indexOf('--label') + 1]!;
                const found = w.schedules.find((x) => x.label === label);
                if (found) w.sessions.add(found.session);
                clockNow += 100_000; // a slow launch
                return { ok: true };
            },
        });
        return w;
    };

    it('judges every due time before the first launch: a slow launch does not make the next schedule missed', async () => {
        const w = slowWorld([schedule('aaaaaa'), schedule('bbbbbb')]);
        // 30 s after the time: fresh for both, though the second would be 130 s late (past the 120 s grace) once the first launch is over.
        await w.runner.tick(T0 + 15 * MIN + 30_000);
        expect(w.launched.map((l) => l.args[3])).toEqual(['sched-aaaaaa', 'sched-bbbbbb']);
        expect(last(w, 'bbbbbb')).toBe('started');
    });

    it('writes every cursor before the first launch', async () => {
        const w = slowWorld([schedule('aaaaaa'), schedule('bbbbbb')]);
        await w.runner.tick(T0 + 15 * MIN + 30_000);
        const firstLaunch = w.events.indexOf('launch');
        expect(firstLaunch).toBeGreaterThan(1); // one write per schedule before it
        expect(w.events.slice(0, firstLaunch).every((e) => e === 'write')).toBe(true);
    });

    it('does not count the time other launches took against a session waiting for its prompt', async () => {
        const w = slowWorld([schedule('aaaaaa', { prompt: 'go' }), schedule('bbbbbb', { wt: 'feat/x' })]);
        const START = T0 + 15 * MIN + 30_000;
        await w.runner.tick(START);
        // The tick ended 100 s after the first session came up: more than PROMPT_WAIT_MS, all of it spent launching the second.
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(true);
        expect(w.state.schedules.aaaaaa!.pending).toBeUndefined();
        w.pane.ready = true;
        await w.runner.poll(START + 100_000 + PROMPT_POLL_MS);
        expect(w.typed).toEqual([{ session: 'hwip-app-sched-aaaaaa', prompt: 'go' }]);
    });

    it('still gives up on a prompt PROMPT_WAIT_MS after the launches are over', async () => {
        const w = slowWorld([schedule('aaaaaa', { prompt: 'go' }), schedule('bbbbbb')]);
        const START = T0 + 15 * MIN + 30_000;
        await w.runner.tick(START);
        // The first session came up 100 s into the tick, the second launch ended the tick 100 s later.
        await w.runner.poll(START + 200_000 + PROMPT_WAIT_MS + 1);
        expect(w.state.schedules.aaaaaa!.pending!.counts).toEqual({ prompt_undelivered: 1 });
    });
});

describe('what the state file keeps when a write fails', () => {
    it('leaves cursor and last as they were, also in what the next schedule saves', async () => {
        const old = { outcome: 'started', at: T0 } as const;
        const state: ScheduleStateFile = { v: 1, schedules: { aaaaaa: { cursor: T0, last: old } } };
        let writes = 0;
        const w = world([schedule('aaaaaa'), schedule('bbbbbb')], {
            state,
            writeState: (next) => {
                writes += 1;
                if (writes === 1) return false;
                w0.state = structuredClone(next);
                return true;
            },
        });
        const w0 = w;
        await w.runner.tick(T0 + 8 * HOUR);
        expect(w.launched.map((l) => l.args[3])).toEqual(['sched-bbbbbb']);
        expect(w.state.schedules.aaaaaa).toEqual({ cursor: T0, last: old });
    });
});

describe('the log line of a failed launch', () => {
    it('is the first non-empty line of the error, without control characters', async () => {
        const w = world([schedule('aaaaaa')], { launchResult: { ok: false, error: '\n\u001b[31mclaude: not found\u0007\nsecond line' } });
        await w.runner.tick(T0 + 15 * MIN);
        const line = w.logs.find((l) => l.includes('launch failed'))!;
        expect(line).toContain('claude: not found');
        expect(line).not.toContain('second line');
        expect(line).not.toMatch(/[\u0000-\u001f]/);
    });
});

describe('a prompt for a started session', () => {
    const START = T0 + 15 * MIN + 10_000;
    const started = async (over: Partial<Schedule> = {}) => {
        const w = world([schedule('aaaaaa', { prompt: 'summarise the open PRs', ...over })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        return w;
    };

    it('is waiting once the session is up', async () => {
        const w = await started();
        expect(w.state.schedules.aaaaaa!.running).toMatchObject({ promptPending: true, startedAt: START });
        expect(w.typed).toEqual([]);
    });

    it('is not typed before the agent is ready, then typed exactly once however many polls follow', async () => {
        const w = await started();
        await w.runner.poll(START + PROMPT_POLL_MS);
        await w.runner.poll(START + 2 * PROMPT_POLL_MS);
        expect(w.typed).toEqual([]);
        w.pane.ready = true;
        await w.runner.poll(START + 3 * PROMPT_POLL_MS);
        await w.runner.poll(START + 4 * PROMPT_POLL_MS);
        await w.runner.poll(START + 5 * PROMPT_POLL_MS);
        expect(w.typed).toEqual([{ session: 'hwip-app-sched-aaaaaa', prompt: 'summarise the open PRs' }]);
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(false);
    });

    it('tries again at the next poll when the prompt was not accepted (rate limit), and does not call that undelivered', async () => {
        const w = await started();
        w.pane.ready = true;
        w.pane.injectOk = false;
        await w.runner.poll(START + PROMPT_POLL_MS);
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(true);
        expect(w.notes).toEqual([]);
        w.pane.injectOk = true;
        await w.runner.poll(START + 2 * PROMPT_POLL_MS);
        expect(w.typed).toHaveLength(1);
    });

    it('gives up after PROMPT_WAIT_MS: tells the person once, keeps the session, never types it late', async () => {
        const w = await started();
        await w.runner.poll(START + PROMPT_WAIT_MS + 1);
        expect(w.state.schedules.aaaaaa!.pending!.counts).toEqual({ prompt_undelivered: 1 });
        await w.runner.tick(START + PROMPT_WAIT_MS + 2_000); // the push goes with the next tick
        expect(w.notes).toHaveLength(1);
        expect(w.notes[0]!.body).toContain('sched-aaaaaa · 할 일 입력 못 함 1회');
        expect(w.notes[0]!.body).not.toContain('summarise');
        expect(last(w, 'aaaaaa')).toBe('prompt_undelivered');
        expect(w.state.schedules.aaaaaa!.running).toMatchObject({ promptPending: false });
        w.pane.ready = true;
        await w.runner.poll(START + PROMPT_WAIT_MS + PROMPT_POLL_MS);
        expect(w.typed).toEqual([]);
        expect(w.notes).toHaveLength(1);
        expect(w.ended).toEqual([]);
    });

    it('is not asked about when the schedule has no prompt', async () => {
        let asked = 0;
        const w = world([schedule('aaaaaa')], { ready: () => { asked += 1; return true; } });
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.poll(START + PROMPT_POLL_MS);
        expect(asked).toBe(0);
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(false);
    });

    it('does not even read the state while no prompt is waiting', async () => {
        let reads = 0;
        const w = world([schedule('aaaaaa')]);
        const read = w.deps.readState;
        w.deps.readState = () => { reads += 1; return read(); };
        const runner = createScheduleRunner(w.deps);
        await runner.tick(START);
        const afterTick = reads;
        await runner.poll(START + PROMPT_POLL_MS);
        await runner.poll(START + 2 * PROMPT_POLL_MS);
        expect(reads).toBe(afterTick);
    });

    it('is carried on after the listener restarts: the state says what was waiting', async () => {
        const w = await started();
        const again = world([schedule('aaaaaa', { prompt: 'summarise the open PRs' })], { state: w.state });
        again.sessions.add('hwip-app-sched-aaaaaa');
        again.pane.ready = true;
        await again.runner.poll(START + PROMPT_POLL_MS);
        expect(again.typed).toHaveLength(1);
    });

    it('is told about once after a restart that came too late for it', async () => {
        const w = await started();
        const again = world([schedule('aaaaaa', { prompt: 'summarise the open PRs' })], { state: w.state });
        again.sessions.add('hwip-app-sched-aaaaaa');
        again.pane.ready = true;
        await again.runner.poll(START + PROMPT_WAIT_MS + MIN / 3);
        await again.runner.poll(START + PROMPT_WAIT_MS + MIN);
        await again.runner.tick(START + PROMPT_WAIT_MS + 2 * MIN);
        expect(again.typed).toEqual([]);
        expect(again.notes).toHaveLength(1);
    });
});

describe('a session past its runtime cap', () => {
    const START = T0 + 15 * MIN + 10_000;
    const MAX_MS = 15 * MIN;
    const started = async () => {
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 15 })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        return w;
    };

    it('is left alone until it has run longer than the cap', async () => {
        const w = await started();
        await w.runner.tick(START + MAX_MS);
        expect(w.ended).toEqual([]);
    });

    it('is asked to end once, still counts as running while it is there, and the person is told once', async () => {
        // A 5-minute cap, so that it passes between two due times.
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 5 })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.tick(START + 5 * MIN + 1);
        expect(w.ended).toEqual(['hwip-app-sched-aaaaaa']);
        expect(w.state.schedules.aaaaaa!.running).toMatchObject({ capped: true, promptPending: false });
        expect(last(w, 'aaaaaa')).toBe('capped');
        expect(w.notes).toHaveLength(1);
        expect(w.notes[0]).toMatchObject({ title: '예약 실행 시간 초과' });
        expect(w.notes[0]!.body).toContain('실행 시간 초과 1회');
        // Later ticks neither ask again nor tell again.
        await w.runner.tick(START + 5 * MIN + 31_000);
        await w.runner.poll(START + 5 * MIN + 40_000);
        expect(w.ended).toHaveLength(1);
        expect(w.notes).toHaveLength(1);
    });

    it('does not ask again or tell again every tick when the state file cannot be written', async () => {
        const record: ScheduleStateFile = {
            v: 1,
            schedules: { aaaaaa: { cursor: T0 + 15 * MIN, running: { session: 'hwip-app-sched-aaaaaa', startedAt: T0 + 15 * MIN, promptPending: false } } },
        };
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 5 })], { state: record, writeState: () => false });
        w.sessions.add('hwip-app-sched-aaaaaa');
        for (const minutes of [21, 22, 23]) await w.runner.tick(T0 + minutes * MIN);
        expect(w.ended).toEqual(['hwip-app-sched-aaaaaa']);
        expect(w.notes).toHaveLength(1);
        expect(w.logs.filter((l) => l.includes('capped after'))).toHaveLength(1);
    });

    // Without a kill (D11) a session may ignore the request; the limit of three has to keep counting it.
    it('does not let sessions that ignore the request make room for more than MAX_RUNNING', async () => {
        const four = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd'].map((id) => schedule(id, { maxRuntimeMin: 5 }));
        const w = world(four);
        await w.runner.tick(T0 + 15 * MIN + 10_000); // a, b, c start; d is over the limit
        expect(w.launched).toHaveLength(MAX_RUNNING);
        expect(last(w, 'dddddd')).toBe('busy');
        for (const s of four.slice(0, 3)) w.sessions.add(s.session);
        await w.runner.tick(T0 + 15 * MIN + 10_000 + 5 * MIN + 1); // the cap passes; endSession does nothing
        expect(w.ended).toHaveLength(MAX_RUNNING);
        await w.runner.tick(T0 + 30 * MIN + 10_000); // all four are due again
        expect(w.launched).toHaveLength(MAX_RUNNING);
        expect(w.sessions.size).toBe(MAX_RUNNING);
        expect(last(w, 'dddddd')).toBe('busy');
    });

    it('makes room once the capped session is gone', async () => {
        const w = await started();
        await w.runner.tick(START + MAX_MS + 1);
        w.sessions.delete('hwip-app-sched-aaaaaa');
        await w.runner.tick(T0 + 45 * MIN + 10_000);
        expect(w.launched).toHaveLength(2);
        expect(w.state.schedules.aaaaaa!.running).toMatchObject({ startedAt: T0 + 45 * MIN + 10_000 });
        expect(w.state.schedules.aaaaaa!.running!.capped).toBeUndefined();
    });

    it('is asked to end by a poll as well', async () => {
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 15, prompt: 'go' })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.poll(START + MAX_MS + PROMPT_POLL_MS);
        expect(w.ended).toEqual(['hwip-app-sched-aaaaaa']);
    });

    it('is only forgotten when it ended by itself: no signal, no message', async () => {
        const w = await started();
        w.sessions.delete('hwip-app-sched-aaaaaa');
        await w.runner.tick(START + MAX_MS + 1); // the 30-minute time is due too, and starts a new run
        expect(w.ended).toEqual([]);
        expect(w.notes).toEqual([]);
        expect(w.state.schedules.aaaaaa!.running!.startedAt).toBe(START + MAX_MS + 1);
    });
});

describe('a prompt typed once, whatever happens next', () => {
    const START = T0 + 15 * MIN + 10_000;

    it('is not typed again when the state saying it was typed could not be written', async () => {
        let failWrites = false;
        const w = world([schedule('aaaaaa', { prompt: 'go' })], {
            writeState: (next) => {
                if (failWrites) return false;
                w0.state = structuredClone(next);
                return true;
            },
        });
        const w0 = w;
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        w.pane.ready = true;
        failWrites = true;
        await w.runner.poll(START + PROMPT_POLL_MS);
        await w.runner.poll(START + 2 * PROMPT_POLL_MS);
        expect(w.typed).toHaveLength(1);
    });

    it('is on disk before another schedule\'s push is waited for', async () => {
        const w = world([schedule('aaaaaa', { prompt: 'go' })], {
            notify: async () => new Promise<boolean>(() => undefined), // a push that never comes back
        });
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        w.pane.ready = true;
        await w.runner.poll(START + PROMPT_POLL_MS);
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(false);
    });

    it('stops waiting when the prompt was taken out of the schedule', async () => {
        const w = world([schedule('aaaaaa', { prompt: 'go' })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        w.schedules = [schedule('aaaaaa')];
        w.pane.ready = true;
        await w.runner.poll(START + PROMPT_POLL_MS);
        expect(w.typed).toEqual([]);
        expect(w.state.schedules.aaaaaa!.running!.promptPending).toBe(false);
    });
});

describe('ticks and polls', () => {
    it('do not run over each other: a poll during a launch does nothing', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let reads = 0;
        const w = world([schedule('aaaaaa', { prompt: 'go' })], {
            launch: async () => { await gate; return { ok: true }; },
        });
        const read = w.deps.readState;
        w.deps.readState = () => { reads += 1; return read(); };
        const runner = createScheduleRunner(w.deps);
        const first = runner.tick(T0 + 15 * MIN);
        const readsDuringLaunch = reads;
        await runner.poll(T0 + 15 * MIN + PROMPT_POLL_MS);
        expect(reads).toBe(readsDuringLaunch);
        release();
        await first;
    });
});

describe('telling the person', () => {
    const T = T0 + 8 * HOUR;
    const everyEight = (id: string, over: Partial<Schedule> = {}) => schedule(id, { when: { kind: 'every', minutes: 15 }, prompt: 'secret prompt text', ...over });

    it('is one push for a night of sleep: 31 missed runs counted, the newest run started', async () => {
        const w = world([everyEight('aaaaaa')]);
        await w.runner.tick(T + 10_000);
        expect(w.notes).toEqual([{ title: '예약 건너뜀', body: 'sched-aaaaaa · 놓침 31회' }]);
        await w.runner.tick(T + 40_000); // what was told comes off the state when the next tick loads it
        expect(w.state.schedules.aaaaaa!.pending).toBeUndefined();
        expect(w.notes).toHaveLength(1);
    });

    it('puts every schedule that has news in one push, one line each, and never the prompt', async () => {
        const w = world([everyEight('aaaaaa', { cwd: '/work/gone' }), everyEight('bbbbbb', { agentKind: 'mystery' as never }), everyEight('cccccc')]);
        w.deps.directoryExists = (cwd) => cwd !== '/work/gone';
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(w.notes).toHaveLength(1);
        expect(w.notes[0]!.body.split('\n')).toEqual(['sched-aaaaaa · 폴더 없음 1회', 'sched-bbbbbb · 알 수 없는 에이전트 1회']);
        expect(JSON.stringify(w.notes)).not.toContain('secret');
    });

    it('keeps what it could not send and sends it with the next tick, once', async () => {
        let up = false;
        const w = world([everyEight('aaaaaa')], { notify: async (title, body) => { w0.notes.push({ title, body }); return up ? 'sent' : 'retry'; } });
        const w0 = w;
        await w.runner.tick(T);
        expect(w.state.schedules.aaaaaa!.pending!.counts).toEqual({ missed: 31 });
        up = true;
        await w.runner.tick(T + 30_000);
        expect(w.notes).toHaveLength(2);
        expect(w.notes[1]!.body).toBe('sched-aaaaaa · 놓침 31회');
        await w.runner.tick(T + 60_000);
        expect(w.state.schedules.aaaaaa!.pending).toBeUndefined();
        expect(w.notes).toHaveLength(2);
    });

    it('waits longer after every failed push: 30 s, then 60 s, then 120 s, up to 30 minutes', async () => {
        let calls = 0;
        const w = world([everyEight('aaaaaa')], { notify: async () => { calls += 1; return 'retry'; } });
        await w.runner.tick(T);
        expect(calls).toBe(1);
        await w.runner.tick(T + 29_000);
        expect(calls).toBe(1);
        await w.runner.tick(T + 30_000); // second try; the next wait is 60 s
        expect(calls).toBe(2);
        await w.runner.tick(T + 60_000);
        await w.runner.tick(T + 89_000);
        expect(calls).toBe(2);
        await w.runner.tick(T + 90_000);
        expect(calls).toBe(3);
        // After many failures the wait stops growing at 30 minutes.
        let at = T + 90_000;
        for (let i = 0; i < 10; i++) {
            at += 31 * MIN;
            await w.runner.tick(at);
        }
        expect(calls).toBe(13);
        expect(w.state.schedules.aaaaaa!.pending).toBeDefined();
    });

    it('starts over at 30 s after a push went out', async () => {
        let outcome: 'sent' | 'retry' = 'retry';
        let calls = 0;
        const w = world([everyEight('aaaaaa')], { notify: async () => { calls += 1; return outcome; } });
        await w.runner.tick(T);
        await w.runner.tick(T + 30_000); // fails again: wait 60 s
        outcome = 'sent';
        await w.runner.tick(T + 90_000); // goes out
        expect(calls).toBe(3);
        outcome = 'retry';
        await w.runner.tick(T + 15 * MIN + 10_000); // a new run's news; fails: wait 30 s
        const afterFail = calls;
        await w.runner.tick(T + 15 * MIN + 10_000 + 30_000);
        expect(calls).toBe(afterFail + 1);
    });

    // A 4xx (a daily limit among them) refuses this push itself; the same text sent every few minutes would only be refused again.
    it('does not try again after the server refused the push, and forgets it', async () => {
        let calls = 0;
        const w = world([everyEight('aaaaaa', { prompt: undefined })], { notify: async () => { calls += 1; return 'rejected'; } });
        await w.runner.tick(T);
        await w.runner.tick(T + 30_000);
        await w.runner.tick(T + 10 * MIN);
        expect(calls).toBe(1);
        expect(w.state.schedules.aaaaaa!.pending).toBeUndefined();
        expect(w.logs.join('\n')).toContain('the server refused the push');
    });

    it('keeps it too when the push throws', async () => {
        const w = world([everyEight('aaaaaa')], { notify: async () => { throw new Error('offline'); } });
        await w.runner.tick(T);
        expect(w.state.schedules.aaaaaa!.pending!.counts).toEqual({ missed: 31 });
        expect(w.logs.join('\n')).toContain('offline');
    });

    it('drops a report older than 24 hours with one log line and no push', async () => {
        const state: ScheduleStateFile = { v: 1, schedules: { aaaaaa: { cursor: T0 + 15 * MIN, pending: { since: T0, counts: { missed: 3 } } } } };
        const w = world([everyEight('aaaaaa')], { state });
        await w.runner.tick(T0 + 25 * HOUR);
        expect(w.logs.filter((l) => l.includes('older than 24 h'))).toHaveLength(1);
        expect(w.notes.some((n) => n.body.includes('놓침 3회'))).toBe(false);
    });

    it('says overlap only for the first of a streak, and the same for busy', async () => {
        const w = world([everyEight('aaaaaa')]);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        await w.runner.tick(T0 + 45 * MIN + 10_000);
        expect(w.notes.map((n) => n.body)).toEqual(['sched-aaaaaa · 이미 실행 중이라 건너뜀 1회']);
    });

    it('says a start that failed every time it fails', async () => {
        const w = world([everyEight('aaaaaa')], { launchResult: { ok: false, error: 'no agent' } });
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        expect(w.notes.map((n) => n.body)).toEqual(['sched-aaaaaa · 시작 실패 1회', 'sched-aaaaaa · 시작 실패 1회']);
    });

    it('says nothing when everything started', async () => {
        const w = world([everyEight('aaaaaa')]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(w.notes).toEqual([]);
    });

    it('takes only what it told off the state: news that came while the push was on its way is told next', async () => {
        let release: (sent: boolean) => void = () => undefined;
        let calls = 0;
        const w = world([everyEight('aaaaaa', { cwd: '/work/gone' })], {
            notify: async (title, body) => {
                w0.notes.push({ title, body });
                calls += 1;
                if (calls > 1) return true;
                return new Promise<boolean>((resolve) => { release = resolve; });
            },
        });
        const w0 = w;
        w.deps.directoryExists = () => false;
        const first = w.runner.tick(T0 + 15 * MIN + 10_000); // pushes "폴더 없음 1회" and waits for the answer
        await new Promise((resolve) => setImmediate(resolve));
        // The push has not come back, but ticks go on: the state is not held, and no second push starts.
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        expect(w.notes).toHaveLength(1);
        expect(w.state.schedules.aaaaaa!.pending!.counts).toEqual({ missing_directory: 2 });
        release(true);
        await first;
        // The next tick takes the first run's count off (it was told), adds its own, and tells what is left: two runs.
        await w.runner.tick(T0 + 45 * MIN + 10_000);
        expect(w.notes).toHaveLength(2);
        expect(w.notes[1]!.body).toBe('sched-aaaaaa · 폴더 없음 2회');
    });

    it('says busy only for the first of a streak', async () => {
        const w = world([everyEight('aaaaaa'), everyEight('bbbbbb'), everyEight('cccccc'), everyEight('dddddd')]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        await w.runner.tick(T0 + 45 * MIN + 10_000);
        // Three run at once; the fourth is busy each time (its sessions never end here), reported once.
        const busy = w.notes.filter((n) => n.body.includes('동시 실행 한도'));
        expect(busy).toHaveLength(1);
    });

    it('keeps what was already pending when the cursor cannot be written', async () => {
        const pending = { since: T0, counts: { start_failed: 2 } };
        const state: ScheduleStateFile = { v: 1, schedules: { aaaaaa: { cursor: T0, pending } } };
        let writes = 0;
        const w = world([everyEight('aaaaaa')], {
            state,
            writeState: (next) => {
                writes += 1;
                if (writes === 1) return false;
                w0.state = structuredClone(next);
                return true;
            },
        });
        const w0 = w;
        await w.runner.tick(T0 + 8 * HOUR);
        expect(w.state.schedules.aaaaaa?.pending?.counts ?? {}).toEqual({ start_failed: 2 });
    });
});

describe('a session tmux could not be asked about', () => {
    it('keeps its record: not being able to tell is not the session being over', async () => {
        const w = world([schedule('aaaaaa', { prompt: 'go' })]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        w.sessions.delete('hwip-app-sched-aaaaaa'); // the probe finds nothing…
        const again = world([schedule('aaaaaa', { prompt: 'go' })], { state: w.state, sessionEnded: () => false }); // …but does not know it is over
        again.pane.ready = true;
        await again.runner.poll(T0 + 15 * MIN + 15_000);
        expect(again.state.schedules.aaaaaa!.running).toBeDefined();
    });
});

describe('the title of the push says what kind of news it is', () => {
    const T = T0 + 8 * HOUR;

    it('is "예약 건너뜀" for missed and skipped runs', async () => {
        const w = world([schedule('aaaaaa')]);
        await w.runner.tick(T);
        expect(w.notes[0]!.title).toBe('예약 건너뜀');
    });

    it('is "예약 할 일 입력 못 함" for a prompt that was not typed', async () => {
        const w = world([schedule('aaaaaa', { prompt: 'go' })]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.poll(T0 + 15 * MIN + 10_000 + PROMPT_WAIT_MS + 1);
        await w.runner.tick(T0 + 15 * MIN + 10_000 + PROMPT_WAIT_MS + 2_000);
        expect(w.notes[0]!.title).toBe('예약 할 일 입력 못 함');
    });

    it('is the general "예약 알림" when one push holds different kinds', async () => {
        const w = world([schedule('aaaaaa'), schedule('bbbbbb', { directoryMissing: undefined } as Partial<Schedule>)], {
            directoryExists: (cwd) => cwd !== '/gone',
        });
        w.schedules[1] = schedule('bbbbbb', { cwd: '/gone', maxRuntimeMin: 15 });
        // aaaaaa started a while ago and is past its cap; bbbbbb's folder is gone.
        w.state = { v: 1, schedules: { aaaaaa: { cursor: T0 + 15 * MIN, running: { session: 'hwip-app-sched-aaaaaa', startedAt: T0 + 15 * MIN, promptPending: false } } } };
        w.sessions.add('hwip-app-sched-aaaaaa');
        await w.runner.tick(T0 + 15 * MIN + 16 * MIN);
        expect(w.notes[0]!.title).toBe('예약 알림');
        expect(w.notes[0]!.body).toContain('실행 시간 초과 1회');
        expect(w.notes[0]!.body).toContain('폴더 없음 1회');
    });
});

describe('a prompt for an agent whose rules cannot say idle', () => {
    const START = T0 + 15 * MIN + 10_000;

    it('starts the session without the prompt, never types it, and tells the person why', async () => {
        const w = world([schedule('aaaaaa', { agentKind: 'claude', prompt: 'go' })], { canPrompt: () => false });
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        expect(w.launched).toHaveLength(1);
        expect(w.state.schedules.aaaaaa!.running).toMatchObject({ promptPending: false });
        w.pane.ready = true; // even a screen that looks ready
        await w.runner.poll(START + PROMPT_POLL_MS);
        await w.runner.poll(START + 2 * PROMPT_POLL_MS);
        expect(w.typed).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('prompt_unsupported');
        await w.runner.tick(START + 31_000);
        expect(w.notes).toHaveLength(1);
        expect(w.notes[0]).toMatchObject({ title: '예약 할 일 입력 못 함' });
        expect(w.notes[0]!.body).toContain('이 에이전트는 입력 준비를 판정할 규칙이 없음');
        expect(w.notes[0]!.body).not.toContain('go');
    });

    it('has nothing to say about a schedule without a prompt', async () => {
        const w = world([schedule('aaaaaa')], { canPrompt: () => false });
        await w.runner.tick(START);
        await w.runner.tick(START + 31_000);
        expect(last(w, 'aaaaaa')).toBe('started');
        expect(w.notes).toEqual([]);
    });
});

describe('the launch timeout', () => {
    it('is longer for --wt, which makes the worktree first', async () => {
        const timeouts: number[] = [];
        const launch = async (_args: string[], _cwd: string, timeoutMs: number): Promise<LaunchResult> => { timeouts.push(timeoutMs); return { ok: true }; };
        const w = world([schedule('aaaaaa'), schedule('bbbbbb', { wt: 'feat/x', label: 'sched-bbbbbb', session: 'hwip-app-wt-feat-x' })], { launch });
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(timeouts).toEqual([LAUNCH_TIMEOUT_MS, LAUNCH_WT_TIMEOUT_MS]);
    });
});

describe('files the runner cannot use', () => {
    it('are said once, not at every tick', async () => {
        const w = world([schedule('aaaaaa')], { listSchedules: () => ({ schedules: [], unreadable: 2 }) });
        await w.runner.tick(T0 + 15 * MIN);
        await w.runner.tick(T0 + 16 * MIN);
        expect(w.logs.filter((l) => l.includes('2 schedule files skipped'))).toHaveLength(1);
    });
});

describe('a running record that names another session', () => {
    it('is dropped: it neither counts against the limit nor has that session asked to end', async () => {
        const state: ScheduleStateFile = {
            v: 1,
            schedules: { aaaaaa: { cursor: T0 + 15 * MIN, running: { session: 'hwip-some-other-work', startedAt: T0, promptPending: false } } },
        };
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 5 })], { state });
        w.sessions.add('hwip-some-other-work');
        await w.runner.tick(T0 + 16 * MIN);
        expect(w.ended).toEqual([]);
        expect(w.state.schedules.aaaaaa!.running).toBeUndefined();
        expect(w.logs.some((l) => l.includes('hwip-some-other-work'))).toBe(true);
    });
});

describe('notifyFailureOutcome', () => {
    const failure = (code: string, status: number) => Object.assign(new Error('x'), { code, status });

    it('gives up only on the server saying no to this very push', () => {
        expect(notifyFailureOutcome(failure('QUOTA_EXCEEDED', 429))).toBe('rejected');
        expect(notifyFailureOutcome(failure('FORBIDDEN', 403))).toBe('rejected');
        expect(notifyFailureOutcome(failure('INVALID_REQUEST', 400))).toBe('rejected');
    });

    it('tries again after a timeout of the client, which is reported as 408', () => {
        expect(notifyFailureOutcome(failure('TIMEOUT', 408))).toBe('retry');
    });

    it('tries again after a proxy that wants credentials (407) or a page that is not the API (captive portal)', () => {
        expect(notifyFailureOutcome(failure('PROXY_AUTH', 407))).toBe('retry');
        expect(notifyFailureOutcome(failure('INVALID_RESPONSE', 403))).toBe('retry');
        expect(notifyFailureOutcome(failure('INVALID_RESPONSE', 200))).toBe('retry');
    });

    it('tries again after the network failing, a 5xx, or anything that is not an HTTP failure', () => {
        expect(notifyFailureOutcome(failure('NETWORK_ERROR', 0))).toBe('retry');
        expect(notifyFailureOutcome(failure('SERVER_ERROR', 503))).toBe('retry');
        expect(notifyFailureOutcome(new Error('boom'))).toBe('retry');
        expect(notifyFailureOutcome('boom')).toBe('retry');
        expect(notifyFailureOutcome(null)).toBe('retry');
    });
});

describe('an edited schedule [F8-edit]', () => {
    it('counts from the edit: the times before it are neither run nor missed, and an every runs a period after it', async () => {
        const edited = new Date(T0 + 5 * HOUR + 7 * MIN).toISOString();
        const w = world([schedule('aaaaaa', { updatedAt: edited })], { state: { v: 1, schedules: { aaaaaa: { cursor: T0 } } } });
        await w.runner.tick(T0 + 5 * HOUR + 7 * MIN + 30_000);
        expect(w.launched).toEqual([]);
        expect(w.logs.join('\n')).not.toContain('missed');
        await w.runner.tick(T0 + 5 * HOUR + 22 * MIN + 10_000);
        expect(w.launched).toHaveLength(1);
        expect(w.logs.join('\n')).not.toContain('missed');
    });

    it('does not count the daily times between the old cursor and the edit as missed', async () => {
        const edited = new Date(T0 + 3 * 24 * HOUR).toISOString();
        const daily = schedule('aaaaaa', { updatedAt: edited, when: { kind: 'daily', at: '00:30', days: [0, 1, 2, 3, 4, 5, 6] }, maxRuntimeMin: 30 });
        const w = world([daily], { state: { v: 1, schedules: { aaaaaa: { cursor: T0 } } } });
        await w.runner.tick(T0 + 3 * 24 * HOUR + 10 * MIN);
        expect(w.logs.join('\n')).not.toContain('missed');
        expect(last(w, 'aaaaaa')).toBeUndefined();
    });
});

describe('a running session when its schedule is edited [F8-edit]', () => {
    it('keeps running, is not started again, and is held to a shorter cap at the next poll', async () => {
        const START = T0 + 15 * MIN + 10_000;
        const w = world([schedule('aaaaaa', { maxRuntimeMin: 15 })]);
        await w.runner.tick(START);
        w.sessions.add('hwip-app-sched-aaaaaa');
        expect(w.launched).toHaveLength(1);
        w.schedules = [schedule('aaaaaa', { maxRuntimeMin: 5, updatedAt: new Date(START + 2 * MIN).toISOString() })];
        w.deps.listSchedules = () => ({ schedules: w.schedules, unreadable: 0 });
        await w.runner.tick(START + 3 * MIN);
        expect(w.ended).toEqual([]);
        expect(w.state.schedules.aaaaaa!.running).toBeDefined();
        await w.runner.tick(START + 5 * MIN + 1);
        expect(w.ended).toEqual(['hwip-app-sched-aaaaaa']);
        expect(w.launched).toHaveLength(1);
    });
});

describe('when kind once', () => {
    const AT = T0 + 30 * MIN;
    const once = (id: string, over: Partial<Schedule> = {}): Schedule =>
        schedule(id, { when: { kind: 'once', at: new Date(AT).toISOString() }, maxRuntimeMin: 120, ...over });

    it('runs at its time, is removed once its session has ended, and never runs again', async () => {
        const w = world([once('aaaaaa')]);
        await w.runner.tick(AT - 10_000);
        expect(w.launched).toEqual([]);
        await w.runner.tick(AT + 10_000);
        expect(w.launched).toHaveLength(1);
        expect(last(w, 'aaaaaa')).toBe('started');
        // Its session still runs: the schedule stays, so the runtime cap and the prompt are still looked after.
        await w.runner.tick(AT + 40_000);
        expect(w.removed).toEqual([]);
        w.sessions.clear();
        await w.runner.tick(AT + 70_000);
        expect(w.removed).toEqual(['aaaaaa']);
        expect(w.state.schedules.aaaaaa).toBeUndefined();
        await w.runner.tick(AT + 24 * HOUR);
        expect(w.launched).toHaveLength(1);
    });

    it('still runs 29 minutes late, after the listener was down', async () => {
        const w = world([once('aaaaaa')]);
        await w.runner.tick(AT + 29 * MIN);
        expect(w.launched).toHaveLength(1);
        expect(ONCE_GRACE_MS).toBe(30 * MIN);
    });

    it('is missed 31 minutes late: not run, told, then removed', async () => {
        const w = world([once('aaaaaa')]);
        await w.runner.tick(AT + 31 * MIN);
        expect(w.launched).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('missed');
        expect(w.notes).toEqual([{ title: '예약 건너뜀', body: 'sched-aaaaaa · 놓침 1회' }]);
        await w.runner.tick(AT + 32 * MIN);
        expect(w.removed).toEqual(['aaaaaa']);
        expect(w.notes).toHaveLength(1);
    });

    it('is removed after a run that failed to start, once that was told', async () => {
        const w = world([once('aaaaaa')], { launchResult: { ok: false, error: 'boom' } });
        await w.runner.tick(AT + 10_000);
        expect(last(w, 'aaaaaa')).toBe('start_failed');
        expect(w.notes).toHaveLength(1);
        await w.runner.tick(AT + 40_000);
        expect(w.removed).toEqual(['aaaaaa']);
        expect(w.launched).toHaveLength(1);
    });

    it('stays until its report has gone out when the push keeps failing', async () => {
        const w = world([once('aaaaaa')], { notify: async () => 'retry' });
        await w.runner.tick(AT + 31 * MIN);
        await w.runner.tick(AT + 32 * MIN);
        expect(w.removed).toEqual([]);
        expect(w.state.schedules.aaaaaa?.pending?.counts).toEqual({ missed: 1 });
    });

    it('reports a once whose time went by without a record (a damaged state file) as missed before removing it', async () => {
        const w = world([once('aaaaaa')], { readState: () => ({ v: 1, schedules: {}, damaged: true }) });
        await w.runner.tick(AT + 5 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.notes).toEqual([{ title: '예약 건너뜀', body: 'sched-aaaaaa · 놓침 1회' }]);
        expect(w.removed).toEqual([]);
    });

    it('keeps the schedule when its id cannot name a file', async () => {
        const w = world([once('aaaaaa')], { removeSchedule: () => 'invalid' });
        await w.runner.tick(AT + 31 * MIN);
        await w.runner.tick(AT + 32 * MIN);
        expect(w.state.schedules.aaaaaa).toBeDefined();
        expect(w.logs.join('\n')).toContain('could not remove');
        expect(w.logs.join('\n')).not.toContain('ran once, removed');
    });

    it('is not run again when its file cannot be removed', async () => {
        const w = world([once('aaaaaa')], { removeSchedule: () => { throw new Error('EACCES'); } });
        await w.runner.tick(AT + 31 * MIN);
        await w.runner.tick(AT + 32 * MIN);
        await w.runner.tick(AT + 33 * MIN);
        expect(w.launched).toEqual([]);
        expect(w.notes).toHaveLength(1);
        expect(w.logs.filter((l) => l.includes('could not remove'))).toHaveLength(1);
    });
});

describe('session target', () => {
    const AT = T0 + 30 * MIN;
    const RUN = '1760000000';
    const into = (id: string, over: Partial<Schedule> = {}): Schedule => schedule(id, {
        when: { kind: 'once', at: new Date(AT).toISOString() },
        target: 'session',
        runId: RUN,
        session: 'hwip-app',
        label: `sched-${id}`,
        prompt: `prompt ${id}`,
        maxRuntimeMin: 120,
        ...over,
    });
    const alive = (w: World, name = 'hwip-app'): void => {
        w.runs.set(RUN, { name });
        w.sessions.add(name);
    };

    it('types the prompt into the running session instead of starting one, and says nothing', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        await w.runner.tick(AT + 10_000);
        expect(w.launched).toEqual([]);
        expect(w.typed).toEqual([{ session: 'hwip-app', prompt: 'prompt aaaaaa' }]);
        expect(last(w, 'aaaaaa')).toBe('started');
        expect(w.notes).toEqual([]);
    });

    it('waits while the session works, and types when it is idle', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        await w.runner.tick(AT + 10_000);
        expect(w.typed).toEqual([]);
        expect(w.state.schedules.aaaaaa!.delivering).toEqual({ session: 'hwip-app', since: AT + 10_000 });
        await w.runner.poll(AT + 20 * MIN);
        expect(w.typed).toEqual([]);
        w.pane.ready = true;
        await w.runner.poll(AT + 25 * MIN);
        expect(w.typed).toHaveLength(1);
        expect(w.state.schedules.aaaaaa?.delivering).toBeUndefined();
    });

    it('gives up as session_busy after 30 minutes of waiting, counted from when the wait began', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        await w.runner.tick(AT + 10_000);
        await w.runner.poll(AT + 10_000 + SESSION_WAIT_MS);
        expect(last(w, 'aaaaaa')).toBeUndefined();
        await w.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(last(w, 'aaaaaa')).toBe('session_busy');
        expect(w.typed).toEqual([]);
        expect(w.notes).toEqual([{ title: '예약 건너뜀', body: 'sched-aaaaaa · 세션이 계속 작업 중이라 건너뜀 1회' }]);
        expect(SESSION_WAIT_MS).toBe(30 * MIN);
    });

    it('keeps the wait it had across a listener restart', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        await w.runner.tick(AT + 10_000);
        const again = world([into('aaaaaa')], { state: w.state });
        alive(again);
        await again.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(last(again, 'aaaaaa')).toBe('session_busy');
    });

    it('fails as session_ended when the run is over, and tells a repeating schedule only the first time', async () => {
        const w = world([into('aaaaaa', { when: { kind: 'every', minutes: 15 } })]);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(last(w, 'aaaaaa')).toBe('session_ended');
        expect(w.notes).toEqual([{ title: '예약 세션 종료됨', body: 'sched-aaaaaa · 세션 종료됨 1회' }]);
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        expect(last(w, 'aaaaaa')).toBe('session_ended');
        expect(w.notes).toHaveLength(1);
        expect(w.launched).toEqual([]);
    });

    it('keeps waiting, not failing, while tmux cannot say where the run is', async () => {
        const w = world([into('aaaaaa')]);
        w.runs.set(RUN, 'unknown');
        await w.runner.tick(AT + 10_000);
        await w.runner.poll(AT + 5 * MIN);
        expect(last(w, 'aaaaaa')).toBeUndefined();
        expect(w.state.schedules.aaaaaa!.delivering).toBeDefined();
        alive(w);
        w.pane.ready = true;
        await w.runner.poll(AT + 6 * MIN);
        expect(w.typed).toHaveLength(1);
    });

    it('follows the run when it was resumed under another name while the prompt waited', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        await w.runner.tick(AT + 10_000);
        alive(w, 'hwip-app-2');
        w.pane.ready = true;
        await w.runner.poll(AT + MIN);
        expect(w.typed).toEqual([{ session: 'hwip-app-2', prompt: 'prompt aaaaaa' }]);
    });

    it('waits while someone typed at an attached terminal in the last 3 minutes, and not without one', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        w.activity = AT;
        await w.runner.tick(AT + 10_000);
        await w.runner.poll(AT + SESSION_QUIET_MS - 1);
        expect(w.typed).toEqual([]);
        await w.runner.poll(AT + SESSION_QUIET_MS);
        expect(w.typed).toHaveLength(1);
        expect(SESSION_QUIET_MS).toBe(3 * MIN);

        const unsure = world([into('bbbbbb')]);
        alive(unsure);
        unsure.pane.ready = true;
        unsure.activity = undefined;
        await unsure.runner.tick(AT + 10_000);
        expect(unsure.typed).toEqual([]);
    });

    it('gives up as session_busy when the terminal stays busy for 30 minutes', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        w.activity = AT;
        await w.runner.tick(AT + 10_000);
        for (let t = AT + MIN; t <= AT + 10_000 + SESSION_WAIT_MS; t += MIN) {
            w.activity = t;
            await w.runner.poll(t);
        }
        await w.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(w.typed).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('session_busy');
    });

    it('types two prompts due together one at a time, in their order', async () => {
        const w = world([into('bbbbbb', { when: { kind: 'once', at: new Date(AT + 1).toISOString() } }), into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        await w.runner.tick(AT + 10_000);
        expect(w.typed.map((t) => t.prompt)).toEqual(['prompt aaaaaa']);
        await w.runner.poll(AT + 15_000);
        expect(w.typed.map((t) => t.prompt)).toEqual(['prompt aaaaaa', 'prompt bbbbbb']);
    });

    it('does not count against the running limit, has no runtime cap and never ends the session', async () => {
        const busy = Array.from({ length: MAX_RUNNING }, (_, i) => schedule(`r${i}aaaa`));
        const w = world([...busy, into('aaaaaa', { when: { kind: 'every', minutes: 15 }, maxRuntimeMin: 5 })]);
        alive(w);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        expect(w.launched).toHaveLength(MAX_RUNNING);
        await w.runner.tick(T0 + 15 * MIN + 20 * MIN);
        expect(w.state.schedules.aaaaaa!.delivering).toBeDefined();
        expect(w.ended.filter((s) => s === 'hwip-app')).toEqual([]);
        w.pane.ready = true;
        await w.runner.poll(T0 + 15 * MIN + 21 * MIN);
        expect(w.typed).toEqual([{ session: 'hwip-app', prompt: 'prompt aaaaaa' }]);
    });

    it('removes a once after its prompt went in', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        await w.runner.tick(AT + 10_000);
        await w.runner.tick(AT + 40_000);
        expect(w.removed).toEqual(['aaaaaa']);
    });

    it('fails as session_ended, not session_busy, when the run ends while the prompt waits', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        await w.runner.tick(AT + 10_000);
        w.runs.delete(RUN);
        await w.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(last(w, 'aaaaaa')).toBe('session_ended');
    });

    it('fails as prompt_undelivered when the prompt would not go in until the wait ran out', async () => {
        const w = world([into('aaaaaa')]);
        alive(w);
        w.pane.ready = true;
        w.pane.injectOk = false;
        await w.runner.tick(AT + 10_000);
        await w.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(last(w, 'aaaaaa')).toBe('prompt_undelivered');
        expect(w.logs.join('\n')).toContain('would not go in');
    });

    it('says why the wait ran out when tmux could not be asked', async () => {
        const w = world([into('aaaaaa')]);
        w.runs.set(RUN, 'unknown');
        await w.runner.tick(AT + 10_000);
        await w.runner.tick(AT + 10_000 + SESSION_WAIT_MS + 1);
        expect(last(w, 'aaaaaa')).toBe('session_busy');
        expect(w.logs.join('\n')).toContain('tmux could not say');
    });

    it('tells every time that an agent without an idle rule got no prompt', async () => {
        const w = world([into('aaaaaa', { when: { kind: 'every', minutes: 15 } })], { canPrompt: () => false });
        alive(w);
        await w.runner.tick(T0 + 15 * MIN + 10_000);
        await w.runner.tick(T0 + 30 * MIN + 10_000);
        expect(w.notes).toHaveLength(2);
    });

    it('is not typed for an agent without an idle rule', async () => {
        const w = world([into('aaaaaa')], { canPrompt: () => false });
        alive(w);
        w.pane.ready = true;
        await w.runner.tick(AT + 10_000);
        expect(w.typed).toEqual([]);
        expect(last(w, 'aaaaaa')).toBe('prompt_unsupported');
    });
});
