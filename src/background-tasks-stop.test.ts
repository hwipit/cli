/**
 * The phone stopping a background command (`agent.task.stop.request`). Two
 * halves: which process group the listener would signal (`findTaskProcessGroup`
 * — the only place that picks a target, fed fake `lsof`/`ps` answers here), and
 * the request handler that admits a sealed request and signals that group.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { trustEveryKey } from '../tests/helpers/trust.js';
import type { SubscriberTrust } from './subscriber-trust.js';
import type { BackgroundTask } from './background-tasks.js';
import { parseProcTable } from './remote-agents.js';
import { findTaskProcessGroup, type StopProbes } from './background-tasks-stop.js';

let stopped: Array<{ outputPath: string; panePid: number }> = [];
let outcome = 'stopped';
vi.mock('./background-tasks-stop.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./background-tasks-stop.js')>();
    return {
        ...actual,
        stopBackgroundTask: async (task: BackgroundTask, panePid: number) => {
            stopped.push({ outputPath: task.outputPath, panePid });
            return outcome;
        },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'hwip-bg-stop-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleBackgroundTaskStopRequest, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
const { recordBackgroundTasks } = await import('./background-tasks.js');
const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const OUTPUT = '/private/tmp/claude-501/-p/s/tasks/a1.output';

/**
 * The spike's tree: tmux pane shell 100 → claude 200 → the task's wrapper zsh
 * 300 (its own group leader) → sleep 301 in that group. The listener is 900,
 * in a group of its own.
 */
const TREE = [
    '    1     0     1     1 launchd',
    '  100     1   100   200 zsh',
    '  200   100   200   200 claude',
    '  300   200   300   200 zsh',
    '  301   300   300   200 sleep',
    '  900     1   900   900 node',
].join('\n');

const probes = (over: Partial<StopProbes> = {}): StopProbes => ({
    writerPids: async () => [300, 301],
    procTable: async () => parseProcTable(TREE),
    selfPid: 900,
    ...over,
});

describe('findTaskProcessGroup — stop request target', () => {
    it('names the group whose leader writes the output and descends from the pane', async () => {
        expect(await findTaskProcessGroup(OUTPUT, 100, probes())).toEqual({ kind: 'group', pgid: 300 });
    });

    it('finds nothing when nobody writes the output, or lsof or ps cannot answer', async () => {
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ writerPids: async () => [] }))).toEqual({ kind: 'not_found' });
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ writerPids: async () => null }))).toEqual({ kind: 'not_found' });
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ procTable: async () => null }))).toEqual({ kind: 'not_found' });
    });

    it('finds nothing when the group leader is not among the writers (the task left its group)', async () => {
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ writerPids: async () => [301] }))).toEqual({ kind: 'not_found' });
    });

    it('finds nothing when the pane is not an ancestor of the leader', async () => {
        expect(await findTaskProcessGroup(OUTPUT, 555, probes())).toEqual({ kind: 'not_found' });
        const elsewhere = TREE.replace('  300   200   300   200 zsh', '  300     1   300   300 zsh');
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ procTable: async () => parseProcTable(elsewhere) }))).toEqual({ kind: 'not_found' });
    });

    it('is ambiguous when two groups qualify, and signals neither', async () => {
        const two = `${TREE}\n  400   200   400   200 zsh`;
        const verdict = await findTaskProcessGroup(OUTPUT, 100, probes({
            writerPids: async () => [300, 301, 400],
            procTable: async () => parseProcTable(two),
        }));
        expect(verdict).toEqual({ kind: 'ambiguous' });
    });

    it('refuses the listener\'s own group, the pane shell\'s and claude\'s', async () => {
        // A writer in claude's own group: the leader 200 descends from the pane, and is claude.
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ writerPids: async () => [200] }))).toEqual({ kind: 'refused' });
        // The pane shell writing the file itself: no descendant of its own pane.
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({ writerPids: async () => [100] }))).toEqual({ kind: 'not_found' });
        // The listener running under the pane, in its own group.
        const mine = TREE.replace('  900     1   900   900 node', '  900   200   900   200 node');
        expect(await findTaskProcessGroup(OUTPUT, 100, probes({
            writerPids: async () => [900],
            procTable: async () => parseProcTable(mine),
        }))).toEqual({ kind: 'refused' });
    });
});

describe('stopBackgroundTask — stop request signal', () => {
    it('sends SIGTERM to the whole group, never to one pid', async () => {
        const { stopBackgroundTask: real } = await vi.importActual<typeof import('./background-tasks-stop.js')>('./background-tasks-stop.js');
        const kills: Array<[number, string]> = [];
        const kill = (pid: number, signal: string): void => { kills.push([pid, signal]); };
        expect(await real({ id: 'a1', description: null, startedAt: null, outputPath: OUTPUT }, 100, { probes: probes(), kill })).toBe('stopped');
        expect(kills).toEqual([[-300, 'SIGTERM']]);
    });

    it('signals nothing when the target is not certain, and says why', async () => {
        const { stopBackgroundTask: real } = await vi.importActual<typeof import('./background-tasks-stop.js')>('./background-tasks-stop.js');
        const kills: number[] = [];
        const kill = (pid: number): void => { kills.push(pid); };
        const t: BackgroundTask = { id: 'a1', description: null, startedAt: null, outputPath: OUTPUT };
        expect(await real(t, 555, { probes: probes(), kill })).toBe('not_found');
        expect(await real(t, 100, { probes: probes({ writerPids: async () => [200] }), kill })).toBe('refused');
        expect(kills).toEqual([]);
    });

    it('reports a signal the system refused as kill_failed', async () => {
        const { stopBackgroundTask: real } = await vi.importActual<typeof import('./background-tasks-stop.js')>('./background-tasks-stop.js');
        const kill = (): void => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
        expect(await real({ id: 'a1', description: null, startedAt: null, outputPath: OUTPUT }, 100, { probes: probes(), kill })).toBe('kill_failed');
    });
});

describe.skipIf(!['/usr/sbin/lsof', '/usr/bin/lsof'].some((p) => existsSync(p)))('stopBackgroundTask on real processes — stop request', () => {
    it('ends a detached group writing a task output under this process, children too', async () => {
        const { stopBackgroundTask: real } = await vi.importActual<typeof import('./background-tasks-stop.js')>('./background-tasks-stop.js');
        const dir = mkdtempSync(join(tmpdir(), 'hwip-bg-real-'));
        const out = join(dir, 'tasks', 'x1.output');
        mkdirSync(join(dir, 'tasks'));
        // Like Claude's wrapper: a shell leading its own group, its output on the file, a child in the group.
        const wrapper = spawn('/bin/sh', ['-c', `exec > '${out}' 2>&1; sleep 30 & wait`], { detached: true, stdio: 'ignore' });
        try {
            await vi.waitFor(() => expect(existsSync(out)).toBe(true));
            await new Promise((r) => setTimeout(r, 200));
            const outcome = await real({ id: 'x1', description: null, startedAt: null, outputPath: out }, process.pid);
            expect(outcome).toBe('stopped');
            await vi.waitFor(() => expect(() => process.kill(-wrapper.pid!, 0)).toThrow(), { timeout: 3000 });
        } finally {
            try { process.kill(-wrapper.pid!, 'SIGKILL'); } catch { /* already gone */ }
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('handleBackgroundTaskStopRequest — stop request', () => {
    const phone = v2Party();
    type Wire = Record<string, unknown>;
    let sent: Wire[] = [];
    const send = (data: Wire): void => { sent.push(data); };
    let listenerKey = '';

    beforeAll(async () => {
        await initDeviceCrypto();
        listenerKey = getDevicePublicKey()!;
    });

    // A request id per test: the listener acts on each sealed request once.
    let next = 0;
    let rid = '';
    const body = (over: Record<string, unknown> = {}): string =>
        JSON.stringify({ v: 1, requestId: rid, taskId: 'a1', at: new Date().toISOString(), ...over });
    const frame = (over: Record<string, unknown> = {}, sealed: string = body(), context = 'hwip-api'): Wire => ({
        subtype: 'agent.task.stop.request',
        targetDeviceId: computeListenerDeviceId(),
        sessionName: 'hwip-api',
        requestId: rid,
        deviceId: 'dev_phone',
        subscriberPublicKey: phone.publicKey,
        encrypted: phone.seal('agent.task.stop', sealed, listenerKey, context),
        ...over,
    });
    const ask = async (msg: Wire): Promise<Wire> => {
        const before = sent.length;
        expect(handleBackgroundTaskStopRequest(msg as never, send)).toBe(true);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1]!;
    };
    const unpinnedTrust: SubscriberTrust = {
        ...trustEveryKey,
        admit: async ({ publicKey }) => (publicKey ? { kind: 'refuse', reason: 'subscriber_unverified' } : { kind: 'plain' }),
    };

    beforeEach(() => {
        rid = `r${next++}`;
        sent = [];
        stopped = [];
        outcome = 'stopped';
        setSubscriberTrust(trustEveryKey);
        recordBackgroundTasks({ 'hwip-api': { tasks: [{ id: 'a1', description: 'sleep', startedAt: null, outputPath: OUTPUT }], panePid: 100 } });
    });

    it('is not its business when it is another request, another machine, or lacks a request id or session', () => {
        expect(handleBackgroundTaskStopRequest({ subtype: 'agent.tasks.request' } as never, send)).toBe(false);
        expect(handleBackgroundTaskStopRequest(frame({ targetDeviceId: 'dev_other' }) as never, send)).toBe(false);
        expect(handleBackgroundTaskStopRequest(frame({ requestId: '' }) as never, send)).toBe(false);
        expect(handleBackgroundTaskStopRequest(frame({ sessionName: 42 }) as never, send)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('stops the task a sealed request from a trusted phone names, and says so', async () => {
        const reply = await ask(frame());
        expect(reply).toMatchObject({
            subtype: 'agent.task.stop.result', requestId: rid, sessionName: 'hwip-api', targetDeviceId: 'dev_phone', result: 'stopped',
        });
        expect(stopped).toEqual([{ outputPath: OUTPUT, panePid: 100 }]);
    });

    it('passes on what the stop found when it could not stop', async () => {
        outcome = 'ambiguous';
        expect(await ask(frame())).toMatchObject({ result: 'ambiguous' });
    });

    it('never stops on a plaintext request', async () => {
        expect(await ask(frame({ encrypted: undefined, subscriberPublicKey: undefined, taskId: 'a1' }))).toMatchObject({ error: 'e2ee_required' });
        expect(await ask(frame({ encrypted: undefined, taskId: 'a1' }))).toMatchObject({ error: 'bad_request' });
        expect(stopped).toEqual([]);
    });

    it('never stops for a key that does not check out', async () => {
        setSubscriberTrust(unpinnedTrust);
        expect(await ask(frame())).toMatchObject({ error: 'subscriber_unverified' });
        expect(stopped).toEqual([]);
    });

    it('never stops on an envelope for another session, or one whose request id or time does not match', async () => {
        expect(await ask(frame({}, body(), 'hwip-web'))).toMatchObject({ error: 'bad_request' });
        expect(await ask(frame({ requestId: 'other' }))).toMatchObject({ error: 'bad_request' });
        expect(await ask(frame({}, body({ at: '2026-01-01T00:00:00.000Z' })))).toMatchObject({ error: 'bad_request' });
        expect(stopped).toEqual([]);
    });

    it('never stops on a request sealed by another key under the phone\'s public key', async () => {
        // A relay knows the phone's public key and can put it in the frame; it cannot seal as the phone.
        const relay = v2Party();
        const forged = frame({ encrypted: relay.seal('agent.task.stop', body(), listenerKey, 'hwip-api') });
        expect(forged.subscriberPublicKey).toBe(phone.publicKey);
        expect(await ask(forged)).toMatchObject({ error: 'bad_request' });
        expect(stopped).toEqual([]);
    });

    it('refuses a task id that is not one, without looking it up', async () => {
        for (const [i, taskId] of ['../a1', 'a'.repeat(33), '', 7].entries()) {
            expect(await ask(frame({ requestId: `b${i}` }, body({ requestId: `b${i}`, taskId })))).toMatchObject({ error: 'bad_request' });
        }
        expect(stopped).toEqual([]);
    });

    it('answers not_found for a task the session does not run', async () => {
        expect(await ask(frame({}, body({ taskId: 'zz9' })))).toMatchObject({ result: 'not_found' });
        expect(stopped).toEqual([]);
    });

    it('does not act on the same sealed request twice', async () => {
        const msg = frame();
        await ask(msg);
        expect(await ask(msg)).toMatchObject({ error: 'bad_request' });
        expect(stopped).toHaveLength(1);
    });
});

