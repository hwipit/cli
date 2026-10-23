// Before the first Date: the DST cases below read local time.
process.env.TZ = 'America/New_York';

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    addSchedule,
    listSchedules,
    MAX_SCHEDULES,
    nextOccurrence,
    occurrencesBetween,
    parseWhen,
    readScheduleState,
    removeSchedule,
    scheduleAnchor,
    scheduleStatePath,
    schedulesDir,
    updateSchedule,
    validateSchedule,
    type Schedule,
    type ScheduleWhen,
} from './schedule.js';
import { withTmpStateDir } from './test-state-dir.js';

withTmpStateDir('hwip-schedule-');

const MIN = 60_000;
const HOUR = 60 * MIN;

const make = (id: string, over: Partial<Schedule> = {}): Schedule => ({
    v: 1,
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'cli',
    agentKind: 'claude',
    cwd: '/work/app',
    label: `sched-${id}`,
    session: `hwip-app-sched-${id}`,
    when: { kind: 'every', minutes: 30 },
    maxRuntimeMin: 30,
    ...over,
});

const ok = <T>(r: { ok: boolean; value?: T; error?: string }): T => {
    if (!r.ok) throw new Error(r.error);
    return r.value as T;
};

describe('parseWhen', () => {
    it('takes 366 days as the longest period', () => {
        expect(parseWhen({ every: '527040m' }).ok).toBe(true);
    });

    it('reads a daily time with every day by default', () => {
        expect(ok(parseWhen({ at: '09:00' }))).toEqual({ kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] });
    });

    it.each([
        ['weekdays', [1, 2, 3, 4, 5]],
        ['daily', [0, 1, 2, 3, 4, 5, 6]],
        ['Wed,mon', [1, 3]],
        ['sun', [0]],
    ])('reads --days %s', (days, expected) => {
        expect(ok(parseWhen({ at: '09:00', days }))).toMatchObject({ days: expected });
    });

    it.each([['30m', 30], ['2h', 120], ['15m', 15]])('reads --every %s', (every, minutes) => {
        expect(ok(parseWhen({ every }))).toEqual({ kind: 'every', minutes });
    });

    it.each([
        [{ at: '9:00' }],
        [{ at: '24:00' }],
        [{ at: '09:60' }],
        [{ at: '09:00', days: 'mon,xyz' }],
        [{ at: '09:00', days: '' }],
        [{ every: '14m' }],
        [{ every: '0m' }],
        [{ every: '30' }],
        [{ every: '1d' }],
        [{ every: '527041m' }],
        [{ every: '99999999m' }],
        [{ every: '30m', at: '09:00' }],
        [{ every: '30m', days: 'mon' }],
        [{ days: 'mon' }],
        [{}],
    ])('refuses %j', (input) => {
        expect(parseWhen(input).ok).toBe(false);
    });
});

describe('occurrencesBetween', () => {
    const anchor = Date.UTC(2026, 9, 1, 0, 0, 0);
    const every15: ScheduleWhen = { kind: 'every', minutes: 15 };

    it('walks at most about a year of days for a daily schedule, however far back the cursor lies', () => {
        const daily: ScheduleWhen = { kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] };
        const until = anchor;
        const r = occurrencesBetween(daily, -8.64e15, until, 0);
        expect(r.latest).not.toBeNull();
        expect(r.count).toBeGreaterThan(300);
        expect(r.count).toBeLessThanOrEqual(401);
    });

    it('counts an 8h sleep with every 15m as 32 runs, the last one at the end', () => {
        const after = anchor + 15 * MIN;
        const r = occurrencesBetween(every15, after, after + 8 * HOUR, anchor);
        expect(r.count).toBe(32);
        expect(r.latest).toBe(after + 8 * HOUR);
    });

    it('is half-open: the cursor itself is not due again, `until` is', () => {
        expect(occurrencesBetween(every15, anchor + 15 * MIN, anchor + 15 * MIN, anchor)).toEqual({ count: 0, latest: null });
        expect(occurrencesBetween(every15, anchor + 15 * MIN - 1, anchor + 15 * MIN, anchor)).toEqual({ count: 1, latest: anchor + 15 * MIN });
    });

    it('does not count the anchor as a run', () => {
        expect(occurrencesBetween(every15, anchor, anchor + 14 * MIN, anchor).count).toBe(0);
    });

    it.each([[NaN, 1], [0, NaN], [-Infinity, 1], [0, Infinity]])('answers none, and returns, for a cursor of %s..%s', (after, until) => {
        const daily: ScheduleWhen = { kind: 'daily', at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] };
        expect(occurrencesBetween(daily, after, until, 0)).toEqual({ count: 0, latest: null });
        expect(occurrencesBetween(every15, after, until, 0)).toEqual({ count: 0, latest: null });
    });

    it('does not loop for a very long gap', () => {
        const r = occurrencesBetween(every15, anchor, anchor + 366 * 24 * HOUR, anchor);
        expect(r.count).toBe(366 * 24 * 4);
    });

    it('walks local days for daily and honours the day list', () => {
        const mondays: ScheduleWhen = { kind: 'daily', at: '09:00', days: [1] };
        // 2026-10-05 is a Monday; New York is UTC-4 in October.
        const after = Date.UTC(2026, 9, 4, 12);
        const until = Date.UTC(2026, 9, 19, 12);
        const r = occurrencesBetween(mondays, after, until, 0);
        expect(r.count).toBe(2);
        expect(r.latest).toBe(Date.UTC(2026, 9, 12, 13));
    });

    it('runs daily 02:30 once on the spring-forward day, at the moved time', () => {
        const when: ScheduleWhen = { kind: 'daily', at: '02:30', days: [0, 1, 2, 3, 4, 5, 6] };
        // 2026-03-08: 02:00 -> 03:00, so 02:30 does not exist.
        const r = occurrencesBetween(when, Date.UTC(2026, 2, 7, 17), Date.UTC(2026, 2, 8, 17), 0);
        expect(r.count).toBe(1);
        expect(r.latest).toBe(Date.UTC(2026, 2, 8, 7, 30));
    });

    it('runs daily 02:30 once on the fall-back day', () => {
        const when: ScheduleWhen = { kind: 'daily', at: '02:30', days: [0, 1, 2, 3, 4, 5, 6] };
        // 2026-11-01: 02:00 -> 01:00, so 01:00-02:00 happens twice and 02:30 once.
        const r = occurrencesBetween(when, Date.UTC(2026, 9, 31, 17), Date.UTC(2026, 10, 1, 17), 0);
        expect(r.count).toBe(1);
        expect(r.latest).toBe(Date.UTC(2026, 10, 1, 7, 30));
    });

    it('runs daily 02:30 once a day across the fall-back weekend', () => {
        const when: ScheduleWhen = { kind: 'daily', at: '02:30', days: [0, 1, 2, 3, 4, 5, 6] };
        expect(occurrencesBetween(when, Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 10, 3, 12), 0).count).toBe(3);
    });

    it('runs a time inside the repeated hour once, the first time round', () => {
        const when: ScheduleWhen = { kind: 'daily', at: '01:30', days: [0, 1, 2, 3, 4, 5, 6] };
        const r = occurrencesBetween(when, Date.UTC(2026, 9, 31, 17), Date.UTC(2026, 10, 1, 17), 0);
        expect(r.count).toBe(1);
        expect(r.latest).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT, not the 01:30 EST an hour later
    });
});

describe('nextOccurrence', () => {
    it('gives the next multiple of the period after now', () => {
        const anchor = Date.UTC(2026, 9, 1);
        expect(nextOccurrence({ kind: 'every', minutes: 30 }, anchor + 10 * MIN, anchor)).toBe(anchor + 30 * MIN);
        expect(nextOccurrence({ kind: 'every', minutes: 30 }, anchor + 30 * MIN, anchor)).toBe(anchor + 60 * MIN);
    });

    it('skips to the next listed day for daily', () => {
        const when: ScheduleWhen = { kind: 'daily', at: '09:00', days: [1] };
        expect(nextOccurrence(when, Date.UTC(2026, 9, 5, 14), 0)).toBe(Date.UTC(2026, 9, 12, 13));
    });
});

describe('validateSchedule', () => {
    it('accepts a well-formed schedule', () => {
        expect(validateSchedule(make('abc123')).ok).toBe(true);
    });

    // The cases below are malformed on purpose, so they are cast past the types.
    it.each([
        ['an agentKind with a slash', { agentKind: 'a/b' }],
        ['a cwd with a control character', { cwd: '/work/\napp' }],
        ['a cwd over 4096 characters', { cwd: `/${'a'.repeat(4096)}` }],
        ['a session over 256 characters', { session: `hwip-${'a'.repeat(252)}` }],
        ['a session that tmux would read as a target', { session: 'hwip-app:0' }],
        ['an empty wt', { wt: '' }],
        ['a NUL in an agent arg', { agentArgs: ['a\0b'] }],
        ['a NUL in the prompt', { prompt: 'a\0b' }],
        ['a fractional runtime', { maxRuntimeMin: 30.5 }],
        ['an id that names a path', { id: '../x' }],
        ['an id with capitals', { id: 'ABC123' }],
        ['a short id', { id: 'abc12' }],
        ['version 2', { v: 2 as never }],
        ['a bad date', { createdAt: 'yesterday' }],
        ['an unknown source', { source: 'web' as never }],
        ['a relative cwd', { cwd: 'work/app' }],
        ['a label with a slash', { label: 'a/b' }],
        ['a session without the hwip- prefix', { session: 'app-x' }],
        ['a wt that looks like a flag', { wt: '--force' }],
        ['a non-string agent arg', { agentArgs: [1 as never] }],
        ['agent args that start with --detach', { agentArgs: ['--detach'] }],
        ['agent args that start with --label=x', { agentArgs: ['--label=x'] }],
        ['agent args that start with --wt', { agentArgs: ['--wt', 'x'] }],
        ['too many agent args', { agentArgs: Array.from({ length: 65 }, () => 'x') }],
        ['an empty prompt', { prompt: '' }],
        ['a prompt over 4000 chars', { prompt: 'x'.repeat(4001) }],
        ['every under 15 minutes', { when: { kind: 'every', minutes: 14 } as ScheduleWhen }],
        ['a fractional period', { when: { kind: 'every', minutes: 20.5 } as ScheduleWhen }],
        ['a bad time', { when: { kind: 'daily', at: '9:00', days: [1] } as ScheduleWhen }],
        ['no days', { when: { kind: 'daily', at: '09:00', days: [] } as ScheduleWhen }],
        ['a day out of range', { when: { kind: 'daily', at: '09:00', days: [7] } as ScheduleWhen }],
        ['a repeated day', { when: { kind: 'daily', at: '09:00', days: [1, 1] } as ScheduleWhen }],
        ['an unknown when kind', { when: { kind: 'cron' } as never }],
        ['a runtime under 5 minutes', { maxRuntimeMin: 4 }],
        ['a runtime over 1440 minutes', { maxRuntimeMin: 1441 }],
        ['a runtime longer than the period', { when: { kind: 'every', minutes: 30 }, maxRuntimeMin: 31 }],
        ['a phone schedule with agentArgs', { source: 'phone' as const, prompt: 'hi', agentArgs: ['x'] }],
        ['a phone schedule with wt', { source: 'phone' as const, prompt: 'hi', wt: 'x' }],
        ['a phone schedule without a prompt', { source: 'phone' as const }],
    ])('refuses %s', (_name, over) => {
        expect(validateSchedule(make('abc123', over as Partial<Schedule>)).ok).toBe(false);
    });

    it.each([[5, 30], [1440, 1440]])('accepts a runtime of %i minutes with an every period of %i', (maxRuntimeMin, minutes) => {
        expect(validateSchedule(make('abc123', { maxRuntimeMin, when: { kind: 'every', minutes } })).ok).toBe(true);
    });

    it('refuses a field it does not know and non-objects', () => {
        expect(validateSchedule({ ...make('abc123'), extra: 1 }).ok).toBe(false);
        expect(validateSchedule(null).ok).toBe(false);
        expect(validateSchedule([]).ok).toBe(false);
        expect(validateSchedule('x').ok).toBe(false);
    });

    it('does not check the agent kind against the table: that is the runner’s call at run time', () => {
        expect(validateSchedule(make('abc123', { agentKind: 'nonesuch' })).ok).toBe(true);
    });

    it('keeps shell text in agentArgs as plain data', () => {
        expect(validateSchedule(make('abc123', { agentArgs: ['; rm -rf ~'] })).ok).toBe(true);
    });
});

describe('files', () => {
    it('writes one 0600 file per schedule in a 0700 directory', () => {
        const added = addSchedule((id) => make(id), () => 'abc123');
        expect(added.ok).toBe(true);
        const file = join(schedulesDir(), 'abc123.json');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(schedulesDir()).mode & 0o777).toBe(0o700);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ id: 'abc123', agentKind: 'claude' });
    });

    it('lists what was added, oldest first', () => {
        addSchedule((id) => make(id, { createdAt: '2026-10-02T00:00:00.000Z' }), () => 'bbbbbb');
        addSchedule((id) => make(id, { createdAt: '2026-10-01T00:00:00.000Z' }), () => 'aaaaaa');
        expect(listSchedules().schedules.map((s) => s.id)).toEqual(['aaaaaa', 'bbbbbb']);
    });

    it('lists nothing when the directory does not exist', () => {
        expect(listSchedules()).toEqual({ schedules: [], unreadable: 0 });
    });

    it('says the list is incomplete when the directory cannot be listed', () => {
        mkdirSync(join(schedulesDir(), '..'), { recursive: true });
        writeFileSync(schedulesDir(), 'a file where the directory should be');
        expect(listSchedules()).toEqual({ schedules: [], unreadable: 0, incomplete: true });
    });

    it('draws another id instead of overwriting one that is taken', () => {
        addSchedule((id) => make(id, { prompt: 'first' }), () => 'abc123');
        const ids = ['abc123', 'def456'];
        const second = addSchedule((id) => make(id, { prompt: 'second' }), () => ids.shift() as string);
        expect(second.ok && second.schedule.id).toBe('def456');
        expect(JSON.parse(readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8')).prompt).toBe('first');
    });

    it('refuses the 21st schedule', () => {
        for (let i = 0; i < MAX_SCHEDULES; i++) {
            const id = `a${String(i).padStart(5, '0')}`;
            expect(addSchedule((x) => make(x), () => id).ok).toBe(true);
        }
        const over = addSchedule((x) => make(x), () => 'zzzzzz');
        expect(over.ok).toBe(false);
        expect(existsSync(join(schedulesDir(), 'zzzzzz.json'))).toBe(false);
    });

    it('refuses to write a schedule that does not validate, leaving no file', () => {
        const r = addSchedule((id) => make(id, { maxRuntimeMin: 1 }), () => 'abc123');
        expect(r.ok).toBe(false);
        expect(existsSync(schedulesDir()) ? readdirSync(schedulesDir()) : []).toEqual([]);
    });

    it('skips broken and hand-edited files and counts them', () => {
        addSchedule((id) => make(id), () => 'abc123');
        const dir = schedulesDir();
        writeFileSync(join(dir, 'broken.json'), '{nope');
        writeFileSync(join(dir, 'bad001.json'), JSON.stringify({ ...make('bad001'), when: { kind: 'every', minutes: 1 } }));
        writeFileSync(join(dir, 'other2.json'), JSON.stringify(make('mism01')));
        writeFileSync(join(dir, 'notes.txt'), 'ignored');
        const list = listSchedules();
        expect(list.schedules.map((s) => s.id)).toEqual(['abc123']);
        expect(list.unreadable).toBe(3);
    });

    // The directory is private, but a file can arrive by hand: a link points anywhere, a group-writable file is not only the user's.
    it('skips a symlink and a file others can write, and counts them', () => {
        addSchedule((id) => make(id), () => 'abc123');
        const dir = schedulesDir();
        writeFileSync(join(dir, 'real01.json'), JSON.stringify(make('real01')), { mode: 0o600 });
        symlinkSync(join(dir, 'real01.json'), join(dir, 'link01.json'));
        writeFileSync(join(dir, 'open01.json'), JSON.stringify(make('open01')), { mode: 0o600 });
        chmodSync(join(dir, 'open01.json'), 0o664);
        const list = listSchedules();
        expect(list.schedules.map((s) => s.id)).toEqual(['abc123', 'real01']);
        expect(list.unreadable).toBe(2);
    });

    it('loads at most MAX_SCHEDULES, the oldest first, and says the list is not whole', () => {
        mkdirSync(schedulesDir(), { recursive: true, mode: 0o700 });
        for (let i = 0; i < MAX_SCHEDULES + 2; i++) {
            const id = `s${String(i).padStart(5, '0')}`;
            writeFileSync(join(schedulesDir(), `${id}.json`), JSON.stringify(make(id, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() })), { mode: 0o600 });
        }
        const list = listSchedules();
        expect(list.schedules).toHaveLength(MAX_SCHEDULES);
        expect(list.schedules[0]!.id).toBe('s00000');
        expect(list.schedules.at(-1)!.id).toBe(`s${String(MAX_SCHEDULES - 1).padStart(5, '0')}`);
        expect(list.unreadable).toBe(2);
        expect(list.incomplete).toBe(true);
    });

    it('counts unreadable files toward the limit', () => {
        addSchedule((id) => make(id), () => 'abc123');
        for (let i = 0; i < MAX_SCHEDULES - 1; i++) writeFileSync(join(schedulesDir(), `bad${String(i).padStart(3, '0')}.json`), 'x');
        expect(addSchedule((id) => make(id), () => 'zzzzzz').ok).toBe(false);
    });

    it('removes a schedule and says so when it is not there', () => {
        addSchedule((id) => make(id), () => 'abc123');
        expect(removeSchedule('abc123')).toBe('removed');
        expect(removeSchedule('abc123')).toBe('missing');
        expect(listSchedules().schedules).toEqual([]);
    });

    it('rejects an id that is not a schedule id before touching the filesystem', () => {
        addSchedule((id) => make(id), () => 'abc123');
        const outside = join(schedulesDir(), '..', 'x.json');
        writeFileSync(outside, '{}');
        expect(removeSchedule('../x')).toBe('invalid');
        expect(removeSchedule('abc12')).toBe('invalid');
        expect(removeSchedule('')).toBe('invalid');
        expect(existsSync(outside)).toBe(true);
    });
});

describe('readScheduleState', () => {
    const write = (content: unknown): void => {
        mkdirSync(join(scheduleStatePath(), '..'), { recursive: true });
        writeFileSync(scheduleStatePath(), typeof content === 'string' ? content : JSON.stringify(content));
    };

    it('reads as nothing done when there is no file', () => {
        expect(readScheduleState()).toEqual({ v: 1, schedules: {} });
    });

    it('reads as nothing done, marked damaged, when the file is damaged, too big or not an object', () => {
        write('{nope');
        expect(readScheduleState()).toEqual({ v: 1, schedules: {}, damaged: true });
        write(`{"v":1,"schedules":{"abc123":{"cursor":1,"pad":"${'x'.repeat(300 * 1024)}"}}}`);
        expect(readScheduleState()).toEqual({ v: 1, schedules: {}, damaged: true });
        write([1, 2]);
        expect(readScheduleState()).toEqual({ v: 1, schedules: {}, damaged: true });
    });

    it('keeps what is well formed and drops the rest, entry by entry', () => {
        write({ v: 1, schedules: {
            abc123: {
                cursor: 5,
                running: { session: 'hwip-a', startedAt: 4, promptPending: true },
                last: { outcome: 'capped', at: 6 },
                pending: { since: 3, counts: { overlap: 2, busy: 1 } },
            },
            def456: { cursor: 'soon' },
            '../x': { cursor: 1 },
            ghi789: { cursor: 1, last: { outcome: 'exploded', at: 1 }, running: { session: 'hwip-a' }, pending: { since: 1, counts: { overlap: 0, bogus: 3, busy: 1.5 } } },
            jkl012: { cursor: 1e300 },
        } });
        expect(readScheduleState().schedules).toEqual({
            abc123: {
                cursor: 5,
                running: { session: 'hwip-a', startedAt: 4, promptPending: true },
                last: { outcome: 'capped', at: 6 },
                pending: { since: 3, counts: { overlap: 2, busy: 1 } },
            },
            ghi789: { cursor: 1 },
        });
        expect(readScheduleState().damaged).toBe(true);
    });

    // The session is what a prompt is typed into and what is asked to end: only a name the schedule files may hold.
    it('drops a running session whose name is not a hwip- tmux session name, and keeps the rest of the entry', () => {
        const bad = ['other', 'hwip-a:1', 'hwip-a.1', 'hwip-a;b', 'hwip-a\nb', `hwip-${'x'.repeat(260)}`, 7];
        const schedules: Record<string, unknown> = {};
        bad.forEach((session, i) => { schedules[`s${i}0000`.slice(0, 6)] = { cursor: 1, running: { session, startedAt: 1, promptPending: false } }; });
        write({ v: 1, schedules });
        const read = readScheduleState().schedules;
        expect(Object.keys(read)).toHaveLength(bad.length);
        for (const entry of Object.values(read)) expect(entry.running).toBeUndefined();
    });

    it('reads the capped mark of a running session', () => {
        write({ v: 1, schedules: { abc123: { cursor: 5, running: { session: 'hwip-a', startedAt: 4, promptPending: false, capped: true } }, def456: { cursor: 5, running: { session: 'hwip-b', startedAt: 4, promptPending: false, capped: 'yes' } } } });
        const read = readScheduleState().schedules;
        expect(read.abc123!.running).toEqual({ session: 'hwip-a', startedAt: 4, promptPending: false, capped: true });
        expect(read.def456!.running).toEqual({ session: 'hwip-b', startedAt: 4, promptPending: false });
    });

    it('is not damaged when every entry is well formed', () => {
        write({ v: 1, schedules: { abc123: { cursor: 5 } } });
        expect(readScheduleState()).toEqual({ v: 1, schedules: { abc123: { cursor: 5 } } });
    });
});

describe('updateSchedule [F8-edit]', () => {
    const NOW = Date.parse('2026-10-20T12:00:00.000Z');

    it('changes when, prompt and run time in place, keeping the id, the session and the creation time', () => {
        addSchedule((id) => make(id, { prompt: 'old' }), () => 'abc123');
        const r = updateSchedule('abc123', { when: { kind: 'every', minutes: 60 }, prompt: 'new', maxRuntimeMin: 45 }, NOW);
        expect(r.ok).toBe(true);
        const file = JSON.parse(readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8'));
        expect(file).toMatchObject({
            id: 'abc123',
            session: 'hwip-app-sched-abc123',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: new Date(NOW).toISOString(),
            when: { kind: 'every', minutes: 60 },
            prompt: 'new',
            maxRuntimeMin: 45,
        });
        expect(statSync(join(schedulesDir(), 'abc123.json')).mode & 0o777).toBe(0o600);
        expect(listSchedules().schedules.map((s) => s.id)).toEqual(['abc123']);
    });

    it('keeps the count where it was when the time sent is the time it had', () => {
        addSchedule((id) => make(id), () => 'abc123');
        expect(updateSchedule('abc123', { when: { kind: 'every', minutes: 30 }, maxRuntimeMin: 20 }, NOW).ok).toBe(true);
        const file = JSON.parse(readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8'));
        expect(file.updatedAt).toBeUndefined();
        expect(file.maxRuntimeMin).toBe(20);
    });

    it('leaves what the change does not name as it was, and keeps the count where it was when the time is not changed', () => {
        addSchedule((id) => make(id, { prompt: 'keep' }), () => 'abc123');
        expect(updateSchedule('abc123', { maxRuntimeMin: 20, prompt: 'new' }, NOW).ok).toBe(true);
        const file = JSON.parse(readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8'));
        expect(file).toMatchObject({ prompt: 'new', when: { kind: 'every', minutes: 30 }, maxRuntimeMin: 20 });
        expect(file.updatedAt).toBeUndefined();
    });

    it('refuses a change that would not validate, and leaves the file as it was', () => {
        addSchedule((id) => make(id), () => 'abc123');
        const before = readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8');
        const r = updateSchedule('abc123', { when: { kind: 'every', minutes: 15 } }, NOW);
        expect(r).toMatchObject({ ok: false, failure: 'invalid' });
        expect(readFileSync(join(schedulesDir(), 'abc123.json'), 'utf8')).toBe(before);
    });

    it('refuses an empty change, a schedule that is not there, and an id that names no file', () => {
        addSchedule((id) => make(id), () => 'abc123');
        expect(updateSchedule('abc123', {}, NOW)).toMatchObject({ ok: false, failure: 'invalid' });
        expect(updateSchedule('zzzzzz', { maxRuntimeMin: 20 }, NOW)).toMatchObject({ ok: false, failure: 'missing' });
        expect(updateSchedule('../x', { maxRuntimeMin: 20 }, NOW)).toMatchObject({ ok: false, failure: 'invalid' });
    });

    it('accepts updatedAt in a file and refuses one that is not a date', () => {
        expect(validateSchedule(make('abc123', { updatedAt: '2026-10-20T00:00:00.000Z' })).ok).toBe(true);
        expect(validateSchedule({ ...make('abc123'), updatedAt: 'yesterday' }).ok).toBe(false);
        expect(validateSchedule(make('abc123', { updatedAt: '2026-09-30T00:00:00.000Z' })).ok).toBe(false);
    });

    it('counts from the edit when there was one, else from the creation', () => {
        expect(scheduleAnchor(make('abc123'))).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
        expect(scheduleAnchor(make('abc123', { updatedAt: '2026-10-20T00:00:00.000Z' }))).toBe(Date.parse('2026-10-20T00:00:00.000Z'));
    });
});

describe('when kind once', () => {
    const AT = new Date(2026, 9, 24, 9, 0).getTime();
    const once = { kind: 'once', at: new Date(AT).toISOString() } as const;

    it('reads --on with --at as that local date and time, one instant', () => {
        expect(ok(parseWhen({ on: '2026-10-24', at: '09:00' }))).toEqual(once);
    });

    it('takes --on only with --at, and never with --days or --every', () => {
        expect(parseWhen({ on: '2026-10-24' })).toMatchObject({ ok: false, error: expect.stringContaining('--on needs --at') });
        expect(parseWhen({ on: '2026-10-24', at: '09:00', days: 'weekdays' })).toMatchObject({ ok: false, error: expect.stringContaining('--on') });
        expect(parseWhen({ on: '2026-10-24', every: '30m' })).toMatchObject({ ok: false, error: expect.stringContaining('--on') });
    });

    it.each(['2026-02-30', '24-10-2026', 'tomorrow', '2026-10-24T09:00'])('refuses %s as a date', (on) => {
        expect(parseWhen({ on, at: '09:00' })).toMatchObject({ ok: false, error: expect.stringContaining('--on takes') });
    });

    it('comes due once, at its time, and never again', () => {
        expect(occurrencesBetween(once, AT - HOUR, AT + 10 * MIN, 0)).toEqual({ count: 1, latest: AT });
        expect(occurrencesBetween(once, AT, AT + 365 * 24 * HOUR, 0)).toEqual({ count: 0, latest: null });
        expect(occurrencesBetween(once, AT - HOUR, AT - 1, 0)).toEqual({ count: 0, latest: null });
    });

    it('has a next time only before its time', () => {
        expect(nextOccurrence(once, AT - 1, 0)).toBe(AT);
        expect(nextOccurrence(once, AT, 0)).toBeNull();
    });

    it('is a schedule a file may hold, with an ISO instant and nothing else', () => {
        expect(validateSchedule(make('abc123', { when: once, maxRuntimeMin: 120 })).ok).toBe(true);
        expect(validateSchedule(make('abc123', { when: { kind: 'once', at: '2026-10-24T09:00:00+09:00' }, maxRuntimeMin: 120 })).ok).toBe(true);
        expect(validateSchedule({ ...make('abc123'), when: { kind: 'once', at: 'tomorrow 9am' } }).ok).toBe(false);
        expect(validateSchedule({ ...make('abc123'), when: { kind: 'once', at: '2026-10-24' } }).ok).toBe(false);
        expect(validateSchedule({ ...make('abc123'), when: { ...once, days: [1] } }).ok).toBe(false);
    });

    it('cannot be added for a time that had passed when it was made, by any caller', () => {
        const r = addSchedule((id) => make(id, { createdAt: new Date(AT + MIN).toISOString(), when: once, maxRuntimeMin: 120 }), () => 'abc123');
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining('passed') });
        expect(existsSync(join(schedulesDir(), 'abc123.json'))).toBe(false);
    });

    it('refuses a local time the clocks skip instead of moving it', () => {
        // 2026-03-08 02:30 does not exist in New York: the clocks go from 02:00 to 03:00.
        expect(parseWhen({ on: '2026-03-08', at: '02:30' })).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
    });

    it('cannot be moved to a time that has passed', () => {
        addSchedule((id) => make(id), () => 'abc123');
        const r = updateSchedule('abc123', { when: once }, AT + MIN);
        expect(r).toMatchObject({ ok: false, failure: 'invalid', error: expect.stringContaining('passed') });
        expect(updateSchedule('abc123', { when: once }, AT - MIN).ok).toBe(true);
    });
});
