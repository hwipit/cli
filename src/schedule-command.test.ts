import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeWhen, onStderr, runSchedule, type ScheduleCommandDeps } from './schedule-command.js';
import { schedulesDir, scheduleStatePath, type Schedule } from './schedule.js';
import { withTmpStateDir } from './test-state-dir.js';

withTmpStateDir('hwip-schedule-cmd-');

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Rig {
    deps: ScheduleCommandDeps;
    out: string[];
    err: string[];
}

const rig = (over: Partial<ScheduleCommandDeps> = {}): Rig => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: ScheduleCommandDeps = {
        now: () => NOW,
        projectDir: () => '/work/app',
        checkoutRoot: (dir) => (dir.startsWith('/work/') ? '/work/hwip' : null),
        validBranch: async (_root, name) => !name.includes('..') && !name.includes(' '),
        listenerRunning: () => true,
        promptKinds: () => ['claude', 'pi'],
        refreshListener: async () => true,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        ...over,
    };
    return { deps, out, err };
};

const saved = (): Schedule[] =>
    // Files the command itself wrote, read back as the type they were written from.
    readdirSync(schedulesDir()).map((name) => JSON.parse(readFileSync(join(schedulesDir(), name), 'utf8')) as Schedule);

const only = (): Schedule => {
    const all = saved();
    expect(all).toHaveLength(1);
    return all[0]!;
};

describe('hwip schedule add', () => {
    it('writes a daily schedule for this project and says when it runs next', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--days', 'weekdays', '--prompt', 'run the tests'], r.deps)).toBe(0);
        const s = only();
        expect(s).toMatchObject({
            v: 1, source: 'cli', agentKind: 'claude', cwd: '/work/app', createdAt: new Date(NOW).toISOString(),
            when: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] }, prompt: 'run the tests', maxRuntimeMin: 120,
        });
        expect(s.label).toBe(`sched-${s.id}`);
        expect(s.session).toBe(`hwip-app-sched-${s.id}`);
        expect(s.wt).toBeUndefined();
        expect(s.agentArgs).toBeUndefined();
        expect(r.out.join('\n')).toContain(`scheduled ${s.id}`);
        expect(r.err).toEqual([]);
    });

    // Typing into an agent hwip cannot tell is idle could answer a trust or permission dialog with Enter.
    it('refuses --prompt for an agent without an idle rule, names the ones that work, and writes nothing', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'codex', '--at', '09:00', '--prompt', 'run the tests'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain('codex cannot take a scheduled --prompt');
        expect(r.err.join('\n')).toContain('--prompt works with: cc, pi');
        expect(() => readdirSync(schedulesDir())).toThrow();
    });

    it('still schedules such an agent when there is no --prompt', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'codex', '--at', '09:00'], r.deps)).toBe(0);
        expect(only().agentKind).toBe('codex');
        expect(only().prompt).toBeUndefined();
    });

    it('takes a prompt that starts with a dash, spaced or joined', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--every', '30m', '--prompt', '--fix the build'], r.deps)).toBe(0);
        expect(only().prompt).toBe('--fix the build');
    });

    it('takes --prompt=… joined', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--every', '30m', '--prompt=-x=y'], r.deps)).toBe(0);
        expect(only().prompt).toBe('-x=y');
    });

    it('passes everything after -- to the agent as separate raw arguments', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--', '--model', 'opus', '; rm -rf ~', '--at', '10:00'], r.deps)).toBe(0);
        expect(only().agentArgs).toEqual(['--model', 'opus', '; rm -rf ~', '--at', '10:00']);
        expect(only().when).toMatchObject({ at: '09:00' });
    });

    it('defaults the runtime to the period when that is shorter than two hours', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--every', '15m'], r.deps)).toBe(0);
        expect(only()).toMatchObject({ when: { kind: 'every', minutes: 15 }, maxRuntimeMin: 15 });
    });

    it('reads --max-runtime in minutes and hours', async () => {
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--max-runtime', '3h'], rig().deps)).toBe(0);
        expect(only().maxRuntimeMin).toBe(180);
    });

    it('makes the label tmux-safe and names the session with it', async () => {
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--label', 'night.run'], rig().deps)).toBe(0);
        expect(only()).toMatchObject({ label: 'night-run', session: 'hwip-app-night-run' });
    });

    it('names a worktree session as the wrapper will, with the schedule label pinned', async () => {
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--wt', 'feat/x'], rig().deps)).toBe(0);
        const s = only();
        expect(s.wt).toBe('feat/x');
        expect(s.session).toBe(`hwip-hwip-wt-feat-x-sched-${s.id}`);
    });

    it.each([
        ['no agent', ['add', '--at', '09:00']],
        ['an unknown agent', ['add', 'vim', '--at', '09:00']],
        ['an extra word', ['add', 'cc', 'extra', '--at', '09:00']],
        ['no time', ['add', 'cc']],
        ['both a time and a period', ['add', 'cc', '--at', '09:00', '--every', '30m']],
        ['a period under 15 minutes', ['add', 'cc', '--every', '14m']],
        ['a bad time', ['add', 'cc', '--at', '25:00']],
        ['a bad day', ['add', 'cc', '--at', '09:00', '--days', 'funday']],
        ['a flag without its value', ['add', 'cc', '--at']],
        ['an empty prompt', ['add', 'cc', '--at', '09:00', '--prompt', ' ']],
        ['a label that tmux cannot hold', ['add', 'cc', '--at', '09:00', '--label', 'a/b']],
        ['a worktree with a label', ['add', 'cc', '--at', '09:00', '--wt', 'feat/x', '--label', 'y']],
        ['a branch git refuses', ['add', 'cc', '--at', '09:00', '--wt', 'a..b']],
        ['a branch of nothing but separators', ['add', 'cc', '--at', '09:00', '--wt', ';']],
        ['a bad runtime', ['add', 'cc', '--at', '09:00', '--max-runtime', 'soon']],
        ['a runtime longer than the period', ['add', 'cc', '--every', '15m', '--max-runtime', '20m']],
        ['a runtime over a day', ['add', 'cc', '--at', '09:00', '--max-runtime', '25h']],
        ['a prompt over 4000 characters', ['add', 'cc', '--at', '09:00', '--prompt', 'x'.repeat(4001)]],
    ])('refuses %s with exit 2 and writes nothing', async (_name, words) => {
        const r = rig();
        expect(await runSchedule(words, r.deps)).toBe(2);
        expect(r.err.join('\n')).toMatch(/^hwip schedule: /);
        expect(() => readdirSync(schedulesDir())).toThrow();
    });

    it('refuses a worktree outside git', async () => {
        const r = rig({ projectDir: () => '/elsewhere/app' });
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--wt', 'feat/x'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain('--wt needs a git checkout');
    });

    it('refuses the 21st schedule with exit 2', async () => {
        for (let i = 0; i < 20; i++) expect(await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps)).toBe(0);
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--at', '09:00'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain('already 20 schedules');
        expect(saved()).toHaveLength(20);
    });

    it('says the listener must be running when it is not, and still succeeds', async () => {
        const r = rig({ listenerRunning: () => false });
        expect(await runSchedule(['add', 'cc', '--at', '09:00'], r.deps)).toBe(0);
        expect(r.err.join('\n')).toContain('only while the listener runs');
    });

    it('takes --json before the agent too', async () => {
        const r = rig();
        expect(await runSchedule(['add', '--json', 'cc', '--at', '09:00'], r.deps)).toBe(0);
        expect(JSON.parse(r.out[0]!)).toMatchObject({ agentKind: 'claude' });
    });

    it('keeps a value that only starts like --json', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--prompt', '--json-schema check'], r.deps)).toBe(0);
        expect(r.out.join('\n')).not.toContain('{');
        expect(saved()[0]!.prompt).toBe('--json-schema check');
    });

    it('prints the schedule as JSON with --json', async () => {
        const r = rig();
        expect(await runSchedule(['add', 'cc', '--at', '09:00', '--json'], r.deps)).toBe(0);
        expect(JSON.parse(r.out[0]!)).toMatchObject({ agentKind: 'claude', when: { kind: 'daily' } });
    });
});

describe('hwip schedule list', () => {
    it('says so when there are none, and does not nag about the listener', async () => {
        const r = rig({ listenerRunning: () => false });
        expect(await runSchedule([], r.deps)).toBe(0);
        expect(r.out.join('\n')).toContain('no schedules');
        expect(r.err).toEqual([]);
    });

    it('lists id, agent, project, cycle, next run and the last result from the state file', async () => {
        await runSchedule(['add', 'cc', '--every', '30m'], rig().deps);
        const { id } = only();
        mkdirSync(join(scheduleStatePath(), '..'), { recursive: true });
        writeFileSync(scheduleStatePath(), JSON.stringify({ v: 1, schedules: { [id]: { cursor: NOW, last: { outcome: 'overlap', at: NOW } } } }));
        const r = rig();
        expect(await runSchedule(['list'], r.deps)).toBe(0);
        const line = r.out[0]!;
        expect(line).toContain(id);
        expect(line).toContain('claude');
        expect(line).toContain('app');
        expect(line).toContain('every 30m');
        expect(line).toContain('last overlap');
        expect(line).toMatch(/next \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    });

    it('prints one JSON array with --json, nextAt as a date and null for a schedule never run', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00', '--label', 'nightly'], rig().deps);
        const r = rig();
        expect(await runSchedule(['list', '--json'], r.deps)).toBe(0);
        const rows = JSON.parse(r.out[0]!);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ agent: 'claude', label: 'nightly', last: null, running: false });
        expect(Date.parse(rows[0].nextAt)).toBeGreaterThan(NOW);
    });

    it('says the listener must be running when it is not', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const r = rig({ listenerRunning: () => false });
        await runSchedule(['list'], r.deps);
        expect(r.err.join('\n')).toContain('only while the listener runs');
    });

    it('takes --json before the subcommand', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const r = rig();
        expect(await runSchedule(['--json', 'list'], r.deps)).toBe(0);
        expect(JSON.parse(r.out[0]!)).toHaveLength(1);
        const bare = rig();
        expect(await runSchedule(['--json'], bare.deps)).toBe(0);
        expect(JSON.parse(bare.out[0]!)).toHaveLength(1);
    });

    it('refuses a word it has no use for', async () => {
        const r = rig();
        expect(await runSchedule(['list', 'foo'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain("unexpected word 'foo'");
    });

    it('shows a running session, and a last result in the JSON', async () => {
        await runSchedule(['add', 'cc', '--every', '30m'], rig().deps);
        const { id } = only();
        mkdirSync(join(scheduleStatePath(), '..'), { recursive: true });
        writeFileSync(scheduleStatePath(), JSON.stringify({ v: 1, schedules: { [id]: {
            cursor: NOW, running: { session: 'hwip-app-x', startedAt: NOW, promptPending: false }, last: { outcome: 'started', at: NOW },
        } } }));
        const text = rig();
        await runSchedule(['list'], text.deps);
        expect(text.out[0]).toContain('last started');
        expect(text.out[0]).toContain('(running)');
        const json = rig();
        await runSchedule(['list', '--json'], json.deps);
        expect(JSON.parse(json.out[0]!)[0]).toMatchObject({ running: true, last: { outcome: 'started', at: new Date(NOW).toISOString() } });
    });

    it('survives a state file with a time no Date holds', async () => {
        await runSchedule(['add', 'cc', '--every', '30m'], rig().deps);
        const { id } = only();
        mkdirSync(join(scheduleStatePath(), '..'), { recursive: true });
        writeFileSync(scheduleStatePath(), JSON.stringify({ v: 1, schedules: { [id]: { cursor: 1e300, last: { outcome: 'started', at: 1e300 } } } }));
        const r = rig();
        expect(await runSchedule(['list'], r.deps)).toBe(0);
        expect(r.out[0]).toContain(id);
        expect(r.out[0]).not.toContain('last started');
    });

    it('counts a file it could not read', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        writeFileSync(join(schedulesDir(), 'broken.json'), '{nope');
        const r = rig();
        expect(await runSchedule([], r.deps)).toBe(0);
        expect(r.err.join('\n')).toContain('1 file');
    });
});

describe('hwip schedule rm', () => {
    it('removes a schedule and says a running session is left alone', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const { id } = only();
        const r = rig();
        expect(await runSchedule(['rm', id], r.deps)).toBe(0);
        expect(r.out.join('\n')).toContain('keeps running');
        expect(saved()).toEqual([]);
    });

    it('exits 1 for a schedule that is not there', async () => {
        const r = rig();
        expect(await runSchedule(['rm', 'abc123'], r.deps)).toBe(1);
        expect(r.err.join('\n')).toContain('no schedule abc123');
    });

    it('exits 2 for more than one id', async () => {
        expect(await runSchedule(['rm', 'abc123', 'def456'], rig().deps)).toBe(2);
    });

    it('takes --json anywhere without taking the id', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const { id } = only();
        expect(await runSchedule(['--json', 'rm', id], rig().deps)).toBe(0);
    });

    it('exits 2 for an id that is not one, and for none', async () => {
        const r = rig();
        expect(await runSchedule(['rm', '../x'], r.deps)).toBe(2);
        expect(await runSchedule(['rm'], r.deps)).toBe(2);
    });
});

describe('hwip schedule edit [F8-edit]', () => {
    const LATER = NOW + 60 * 60_000;

    it('changes the time, prompt and run time of a schedule and keeps the rest', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00', '--days', 'weekdays', '--prompt', 'old'], rig().deps);
        const before = only();
        const r = rig({ now: () => LATER });
        expect(await runSchedule(['edit', before.id, '--every', '30m', '--prompt', 'new', '--max-runtime', '20m'], r.deps)).toBe(0);
        const after = only();
        expect(after).toMatchObject({
            id: before.id, session: before.session, label: before.label, cwd: before.cwd, createdAt: before.createdAt,
            updatedAt: new Date(LATER).toISOString(), when: { kind: 'every', minutes: 30 }, prompt: 'new', maxRuntimeMin: 20,
        });
        expect(r.out.join('\n')).toContain(`updated ${before.id}`);
        expect(r.out.join('\n')).toContain('every 30m');
        const listed = rig({ now: () => LATER });
        await runSchedule(['list', '--json'], listed.deps);
        expect(JSON.parse(listed.out[0]!)[0].nextAt).toBe(new Date(LATER + 30 * 60_000).toISOString());
    });

    it('says what the listener refresh does on stderr, so --json output stays one JSON line', async () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await onStderr(async () => { console.log('hwip: listener 0.1.3 is stale — restarting on 0.1.4'); });
            expect(out).not.toHaveBeenCalled();
            expect(err).toHaveBeenCalledWith('hwip: listener 0.1.3 is stale — restarting on 0.1.4');
            expect(console.log).toBe(out);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('keeps the days when only --at changes, and the time when only --days changes', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00', '--days', 'weekdays'], rig().deps);
        const { id } = only();
        expect(await runSchedule(['edit', id, '--at', '10:30'], rig().deps)).toBe(0);
        expect(only().when).toEqual({ kind: 'daily', at: '10:30', days: [1, 2, 3, 4, 5] });
        expect(await runSchedule(['edit', id, '--days', 'mon,wed'], rig().deps)).toBe(0);
        expect(only().when).toEqual({ kind: 'daily', at: '10:30', days: [1, 3] });
    });

    it('refuses --days alone on an --every schedule, and --at with --every', async () => {
        await runSchedule(['add', 'cc', '--every', '1h'], rig().deps);
        const { id } = only();
        const r = rig();
        expect(await runSchedule(['edit', id, '--days', 'mon'], r.deps)).toBe(2);
        expect(await runSchedule(['edit', id, '--at', '09:00', '--every', '1h'], r.deps)).toBe(2);
        expect(only().when).toEqual({ kind: 'every', minutes: 60 });
    });

    it('refuses nothing to change, flags that cannot be edited, an empty prompt and a prompt the agent cannot take', async () => {
        await runSchedule(['add', 'codex', '--at', '09:00'], rig().deps);
        const { id } = only();
        const r = rig();
        expect(await runSchedule(['edit', id], r.deps)).toBe(2);
        expect(await runSchedule(['edit', id, '--label', 'x'], r.deps)).toBe(2);
        expect(await runSchedule(['edit', id, '--wt', 'feat/x'], r.deps)).toBe(2);
        expect(await runSchedule(['edit', id, '--prompt', ' '], r.deps)).toBe(2);
        expect(await runSchedule(['edit', id, '--prompt', 'go'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain('cannot take a scheduled --prompt');
        expect(only().updatedAt).toBeUndefined();
    });

    it('refuses a change that does not validate and leaves the schedule as it was', async () => {
        await runSchedule(['add', 'cc', '--every', '1h', '--max-runtime', '60m'], rig().deps);
        const { id } = only();
        const r = rig();
        expect(await runSchedule(['edit', id, '--every', '30m'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain('maxRuntimeMin');
        expect(only().when).toEqual({ kind: 'every', minutes: 60 });
    });

    it('exits 1 for a schedule that is not there and 2 for an id that is not one or none', async () => {
        expect(await runSchedule(['edit', 'abc123', '--at', '09:00'], rig().deps)).toBe(1);
        expect(await runSchedule(['edit', '../x', '--at', '09:00'], rig().deps)).toBe(2);
        expect(await runSchedule(['edit'], rig().deps)).toBe(2);
    });

    it('has a drifted listener replaced before the edited file is written, since an old one would skip it', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const { id } = only();
        const order: string[] = [];
        const r = rig({ refreshListener: async () => { order.push(only().updatedAt ?? 'unedited'); return true; } });
        expect(await runSchedule(['edit', id, '--at', '10:00'], r.deps)).toBe(0);
        expect(order).toEqual(['unedited']);
    });

    it('leaves a new time unwritten while an older listener still runs, since it would stop running the schedule', async () => {
        await runSchedule(['add', 'cc', '--at', '09:00'], rig().deps);
        const { id } = only();
        const stuck = rig({ refreshListener: async () => false });
        expect(await runSchedule(['edit', id, '--at', '10:00'], stuck.deps)).toBe(1);
        expect(only().when).toEqual({ kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] });
        expect(stuck.err.join('\n')).toContain('older hwip');
        // A change that keeps the time adds nothing an older listener cannot read.
        expect(await runSchedule(['edit', id, '--max-runtime', '30m'], rig({ refreshListener: async () => false }).deps)).toBe(0);
        expect(only().maxRuntimeMin).toBe(30);
    });
});

describe('hwip schedule', () => {
    it('exits 2 for a subcommand it does not know', async () => {
        const r = rig();
        expect(await runSchedule(['frobnicate'], r.deps)).toBe(2);
        expect(r.err.join('\n')).toContain("unknown subcommand 'frobnicate'");
    });
});

describe('describeWhen', () => {
    it.each([
        [{ kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, 'daily 09:00'],
        [{ kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] }, 'weekdays 09:00'],
        [{ kind: 'daily', at: '18:30', days: [1, 3] }, 'mon,wed 18:30'],
        [{ kind: 'every', minutes: 90 }, 'every 90m'],
        [{ kind: 'every', minutes: 120 }, 'every 2h'],
    ] as const)('%j reads %s', (when, text) => {
        // The table's literal types are wider than `ScheduleWhen`'s; the values are valid.
        expect(describeWhen(when as never)).toBe(text);
    });
});
