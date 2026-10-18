import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { withTmpStateDir } from './test-state-dir.js';
import { addSchedule, listSchedules, schedulesDir, writeScheduleState, type Schedule } from './schedule.js';
import { applyPhoneSchedule, LIST_PROMPT_CHARS, phoneScheduleList, type PhoneScheduleDeps, type PhoneScheduleResult } from './schedule-remote.js';

const stateRoot = withTmpStateDir('hwip-schedule-remote-');

const make = (id: string, over: Partial<Schedule> = {}): Schedule => ({
    v: 1,
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'cli',
    agentKind: 'claude',
    cwd: '/work/api',
    label: `sched-${id}`,
    session: `hwip-api-sched-${id}`,
    when: { kind: 'every', minutes: 60 },
    maxRuntimeMin: 30,
    ...over,
});
const put = (id: string, over: Partial<Schedule> = {}) => addSchedule(() => make(id, over), () => id);

describe('phoneScheduleList', () => {
    it('lists the schedules oldest first with the project, the next run and the last result', () => {
        put('aaaaaa');
        put('bbbbbb', { createdAt: '2026-10-02T00:00:00.000Z' });
        writeScheduleState({ v: 1, schedules: { aaaaaa: { cursor: 0, last: { outcome: 'overlap', at: Date.parse('2026-10-03T00:00:00.000Z') } } } });
        const now = Date.parse('2026-10-03T00:10:00.000Z');
        const [first, second] = phoneScheduleList(now)!.schedules;
        expect([first.id, second.id]).toEqual(['aaaaaa', 'bbbbbb']);
        expect(first).toMatchObject({ project: 'api', nextAt: '2026-10-03T01:00:00.000Z', last: { outcome: 'overlap', at: '2026-10-03T00:00:00.000Z' } });
        expect(second.last).toBeUndefined();
        expect(first).not.toHaveProperty('cwd');
    });

    it('leaves out a file that cannot be read, as `hwip schedule` does', () => {
        put('aaaaaa');
        writeFileSync(join(schedulesDir(), 'bbbbbb.json'), '{ not json');
        expect(phoneScheduleList(Date.now())).toMatchObject({ unreadable: 1, schedules: [{ id: 'aaaaaa' }] });
    });

    it('is empty when there is no directory yet', () => {
        mkdirSync(stateRoot(), { recursive: true });
        expect(phoneScheduleList(Date.now())).toEqual({ schedules: [], unreadable: 0 });
    });

    it('cuts a long prompt, not through a surrogate pair', () => {
        const pair = '😀';
        put('aaaaaa', { prompt: `${'x'.repeat(LIST_PROMPT_CHARS - 2)}${pair}${'y'.repeat(50)}` });
        put('bbbbbb', { prompt: 'short' });
        const [cut, kept] = phoneScheduleList(Date.now())!.schedules;
        expect(cut.prompt!.length).toBeLessThanOrEqual(LIST_PROMPT_CHARS);
        expect(cut.prompt!.endsWith('…')).toBe(true);
        expect(cut.prompt).not.toMatch(/[\ud800-\udbff]…$/);
        expect(kept.prompt).toBe('short');
    });
});

describe('applyPhoneSchedule', () => {
    const entry = { name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', lastSeenAt: '2026-10-01T00:00:00.000Z' };
    const deps = (over: Partial<PhoneScheduleDeps> = {}): PhoneScheduleDeps => ({
        now: () => Date.parse('2026-10-05T00:00:00.000Z'),
        recall: (name, kind) => (name === 'hwip-api' && (kind === undefined || kind === 'claude') ? entry : null),
        directoryExists: () => true,
        canPrompt: (kind) => kind === 'claude',
        ...over,
    });
    const create = (over: Record<string, unknown> = {}) => ({
        op: 'create', when: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] }, prompt: 'triage', ...over,
    });
    const refused = (result: PhoneScheduleResult, reason: string) => expect(result).toMatchObject({ ok: false, reason });

    it('creates a schedule from the recorded session: its directory and agent, a label of its own, no wt or arguments', () => {
        const result = applyPhoneSchedule(create(), 'hwip-api', deps());
        expect(result).toMatchObject({ ok: true });
        const [saved] = listSchedules().schedules;
        expect(saved).toMatchObject({
            source: 'phone', agentKind: 'claude', cwd: '/work/api', prompt: 'triage', maxRuntimeMin: 120,
            createdAt: '2026-10-05T00:00:00.000Z', when: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
        });
        expect(saved.label).toBe(`sched-${saved.id}`);
        expect(saved.session).toBe(`hwip-api-sched-${saved.id}`);
        expect(saved).not.toHaveProperty('wt');
        expect(saved).not.toHaveProperty('agentArgs');
    });

    it('takes the run time asked for, and an every schedule defaults to its period', () => {
        applyPhoneSchedule(create({ maxRuntimeMin: 45 }), 'hwip-api', deps());
        applyPhoneSchedule(create({ when: { kind: 'every', minutes: 30 } }), 'hwip-api', deps());
        expect(listSchedules().schedules.map((s) => s.maxRuntimeMin).sort((a, b) => a - b)).toEqual([30, 45]);
    });

    it('looks the run up by agent when the phone names one', () => {
        // The session is known, the agent named is not: told as a bad request, not as an unknown session.
        refused(applyPhoneSchedule(create({ agentKind: 'codex' }), 'hwip-api', deps()), 'schedule_invalid');
        refused(applyPhoneSchedule(create({ agentKind: 'codex' }), 'hwip-nope', deps()), 'unknown_session');
        expect(applyPhoneSchedule(create({ agentKind: 'claude' }), 'hwip-api', deps())).toMatchObject({ ok: true });
    });

    it.each([
        ['cwd', { cwd: '/etc' }],
        ['agentArgs', { agentArgs: ['--x'] }],
        ['wt', { wt: 'main' }],
        ['label', { label: 'mine' }],
        ['session', { session: 'hwip-other' }],
        ['id', { id: 'abc123' }],
        ['source', { source: 'cli' }],
    ])('refuses a create that carries %s, and writes nothing', (_name, extra) => {
        refused(applyPhoneSchedule(create(extra), 'hwip-api', deps()), 'schedule_invalid');
        expect(listSchedules().schedules).toEqual([]);
    });

    it.each([
        ['no prompt', { prompt: undefined }],
        ['an empty prompt', { prompt: '' }],
        ['a prompt that is not text', { prompt: 5 }],
        ['a prompt past 4000 characters', { prompt: 'x'.repeat(4001) }],
        ['a time that is not a time', { when: { kind: 'daily', at: '25:00', days: [1] } }],
        ['an every under 15 minutes', { when: { kind: 'every', minutes: 5 } }],
        ['a run time past the every period', { when: { kind: 'every', minutes: 15 }, maxRuntimeMin: 60 }],
        ['a run time under 5 minutes', { maxRuntimeMin: 1 }],
        ['when that is not an object', { when: 'daily' }],
    ])('refuses a create with %s', (_name, over) => {
        refused(applyPhoneSchedule(create(over), 'hwip-api', deps()), 'schedule_invalid');
        expect(listSchedules().schedules).toEqual([]);
    });

    it('refuses a prompt for an agent that cannot take one', () => {
        refused(applyPhoneSchedule(create(), 'hwip-api', deps({ canPrompt: () => false })), 'schedule_invalid');
    });

    it('refuses a session this machine never recorded, or whose directory is gone', () => {
        refused(applyPhoneSchedule(create(), 'hwip-nope', deps()), 'unknown_session');
        refused(applyPhoneSchedule(create(), 'hwip-api', deps({ directoryExists: () => false })), 'unknown_session');
    });

    it('tells a throw from the registry or the files as schedule_failed', () => {
        refused(applyPhoneSchedule(create(), 'hwip-api', deps({ recall: () => { throw new Error('EACCES'); } })), 'schedule_failed');
    });

    it('tells a schedules directory that cannot be listed or written as schedule_failed, for a create and for a remove', () => {
        applyPhoneSchedule(create(), 'hwip-api', deps());
        const [saved] = listSchedules().schedules;
        const dir = schedulesDir();
        try {
            // Readable but not writable: the unlink throws.
            chmodSync(dir, 0o500);
            if (process.getuid?.() !== 0) refused(applyPhoneSchedule({ op: 'remove', id: saved.id }, saved.session, deps()), 'schedule_failed');
        } finally {
            chmodSync(dir, 0o700);
        }
        // Not a directory: it cannot be listed, so "no such schedule" would be a guess; and nothing can be made in it.
        rmSync(dir, { recursive: true });
        writeFileSync(dir, 'in the way');
        refused(applyPhoneSchedule({ op: 'remove', id: saved.id }, saved.session, deps()), 'schedule_failed');
        refused(applyPhoneSchedule(create(), 'hwip-api', deps()), 'schedule_failed');
    });

    it('a second remove of the same schedule finds nothing and is refused', () => {
        applyPhoneSchedule(create(), 'hwip-api', deps());
        const [saved] = listSchedules().schedules;
        expect(applyPhoneSchedule({ op: 'remove', id: saved.id }, saved.session, deps())).toEqual({ ok: true });
        refused(applyPhoneSchedule({ op: 'remove', id: saved.id }, saved.session, deps()), 'schedule_invalid');
    });

    it('refuses the 21st schedule with its own reason', () => {
        for (let i = 0; i < 20; i++) expect(applyPhoneSchedule(create(), 'hwip-api', deps())).toMatchObject({ ok: true });
        refused(applyPhoneSchedule(create(), 'hwip-api', deps()), 'schedule_limit');
        expect(listSchedules().schedules).toHaveLength(20);
    });

    it('removes a schedule by id, for the session it names', () => {
        applyPhoneSchedule(create(), 'hwip-api', deps());
        const [saved] = listSchedules().schedules;
        expect(applyPhoneSchedule({ op: 'remove', id: saved.id }, saved.session, deps())).toEqual({ ok: true });
        expect(listSchedules().schedules).toEqual([]);
    });

    it('refuses a remove for another session, an unknown id, or an id that is a path', () => {
        applyPhoneSchedule(create(), 'hwip-api', deps());
        const [saved] = listSchedules().schedules;
        refused(applyPhoneSchedule({ op: 'remove', id: saved.id }, 'hwip-other', deps()), 'schedule_invalid');
        refused(applyPhoneSchedule({ op: 'remove', id: 'zzzzzz' }, saved.session, deps()), 'schedule_invalid');
        refused(applyPhoneSchedule({ op: 'remove', id: '../x' }, saved.session, deps()), 'schedule_invalid');
        refused(applyPhoneSchedule({ op: 'remove', id: saved.id, cwd: '/' }, saved.session, deps()), 'schedule_invalid');
        expect(listSchedules().schedules).toHaveLength(1);
    });

    it.each([[undefined], [null], ['create'], [[]], [{}], [{ op: 'pause', id: 'abcdef' }]])('refuses %j as a request', (request) => {
        refused(applyPhoneSchedule(request, 'hwip-api', deps()), 'schedule_invalid');
    });
});
