/**
 * The phone reading the end of a background command's output
 * (`agent.task.output.request`). Two halves: which file may be read and what
 * of it (`readTaskOutputTail`, on real files in a temporary directory), and
 * the request handler that admits the request and seals the answer.
 */

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { trustEveryKey } from '../tests/helpers/trust.js';
import type { SubscriberTrust } from './subscriber-trust.js';
import type { BackgroundTask } from './background-tasks.js';
import { TASK_OUTPUT_TAIL_BYTES, fitTaskOutputBody, readTaskOutputTail } from './background-tasks-output.js';

const TMP = mkdtempSync(join(tmpdir(), 'hwip-bg-output-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleBackgroundTaskOutputRequest, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
const { recordBackgroundTasks } = await import('./background-tasks.js');
const { initDeviceCrypto } = await import('./crypto.js');

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const TASKS = join(TMP, 'claude', 'session', 'tasks');
mkdirSync(TASKS, { recursive: true });
const task = (id: string, outputPath = join(TASKS, `${id}.output`)): BackgroundTask => ({ id, description: null, startedAt: null, outputPath });

describe('readTaskOutputTail — output request file', () => {
    it('reads a whole small file', async () => {
        writeFileSync(join(TASKS, 'a1.output'), 'ready on :3000\n');
        expect(await readTaskOutputTail(task('a1'))).toEqual({ text: 'ready on :3000\n', size: 15, truncated: false });
    });

    it('reads only the last 16 KB of a larger file, starting on a whole character', async () => {
        // 'é' is two bytes: the cut lands inside one, which is dropped rather than shown broken.
        const body = `${'x'.repeat(10)}${'é'.repeat(TASK_OUTPUT_TAIL_BYTES)}END`;
        writeFileSync(join(TASKS, 'b2.output'), body);
        const tail = await readTaskOutputTail(task('b2'));
        if (!('text' in tail)) throw new Error(`no text: ${JSON.stringify(tail)}`);
        expect(tail.truncated).toBe(true);
        expect(tail.size).toBe(Buffer.byteLength(body));
        expect(tail.text.endsWith('END')).toBe(true);
        expect(tail.text).not.toContain('�');
        expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(TASK_OUTPUT_TAIL_BYTES);
        expect(Buffer.byteLength(tail.text)).toBeGreaterThan(TASK_OUTPUT_TAIL_BYTES - 4);
    });

    it('refuses a path that is not a tasks/<id>.output file for this task', async () => {
        writeFileSync(join(TMP, 'secret.txt'), 'token=abc');
        expect(await readTaskOutputTail(task('c3', join(TMP, 'secret.txt')))).toEqual({ error: 'path_refused' });
        writeFileSync(join(TASKS, 'other.output'), 'x');
        expect(await readTaskOutputTail(task('c3', join(TASKS, 'other.output')))).toEqual({ error: 'path_refused' });
    });

    it('refuses a symlink that leads out of the tasks directory', async () => {
        symlinkSync(join(TMP, 'secret.txt'), join(TASKS, 'd4.output'));
        expect(await readTaskOutputTail(task('d4'))).toEqual({ error: 'path_refused' });
    });

    it('refuses a hard link to another file, which has the output\'s real path too', async () => {
        linkSync(join(TMP, 'secret.txt'), join(TASKS, 'h8.output'));
        expect(await readTaskOutputTail(task('h8'))).toEqual({ error: 'path_refused' });
    });

    it('drops a character the command has not finished writing at the end', async () => {
        writeFileSync(join(TASKS, 'i9.output'), Buffer.concat([Buffer.from('done '), Buffer.from('é').subarray(0, 1)]));
        expect(await readTaskOutputTail(task('i9'))).toEqual({ text: 'done ', size: 6, truncated: false });
    });

    it('refuses a directory named like an output, and says a missing file is gone', async () => {
        mkdirSync(join(TASKS, 'e5.output'));
        expect(await readTaskOutputTail(task('e5'))).toEqual({ error: 'path_refused' });
        expect(await readTaskOutputTail(task('f6'))).toEqual({ error: 'not_found' });
    });
});

describe('fitTaskOutputBody — output request frame', () => {
    const head = { requestId: 'r1', at: '2026-11-11T07:00:00.000Z', taskId: 'a1' };

    it('keeps a body that fits as it is', () => {
        expect(JSON.parse(fitTaskOutputBody(head, { text: 'ok\n', size: 3, truncated: false }, 20 * 1024)))
            .toEqual({ v: 1, ...head, text: 'ok\n', size: 3, truncated: false });
    });

    it('cuts a coloured log from the top until its JSON fits, keeping the newest lines', () => {
        const line = (n: number): string => `\u001b[32m\u001b[1mok\u001b[0m test ${n}\n`;
        const text = Array.from({ length: 800 }, (_, n) => line(n)).join('');
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TASK_OUTPUT_TAIL_BYTES + 4096);
        const body = fitTaskOutputBody(head, { text, size: 99_000, truncated: true }, 20 * 1024);
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(20 * 1024);
        const opened = JSON.parse(body) as { text: string; truncated: boolean; size: number };
        expect(opened.text.endsWith(line(799))).toBe(true);
        expect(opened.text.startsWith('\u001b[32m')).toBe(true);
        expect(opened).toMatchObject({ truncated: true, size: 99_000 });
    });

    it('cuts one runaway line too', () => {
        const body = fitTaskOutputBody(head, { text: '\u001b'.repeat(8000), size: 8000, truncated: false }, 4 * 1024);
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4 * 1024);
        expect(JSON.parse(body)).toMatchObject({ truncated: true });
    });
});

describe('handleBackgroundTaskOutputRequest — output request', () => {
    const phone = v2Party();
    type Wire = Record<string, unknown>;
    let sent: Wire[] = [];
    const send = (data: Wire): void => { sent.push(data); };

    beforeAll(async () => { await initDeviceCrypto(); });

    const frame = (over: Wire = {}): Wire => ({
        subtype: 'agent.task.output.request',
        targetDeviceId: computeListenerDeviceId(),
        sessionName: 'hwip-api',
        requestId: 'r1',
        taskId: 'g7',
        deviceId: 'dev_phone',
        subscriberPublicKey: phone.publicKey,
        ...over,
    });
    const ask = async (msg: Wire): Promise<Wire> => {
        const before = sent.length;
        expect(handleBackgroundTaskOutputRequest(msg as never, send)).toBe(true);
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 5000 });
        return sent[sent.length - 1]!;
    };
    const opened = (reply: Wire, session = 'hwip-api'): Record<string, unknown> =>
        JSON.parse(phone.open('agent.task.output', reply.encrypted as Parameters<typeof phone.open>[1], session)) as Record<string, unknown>;
    const unpinnedTrust: SubscriberTrust = {
        ...trustEveryKey,
        admit: async ({ publicKey }) => (publicKey ? { kind: 'refuse', reason: 'subscriber_unverified' } : { kind: 'plain' }),
    };

    beforeEach(() => {
        sent = [];
        setSubscriberTrust(trustEveryKey);
        writeFileSync(join(TASKS, 'g7.output'), 'compiled 12 files\n');
        recordBackgroundTasks({ 'hwip-api': { tasks: [task('g7')], panePid: 100 } });
    });

    it('is not its business when it is another request, another machine, or lacks a request id or session', () => {
        expect(handleBackgroundTaskOutputRequest({ subtype: 'agent.tasks.request' } as never, send)).toBe(false);
        expect(handleBackgroundTaskOutputRequest(frame({ targetDeviceId: 'dev_other' }) as never, send)).toBe(false);
        expect(handleBackgroundTaskOutputRequest(frame({ requestId: '' }) as never, send)).toBe(false);
        expect(handleBackgroundTaskOutputRequest(frame({ sessionName: 42 }) as never, send)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('seals the end of the output for the asking phone, bound to the session, the request and the task', async () => {
        const reply = await ask(frame());
        expect(reply).toMatchObject({ subtype: 'agent.task.output.result', requestId: 'r1', sessionName: 'hwip-api', targetDeviceId: 'dev_phone' });
        expect(Object.keys(reply).sort()).toEqual(['at', 'encrypted', 'requestId', 'sessionName', 'subtype', 'targetDeviceId']);
        expect(opened(reply)).toEqual({ v: 1, requestId: 'r1', at: reply.at, taskId: 'g7', text: 'compiled 12 files\n', size: 18, truncated: false });
        expect(JSON.stringify(reply)).not.toContain('compiled');
    });

    it('never answers in the clear, nor to a key that does not check out', async () => {
        expect(await ask(frame({ subscriberPublicKey: undefined }))).toMatchObject({ error: 'e2ee_required' });
        setSubscriberTrust(unpinnedTrust);
        const refused = await ask(frame());
        expect(refused).toMatchObject({ error: 'subscriber_unverified' });
        expect(JSON.stringify(refused)).not.toContain('compiled');
    });

    it('answers not_found for a task the session does not run, and bad_request for an id that is not one', async () => {
        expect(await ask(frame({ taskId: 'zz9' }))).toMatchObject({ error: 'not_found' });
        expect(await ask(frame({ taskId: '../g7' }))).toMatchObject({ error: 'bad_request' });
        expect(await ask(frame({ taskId: 7 }))).toMatchObject({ error: 'bad_request' });
    });

    it('passes on a refused path as an error, with nothing read', async () => {
        recordBackgroundTasks({ 'hwip-api': { tasks: [task('g7', join(TMP, 'secret.txt'))], panePid: 100 } });
        const reply = await ask(frame());
        expect(reply).toMatchObject({ error: 'path_refused' });
        expect(JSON.stringify(reply)).not.toContain('token');
    });
});
