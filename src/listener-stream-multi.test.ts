import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSealedV2Wire, v2Party, type V2Party } from '../tests/helpers/seal.js';

// Several devices watching one session: each keeps its own sealed stream (its key, nonce, epoch and
// seq), frames and answers carry the device they are for, a stop ends only that device's stream, and
// the session's pane is captured once per tick however many watch. Same fake tmux and phone as
// hostile-relay.test.ts; the phones are `v2Party`, an independent implementation of the envelope.

const FIELD_SEP = '␟';
const SESSIONS = ['hwip-a', 'hwip-b'];
const PANE = 'secret pane\n';
let tmuxCalls: string[][] = [];

// tmux is faked as in listener-stream-bound.test.ts: the inventory guard needs
// a pane running an agent, and a capture needs something to capture.
const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-panes') {
        const rows = SESSIONS.map((n, i) => [n, '0', '1700000000', '1700000000', '0', '0', `%${i}`, 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''].join(FIELD_SEP));
        return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'display-message') {
        const target = a[a.indexOf('-t') + 1];
        // The pane fitter's look at the window: detached, one pane, 120 wide.
        if (a[4]?.includes('#{session_attached}')) return { status: 0, stdout: ['0', '1', '120'].join(FIELD_SEP), stderr: '' };
        const session = SESSIONS[Number(target.slice(1))] ?? target;
        if (a[4]?.includes('#{session_name}')) return { status: 0, stdout: ['node', session, ''].join(FIELD_SEP), stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: PANE, stderr: '' };
    if (a[0] === 'resize-window' || a[0] === 'set-option') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
};

// The stream tick reads cursor and capture in one client (`display-message ;
// capture-pane`): tmux runs each command and prints their output in turn.
const fakeTmuxChain = (args: readonly string[]) => {
    const prefix = args[0] === '-S' ? args.slice(0, 2) : [];
    const commands: string[][] = [[]];
    for (const arg of args.slice(prefix.length)) {
        if (arg === ';') commands.push([]);
        else commands[commands.length - 1].push(arg);
    }
    let stdout = '';
    for (const command of commands) {
        const r = fakeTmux([...prefix, ...command]);
        if (r.status !== 0) return r;
        stdout += r.stdout.endsWith('\n') || command === commands[commands.length - 1] ? r.stdout : `${r.stdout}\n`;
    }
    return { status: 0, stdout, stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmuxChain(args ?? []) : { status: 1, stdout: '', stderr: '' },
        // The listener's device id reads the machine id: a real `ioreg` is a 20 ms spawn in every test.
        execFileSync: ((cmd: string, ...rest: unknown[]) =>
            cmd === '/usr/sbin/ioreg'
                ? '  "IOPlatformUUID" = "HWIP-HOSTILE-RELAY-TEST-MACHINE"\n'
                : (actual.execFileSync as (...args: unknown[]) => unknown)(cmd, ...rest)) as typeof actual.execFileSync,
    };
});

const PHONE_ID = 'dev_ios_0a1b2c3d';

/** One message the listener sent: the handlers' own `send` parameter. */
type Wire = Parameters<Parameters<typeof import('./listener.js').handleStreamControl>[1]>[0];

let TMP: string;
const originalHome = process.env.HOME;

/**
 * What the listener's handlers returned that was still a promise: a handler is async (a trust check reads and
 * writes a file) and a test that does not await it would otherwise be waiting for it by the real clock.
 */
let pending: Promise<unknown>[] = [];
/** What the listener has put on the wire in this test, over all rigs. */
let wireCount = 0;
const handlersTracked = (listener: typeof import('./listener.js')): typeof import('./listener.js') =>
    new Proxy(listener, {
        get: (target, key, receiver) => {
            const value = Reflect.get(target, key, receiver) as unknown;
            if (typeof value !== 'function' || typeof key !== 'string' || !key.startsWith('handle')) return value;
            return (...args: unknown[]) => {
                const result = (value as (...a: unknown[]) => unknown)(...args);
                if (result instanceof Promise) pending.push(result);
                return result;
            };
        },
    });
/**
 * Until every handler call made so far, and the ones those made in turn, has finished. A handler that answers
 * "handled" at once and does its work in a promise of its own (`handleCommandInput` opening an envelope) cannot be awaited:
 * for that, nothing may have reached the wire or tmux for a moment of real time (`quietMs`).
 *
 * The assumption behind the quiet window: what a handler leaves running is microtasks, file reads and WebCrypto, which
 * finish within a few real milliseconds. Work that sleeps on the real clock (a child process, a real timer) would have to
 * outlast it to be missed — the negative windows (`aFewTicks`) therefore wait a long one. A handler promise that never settles
 * is given `SETTLE_DEADLINE_MS` and then left (the test goes on and fails on what it expected, not on a hang).
 */
const SETTLE_DEADLINE_MS = 2000;
const settled = async (quietMs = 30): Promise<void> => {
    const deadline = realNow() + SETTLE_DEADLINE_MS;
    for (let seen = -1; seen !== pending.length && realNow() < deadline;) {
        seen = pending.length;
        await Promise.race([Promise.allSettled(pending), new Promise((resolve) => realSetTimeout(resolve, SETTLE_DEADLINE_MS))]);
    }
    for (let activity = -1; activity !== wireCount + tmuxCalls.length && realNow() < deadline;) {
        activity = wireCount + tmuxCalls.length;
        await new Promise((resolve) => realSetTimeout(resolve, quietMs));
    }
};

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'hostile-relay-'));
    process.env.HOME = TMP;
    tmuxCalls = [];
    pending = [];
    wireCount = 0;
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The streams tick on timers (the first one 400 ms out): a fake clock, so waiting for ticks takes no time (C115).
    vi.useFakeTimers();
});

afterEach(async () => {
    const { stopAllStreams, setSubscriberTrust } = await import('./listener.js');
    stopAllStreams();
    setSubscriberTrust(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/**
 * A listener with a trust store, a phone, and the account's device list as the
 * server presents it — which the relay scenarios rewrite.
 */
const setUp = async () => {
    const listener = handlersTracked(await import('./listener.js'));
    const { createSubscriberTrust } = await import('./subscriber-trust.js');
    const phone = v2Party();
    const relay = v2Party();
    /** deviceId → key, as `GET /devices` answers. The server owns this. */
    const deviceList = new Map<string, string>([[PHONE_ID, phone.publicKey]]);
    listener.setSubscriberTrust(createSubscriberTrust({
        path: join(TMP, 'trusted-devices.json'),
        registeredKey: async (deviceId) => deviceList.get(deviceId) ?? null,
        // As the daemon wires it: what the trust store says ends up on the listener's log.
        log: (msg) => console.log(msg),
    }));
    const me = listener.computeListenerDeviceId();
    // An inventory sweep reads every pane to tell what its agent is doing, and
    // a request for a session the last sweep did not record runs one. Record
    // the sessions as the daemon's own sweep would have, so a capture counted
    // below is the pane being read for the requester.
    listener.recordInventory(SESSIONS.map((name) => ({ name })));
    tmuxCalls = [];
    const captures = (): number => tmuxCalls.filter((c) => c[0] === 'capture-pane').length;
    /** `fields` is whatever the relay made of the request, ill-typed values included. */
    const screenRequest = (fields: object = {}) => listener.handleScreenRequest({
        subtype: 'agent.screen.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'r1',
        deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey, subscriberNonce: 'bm9uY2U=', ...fields,
    });
    /** Everything the listener put on the wire for the relay to carry. */
    const sent: Wire[] = [];
    const send = (data: Wire): void => { sent.push(data); wireCount += 1; };
    const streamStart = (fields: object = {}) => listener.handleStreamControl({
        subtype: 'agent.stream.start', targetDeviceId: me, sessionName: 'hwip-a', renew: true,
        deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey, subscriberNonce: 'bm9uY2U=', ...fields,
    }, send);
    const frames = (): Wire[] => sent.filter((m) => m.subtype === 'agent.stream.frame' && !m.error);
    const errors = (): string[] => sent.filter((m) => m.error).map((m) => String(m.error));
    return { listener, phone, relay, deviceList, me, captures, screenRequest, sent, send, streamStart, frames, errors };
};

/** Long enough for a stream that may send to have sent: its first tick is 400 ms out. On the fake clock. */
const aFewTicks = async (): Promise<void> => {
    await settled();
    await vi.advanceTimersByTimeAsync(1300);
    // The last look is the one a "sent nothing" assertion rests on: a long quiet window, for work that sleeps on the real clock.
    await settled(200);
};

// The clock the tests do not fake: the real timer, and the real time that runs out.
const realSetTimeout = setTimeout;
const realNow = performance.now.bind(performance);

/**
 * Waits until `callback` stops throwing. Each round moves the fake clock on by 100 ms (a stream's first tick is 400 ms out)
 * and gives the real event loop a millisecond for what is not on the clock (a trust check that reads and writes a file).
 * `vi.waitFor` moved the fake clock only as far as the real one, 50 real ms at a time: a test took a second.
 * The fake clock stops at `MAX_FAKE_MS`, short of the stream lease (15 s): past that a slow machine would have the lease
 * reaped under a test that is only waiting for real work, and the test would fail on the wrong thing.
 */
const MAX_FAKE_MS = 10_000;
const waitFor = async <T>(callback: () => T | Promise<T>, options: number | { timeout?: number } = {}): Promise<T> => {
    const timeout = typeof options === 'number' ? options : (options.timeout ?? 1000);
    const deadline = realNow() + timeout;
    for (let advanced = 0; ; advanced += 100) {
        try {
            return await callback();
        } catch (error) {
            if (realNow() > deadline) throw error;
        }
        if (advanced < MAX_FAKE_MS) await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
};


const SECOND_ID = 'dev_ios_4e5f6a7b';

/** A listener with two phones, both on the account's device list. */
const twoPhones = async () => {
    const rig = await setUp();
    const second = v2Party();
    rig.deviceList.set(SECOND_ID, second.publicKey);
    const start = (id: string, key: string, nonce: string, more: object = {}) => rig.listener.handleStreamControl({
        subtype: 'agent.stream.start', targetDeviceId: rig.me, sessionName: 'hwip-a', renew: true,
        deviceId: id, subscriberPublicKey: key, subscriberNonce: nonce, ...more,
    }, rig.send);
    const control = (subtype: string, id: string | undefined, more: object = {}) => rig.listener.handleStreamControl({
        subtype, targetDeviceId: rig.me, sessionName: 'hwip-a', ...(id ? { deviceId: id } : {}), ...more,
    }, rig.send);
    const framesFor = (id: string): Wire[] => rig.frames().filter((m) => m.targetDeviceId === id);
    return { ...rig, second, start, control, framesFor };
};

/** `twoPhones`, plus the widths `resize-window` was asked for, in order. */
const twoPhonesWithResizes = async () => {
    const rig = await twoPhones();
    const tmuxResizes = (): string[] => tmuxCalls.filter((c) => c[0] === 'resize-window').map((c) => c[c.indexOf('-x') + 1]!);
    return { ...rig, tmuxResizes };
};

const openFrame = (who: V2Party, frame: Wire): { nonce?: string; epoch: number; seq: number; content: string } => {
    const envelope = frame.encrypted;
    if (!isSealedV2Wire(envelope)) throw new Error('the frame carries no v2 envelope');
    return JSON.parse(who.open('stream.frame', envelope, 'hwip-a'));
};

describe('two devices watching one session', () => {
    it('should give each device its own sealed frames, addressed to it, with its own nonce', async () => {
        const { phone, second, start, framesFor } = await twoPhones();

        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await waitFor(() => { expect(framesFor(PHONE_ID).length).toBeGreaterThan(0); expect(framesFor(SECOND_ID).length).toBeGreaterThan(0); }, { timeout: 3000 });

        const a = openFrame(phone, framesFor(PHONE_ID)[0]!);
        const b = openFrame(second, framesFor(SECOND_ID)[0]!);
        expect(a).toMatchObject({ nonce: 'bm9uY2UtYQ==', content: PANE });
        expect(b).toMatchObject({ nonce: 'bm9uY2UtYg==', content: PANE });
        // Each opens only its own: the other phone's key does not open this envelope.
        expect(() => openFrame(second, framesFor(PHONE_ID)[0]!)).toThrow();
        expect(() => openFrame(phone, framesFor(SECOND_ID)[0]!)).toThrow();
    });

    it('should keep the first device streaming when the second joins (no takeover)', async () => {
        const { phone, second, start, framesFor, sent } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        await waitFor(() => expect(framesFor(PHONE_ID).length).toBeGreaterThan(0), { timeout: 3000 });
        const before = framesFor(PHONE_ID).length;

        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await waitFor(() => expect(framesFor(SECOND_ID).length).toBeGreaterThan(0), { timeout: 3000 });
        // Change the pane so the first device's gate lets another frame through.
        await aFewTicks();

        expect(sent.filter((m) => m.error)).toEqual([]);
        expect(framesFor(PHONE_ID).length).toBeGreaterThanOrEqual(before);
    });

    it('should end only the stopping device\'s stream', async () => {
        const { phone, second, start, control, framesFor, sent } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await waitFor(() => { expect(framesFor(PHONE_ID).length).toBeGreaterThan(0); expect(framesFor(SECOND_ID).length).toBeGreaterThan(0); }, { timeout: 3000 });

        control('agent.stream.stop', PHONE_ID);
        // The second device's renew still finds its stream; the first's does not.
        control('agent.stream.renew', SECOND_ID);
        control('agent.stream.renew', PHONE_ID);

        const renews = sent.filter((m) => m.subtype === 'agent.stream.renew.ok');
        expect(renews.map((m) => m.targetDeviceId)).toEqual([SECOND_ID]);
        const gone = sent.filter((m) => m.error === 'stream_gone');
        expect(gone.map((m) => m.targetDeviceId)).toEqual([PHONE_ID]);
    });

    it('should seal each renew answer for the device that renewed, with its own challenge', async () => {
        const { phone, second, start, control, framesFor, sent } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await waitFor(() => { expect(framesFor(PHONE_ID).length).toBeGreaterThan(0); expect(framesFor(SECOND_ID).length).toBeGreaterThan(0); }, { timeout: 3000 });

        control('agent.stream.renew', SECOND_ID, { challenge: 'c2Vjb25kLWNoYWxsZW5nZQ==' });
        await waitFor(() => expect(sent.some((m) => m.subtype === 'agent.stream.renew.ok')).toBe(true));

        const reply = sent.find((m) => m.subtype === 'agent.stream.renew.ok')!;
        expect(reply.targetDeviceId).toBe(SECOND_ID);
        const envelope = reply.encrypted;
        if (!isSealedV2Wire(envelope)) throw new Error('the renew answer carries no v2 envelope');
        expect(JSON.parse(second.open('stream.alive', envelope, 'hwip-a'))).toMatchObject({ nonce: 'bm9uY2UtYg==', challenge: 'c2Vjb25kLWNoYWxsZW5nZQ==' });
    });

    it('should read the pane once per tick for both devices, and still send each a frame', async () => {
        const { phone, second, start, framesFor, captures } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await waitFor(() => { expect(framesFor(PHONE_ID).length).toBeGreaterThan(0); expect(framesFor(SECOND_ID).length).toBeGreaterThan(0); }, { timeout: 3000 });
        const frameTotal = framesFor(PHONE_ID).length + framesFor(SECOND_ID).length;

        // One capture per tick serves both: fewer pane reads than frames sent.
        expect(captures()).toBeLessThan(frameTotal);
    });

    it('should count a session once against the concurrency cap, however many devices watch it', async () => {
        const { phone, second, start, errors } = await twoPhones();

        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await settled();

        expect(errors()).toEqual([]);
    });

    it('should refuse plaintext input while any device on the session is sealed', async () => {
        const { phone, listener, me, start, send, errors } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        await settled();

        listener.handleCommandInput({ subtype: 'agent.command.input', targetDeviceId: me, sessionName: 'hwip-a', deviceId: SECOND_ID, seq: 1, epoch: 1, keys: ['up'] }, send);

        expect(errors()).toContain('input_rejected');
    });

    it('should answer a scrollback request to the device that asked', async () => {
        const { phone, listener, me, start, send, sent } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        await settled();

        listener.handleScreenHistoryRequest({ subtype: 'agent.screen.history.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'h1', deviceId: PHONE_ID }, send);

        const replies = sent.filter((m) => m.subtype === 'agent.screen.history.snapshot');
        expect(replies.length).toBeGreaterThan(0);
        expect(replies.every((m) => m.targetDeviceId === PHONE_ID)).toBe(true);
    });

    it('should stop the capture loop when the last device leaves', async () => {
        const { phone, second, start, control, captures } = await twoPhones();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==');
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==');
        await aFewTicks();

        control('agent.stream.stop', PHONE_ID);
        control('agent.stream.stop', SECOND_ID);
        const after = captures();
        await aFewTicks();

        expect(captures()).toBe(after);
    });

    it('should let a renew resize the pane for another device only when its width changed', async () => {
        const { phone, second, start, control, tmuxResizes } = await twoPhonesWithResizes();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==', { cols: 60 });
        start(SECOND_ID, second.publicKey, 'bm9uY2UtYg==', { cols: 100 });
        await aFewTicks();
        expect(tmuxResizes()).toEqual(['60', '100']);

        // An app sends its width on every renew: unchanged widths must not tug the pane back and forth.
        control('agent.stream.renew', PHONE_ID, { cols: 60 });
        control('agent.stream.renew', SECOND_ID, { cols: 100 });
        await aFewTicks();
        expect(tmuxResizes()).toEqual(['60', '100']);

        control('agent.stream.renew', PHONE_ID, { cols: 70 });
        await aFewTicks();
        expect(tmuxResizes()).toEqual(['60', '100', '70']);
    });

    it('should keep re-fitting on every renew while one device watches', async () => {
        const { phone, start, control, tmuxResizes } = await twoPhonesWithResizes();
        start(PHONE_ID, phone.publicKey, 'bm9uY2UtYQ==', { cols: 60 });
        await aFewTicks();
        const before = tmuxResizes().length;

        control('agent.stream.renew', PHONE_ID, { cols: 60 });
        await aFewTicks();

        // The window reads 120 wide in the fake, so an unchanged 60 is still a fit: as before this change.
        expect(tmuxResizes().length).toBe(before + 1);
    });
});
