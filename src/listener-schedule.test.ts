/**
 * The phone reading this machine's schedules (F8 slice 06).
 *
 * The request is routing fields and the key the answer is sealed for; the schedules ride only
 * inside the envelope, bound to this machine's device id. The phone is `v2Party`, an independent
 * implementation of the envelope, so "it opens" says something about the wire format.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { trustEveryKey } from '../tests/helpers/trust.js';
import type { SubscriberTrust } from './subscriber-trust.js';

let failSeal = false;
vi.mock('./crypto.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto.js')>();
    return {
        ...actual,
        sealV2: ((...args: Parameters<typeof actual.sealV2>) =>
            failSeal ? Promise.reject(new Error('seal exploded')) : actual.sealV2(...args)) as typeof actual.sealV2,
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'hwip-schedule-list-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleScheduleListRequest, handlePush, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');
const { getDevicePublicKey, initDeviceCrypto } = await import('./crypto.js');
const { addSchedule, writeScheduleState } = await import('./schedule.js');

const phone = v2Party();
let listenerKey: string;

type Wire = Record<string, unknown>;
const ALLOWED_FRAME_KEYS = new Set(['subtype', 'requestId', 'targetDeviceId', 'at', 'schedules', 'unreadable', 'encrypted', 'error']);

beforeAll(async () => {
    await initDeviceCrypto();
    listenerKey = getDevicePublicKey() as string;
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const sealedOnlyTrust: SubscriberTrust = {
    ...trustEveryKey,
    sealedOnly: () => true,
    admit: async ({ publicKey }) => (publicKey ? { kind: 'seal', publicKey } : { kind: 'refuse', reason: 'e2ee_required' }),
};
const unpinnedTrust: SubscriberTrust = {
    ...trustEveryKey,
    admit: async ({ publicKey }) => (publicKey ? { kind: 'refuse', reason: 'subscriber_unverified' } : { kind: 'plain' }),
};

describe('agent.schedule.list — the schedules on this machine', () => {
    const device = computeListenerDeviceId();
    let sent: Wire[];
    const send = (data: Wire) => { sent.push(data); };

    const make = (id: string, over: Record<string, unknown> = {}) => ({
        v: 1 as const,
        id,
        createdAt: '2026-10-01T00:00:00.000Z',
        source: 'phone' as const,
        agentKind: 'claude',
        cwd: '/Users/me/secret-place/api',
        label: `sched-${id}`,
        session: `hwip-api-sched-${id}`,
        prompt: 'triage the issues',
        when: { kind: 'daily' as const, at: '09:00', days: [1, 2, 3, 4, 5] },
        maxRuntimeMin: 60,
        ...over,
    });

    const put = (id: string, over: Record<string, unknown> = {}) => addSchedule(() => make(id, over), () => id);

    const frame = (over: Wire = {}): Wire => ({
        subtype: 'agent.schedule.list.request',
        targetDeviceId: device,
        requestId: 'r1',
        deviceId: 'dev_phone',
        subscriberPublicKey: phone.publicKey,
        ...over,
    });

    const ask = async (request: Wire): Promise<Wire> => {
        const before = sent.length;
        expect(handleScheduleListRequest(request, send)).toBe(true);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1];
    };

    /** What the phone reads from a sealed answer: the whole text, which names the request it answers. */
    const openedText = (reply: Wire): Record<string, any> =>
        JSON.parse(phone.open('schedule.list', reply.encrypted as Parameters<typeof phone.open>[1], device)) as Record<string, any>;
    const opened = (reply: Wire): Record<string, any>[] => openedText(reply).schedules;

    beforeEach(() => {
        sent = [];
        failSeal = false;
        setSubscriberTrust(trustEveryKey);
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });

    it('is not its business when it is another request, another machine or has no request id', () => {
        expect(handleScheduleListRequest({ subtype: 'agent.screen.request' }, send)).toBe(false);
        expect(handleScheduleListRequest(frame({ targetDeviceId: 'dev_other' }), send)).toBe(false);
        expect(handleScheduleListRequest(frame({ requestId: '' }), send)).toBe(false);
        expect(handleScheduleListRequest(frame({ requestId: 'x'.repeat(500) }), send)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('seals the list for the asking phone, bound to this machine, with the fields the app shows', async () => {
        expect(put('abc123')).toMatchObject({ ok: true });
        writeScheduleState({
            v: 1,
            schedules: { abc123: { cursor: 0, last: { outcome: 'missed', at: Date.parse('2026-10-05T09:00:00.000Z') } } },
        });
        const reply = await ask(frame());
        expect(reply).toMatchObject({ subtype: 'agent.schedule.list.result', requestId: 'r1', targetDeviceId: 'dev_phone' });
        expect(reply.schedules).toBeUndefined();
        const [item] = opened(reply);
        expect(item).toEqual({
            id: 'abc123',
            source: 'phone',
            agentKind: 'claude',
            project: 'api',
            session: 'hwip-api-sched-abc123',
            when: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
            prompt: 'triage the issues',
            maxRuntimeMin: 60,
            nextAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
            last: { outcome: 'missed', at: '2026-10-05T09:00:00.000Z' },
        });
    });

    it('answers an empty list', async () => {
        expect(opened(await ask(frame()))).toEqual([]);
    });

    it('names the request and the time inside the seal, so an older sealed list is not the answer to a newer request', async () => {
        const first = await ask(frame({ requestId: 'r1' }));
        const second = await ask(frame({ requestId: 'r2' }));
        expect(openedText(first)).toMatchObject({ v: 1, requestId: 'r1', at: first.at });
        expect(openedText(second)).toMatchObject({ v: 1, requestId: 'r2', at: second.at });
    });

    it('says how many files it could not read, rather than listing the rest as everything', async () => {
        put('abc123');
        mkdirSync(join(TMP, 'state', 'hwip', 'schedules'), { recursive: true });
        writeFileSync(join(TMP, 'state', 'hwip', 'schedules', 'bbbbbb.json'), '{ not json');
        const reply = await ask(frame());
        expect(openedText(reply)).toMatchObject({ unreadable: 1 });
        expect(openedText(reply).schedules).toHaveLength(1);
    });

    it('answers read_failed, not an empty list, when the schedules cannot be listed', async () => {
        mkdirSync(join(TMP, 'state', 'hwip'), { recursive: true });
        writeFileSync(join(TMP, 'state', 'hwip', 'schedules'), 'a file where the directory should be');
        const reply = await ask(frame());
        expect(reply.error).toBe('read_failed');
        expect(reply.encrypted).toBeUndefined();
    });

    it('never puts a directory path or agent arguments on the wire, in the clear or sealed', async () => {
        put('abc123', { source: 'cli', wt: 'feature', agentArgs: ['--dangerously-skip-permissions'] });
        const reply = await ask(frame());
        expect(Object.keys(reply).every((k) => ALLOWED_FRAME_KEYS.has(k))).toBe(true);
        const text = phone.open('schedule.list', reply.encrypted as Parameters<typeof phone.open>[1], device);
        expect(text).not.toContain('secret-place');
        expect(text).not.toContain('--dangerously');
        expect(text).not.toContain('cwd');
        expect(text).not.toContain('agentArgs');
        expect(text).not.toContain('"wt"');
    });

    it('does not open for another context: a list sealed for this machine is bound to its device id', async () => {
        const reply = await ask(frame());
        expect(() => phone.open('schedule.list', reply.encrypted as Parameters<typeof phone.open>[1], 'dev_other')).toThrow();
    });

    it('answers in the clear a request that has no key, while this listener has never sealed', async () => {
        put('abc123');
        const reply = await ask(frame({ subscriberPublicKey: undefined }));
        expect(reply.encrypted).toBeUndefined();
        expect(JSON.parse(reply.schedules as string)).toHaveLength(1);
    });

    it('refuses a request that has no key once the listener only seals, and sends no schedule', async () => {
        setSubscriberTrust(sealedOnlyTrust);
        put('abc123');
        const reply = await ask(frame({ subscriberPublicKey: undefined }));
        expect(reply.error).toBe('e2ee_required');
        expect(reply.schedules).toBeUndefined();
        expect(reply.encrypted).toBeUndefined();
    });

    it('refuses a key that was not pinned, never answering a seal request in the clear', async () => {
        setSubscriberTrust(unpinnedTrust);
        put('abc123');
        const reply = await ask(frame());
        expect(reply.error).toBe('subscriber_unverified');
        expect(reply.schedules).toBeUndefined();
        expect(reply.encrypted).toBeUndefined();
    });

    it('turns a seal that fails into an error, never a plaintext list', async () => {
        put('abc123');
        failSeal = true;
        const reply = await ask(frame());
        expect(reply.error).toBe('encrypt_failed');
        expect(reply.schedules).toBeUndefined();
    });

    it('shortens prompts until the answer fits a frame, counting bytes: 20 Korean prompts of 500 characters', async () => {
        for (let i = 0; i < 20; i++) put(`s${String(i).padStart(5, '0')}`, { prompt: '가'.repeat(500) });
        const text = phone.open('schedule.list', (await ask(frame())).encrypted as Parameters<typeof phone.open>[1], device);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24 * 1024);
        const { schedules } = JSON.parse(text) as { schedules: { prompt?: string }[] };
        expect(schedules).toHaveLength(20);
        expect(schedules.every((s) => (s.prompt ?? '').length > 0)).toBe(true);
    });

    it('answers too_large rather than a frame the relay would drop, when even the list without prompts is too big', async () => {
        for (let i = 0; i < 20; i++) put(`s${String(i).padStart(5, '0')}`, { cwd: `/w/${'p'.repeat(1500)}` });
        const reply = await ask(frame());
        expect(reply.error).toBe('too_large');
        expect(reply.encrypted).toBeUndefined();
    });

    it('keeps one budget per asking device: a flood from one does not use up another', async () => {
        for (let i = 0; i < 300; i++) handleScheduleListRequest(frame({ requestId: `f${i}`, deviceId: 'dev_forged' }), send);
        sent = [];
        const reply = await ask(frame({ requestId: 'real', deviceId: 'dev_real' }));
        expect(reply.error).toBeUndefined();
    });

    it('rate-limits a phone that asks over and over, before it reads anything', () => {
        // The refusal is sent at once; an answer waits for the key check, so the first frames to land are the refusals.
        for (let i = 0; i < 300; i++) handleScheduleListRequest(frame({ requestId: `r${i}` }), send);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((f) => f.error === 'rate_limited')).toBe(true);
    });
});

describe('agent.command with a schedule — the phone makes and removes schedules', () => {
    const me = computeListenerDeviceId();
    const SESSION = 'hwip-api';
    const REPO = join(TMP, 'work', 'api');
    const when = { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] };
    const create = (over: Record<string, unknown> = {}) => ({ op: 'create', when, prompt: 'triage the issues', ...over });

    let typed: string[];
    let refusals: string[];
    let accepted: Map<string, number>;
    /** A trust that takes the phone's key and refuses a number it has seen, as the real one does. */
    const trust = (over: Partial<SubscriberTrust> = {}): SubscriberTrust => ({
        ...trustEveryKey,
        acceptCommand: (sender, n) => {
            if (n <= (accepted.get(sender) ?? 0)) return false;
            accepted.set(sender, n);
            return true;
        },
        ...over,
    });
    const deps = (over: Record<string, unknown> = {}) => ({
        deviceId: () => me,
        inject: (_: string, text: string) => { typed.push(text); return true; },
        insertText: (_: string, text: string) => { typed.push(text); return true; },
        sendKeys: () => { typed.push('<keys>'); return true; },
        rateLimit: () => true,
        // What the phone is told: `handlePush` reports one frame per refused command, already generalized for a sealed one.
        reportRefusal: ({ reason }: { reason: string }) => { refusals.push(reason); },
        ...over,
    });
    const stored = (): string[] => (existsSync(join(TMP, 'state', 'hwip', 'schedules')) ? readdirSync(join(TMP, 'state', 'hwip', 'schedules')) : []);

    const plain = (schedule: unknown, over: Record<string, unknown> = {}) => ({
        pushId: 'p1', type: 'agent.command', targetDeviceId: me, agentSessionName: SESSION, schedule, ...over,
    });
    let counter: number;
    /** A command push as the app seals it: the whole request inside, only the `op` beside it. */
    const sealedPush = (schedule: Record<string, unknown>, over: { outside?: unknown; n?: number; extra?: Record<string, unknown>; content?: Record<string, unknown> } = {}) => {
        const sealed = phone.sealPush(
            { cmd: { n: over.n ?? ++counter, session: SESSION, device: me }, schedule, ...over.content },
            listenerKey,
        );
        return {
            pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: me, agentSessionName: SESSION,
            senderDeviceId: 'dev_phone', senderPublicKey: phone.publicKey,
            body: sealed.body, deviceKeyMap: { [me]: sealed.entry },
            schedule: 'outside' in over ? over.outside : { op: schedule.op },
            ...over.extra,
        };
    };

    beforeEach(() => {
        typed = [];
        refusals = [];
        accepted = new Map();
        counter = 1000;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        mkdirSync(REPO, { recursive: true });
        rememberSessions([{ name: SESSION, cwd: REPO, agentKind: 'claude' }]);
        setSubscriberTrust(trust());
    });

    describe('plain', () => {
        it('makes a schedule from the recorded session, types nothing and reports no refusal', async () => {
            expect(await handlePush(plain(create()), deps())).toBe(true);
            expect(stored()).toHaveLength(1);
            expect(typed).toEqual([]);
            expect(refusals).toEqual([]);
        });

        it('removes the schedule named, for the session it belongs to', async () => {
            await handlePush(plain(create()), deps());
            const [file] = stored();
            const id = file.replace('.json', '');
            const session = `hwip-api-sched-${id}`;
            expect(await handlePush(plain({ op: 'remove', id }, { agentSessionName: session }), deps())).toBe(true);
            expect(stored()).toEqual([]);
            expect(typed).toEqual([]);
        });

        it.each([
            ['a directory', { cwd: '/etc' }],
            ['agent arguments', { agentArgs: ['--yolo'] }],
            ['a worktree', { wt: 'main' }],
            ['a label', { label: 'mine' }],
        ])('refuses a create that carries %s, as schedule_invalid', async (_name, extra) => {
            expect(await handlePush(plain(create(extra)), deps())).toBe(false);
            expect(refusals).toEqual(['schedule_invalid']);
            expect(stored()).toEqual([]);
        });

        it('refuses a session this machine never recorded', async () => {
            expect(await handlePush(plain(create(), { agentSessionName: 'hwip-nowhere' }), deps())).toBe(false);
            expect(refusals).toEqual(['unknown_session']);
            expect(stored()).toEqual([]);
        });

        it('refuses the 21st schedule as schedule_limit', async () => {
            for (let i = 0; i < 20; i++) expect(await handlePush(plain(create()), deps())).toBe(true);
            expect(await handlePush(plain(create()), deps())).toBe(false);
            expect(refusals).toEqual(['schedule_limit']);
            expect(stored()).toHaveLength(20);
        });

        it('refuses a remove of a path, or of a schedule that is not there', async () => {
            expect(await handlePush(plain({ op: 'remove', id: '../x' }), deps())).toBe(false);
            expect(await handlePush(plain({ op: 'remove', id: 'zzzzzz' }), deps())).toBe(false);
            expect(refusals).toEqual(['schedule_invalid', 'schedule_invalid']);
        });

        it('refuses a request beside text, keys, an insert or an attachment', async () => {
            for (const beside of [{ body: 'hi' }, { keys: ['enter'] }, { insert: 'x' }, { files: [{ fileKey: 'k', fileName: 'a' }] }]) {
                expect(await handlePush(plain(create(), beside), deps())).toBe(false);
            }
            expect(refusals).toEqual(['invalid_command', 'invalid_command', 'invalid_command', 'invalid_command']);
            expect(stored()).toEqual([]);
            expect(typed).toEqual([]);
        });

        it('does not spend a schedule on a session over its rate limit', async () => {
            expect(await handlePush(plain(create()), deps({ rateLimit: () => false }))).toBe(false);
            expect(refusals).toEqual(['rate_limited']);
            expect(stored()).toEqual([]);
        });

        it('leaves a sealed push addressed to another machine alone and silent', async () => {
            expect(await handlePush(sealedPush(create(), { extra: { targetDeviceId: 'dev_other' } }), deps())).toBe(false);
            expect(stored()).toEqual([]);
            expect(refusals).toEqual([]);
        });

        it('tells a failure of this machine\'s own files as schedule_failed, not as a bad request', async () => {
            // A file where the schedules directory belongs: the request is fine, the machine cannot keep it.
            mkdirSync(join(TMP, 'state', 'hwip'), { recursive: true });
            writeFileSync(join(TMP, 'state', 'hwip', 'schedules'), 'in the way');
            expect(await handlePush(plain(create()), deps())).toBe(false);
            expect(refusals).toEqual(['schedule_failed']);
        });

        it('leaves a push addressed to another machine, or to none, alone and silent', async () => {
            expect(await handlePush(plain(create(), { targetDeviceId: 'dev_other' }), deps())).toBe(false);
            expect(await handlePush(plain(create(), { targetDeviceId: undefined }), deps())).toBe(false);
            expect(stored()).toEqual([]);
            expect(refusals).toEqual([]);
        });

        it('ignores a schedule that is not an object', async () => {
            expect(await handlePush(plain('create') as never, deps())).toBe(false);
            expect(await handlePush(plain([create()]) as never, deps())).toBe(false);
            expect(stored()).toEqual([]);
        });

        it('is refused whole once the listener only seals (e2ee_required), whatever it asks', async () => {
            setSubscriberTrust(trust({ sealedOnly: () => true }));
            expect(await handlePush(plain(create()), deps())).toBe(false);
            expect(await handlePush(plain({ op: 'remove', id: 'abcdef' }), deps())).toBe(false);
            expect(refusals).toEqual(['e2ee_required', 'e2ee_required']);
            expect(stored()).toEqual([]);
        });
    });

    describe('sealed', () => {
        it('makes a schedule from a sealed request that passed the sender checks, and types nothing', async () => {
            setSubscriberTrust(trust({ sealedOnly: () => true }));
            expect(await handlePush(sealedPush(create()), deps())).toBe(true);
            expect(stored()).toHaveLength(1);
            expect(typed).toEqual([]);
            expect(refusals).toEqual([]);
        });

        it('refuses the same number twice: a replay changes nothing', async () => {
            const push = sealedPush(create(), { n: 1000 });
            expect(await handlePush(push, deps())).toBe(true);
            expect(await handlePush(push, deps())).toBe(false);
            expect(refusals).toEqual(['sealed_rejected']);
            expect(stored()).toHaveLength(1);
        });

        it('refuses a relay that turned the sealed op into another', async () => {
            expect(await handlePush(sealedPush(create(), { outside: { op: 'remove' } }), deps())).toBe(false);
            expect(await handlePush(sealedPush({ op: 'remove', id: 'abcdef' }, { outside: { op: 'create' } }), deps())).toBe(false);
            expect(refusals).toEqual(['sealed_rejected', 'sealed_rejected']);
            expect(stored()).toEqual([]);
        });

        it('refuses a push whose plain side has no op, more than an op, or no schedule at all', async () => {
            expect(await handlePush(sealedPush(create(), { outside: {} }), deps())).toBe(false);
            expect(await handlePush(sealedPush(create(), { outside: { op: 'create', cwd: '/etc' } }), deps())).toBe(false);
            expect(await handlePush(sealedPush(create(), { outside: undefined }), deps())).toBe(false);
            expect(stored()).toEqual([]);
        });

        it('refuses a schedule written beside a seal that holds none', async () => {
            const push = sealedPush({ op: 'create' }, { content: { schedule: undefined, body: 'hello' } });
            expect(await handlePush({ ...push, schedule: { op: 'create' } }, deps())).toBe(false);
            expect(typed).toEqual([]);
            expect(stored()).toEqual([]);
        });

        it('tells the phone only sealed_rejected about why a sealed request failed, a bad field and the limit alike', async () => {
            await handlePush(sealedPush(create({ cwd: '/etc' })), deps());
            for (let i = 0; i < 20; i++) await handlePush(sealedPush(create()), deps());
            await handlePush(sealedPush(create()), deps());
            expect(refusals).toEqual(['sealed_rejected', 'sealed_rejected']);
            expect(stored()).toHaveLength(20);
        });

        it('refuses a request beside text or keys inside the seal', async () => {
            expect(await handlePush(sealedPush(create(), { content: { body: 'also type this' } }), deps())).toBe(false);
            expect(await handlePush(sealedPush(create(), { content: { keys: ['enter'] } }), deps())).toBe(false);
            expect(typed).toEqual([]);
            expect(stored()).toEqual([]);
        });

        it('refuses a sender whose key did not check out', async () => {
            setSubscriberTrust(trust({ admit: async () => ({ kind: 'refuse', reason: 'subscriber_unverified' }) }));
            expect(await handlePush(sealedPush(create()), deps())).toBe(false);
            expect(refusals).toEqual(['sealed_rejected']);
            expect(stored()).toEqual([]);
        });

        it('removes by a sealed request', async () => {
            await handlePush(sealedPush(create()), deps());
            const id = stored()[0].replace('.json', '');
            const removal = { ...sealedPush({ op: 'remove', id }), agentSessionName: `hwip-api-sched-${id}` };
            // The label binds the session: a removal sealed for another session is not this one's.
            expect(await handlePush(removal, deps())).toBe(false);
            const own = sealedPush({ op: 'remove', id });
            const sealedForIt = phone.sealPush({ cmd: { n: ++counter, session: `hwip-api-sched-${id}`, device: me }, schedule: { op: 'remove', id } }, listenerKey);
            expect(await handlePush({ ...own, agentSessionName: `hwip-api-sched-${id}`, body: sealedForIt.body, deviceKeyMap: { [me]: sealedForIt.entry } }, deps())).toBe(true);
            expect(stored()).toEqual([]);
        });
    });
});
