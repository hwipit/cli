/**
 * The phone asking what background commands a Claude session runs
 * (`agent.tasks.request`). The rows ride only inside the envelope, sealed for
 * the asking phone and bound to the session; the phone is `v2Party`, an
 * independent implementation of the envelope.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { trustEveryKey } from '../tests/helpers/trust.js';
import type { SubscriberTrust } from './subscriber-trust.js';
import type { AsyncWriterProbe, BackgroundTask, WriterProbe } from './background-tasks.js';

let failSeal = false;
let probe: WriterProbe = (paths) => new Set(paths);
vi.mock('./background-tasks.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./background-tasks.js')>();
    return { ...actual, lsofWritersAsync: (async (paths) => probe(paths)) as AsyncWriterProbe };
});
vi.mock('./crypto.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto.js')>();
    return {
        ...actual,
        sealV2: ((...args: Parameters<typeof actual.sealV2>) =>
            failSeal ? Promise.reject(new Error('seal exploded')) : actual.sealV2(...args)) as typeof actual.sealV2,
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'hwip-bg-requests-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleBackgroundTasksRequest, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
const { recordBackgroundTasks } = await import('./background-tasks.js');
const { liveTaskRows } = await import('./background-tasks-requests.js');
const { initDeviceCrypto } = await import('./crypto.js');

const phone = v2Party();
type Wire = Record<string, unknown>;

beforeAll(async () => { await initDeviceCrypto(); });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const task = (id: string, description: string | null = `run ${id}`): BackgroundTask => ({
    id,
    description,
    startedAt: '2026-11-11T07:00:00.000Z',
    outputPath: `/private/tmp/claude-501/-p/s/tasks/${id}.output`,
});

const unpinnedTrust: SubscriberTrust = {
    ...trustEveryKey,
    admit: async ({ publicKey }) => (publicKey ? { kind: 'refuse', reason: 'subscriber_unverified' } : { kind: 'plain' }),
};

describe('liveTaskRows — tasks request rows', () => {
    it('keeps only the tasks whose output someone still writes, without the output path', async () => {
        const alive: AsyncWriterProbe = async (paths) => new Set(paths.filter((p) => p.includes('/a1.')));
        expect(await liveTaskRows([task('a1'), task('b2')], alive)).toEqual([
            { id: 'a1', description: 'run a1', startedAt: '2026-11-11T07:00:00.000Z' },
        ]);
    });

    it('keeps every task when the probe cannot answer', async () => {
        expect((await liveTaskRows([task('a1'), task('b2')], async () => null)).map((r) => r.id)).toEqual(['a1', 'b2']);
    });

    it('never probes an empty list', async () => {
        let calls = 0;
        expect(await liveTaskRows([], async () => { calls++; return new Set(); })).toEqual([]);
        expect(calls).toBe(0);
    });
});

describe('agent.tasks.request — tasks request handler', () => {
    const device = computeListenerDeviceId();
    let sent: Wire[];
    const send = (data: Wire) => { sent.push(data); };

    const frame = (over: Wire = {}): Wire => ({
        subtype: 'agent.tasks.request',
        targetDeviceId: device,
        sessionName: 'hwip-api',
        requestId: 'r1',
        deviceId: 'dev_phone',
        subscriberPublicKey: phone.publicKey,
        ...over,
    });

    const ask = async (request: Wire): Promise<Wire> => {
        const before = sent.length;
        expect(handleBackgroundTasksRequest(request, send)).toBe(true);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1];
    };

    const opened = (reply: Wire, session = 'hwip-api'): Record<string, any> =>
        JSON.parse(phone.open('agent.tasks', reply.encrypted as Parameters<typeof phone.open>[1], session)) as Record<string, any>;

    beforeEach(() => {
        sent = [];
        failSeal = false;
        setSubscriberTrust(trustEveryKey);
        probe = (paths) => new Set(paths);
        recordBackgroundTasks({ 'hwip-api': { tasks: [task('a1'), task('b2', null)], panePid: 4242 } });
    });

    it('is not its business when it is another request, another machine, or lacks a request id or session', () => {
        expect(handleBackgroundTasksRequest({ subtype: 'agent.screen.request' }, send)).toBe(false);
        expect(handleBackgroundTasksRequest(frame({ targetDeviceId: 'dev_other' }), send)).toBe(false);
        expect(handleBackgroundTasksRequest(frame({ requestId: '' }), send)).toBe(false);
        expect(handleBackgroundTasksRequest(frame({ requestId: 'x'.repeat(500) }), send)).toBe(false);
        expect(handleBackgroundTasksRequest(frame({ sessionName: 42 }), send)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('seals the rows for the asking phone, bound to the session and the request', async () => {
        const reply = await ask(frame());
        expect(reply).toMatchObject({ subtype: 'agent.tasks.result', requestId: 'r1', sessionName: 'hwip-api', targetDeviceId: 'dev_phone' });
        expect(Object.keys(reply).sort()).toEqual(['at', 'encrypted', 'requestId', 'sessionName', 'subtype', 'targetDeviceId']);
        const text = opened(reply);
        expect(text).toEqual({
            v: 1,
            requestId: 'r1',
            at: reply.at,
            tasks: [
                { id: 'a1', description: 'run a1', startedAt: '2026-11-11T07:00:00.000Z' },
                { id: 'b2', description: null, startedAt: '2026-11-11T07:00:00.000Z' },
            ],
        });
        expect(JSON.stringify(reply)).not.toContain('.output');
    });

    it('leaves out a task whose output nobody writes any more', async () => {
        probe = (paths) => new Set(paths.filter((p) => p.includes('/b2.')));
        expect(opened(await ask(frame())).tasks.map((t: { id: string }) => t.id)).toEqual(['b2']);
    });

    it('answers an empty list for a session with no tasks', async () => {
        expect(opened(await ask(frame({ sessionName: 'hwip-web' })), 'hwip-web').tasks).toEqual([]);
    });

    it('never answers in the clear — a request without a key is refused', async () => {
        setSubscriberTrust(unpinnedTrust);
        const reply = await ask(frame({ subscriberPublicKey: undefined }));
        expect(reply).toMatchObject({ error: 'e2ee_required' });
        expect(reply.encrypted).toBeUndefined();
        expect(JSON.stringify(reply)).not.toContain('run a1');
    });

    it('refuses a key that does not check out, with no rows', async () => {
        setSubscriberTrust(unpinnedTrust);
        const reply = await ask(frame());
        expect(reply).toMatchObject({ error: 'subscriber_unverified' });
        expect(JSON.stringify(reply)).not.toContain('run a1');
    });

    it('answers a seal that fails with an error, never the rows', async () => {
        failSeal = true;
        const reply = await ask(frame());
        expect(reply).toMatchObject({ error: 'encrypt_failed' });
        expect(JSON.stringify(reply)).not.toContain('run a1');
    });

    it('rate-limits one asking device without spending another one\'s budget', async () => {
        let last: Wire = {};
        // Keyless requests are answered at once (refused), which spends the budget without a seal each.
        for (let i = 0; i < 130; i++) last = await ask(frame({ requestId: `r${i}`, deviceId: 'dev_flood', subscriberPublicKey: undefined }));
        expect(last).toMatchObject({ error: 'rate_limited' });
        expect(await ask(frame({ requestId: 'other' }))).toHaveProperty('encrypted');
    });
});
