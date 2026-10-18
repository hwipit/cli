import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSealedV2Wire, mirroredPublicKey, v2Party, type V2Party } from '../tests/helpers/seal.js';

// A relay that does more than relay. Each scenario plays the server between a
// phone and this listener doing one thing an honest relay never would — swap a
// key, strip one, hand a message back — and checks that the listener refuses,
// and that no pane text left it in a form the relay can read.
//
// The phone is `v2Party`: an independent implementation of the envelope, so
// "the phone can open it" is a statement about the wire format.

const FIELD_SEP = '␟';
const SESSIONS = ['hwip-a', 'hwip-b'];
const PANE = 'secret pane\n';
let tmuxCalls: string[][] = [];
/** How often the listener started git: a refused diff request must not. */
let gitRuns = 0;

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
        const session = SESSIONS[Number(target.slice(1))] ?? target;
        if (a[4]?.includes('#{session_name}')) return { status: 0, stdout: ['node', session, ''].join(FIELD_SEP), stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: PANE, stderr: '' };
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
        spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'git') gitRuns += 1;
            return cmd === 'tmux' ? fakeTmuxChain(args ?? []) : { status: 1, stdout: '', stderr: '' };
        },
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
    gitRuns = 0;
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

/** What `who` reads in a sealed reply; throws when there is no envelope or it does not open. */
const openSnapshot = (who: V2Party, reply: object | null, session = 'hwip-a'): object => {
    const envelope = reply && 'encrypted' in reply ? reply.encrypted : undefined;
    if (!isSealedV2Wire(envelope)) throw new Error('the reply carries no v2 envelope');
    const sealed: unknown = JSON.parse(who.open('screen.snapshot', envelope, session));
    if (typeof sealed !== 'object' || sealed === null) throw new Error('the envelope holds no object');
    return sealed;
};

describe('hostile relay — a screen snapshot request', () => {
    it('should seal the snapshot for the phone and bind it to the request', async () => {
        const { phone, screenRequest } = await setUp();

        const reply = await screenRequest();

        expect(reply).not.toHaveProperty('content');
        expect(reply).not.toHaveProperty('error');
        expect(JSON.stringify(reply)).not.toContain('secret pane');
        expect(openSnapshot(phone, reply)).toEqual({
            requestId: 'r1', sessionName: 'hwip-a', nonce: 'bm9uY2U=', capturedAt: reply?.capturedAt, content: PANE, truncated: false,
        });
        expect(reply?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should not be openable by the relay', async () => {
        const { relay, screenRequest } = await setUp();

        const reply = await screenRequest();

        expect(reply).toHaveProperty('encrypted');
        expect(() => openSnapshot(relay, reply)).toThrow();
    });

    it('should not open as a snapshot of another session', async () => {
        const { phone, screenRequest } = await setUp();

        const reply = await screenRequest();

        expect(openSnapshot(phone, reply, 'hwip-a')).toMatchObject({ sessionName: 'hwip-a' });
        expect(() => openSnapshot(phone, reply, 'hwip-b')).toThrow();
    });

    it('should send an error and no pane when the seal fails', async () => {
        // Spelled like a device key, but its 64 coordinate bytes are no point on
        // the curve: the trust check passes (the account "registered" it), the
        // seal cannot be made.
        const { deviceList, screenRequest } = await setUp();
        const offCurve = Buffer.concat([
            Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
            Buffer.from([0x04]),
            Buffer.alloc(64, 0x11),
        ]).toString('base64');
        deviceList.set(PHONE_ID, offCurve);

        const reply = await screenRequest({ subscriberPublicKey: offCurve });

        expect(reply).toMatchObject({ requestId: 'r1', error: 'encrypt_failed' });
        expect(reply).not.toHaveProperty('content');
        expect(reply).not.toHaveProperty('encrypted');
        expect(JSON.stringify(reply)).not.toContain('secret pane');
    });

    it.each([
        ['with control characters', 'dev_ios_0a1b2c3d\n\u001b[2J'],
        ['with a shell command in it', 'x; rm -rf ~'],
        ['of relay size', 'd'.repeat(5000)],
    ])('should not seal for a device id %s, and not print it', async (_what, deviceId) => {
        const { relay, deviceList, captures, screenRequest } = await setUp();
        deviceList.set(deviceId, relay.publicKey);
        const logged = vi.mocked(console.log);
        logged.mockClear();

        const reply = await screenRequest({ deviceId, subscriberPublicKey: relay.publicKey });

        expect(reply).toMatchObject({ error: 'subscriber_unverified' });
        expect(captures()).toBe(0);
        expect(logged.mock.calls.flat().join('\n')).not.toContain(deviceId);
    });

    it('should ignore a request whose id is of relay size', async () => {
        const { captures, screenRequest } = await setUp();

        expect(await screenRequest({ requestId: 'r'.repeat(129) })).toBeNull();
        expect(await screenRequest({ requestId: 7 })).toBeNull();
        expect(captures()).toBe(0);
    });

    it('should not seal for a key the relay put in place of the phone\'s', async () => {
        const { relay, captures, screenRequest } = await setUp();

        const reply = await screenRequest({ subscriberPublicKey: relay.publicKey });

        expect(reply).toMatchObject({ error: 'subscriber_unverified' });
        expect(reply).not.toHaveProperty('encrypted');
        expect(reply).not.toHaveProperty('content');
        // Refused before the pane was read.
        expect(captures()).toBe(0);
    });

    it('should not seal for a device the relay made up', async () => {
        const { relay, captures, screenRequest } = await setUp();

        const reply = await screenRequest({ deviceId: 'dev_ios_deadbeef', subscriberPublicKey: relay.publicKey });

        expect(reply).toMatchObject({ error: 'subscriber_unverified' });
        expect(captures()).toBe(0);
    });

    // A key the account lists for a pinned device is followed: a reinstalled phone has to work without a trip to this
    // computer. What the pin no longer does is stop a relay that rewrites the device list — it says so in the log, once.
    it('should seal for the key the account now lists for the phone, replace the pin and say so', async () => {
        const { relay, deviceList, screenRequest } = await setUp();
        await screenRequest(); // the phone, pinned on first use
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        deviceList.set(PHONE_ID, relay.publicKey);
        const reply = await screenRequest({ requestId: 'r2', subscriberPublicKey: relay.publicKey });

        expect(reply).toMatchObject({ requestId: 'r2' });
        expect(reply).not.toHaveProperty('error');
        expect(reply).toHaveProperty('encrypted');
        expect(JSON.parse(readFileSync(join(TMP, 'trusted-devices.json'), 'utf-8')).devices[PHONE_ID].publicKey).toBe(relay.publicKey);
        expect(log.mock.calls.flat().filter((line) => String(line).includes('changed its key'))).toHaveLength(1);
        log.mockRestore();
    });

    it('should not seal for a key the account does not list, whatever the pin says', async () => {
        const { relay, captures, screenRequest } = await setUp();
        await screenRequest();
        const before = captures();

        const reply = await screenRequest({ requestId: 'r2', subscriberPublicKey: relay.publicKey });

        expect(reply).toMatchObject({ requestId: 'r2', error: 'subscriber_unverified' });
        expect(reply).not.toHaveProperty('encrypted');
        expect(captures()).toBe(before);
    });

    it('should not answer in the clear once it has sealed, when the relay strips the key', async () => {
        const { captures, screenRequest } = await setUp();
        await screenRequest();
        const before = captures();

        for (const stripped of [{ subscriberPublicKey: undefined }, { subscriberPublicKey: '' }, { subscriberPublicKey: 42 }]) {
            const reply = await screenRequest({ requestId: 'r2', ...stripped });

            expect(reply).toMatchObject({ requestId: 'r2', error: 'e2ee_required' });
            expect(reply).not.toHaveProperty('content');
        }
        expect(captures()).toBe(before);
    });

    it('should still answer a plaintext request while it has never sealed', async () => {
        // The pre-E2E viewer: no key anywhere, no history of sealing.
        const { screenRequest } = await setUp();

        const reply = await screenRequest({ subscriberPublicKey: undefined, subscriberNonce: undefined });

        expect(reply).toMatchObject({ requestId: 'r1', content: PANE });
    });

    it('should seal nothing in a process that has no device list to check against', async () => {
        const { listener, screenRequest } = await setUp();
        listener.setSubscriberTrust(null);

        expect(await screenRequest()).toMatchObject({ error: 'subscriber_unverified' });
    });
});

describe('hostile relay — the snapshots after a key press', () => {
    const afterKeyPress = async (listener: typeof import('./listener.js')): Promise<object[]> => {
        const sent: object[] = [];
        listener.scheduleInjectSnapshots('hwip-a', (d) => sent.push(d), [0]);
        await vi.advanceTimersByTimeAsync(20);
        return sent;
    };

    it('should send none once the listener only seals: nobody asked, so there is no key to seal for', async () => {
        const { listener, captures, screenRequest } = await setUp();
        await screenRequest();
        const before = captures();

        expect(await afterKeyPress(listener)).toEqual([]);
        expect(captures()).toBe(before);
    });

    it('should send none when the first seal lands between the key press and the snapshot', async () => {
        const { listener, screenRequest } = await setUp();
        const sent: object[] = [];

        listener.scheduleInjectSnapshots('hwip-a', (d) => sent.push(d), [40]);
        await screenRequest();
        await vi.advanceTimersByTimeAsync(80);

        expect(sent).toEqual([]);
    });

    it('should still send them while the listener has never sealed', async () => {
        const { listener } = await setUp();

        expect(await afterKeyPress(listener)).toMatchObject([{ subtype: 'agent.screen.snapshot', sessionName: 'hwip-a', content: PANE }]);
    });
});

describe('hostile relay — a swapped key on a stream subscription', () => {
    it('should stream sealed frames to the phone, and nothing in the clear', async () => {
        const { streamStart, frames, errors } = await setUp();

        streamStart();
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        expect(errors()).toEqual([]);
        for (const frame of frames()) {
            expect(frame).toHaveProperty('encrypted');
            expect(frame).not.toHaveProperty('content');
            expect(JSON.stringify(frame)).not.toContain('secret pane');
        }
    });

    it('should send no frame for a key the relay put in place of the phone\'s', async () => {
        const { relay, streamStart, frames, errors, captures } = await setUp();

        streamStart({ subscriberPublicKey: relay.publicKey });
        await aFewTicks();

        expect(errors()).toEqual(['subscriber_unverified']);
        expect(frames()).toEqual([]);
        expect(captures()).toBe(0);
    });

    it('should follow the device list to a new key for the phone', async () => {
        const { relay, deviceList, streamStart, frames, errors, sent, captures, listener } = await setUp();
        streamStart(); // the phone, pinned on first use
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });
        listener.stopAllStreams();
        sent.length = 0;
        const before = captures();

        deviceList.set(PHONE_ID, relay.publicKey);
        streamStart({ subscriberPublicKey: relay.publicKey });
        await aFewTicks();

        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });
        expect(errors()).toEqual([]);
        expect(captures()).toBeGreaterThan(before);
    });

    it('should send no frame when the relay names no device, or one of its own making', async () => {
        const { relay, streamStart, frames, errors } = await setUp();

        streamStart({ deviceId: undefined });
        await aFewTicks();
        streamStart({ deviceId: 'dev_ios_deadbeef', subscriberPublicKey: relay.publicKey });
        await aFewTicks();

        expect(errors()).toEqual(['subscriber_unverified', 'subscriber_unverified']);
        expect(frames()).toEqual([]);
    });

    it('should read nothing off the pane while the key is still being checked', async () => {
        const { listener, phone, me, sent, send, captures } = await setUp();
        const { createSubscriberTrust } = await import('./subscriber-trust.js');
        // A device list that takes its time, as a slow API does.
        let answer: (key: string | null) => void = () => {};
        listener.setSubscriberTrust(createSubscriberTrust({
            path: join(TMP, 'trusted-devices.json'),
            registeredKey: () => new Promise((resolve) => { answer = resolve; }),
            log: () => {},
        }));
        const start = { subtype: 'agent.stream.start', targetDeviceId: me, sessionName: 'hwip-a', renew: true, deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey };

        listener.handleStreamControl(start, send);
        await aFewTicks();

        expect(sent).toEqual([]);
        expect(captures()).toBe(0);
        // Sealed input and scrollback wait for the same answer.
        listener.handleCommandInput({
            subtype: 'agent.command.input', targetDeviceId: me, sessionName: 'hwip-a', seq: 1, epoch: 1,
            encrypted: { ciphertext: 'x', iv: 'x', encryptedKey: 'x', keyIv: 'x', senderPublicKey: phone.publicKey },
        }, send);
        listener.handleScreenHistoryRequest({ subtype: 'agent.screen.history.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'h1' }, send);
        expect(sent.map((m) => m.error)).toEqual(['input_rejected', 'no_stream']);

        answer(phone.publicKey);
        await waitFor(() => expect(sent.some((m) => m.encrypted)).toBe(true), { timeout: 3000 });
    });

    it('should drop the answer for a stream that was stopped while its key was being checked', async () => {
        const { listener, phone, me, sent, send } = await setUp();
        const { createSubscriberTrust } = await import('./subscriber-trust.js');
        let answer: (key: string | null) => void = () => {};
        listener.setSubscriberTrust(createSubscriberTrust({
            path: join(TMP, 'trusted-devices.json'),
            registeredKey: () => new Promise((resolve) => { answer = resolve; }),
            log: () => {},
        }));

        listener.handleStreamControl({ subtype: 'agent.stream.start', targetDeviceId: me, sessionName: 'hwip-a', renew: true, deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey }, send);
        listener.handleStreamControl({ subtype: 'agent.stream.stop', targetDeviceId: me, sessionName: 'hwip-a' }, send);
        answer(null);
        await aFewTicks();

        // Neither a frame nor an error for a stream nobody is waiting on.
        expect(sent).toEqual([]);
    });
});

describe('hostile relay — a renew on a sealed stream', () => {
    const renewOks = (sent: Wire[]): Wire[] => sent.filter((m) => m.subtype === 'agent.stream.renew.ok');
    const renewing = async (fields: object) => {
        const rig = await setUp();
        const renew = (more: object = {}) => rig.listener.handleStreamControl({
            subtype: 'agent.stream.renew', targetDeviceId: rig.me, sessionName: 'hwip-a', ...fields, ...more,
        }, rig.send);
        return { ...rig, renew };
    };

    it('should answer with a sealed alive naming the challenge and the last frame it sent', async () => {
        const { phone, streamStart, frames, sent, renew } = await renewing({ challenge: 'Y2hhbGxlbmdlLW9uZQ==' });
        streamStart();
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });
        const last = frames().at(-1);

        renew();
        await waitFor(() => expect(renewOks(sent)).toHaveLength(1));

        const [reply] = renewOks(sent);
        const envelope = reply.encrypted;
        if (!isSealedV2Wire(envelope)) throw new Error('the renew answer carries no v2 envelope');
        const { getDevicePublicKey } = await import('./crypto.js');
        expect(envelope.senderPublicKey).toBe(getDevicePublicKey());
        expect(JSON.parse(phone.open('stream.alive', envelope, 'hwip-a'))).toEqual({
            sessionName: 'hwip-a', nonce: 'bm9uY2U=', challenge: 'Y2hhbGxlbmdlLW9uZQ==', epoch: last?.epoch, seq: last?.seq,
        });
    });

    it.each([
        ['no challenge', {}],
        ['a challenge that is not a string', { challenge: 42 }],
        ['a challenge of relay size', { challenge: 'A'.repeat(200) }],
        ['an empty challenge', { challenge: '' }],
    ])('should answer %s with a bare renew, nothing sealed', async (_, fields) => {
        const { streamStart, frames, sent, renew } = await renewing(fields);
        streamStart();
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        renew();

        expect(renewOks(sent)).toEqual([{ subtype: 'agent.stream.renew.ok', sessionName: 'hwip-a' }]);
    });

    it('should seal no alive on a plain stream', async () => {
        const { streamStart, frames, sent, renew } = await renewing({ challenge: 'Y2hhbGxlbmdlLW9uZQ==' });
        streamStart({ subscriberPublicKey: undefined, subscriberNonce: undefined });
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        renew();

        expect(renewOks(sent)).toEqual([{ subtype: 'agent.stream.renew.ok', sessionName: 'hwip-a' }]);
    });
});

describe('hostile relay — a stream start stripped of its key', () => {
    it('should stream nothing in the clear once it has sealed', async () => {
        const { streamStart, frames, errors, sent, captures, screenRequest } = await setUp();
        await screenRequest(); // sealed once: from here on, only sealed
        const before = captures();

        for (const stripped of [{ subscriberPublicKey: undefined, subscriberNonce: undefined }, { subscriberPublicKey: '' }]) {
            streamStart(stripped);
        }
        await aFewTicks();

        expect(errors()).toEqual(['e2ee_required', 'e2ee_required']);
        expect(frames()).toEqual([]);
        expect(JSON.stringify(sent)).not.toContain('secret pane');
        expect(captures()).toBe(before);
    });

    it('should leave the sealed stream of that session running', async () => {
        const { listener, me, streamStart, frames, errors, sent, send } = await setUp();
        streamStart();
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        // A start without a key does not restart (and so end) the phone's sealed stream. A stop
        // still would — stop carries no key and is not checked; this is only about the start.
        streamStart({ subscriberPublicKey: undefined, subscriberNonce: undefined });
        listener.handleStreamControl({ subtype: 'agent.stream.renew', targetDeviceId: me, sessionName: 'hwip-a' }, send);

        expect(errors()).toEqual(['e2ee_required']);
        expect(sent.at(-1)).toEqual({ subtype: 'agent.stream.renew.ok', sessionName: 'hwip-a' });
    });

    it('should end a plain stream that was running when it first sealed', async () => {
        const { listener, me, streamStart, frames, errors, sent, send, screenRequest } = await setUp();
        streamStart({ subscriberPublicKey: undefined, subscriberNonce: undefined });
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        await screenRequest(); // the first seal: from here on, only sealed
        await waitFor(() => expect(errors()).toEqual(['e2ee_required']), { timeout: 3000 });
        listener.handleStreamControl({ subtype: 'agent.stream.renew', targetDeviceId: me, sessionName: 'hwip-a' }, send);

        // Its lease is gone with it: a renew finds no stream to keep.
        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.stream.frame', sessionName: 'hwip-a', error: 'stream_gone' });
    });

    it('should give no plaintext scrollback from a plain stream once it has sealed', async () => {
        const { listener, me, streamStart, frames, sent, send, screenRequest } = await setUp();
        streamStart({ subscriberPublicKey: undefined, subscriberNonce: undefined });
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });
        const plainFrames = sent.length;

        await screenRequest(); // the first seal: from here on, only sealed
        listener.handleScreenHistoryRequest({ subtype: 'agent.screen.history.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'h1', before: 0 }, send);

        expect(sent.find((m) => m.requestId === 'h1')).toMatchObject({ error: 'e2ee_required' });
        expect(JSON.stringify(sent.slice(plainFrames))).not.toContain('secret pane');
        // The stream went with the page: a renew finds nothing to keep.
        listener.handleStreamControl({ subtype: 'agent.stream.renew', targetDeviceId: me, sessionName: 'hwip-a' }, send);
        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.stream.frame', sessionName: 'hwip-a', error: 'stream_gone' });
    });

    it('should still stream in the clear while it has never sealed', async () => {
        // The pre-E2E viewer: no key anywhere, no history of sealing.
        const { streamStart, frames, errors } = await setUp();

        streamStart({ subscriberPublicKey: undefined, subscriberNonce: undefined });
        await waitFor(() => expect(frames().length).toBeGreaterThan(0), { timeout: 3000 });

        expect(errors()).toEqual([]);
        expect(frames()[0]).toMatchObject({ content: PANE });
    });
});

describe('hostile relay — a diff or a chat timeline without a key, from a listener that only seals', () => {
    it('should refuse a chat timeline watch whose key the relay stripped', async () => {
        const { listener, me, sent, send, screenRequest } = await setUp();
        await screenRequest(); // sealed once

        for (const stripped of [{}, { subscriberPublicKey: '' }]) {
            expect(listener.handleTurnWatch({ subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, ...stripped }, send)).toBe(true);
        }

        expect(sent).toEqual([
            { subtype: 'agent.turn.watch.error', sessionName: 'hwip-a', error: 'e2ee_required' },
            { subtype: 'agent.turn.watch.error', sessionName: 'hwip-a', error: 'e2ee_required' },
        ]);
    });

    it('should refuse a diff whose key the relay stripped', async () => {
        const { listener, me, sent, send, screenRequest } = await setUp();
        await screenRequest(); // sealed once

        listener.handleDiffFilesRequest({ subtype: 'agent.diff.files.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'd1', deviceId: PHONE_ID }, send);
        listener.handleDiffFileRequest({ subtype: 'agent.diff.file.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'd2', path: 'a.ts', deviceId: PHONE_ID }, send);

        expect(sent.map((m) => [m.requestId, m.error])).toEqual([['d1', 'e2ee_required'], ['d2', 'e2ee_required']]);
        for (const reply of sent) {
            expect(reply).not.toHaveProperty('files');
            expect(reply).not.toHaveProperty('chunk');
        }
    });
});

describe('hostile relay — a diff request the relay tampered with', () => {
    const setUpDiff = async () => {
        const rig = await setUp();
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const listenerKey = getDevicePublicKey() as string;
        const seal = (who: V2Party, inner: object, session = 'hwip-a') => who.seal('session.diff', JSON.stringify(inner), listenerKey, session);
        const question = (over: object = {}) => ({ v: 1, kind: 'file.request', requestId: 'd1', base: 'head', path: 'src/secret.ts', offset: 0, ...over });
        const request = (fields: object = {}) => rig.listener.handleDiffFileRequest({
            subtype: 'agent.diff.file.request', targetDeviceId: rig.me, sessionName: 'hwip-a', requestId: 'd1',
            deviceId: PHONE_ID, subscriberPublicKey: rig.phone.publicKey, encrypted: seal(rig.phone, question()), ...fields,
        }, rig.send);
        return { ...rig, seal, question, request };
    };

    it('should refuse a request whose key the relay swapped for its own, and run no git', async () => {
        const { relay, seal, question, request, sent } = await setUpDiff();

        request({ subscriberPublicKey: relay.publicKey, encrypted: seal(relay, question()) });
        await aFewTicks();

        expect(sent.map((m) => m.error)).toEqual(['subscriber_unverified']);
        expect(gitRuns).toBe(0);
    });

    it('should refuse a question the relay sealed itself under the phone\'s key field', async () => {
        const { relay, seal, question, request, sent } = await setUpDiff();

        request({ encrypted: seal(relay, question()) });
        await aFewTicks();

        expect(sent.map((m) => m.error)).toEqual(['bad_request']);
        expect(gitRuns).toBe(0);
    });

    it('should refuse the phone\'s question moved to another session or another request', async () => {
        const { phone, seal, question, request, sent } = await setUpDiff();

        request({ sessionName: 'hwip-b', encrypted: seal(phone, question(), 'hwip-a') });
        request({ requestId: 'd2', encrypted: seal(phone, question({ requestId: 'd1' })) });
        await aFewTicks();

        expect(sent.map((m) => m.error)).toEqual(['bad_request', 'bad_request']);
        expect(gitRuns).toBe(0);
    });

    it('should show the relay no path, base or content in what it carries', async () => {
        const { request, sent } = await setUpDiff();

        request();
        await aFewTicks();

        for (const frame of sent) {
            expect(Object.keys(frame).sort().filter((k) => !['subtype', 'requestId', 'sessionName', 'targetDeviceId', 'at', 'encrypted', 'error'].includes(k))).toEqual([]);
        }
        expect(JSON.stringify(sent)).not.toContain('secret.ts');
    });
});

describe('hostile relay — a key field that holds no key', () => {
    // Base64 decoding turns `["<key>"]` back into the key, and code that only
    // asks "is there a key" would seal for it: the relay's key, unchecked.
    const notAString = (key: string): unknown[] => [[key], { toString: () => key }, 1];

    it('should refuse a chat timeline watch, and never hand the key on', async () => {
        const { listener, relay, me, sent, send } = await setUp();

        // One at a time: a newer start overtakes one still being checked, and only its answer goes out.
        for (const subscriberPublicKey of notAString(relay.publicKey)) {
            // @ts-expect-error — relay JSON: the field is whatever the relay made it.
            listener.handleTurnWatch({ subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey }, send);
            await aFewTicks();
        }

        expect(sent.map((m) => m.error)).toEqual(['subscriber_unverified', 'subscriber_unverified', 'subscriber_unverified']);
    });

    it('should refuse a stream, a snapshot and a diff the same way', async () => {
        const { listener, relay, phone, me, sent, send, streamStart, screenRequest, frames } = await setUp();
        const [subscriberPublicKey] = notAString(relay.publicKey);
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const question = phone.seal('session.diff', JSON.stringify({ v: 1, kind: 'files.request', requestId: 'd1', base: 'head' }), getDevicePublicKey() as string, 'hwip-a');

        streamStart({ subscriberPublicKey });
        const snapshot = await screenRequest({ subscriberPublicKey });
        // @ts-expect-error — relay JSON, as above.
        listener.handleDiffFilesRequest({ subtype: 'agent.diff.files.request', targetDeviceId: me, sessionName: 'hwip-a', requestId: 'd1', deviceId: PHONE_ID, subscriberPublicKey, encrypted: question }, send);
        await aFewTicks();

        expect(snapshot).toMatchObject({ error: 'subscriber_unverified' });
        expect(snapshot).not.toHaveProperty('content');
        expect(sent.map((m) => m.error)).toEqual(['subscriber_unverified', 'subscriber_unverified']);
        expect(frames()).toEqual([]);
    });
});

describe('hostile relay — a swapped key on a chat timeline watch', () => {
    it('should start the watch once the phone\'s key checked out', async () => {
        const { listener, phone, me, sent, send } = await setUp();

        listener.handleTurnWatch({
            subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey,
        }, send);
        await aFewTicks();

        // Past the door: what answers now is the watcher itself. This fake
        // session has no transcript to follow, and it says so — a refusal of
        // its own, not the trust store's.
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ subtype: 'agent.turn.watch.error', sessionName: 'hwip-a' });
        expect(['subscriber_unverified', 'e2ee_required']).not.toContain(sent[0].error);
    });

    /** A device list that answers when the test says so: the key check stays open meanwhile. */
    const checkedLater = async (listener: typeof import('./listener.js')): Promise<(key: string | null) => void> => {
        const { createSubscriberTrust } = await import('./subscriber-trust.js');
        let answer: (key: string | null) => void = () => {};
        listener.setSubscriberTrust(createSubscriberTrust({
            path: join(TMP, 'trusted-devices.json'),
            registeredKey: () => new Promise((resolve) => { answer = resolve; }),
            log: () => {},
        }));
        return (key) => answer(key);
    };

    it('should drop a start that a stop overtook while its key was being checked', async () => {
        const { listener, phone, me, sent, send } = await setUp();
        const answer = await checkedLater(listener);

        listener.handleTurnWatch({ subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey }, send);
        listener.handleTurnWatch({ subtype: 'agent.turn.watch.stop', targetDeviceId: me, sessionName: 'hwip-a' }, send);
        answer(phone.publicKey);
        await aFewTicks();

        expect(sent).toEqual([]);
    });

    it('should not send the refusal of a start that a stop overtook', async () => {
        const { listener, phone, relay, me, sent, send } = await setUp();
        const answer = await checkedLater(listener);

        listener.handleTurnWatch({ subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: relay.publicKey }, send);
        listener.handleTurnWatch({ subtype: 'agent.turn.watch.stop', targetDeviceId: me, sessionName: 'hwip-a' }, send);
        // The registered key is the phone's: the relay's is refused.
        answer(phone.publicKey);
        await aFewTicks();

        expect(sent).toEqual([]);
    });

    it('should keep a start whose key is being checked when a renew arrives', async () => {
        const { listener, phone, me, sent, send } = await setUp();
        const answer = await checkedLater(listener);

        listener.handleTurnWatch({ subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: phone.publicKey }, send);
        listener.handleTurnWatch({ subtype: 'agent.turn.watch.renew', targetDeviceId: me, sessionName: 'hwip-a' }, send);
        answer(phone.publicKey);
        await aFewTicks();

        // The start reached the watcher, which answers it (this fake session has no transcript).
        expect(sent.filter((m) => m.subtype === 'agent.turn.watch.error')).toHaveLength(1);
    });

    it('should refuse a sealed watch for a key the relay put in place of the phone\'s', async () => {
        const { listener, relay, me, sent, send } = await setUp();

        const claimed = listener.handleTurnWatch({
            subtype: 'agent.turn.watch.start', targetDeviceId: me, sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: relay.publicKey,
        }, send);
        await aFewTicks();

        expect(claimed).toBe(true);
        expect(sent).toEqual([{ subtype: 'agent.turn.watch.error', sessionName: 'hwip-a', error: 'subscriber_unverified' }]);
    });

    it('should leave a watch addressed to another machine alone', async () => {
        const { listener, relay, sent, send } = await setUp();

        const claimed = listener.handleTurnWatch({
            subtype: 'agent.turn.watch.start', targetDeviceId: 'dev_listener_other', sessionName: 'hwip-a', deviceId: PHONE_ID, subscriberPublicKey: relay.publicKey,
        }, send);
        await aFewTicks();

        expect(claimed).toBe(false);
        expect(sent).toEqual([]);
    });
});


describe('hostile relay — a sealed REST command', () => {
    /** A command push as the app seals it (M5 D8), sealed by `sender` for this listener. */
    const sealedCommand = async (
        rig: Awaited<ReturnType<typeof setUp>>,
        options: { sender?: V2Party; cmd?: object | null; session?: string; extra?: object; slotFor?: string; body?: string; files?: object[]; content?: object } = {},
    ) => {
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const me = getDevicePublicKey();
        if (!me) throw new Error('no device key');
        const sender = options.sender ?? rig.phone;
        const session = options.session ?? 'hwip-a';
        const cmd = options.cmd === null ? {} : { cmd: options.cmd ?? { n: 1000, session, device: rig.me } };
        const body = 'body' in options ? options.body : 'do the thing';
        const sealed = sender.sealPush({ ...(body === undefined ? {} : { body }), ...cmd, ...(options.files ? { files: options.files } : {}), ...(options.content ?? {}) }, me);
        return {
            pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: rig.me, agentSessionName: session,
            senderDeviceId: PHONE_ID, senderPublicKey: sender.publicKey,
            body: sealed.body, deviceKeyMap: { [options.slotFor ?? rig.me]: sealed.entry },
            ...options.extra,
        };
    };

    const typing = (rig: Awaited<ReturnType<typeof setUp>>) => {
        const typed: string[] = [];
        const deps = {
            deviceId: () => rig.me,
            paneProbe: () => ({ command: 'claude', shellMarked: false }),
            inject: (_: string, text: string) => { typed.push(text); return true; },
            rateLimit: () => true,
            paneCwd: () => null,
        };
        return { typed, deps };
    };

    it('should type what the phone sealed', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);

        expect(await rig.listener.handlePush(await sealedCommand(rig), deps)).toBe(true);

        expect(typed).toEqual(['do the thing']);
    });

    it('should tell the phone a replay was refused, and say nothing when it typed', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const reports: { pushId: string; reason: string }[] = [];
        const withReport = { ...deps, reportRefusal: (r: { pushId: string; reason: string }) => reports.push(r) };
        const command = await sealedCommand(rig);

        expect(await rig.listener.handlePush(command, withReport)).toBe(true);
        expect(reports).toEqual([]);
        expect(await rig.listener.handlePush(command, withReport)).toBe(false);
        expect(reports).toEqual([expect.objectContaining({ pushId: 'p1', reason: 'sealed_rejected' })]);
        expect(typed).toEqual(['do the thing']);
    });

    it('should not tell the relay what the sealed text held: a shell refusal reads as a sealed one', async () => {
        // A control character or newline is a property of the plaintext. The
        // plain-text path says shell_input; a sealed command must not.
        const rig = await setUp();
        const { deps } = typing(rig);
        const reports: { reason: string }[] = [];
        const shell = { ...deps, paneProbe: () => ({ command: 'zsh', shellMarked: true }), reportRefusal: (r: { reason: string }) => reports.push(r) };

        expect(await rig.listener.handlePush(await sealedCommand(rig, { body: 'ls\x1b[A' }), shell)).toBe(false);

        expect(reports).toEqual([{ sessionName: 'hwip-a', pushId: 'p1', reason: 'sealed_rejected' }]);
    });

    it('should not type a command again because the relay stamped it with another device id the list gives the phone\'s key', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        rig.deviceList.set('dev_fresh_1', rig.phone.publicKey);

        expect(await rig.listener.handlePush(command, deps)).toBe(true);
        expect(await rig.listener.handlePush({ ...command, senderDeviceId: 'dev_fresh_1' }, deps)).toBe(false);
        expect(await rig.listener.handlePush({ ...command, senderDeviceId: 'dev_fresh_2' }, deps)).toBe(false);

        expect(typed).toEqual(['do the thing']);
    });

    // A sealed push opens from the x coordinate of the ECDH secret alone, so the relay can hand the same box to the
    // listener under the phone's key mirrored ((x, p - y)), with no secret key: a string that no pin and no list entry
    // matches, from the same sender.
    it('should not type a command again under the phone\'s key mirrored, stamped with a new device id', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        const mirror = mirroredPublicKey(rig.phone.publicKey);
        rig.deviceList.set('dev_fresh_1', mirror);
        expect(await rig.listener.handlePush(command, deps)).toBe(true);

        const replay = { ...command, senderDeviceId: 'dev_fresh_1', senderPublicKey: mirror };

        expect(await rig.listener.handlePush(replay, deps)).toBe(false);
        expect(typed).toEqual(['do the thing']);
        expect(Object.keys(JSON.parse(readFileSync(join(TMP, 'trusted-devices.json'), 'utf-8')).devices)).toEqual([PHONE_ID]);
    });

    it('should not type a command again under the mirrored key after `hwip trust --reset`', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        const mirror = mirroredPublicKey(rig.phone.publicKey);
        rig.deviceList.set('dev_fresh_1', mirror);
        expect(await rig.listener.handlePush(command, deps)).toBe(true);
        const { runTrust } = await import('./trust-command.js');
        await runTrust({ reset: true, yes: true }, {
            path: join(TMP, 'trusted-devices.json'),
            devicePublicKey: async () => rig.phone.publicKey,
            registeredKey: async () => null,
            confirm: async () => true,
            print: () => {},
            printError: () => {},
        });

        expect(await rig.listener.handlePush({ ...command, senderDeviceId: 'dev_fresh_1', senderPublicKey: mirror }, deps)).toBe(false);
        expect(typed).toEqual(['do the thing']);
    });

    // `hwip trust --reset` forgets the pins, not the numbers; the key each number was taken with is kept beside it, or
    // a relay could stamp the old command with a new id the account lists for the phone's key and have it typed again.
    it('should not type a command again after `hwip trust --reset` because the relay stamped it with a new id', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        rig.deviceList.set('dev_fresh_1', rig.phone.publicKey);
        expect(await rig.listener.handlePush(command, deps)).toBe(true);

        const { runTrust } = await import('./trust-command.js');
        const reset = await runTrust({ reset: true, yes: true }, {
            path: join(TMP, 'trusted-devices.json'),
            devicePublicKey: async () => rig.phone.publicKey,
            registeredKey: async () => null,
            confirm: async () => true,
            print: () => {},
            printError: () => {},
        });
        expect(reset).toBe(0);

        expect(await rig.listener.handlePush({ ...command, senderDeviceId: 'dev_fresh_1' }, deps)).toBe(false);
        expect(typed).toEqual(['do the thing']);
    });

    it('should count the numbers of a key pinned under two ids as one (a person pinned both)', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        rig.deviceList.set('dev_fresh_1', rig.phone.publicKey);
        const pin = { publicKey: rig.phone.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' };
        writeFileSync(join(TMP, 'trusted-devices.json'), JSON.stringify({ version: 1, devices: { [PHONE_ID]: pin, dev_fresh_1: pin } }));

        expect(await rig.listener.handlePush(command, deps)).toBe(true);
        expect(await rig.listener.handlePush({ ...command, senderDeviceId: 'dev_fresh_1' }, deps)).toBe(false);

        expect(typed).toEqual(['do the thing']);
    });

    it('should not type the same command twice, nor an older one', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        await rig.listener.handlePush(command, deps);

        expect(await rig.listener.handlePush(command, deps)).toBe(false);
        expect(await rig.listener.handlePush(await sealedCommand(rig, { cmd: { n: 999, session: 'hwip-a', device: rig.me } }), deps)).toBe(false);

        expect(typed).toEqual(['do the thing']);
    });

    it('should not type a command sent again after the listener restarted', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const command = await sealedCommand(rig);
        await rig.listener.handlePush(command, deps);
        const { createSubscriberTrust } = await import('./subscriber-trust.js');
        rig.listener.setSubscriberTrust(createSubscriberTrust({
            path: join(TMP, 'trusted-devices.json'),
            registeredKey: async (deviceId) => rig.deviceList.get(deviceId) ?? null,
            log: () => {},
        }));

        expect(await rig.listener.handlePush(command, deps)).toBe(false);
        expect(typed).toHaveLength(1);
    });

    it.each([
        ['no command label (a sealed notification handed back)', { cmd: null }],
        ['a label for another session', { cmd: { n: 1000, session: 'hwip-b', device: 'ME' } }],
        ['a label for another machine', { cmd: { n: 1000, session: 'hwip-a', device: 'dev_listener_other' } }],
        ['a label whose number is not a whole number', { cmd: { n: '1000', session: 'hwip-a', device: 'ME' } }],
    ])('should type nothing for %s', async (_, options) => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const cmd = 'cmd' in options && options.cmd && 'device' in options.cmd && options.cmd.device === 'ME'
            ? { ...options.cmd, device: rig.me } : options.cmd;

        expect(await rig.listener.handlePush(await sealedCommand(rig, { cmd }), deps)).toBe(false);

        expect(typed).toEqual([]);
    });

    it('should type nothing the relay sealed in the phone\'s name', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);

        expect(await rig.listener.handlePush(await sealedCommand(rig, { sender: rig.relay }), deps)).toBe(false);

        expect(typed).toEqual([]);
    });

    it('should type nothing sealed only for another device', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);

        expect(await rig.listener.handlePush(await sealedCommand(rig, { slotFor: 'dev_listener_other' }), deps)).toBe(false);

        expect(typed).toEqual([]);
    });

    it.each([
        ['keys', { keys: ['enter'] }],
        ['an insert', { insert: 'y' }],
        ['attachments', { files: [{ fileKey: 'files/x.sh', fileName: 'x.sh', fileType: 'text/plain', fileSize: 4 }] }],
    ])('should type nothing when the relay adds plain %s to a sealed command', async (_, extra) => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const sendKeys = vi.fn(() => true);
        const downloadAttachments = vi.fn(async () => ['/tmp/x.sh']);

        expect(await rig.listener.handlePush(await sealedCommand(rig, { extra }), { ...deps, sendKeys, insertText: () => true, downloadAttachments })).toBe(false);

        expect(typed).toEqual([]);
        expect(sendKeys).not.toHaveBeenCalled();
        expect(downloadAttachments).not.toHaveBeenCalled();
    });

    describe('sealed keys for a blocked prompt', () => {
        const BASH = readFileSync(new URL('./fixtures/panes/claude-blocked-bash.txt', import.meta.url), 'utf-8');
        const IDLE = readFileSync(new URL('./fixtures/panes/claude-idle.txt', import.meta.url), 'utf-8');
        const MOVED = BASH.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No');

        const keyRig = async (rig: Awaited<ReturnType<typeof setUp>>, pane: string) => {
            const { parseBlockedDialog } = await import('./blocked-prompt.js');
            const { typed, deps } = typing(rig);
            const keys: string[][] = [];
            const reasons: string[] = [];
            return {
                id: parseBlockedDialog(BASH)!.id,
                typed, keys, reasons,
                deps: {
                    ...deps,
                    capturePane: () => pane,
                    sendKeys: (_s: string, t: string[]) => { keys.push(t); return true; },
                    insertText: () => true,
                    reportRefusal: (f: { reason: string }) => { reasons.push(f.reason); },
                },
            };
        };

        it('should type sealed keys that carry no body', async () => {
            const rig = await setUp();
            const { id, deps, typed, keys, reasons } = await keyRig(rig, BASH);

            const push = await sealedCommand(rig, { body: undefined, content: { keys: ['enter'], ifPrompt: id } });
            expect(await rig.listener.handlePush(push, deps)).toBe(true);

            expect(keys).toEqual([['Enter']]);
            expect(typed).toEqual([]);
            expect(reasons).toEqual([]);
        });

        it('should refuse the whole command when a sealed key is outside the whitelist', async () => {
            const rig = await setUp();
            const { deps, typed, keys, reasons } = await keyRig(rig, BASH);

            const push = await sealedCommand(rig, { content: { keys: ['M-x'] } });
            expect(await rig.listener.handlePush(push, deps)).toBe(false);

            expect(typed).toEqual([]);
            expect(keys).toEqual([]);
            expect(reasons).toEqual(['sealed_rejected']);
        });

        it('should refuse sealed keys with prompt_changed when the prompt moved', async () => {
            const rig = await setUp();
            const { id, deps, keys, reasons } = await keyRig(rig, MOVED);

            const push = await sealedCommand(rig, { body: undefined, content: { keys: ['enter'], ifPrompt: id } });
            expect(await rig.listener.handlePush(push, deps)).toBe(false);

            expect(keys).toEqual([]);
            expect(reasons).toEqual(['prompt_changed']);
        });

        it('should ignore a plain ifPrompt beside a sealed body', async () => {
            const rig = await setUp();
            const { deps, typed, reasons } = await keyRig(rig, IDLE);

            const push = await sealedCommand(rig, { extra: { ifPrompt: '0123456789abcdef' } });
            expect(await rig.listener.handlePush(push, deps)).toBe(true);

            expect(typed).toEqual(['do the thing']);
            expect(reasons).toEqual([]);
        });
    });

    describe('from another machine of the account (REST key, sealed `cmd.from`)', () => {
        const PC_ID = 'dev_pc_9f8e7d6c';
        /** The command push as the relay carries a send made with an API key: stamped `api_<keyId>`, sealed by the PC. */
        const fromPc = async (
            rig: Awaited<ReturnType<typeof setUp>>,
            pc: V2Party,
            options: { from?: string | null; senderDeviceId?: string | null; n?: number; body?: string } = {},
        ) => {
            const from = options.from === undefined ? PC_ID : options.from;
            const command = await sealedCommand(rig, {
                sender: pc,
                ...(options.body === undefined ? {} : { body: options.body }),
                cmd: { n: options.n ?? 1000, session: 'hwip-a', device: rig.me, ...(from === null ? {} : { from }) },
            });
            const { senderDeviceId: _stamped, ...rest } = command;
            return options.senderDeviceId === null ? rest : { ...rest, senderDeviceId: options.senderDeviceId ?? 'api_key_1' };
        };
        const withPc = async () => {
            const rig = await setUp();
            const pc = v2Party();
            rig.deviceList.set(PC_ID, pc.publicKey);
            return { rig, pc };
        };

        it('should type what a registered machine sealed, though the relay stamped an API key', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc), deps)).toBe(true);

            expect(typed).toEqual(['do the thing']);
        });

        it('should type what `sealedCommand` — the sender\'s own module — makes of a send (round trip)', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);
            const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
            await initDeviceCrypto();
            const listenerKey = getDevicePublicKey();
            if (!listenerKey) throw new Error('no device key');
            const trustPath = join(mkdtempSync(join(tmpdir(), 'round-trip-')), 'trusted-devices.json');
            writeFileSync(trustPath, JSON.stringify({ version: 1, devices: { [rig.me]: { publicKey: listenerKey, pinnedAt: '2026-10-01T00:00:00.000Z' } } }));
            const { sealedCommand: makeSealed } = await import('./command-seal.js');

            const prepared = await makeSealed({ targetDeviceId: rig.me, session: 'hwip-a', message: '[from cli@pc] run the tests' }, {
                loadKeys: async () => undefined,
                self: () => ({ deviceId: PC_ID, publicKey: pc.publicKey }),
                listDevices: async () => [{ deviceId: PC_ID, publicKey: pc.publicKey }, { deviceId: rig.me, publicKey: listenerKey }],
                register: async () => null,
                trustPath,
                nextNumber: async () => 1700000000001,
                // The envelope is made here with the PC's key: crypto is command-seal.test.ts's, the labels are what this checks.
                seal: async (content, recipients) => {
                    const sealedFor = pc.sealPush(content, recipients[0]!.publicKey);
                    return { isEncrypted: true, body: sealedFor.body, senderPublicKey: pc.publicKey, deviceKeyMap: { [recipients[0]!.deviceId]: sealedFor.entry } };
                },
            });
            if (prepared.kind !== 'sealed') throw new Error(`not sealed: ${JSON.stringify(prepared)}`);

            const push = {
                pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: rig.me, agentSessionName: 'hwip-a',
                senderDeviceId: 'api_key_1', ...prepared.fields,
            };
            expect(await rig.listener.handlePush(push, deps)).toBe(true);

            expect(typed).toEqual(['[from cli@pc] run the tests']);
        });

        // Neither end faked: the real sealer (this machine's own key) for another session on the same computer, the real listener.
        it('should type what the default sealer makes of a send to another session on the same computer', async () => {
            const rig = await setUp();
            const { typed, deps } = typing(rig);
            const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
            await initDeviceCrypto();
            const ownKey = getDevicePublicKey();
            if (!ownKey) throw new Error('no device key');
            rig.deviceList.set(rig.me, ownKey);
            const trustPath = join(mkdtempSync(join(tmpdir(), 'round-trip-')), 'trusted-devices.json');
            const { sealedCommand: makeSealed } = await import('./command-seal.js');

            const prepared = await makeSealed({ targetDeviceId: rig.me, session: 'hwip-a', message: 'run the tests' }, {
                loadKeys: async () => undefined,
                self: () => ({ deviceId: rig.me, publicKey: ownKey }),
                listDevices: async () => [{ deviceId: rig.me, publicKey: ownKey }],
                register: async () => null,
                trustPath,
                nextNumber: async () => 1700000000001,
            });
            if (prepared.kind !== 'sealed') throw new Error(`not sealed: ${JSON.stringify(prepared)}`);

            const push = {
                pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: rig.me, agentSessionName: 'hwip-a',
                senderDeviceId: 'api_key_1', ...prepared.fields,
            };
            expect(await rig.listener.handlePush(push, deps)).toBe(true);
            expect(typed).toEqual(['run the tests']);
            // The same push again is a replay.
            expect(await rig.listener.handlePush(push, deps)).toBe(false);
        });

        it('should type it with no sender stamped at all', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { senderDeviceId: null }), deps)).toBe(true);

            expect(typed).toEqual(['do the thing']);
        });

        it('should type it when the stamp is the sealed machine itself', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { senderDeviceId: PC_ID }), deps)).toBe(true);

            expect(typed).toEqual(['do the thing']);
        });

        it('should type nothing when the stamp is another machine than the sealed one', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { senderDeviceId: PHONE_ID }), deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should pin the machine on its first command', async () => {
            const { rig, pc } = await withPc();
            const { deps } = typing(rig);

            await rig.listener.handlePush(await fromPc(rig, pc), deps);

            const state = JSON.parse(readFileSync(join(TMP, 'trusted-devices.json'), 'utf-8')) as { devices: Record<string, { publicKey: string }> };
            expect(state.devices[PC_ID]?.publicKey).toBe(pc.publicKey);
        });

        it('should type nothing when one byte of the sealed body was changed', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);
            const command = await fromPc(rig, pc);
            const bytes = Buffer.from(command.body ?? '', 'base64');
            bytes[bytes.length - 1] ^= 1;

            expect(await rig.listener.handlePush({ ...command, body: bytes.toString('base64') }, deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should type nothing from a machine the account does not list', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);
            rig.deviceList.delete(PC_ID);

            expect(await rig.listener.handlePush(await fromPc(rig, pc), deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should type nothing when an API key stamped it and the body names no machine', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { from: null }), deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should type nothing when the sender key is not the one registered for the named machine', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, rig.relay), deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should type nothing when a registered machine sealed in the phone\'s name', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { from: PHONE_ID }), deps)).toBe(false);

            expect(typed).toEqual([]);
        });

        it('should type from a machine whose key changed after it was pinned, and nothing more from the old key', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);
            expect(await rig.listener.handlePush(await fromPc(rig, pc), deps)).toBe(true);
            const replacement = v2Party();
            rig.deviceList.set(PC_ID, replacement.publicKey);

            expect(await rig.listener.handlePush(await fromPc(rig, replacement, { n: 2000 }), deps)).toBe(true);
            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 3000 }), deps)).toBe(false);

            expect(typed).toEqual(['do the thing', 'do the thing']);
        });

        it('should count command numbers per sealing machine', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 1000 }), deps)).toBe(true);
            expect(await rig.listener.handlePush(await sealedCommand(rig), deps)).toBe(true); // the phone's own 1000
            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 1000 }), deps)).toBe(false); // a replay
            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 1001 }), deps)).toBe(true);

            expect(typed).toHaveLength(3);
        });

        it('should type what this machine sealed to itself (a send from another session on the same computer)', async () => {
            const rig = await setUp();
            const { typed, deps } = typing(rig);
            const { initDeviceCrypto, getDevicePublicKey, encryptPushBodyForDevices } = await import('./crypto.js');
            await initDeviceCrypto();
            const own = getDevicePublicKey() ?? '';
            const sealed = await encryptPushBodyForDevices(
                { body: 'do the thing', cmd: { n: 1000, session: 'hwip-a', device: rig.me, from: rig.me } },
                [{ deviceId: rig.me, publicKey: own }],
            );
            const push = {
                pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: rig.me, agentSessionName: 'hwip-a',
                senderDeviceId: 'api_key_1', ...sealed,
            };

            expect(await rig.listener.handlePush(push, deps)).toBe(true);
            expect(await rig.listener.handlePush(push, deps)).toBe(false); // the same command again is a replay

            expect(typed).toEqual(['do the thing']);
        });

        it('should type nothing a relay sealed with its own key as this machine, though the account lists that key for it', async () => {
            const rig = await setUp();
            const { typed, deps } = typing(rig);
            const relay = v2Party();
            rig.deviceList.set(rig.me, relay.publicKey); // the relay writes the list
            const forged = await sealedCommand(rig, { sender: relay, cmd: { n: 1000, session: 'hwip-a', device: rig.me, from: rig.me } });

            expect(await rig.listener.handlePush({ ...forged, senderDeviceId: 'api_key_1' }, deps)).toBe(false);

            expect(typed).toEqual([]);
            const file = join(TMP, 'trusted-devices.json');
            const pinned = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as { devices: Record<string, unknown> }).devices : {};
            expect(Object.keys(pinned)).toEqual([]);
        });

        it('should not let a command number another stamp carries reset the count', async () => {
            const { rig, pc } = await withPc();
            const { typed, deps } = typing(rig);

            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 1000, senderDeviceId: 'api_key_1' }), deps)).toBe(true);
            expect(await rig.listener.handlePush(await fromPc(rig, pc, { n: 1000, senderDeviceId: 'api_key_2' }), deps)).toBe(false);

            expect(typed).toHaveLength(1);
        });

        it.each([
            ['an unlisted machine', { unlist: true }],
            ['a label for another session', { session: 'hwip-b' }],
            ['a replayed number', { replay: true }],
        ])('should write nothing of the sealed text to the log for %s', async (_, how: { unlist?: boolean; session?: string; replay?: boolean }) => {
            const { rig, pc } = await withPc();
            const { deps } = typing(rig);
            if (how.unlist) rig.deviceList.delete(PC_ID);
            const secret = () => how.session
                ? sealedCommand(rig, { sender: pc, body: 'SECRET-TEXT-9', cmd: { n: 1000, session: how.session, device: rig.me, from: PC_ID } })
                : fromPc(rig, pc, { body: 'SECRET-TEXT-9' });
            const logged = vi.spyOn(console, 'log');
            if (how.replay) await rig.listener.handlePush(await secret(), deps);
            logged.mockClear(); // what the accepted first send logged is not the question

            expect(await rig.listener.handlePush(await secret(), deps)).toBe(false);

            expect(logged).toHaveBeenCalled(); // the refusal is said, the text is not
            expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET-TEXT-9');
        });
    });

    /** An attachment the phone sealed for this machine and itself, as the app uploads it. */
    const sealedAttachment = async (rig: Awaited<ReturnType<typeof setUp>>, bytes = Buffer.from('png bytes')) => {
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const sealed = rig.phone.sealFile(bytes, getDevicePublicKey() ?? '');
        return {
            file: { fileKey: 'files/shot.png', fileName: 'shot.png', fileType: 'image/png', fileSize: bytes.length, iv: sealed.iv, deviceKeyMap: { [rig.me]: sealed.entry } },
            uploaded: sealed.bytes,
        };
    };

    /** What the sealed body says about an attachment (cli `SealedFileMeta`). */
    const metaOf = (file: { iv: string; fileName: string; fileType: string; fileSize: number }) =>
        ({ iv: file.iv, name: file.fileName, type: file.fileType, size: file.fileSize });

    it('should type a sealed attachment with the sealed caption, opened as the phone\'s', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const { file } = await sealedAttachment(rig);
        const command = await sealedCommand(rig, { files: [metaOf(file)] });
        const downloadAttachments = vi.fn(async () => ['/tmp/hwip/shot.png']);

        expect(await rig.listener.handlePush({ ...command, files: [file] }, { ...deps, downloadAttachments })).toBe(true);

        expect(downloadAttachments).toHaveBeenCalledWith('p1', [file], { deviceId: rig.me, senderPublicKey: rig.phone.publicKey, files: [metaOf(file)] });
        expect(typed).toHaveLength(1);
        expect(typed[0]).toContain('do the thing');
        expect(typed[0]).toContain('/tmp/hwip/shot.png');
    });

    it.each([
        ['an attachment that will not open', vi.fn(async () => { throw new Error('bad tag'); })],
        ['an attachment that did not come down', vi.fn(async () => [])],
    ])('should type nothing of a sealed command with %s', async (_, downloadAttachments) => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const { file } = await sealedAttachment(rig);
        const command = await sealedCommand(rig, { files: [metaOf(file)] });

        expect(await rig.listener.handlePush({ ...command, files: [file] }, { ...deps, downloadAttachments })).toBe(false);

        expect(typed).toEqual([]);
    });

    it('should type a sealed file sent without a caption', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const { file } = await sealedAttachment(rig);
        const command = await sealedCommand(rig, { body: undefined, files: [metaOf(file)] });
        const downloadAttachments = vi.fn(async () => ['/tmp/hwip/shot.png']);

        expect(await rig.listener.handlePush({ ...command, files: [file] }, { ...deps, downloadAttachments })).toBe(true);

        expect(typed).toHaveLength(1);
        expect(typed[0]).toContain('/tmp/hwip/shot.png');
    });

    it('should type nothing of a sealed command with neither text nor a file', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);

        expect(await rig.listener.handlePush(await sealedCommand(rig, { body: undefined }), deps)).toBe(false);

        expect(typed).toEqual([]);
    });

    it('should type nothing when the relay drops the file the sealed body names', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const { file } = await sealedAttachment(rig);
        const command = await sealedCommand(rig, { files: [metaOf(file)] });

        expect(await rig.listener.handlePush(command, deps)).toBe(false);

        expect(typed).toEqual([]);
    });

    it('should type nothing when the relay swaps in a file the phone sealed for another message', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        const { file } = await sealedAttachment(rig);
        const { file: earlier } = await sealedAttachment(rig, Buffer.from('an older file'));
        const command = await sealedCommand(rig, { files: [metaOf(file)] });
        const downloadAttachments = vi.fn(async () => ['/tmp/hwip/older']);

        expect(await rig.listener.handlePush({ ...command, files: [earlier] }, { ...deps, downloadAttachments })).toBe(false);

        expect(typed).toEqual([]);
        expect(downloadAttachments).not.toHaveBeenCalled();
    });

    it('should open a sealed attachment with this machine\'s slot, and refuse one sealed only for another', async () => {
        const rig = await setUp();
        const { file, uploaded } = await sealedAttachment(rig);
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/files/')
            ? new Response(JSON.stringify({ data: { downloadUrl: 'https://bucket.s3.ap-northeast-2.amazonaws.com/x' } }))
            : new Response(uploaded))));
        const ctx = { apiKey: 'k', baseUrl: 'https://api.example.com' };
        const sealed = { deviceId: rig.me, senderPublicKey: rig.phone.publicKey };
        try {
            const [path] = await rig.listener.downloadAttachments('p1', [file], ctx, sealed);
            const { readFileSync } = await import('fs');
            expect(readFileSync(path, 'utf-8')).toBe('png bytes');

            // Padded before sealing, under a placeholder record: the sealed body's
            // name and size are what it is saved as.
            const padded = await sealedAttachment(rig, Buffer.concat([Buffer.from('png bytes'), Buffer.alloc(7)]));
            vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/files/')
                ? new Response(JSON.stringify({ data: { downloadUrl: 'https://bucket.s3.ap-northeast-2.amazonaws.com/y' } }))
                : new Response(padded.uploaded))));
            const placeholder = { ...padded.file, fileName: 'file', fileType: 'application/octet-stream', fileSize: 16 };
            const [real] = await rig.listener.downloadAttachments('p4', [placeholder], ctx, {
                ...sealed, files: [{ iv: padded.file.iv, name: 'shot.png', type: 'image/png', size: 9 }],
            });
            expect(real.endsWith('shot.png')).toBe(true);
            expect(readFileSync(real, 'utf-8')).toBe('png bytes');

            const elsewhere = { ...file, deviceKeyMap: { dev_listener_other: file.deviceKeyMap[rig.me] } };
            await expect(rig.listener.downloadAttachments('p2', [elsewhere], ctx, sealed)).rejects.toThrow();
            // Opened under another sender's key, the slot does not unwrap.
            await expect(rig.listener.downloadAttachments('p3', [file], ctx, { ...sealed, senderPublicKey: rig.relay.publicKey })).rejects.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('should type nothing in a process that has no device list to check against', async () => {
        const rig = await setUp();
        const { typed, deps } = typing(rig);
        rig.listener.setSubscriberTrust(null);

        expect(await rig.listener.handlePush(await sealedCommand(rig), deps)).toBe(false);

        expect(typed).toEqual([]);
    });
});

describe('hostile relay — envelopes handed back on a v2 stream', () => {
    const sealedStream = async () => {
        const rig = await setUp();
        rig.streamStart();
        await waitFor(() => expect(rig.frames().length).toBeGreaterThan(0), { timeout: 3000 });
        const { getDevicePublicKey } = await import('./crypto.js');
        const listenerKey = getDevicePublicKey();
        if (!listenerKey) throw new Error('no device key');
        streamEpoch = rig.frames()[0].epoch;
        const typedKeys = () => tmuxCalls.filter((c) => c[0] === 'send-keys');
        const type = (encrypted: unknown, seq = 1) => rig.listener.handleCommandInput({
            subtype: 'agent.command.input', targetDeviceId: rig.me, sessionName: 'hwip-a', seq, epoch: 1, deviceId: PHONE_ID, encrypted,
        }, rig.send);
        return { ...rig, listenerKey, typedKeys, type };
    };
    /** The phone's input as it seals it: bound to the stream epoch of the frames it sees and to itself. */
    let streamEpoch: unknown;
    const inputFrom = (phone: V2Party, listenerKey: string, purpose = 'stream.input', fields: object = {}) =>
        phone.seal(purpose, JSON.stringify({ sessionName: 'hwip-a', seq: 1, epoch: 1, streamEpoch, deviceId: PHONE_ID, keys: ['down'], ...fields }), listenerKey, 'hwip-a');

    it('should answer the start with a sealed v2 answer bound to the subscription', async () => {
        const { phone, sent } = await sealedStream();
        await waitFor(() => expect(sent.some((m) => m.subtype === 'agent.stream.start.ok')).toBe(true), { timeout: 3000 });

        const answer = sent.find((m) => m.subtype === 'agent.stream.start.ok');
        expect(answer).toMatchObject({ sessionName: 'hwip-a', sealVersion: 2 });
        const envelope = answer?.encrypted;
        if (!isSealedV2Wire(envelope)) throw new Error('no v2 envelope');
        expect(JSON.parse(phone.open('stream.started', envelope, 'hwip-a'))).toMatchObject({ sessionName: 'hwip-a', nonce: 'bm9uY2U=', v: 2 });
    });

    it('should type the phone\'s v2 input', async () => {
        const { phone, listenerKey, typedKeys, type } = await sealedStream();
        tmuxCalls = [];

        type(inputFrom(phone, listenerKey));
        await waitFor(() => expect(typedKeys().length).toBeGreaterThan(0));
    });

    it('should type nothing of the phone\'s input replayed after a start the relay sent in its name', async () => {
        const { phone, listenerKey, typedKeys, type, streamStart, frames } = await sealedStream();
        const captured = inputFrom(phone, listenerKey);
        await vi.advanceTimersByTimeAsync(5);
        streamStart();
        await waitFor(() => expect(frames().some((f) => f.epoch !== streamEpoch)).toBe(true), { timeout: 3000 });
        tmuxCalls = [];

        type(captured);
        await aFewTicks();

        expect(typedKeys()).toEqual([]);
    });

    it('should type nothing when the relay hands a frame back as input', async () => {
        const { frames, typedKeys, type, errors } = await sealedStream();
        tmuxCalls = [];

        type(frames()[0].encrypted);
        await aFewTicks();

        expect(typedKeys()).toEqual([]);
        expect(errors()).toContain('input_rejected');
    });

    it.each([
        ['an alive answer', 'stream.alive'],
        ['a snapshot', 'screen.snapshot'],
    ])('should type nothing sealed by the phone for another purpose: %s', async (_, purpose) => {
        const { phone, listenerKey, typedKeys, type, errors } = await sealedStream();
        tmuxCalls = [];

        type(inputFrom(phone, listenerKey, purpose));
        await aFewTicks();

        expect(typedKeys()).toEqual([]);
        expect(errors()).toContain('input_rejected');
    });

    it('should type nothing from a v1 envelope', async () => {
        const { phone, listenerKey, typedKeys, type, errors } = await sealedStream();
        const sealed = phone.sealPush({ sessionName: 'hwip-a', seq: 1, epoch: 1, keys: ['down'] }, listenerKey);
        tmuxCalls = [];

        type({ ...JSON.parse(sealed.body), ...JSON.parse(sealed.entry), senderPublicKey: phone.publicKey });
        await aFewTicks();

        expect(typedKeys()).toEqual([]);
        expect(errors()).toContain('input_rejected');
    });
});

describe('a sealed file sent to this machine', () => {
    // M5: the record says `file`, `application/octet-stream` and a padded
    // size; the sealed body names the file by its IV with what it really is.
    it('should save it under its real name and size', async () => {
        const rig = await setUp();
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const me = getDevicePublicKey() ?? '';
        const file = rig.phone.sealFile(Buffer.concat([Buffer.from('png bytes'), Buffer.alloc(7)]), me);
        const body = rig.phone.sealPush({ files: [{ iv: file.iv, name: 'shot.png', type: 'image/png', size: 9 }] }, me);
        const saved: Array<{ fileName?: string; fileSize?: number }> = [];

        const ok = await rig.listener.handlePush({
            pushId: 'p1', type: 'file', isEncrypted: true, senderDeviceId: PHONE_ID, senderPublicKey: rig.phone.publicKey,
            targetDeviceId: rig.me, body: body.body, deviceKeyMap: { [rig.me]: body.entry },
            files: [{ fileKey: 'fk', fileName: 'file', fileType: 'application/octet-stream', fileSize: 16, iv: file.iv, deviceKeyMap: { [rig.me]: file.entry } }],
        }, {
            deviceId: () => rig.me,
            saveFile: async (_push, f, sealedSize) => { saved.push({ fileName: f.fileName, fileSize: sealedSize }); return `/tmp/${f.fileName}`; },
            notify: async () => true,
        });

        expect(ok).toBe(true);
        expect(saved).toEqual([{ fileName: 'shot.png', fileSize: 9 }]);
    });
});

describe('hostile relay — a plaintext command to a listener that only seals', () => {
    const BLOCKED = readFileSync(new URL('./fixtures/panes/claude-blocked-bash.txt', import.meta.url), 'utf-8');

    /** A listener that has sealed once (a sealed screen request is the first seal), and what the commands do to its session. */
    const sealedOnlyListener = async () => {
        const rig = await setUp();
        await rig.screenRequest();
        const typed: string[] = [];
        const inserted: string[] = [];
        const keys: string[][] = [];
        const reports: { reason: string }[] = [];
        const downloads: string[] = [];
        const deps = {
            deviceId: () => rig.me,
            paneProbe: () => ({ command: 'claude', shellMarked: false }),
            inject: (_: string, text: string) => { typed.push(text); return true; },
            insertText: (_: string, text: string) => { inserted.push(text); return true; },
            sendKeys: (_: string, tokens: string[]) => { keys.push(tokens); return true; },
            downloadAttachments: async (pushId: string) => { downloads.push(pushId); return ['/tmp/x.sh']; },
            capturePane: () => BLOCKED,
            rateLimit: () => true,
            paneCwd: () => null,
            reportRefusal: (r: { reason: string }) => { reports.push(r); },
        };
        const plain = (fields: object = {}) => ({
            pushId: 'p1', type: 'agent.command', targetDeviceId: rig.me, agentSessionName: 'hwip-a', senderDeviceId: PHONE_ID, ...fields,
        });
        return { rig, deps, plain, typed, inserted, keys, reports, downloads };
    };

    it('should type nothing of a plain body, and tell the phone why', async () => {
        const { rig, deps, plain, typed, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ body: 'rm -rf ~' }), deps)).toBe(false);

        expect(typed).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should type nothing of a plain insert', async () => {
        const { rig, deps, plain, inserted, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ insert: 'y' }), deps)).toBe(false);

        expect(inserted).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should download and type nothing of a plain attachment with no body', async () => {
        const { rig, deps, plain, typed, downloads, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ files: [{ fileKey: 'files/x.sh', fileName: 'x.sh', fileType: 'text/plain', fileSize: 4 }] }), deps)).toBe(false);

        expect(downloads).toEqual([]);
        expect(typed).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should save no plain file push: the relay could have written every byte and name', async () => {
        const { rig } = await sealedOnlyListener();
        const saved: string[] = [];

        const ok = await rig.listener.handlePush({
            pushId: 'p1', type: 'file', senderDeviceId: PHONE_ID, targetDeviceId: rig.me,
            files: [{ fileKey: 'files/run.command', fileName: 'run.command', fileType: 'text/plain', fileSize: 4 }],
        }, {
            deviceId: () => rig.me,
            saveFile: async (_push, f) => { saved.push(f.fileName); return `/tmp/${f.fileName}`; },
            notify: async () => true,
        });

        expect(ok).toBe(false);
        expect(saved).toEqual([]);
    });

    it('should still save a file sealed for this machine', async () => {
        const { rig } = await sealedOnlyListener();
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const me = getDevicePublicKey() ?? '';
        const file = rig.phone.sealFile(Buffer.from('png bytes'), me);
        const body = rig.phone.sealPush({ files: [{ iv: file.iv, name: 'shot.png', type: 'image/png', size: 9 }] }, me);
        const saved: string[] = [];

        const ok = await rig.listener.handlePush({
            pushId: 'p1', type: 'file', isEncrypted: true, senderDeviceId: PHONE_ID, senderPublicKey: rig.phone.publicKey,
            targetDeviceId: rig.me, body: body.body, deviceKeyMap: { [rig.me]: body.entry },
            files: [{ fileKey: 'fk', fileName: 'file', fileType: 'application/octet-stream', fileSize: 16, iv: file.iv, deviceKeyMap: { [rig.me]: file.entry } }],
        }, {
            deviceId: () => rig.me,
            saveFile: async (_push, f) => { saved.push(f.fileName); return `/tmp/${f.fileName}`; },
            notify: async () => true,
        });

        expect(ok).toBe(true);
        expect(saved).toEqual(['shot.png']);
    });

    it('should refuse plain keys, and tell the phone why: a relay could have written them', async () => {
        const { rig, deps, plain, keys, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ keys: ['enter'] }), deps)).toBe(false);

        expect(keys).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should refuse plain keys bound to a prompt just the same', async () => {
        const { parseBlockedDialog } = await import('./blocked-prompt.js');
        const { rig, deps, plain, keys, reports } = await sealedOnlyListener();
        const ifPrompt = parseBlockedDialog(BLOCKED)?.id;

        expect(await rig.listener.handlePush(plain({ keys: ['enter'], ifPrompt }), deps)).toBe(false);
        expect(keys).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should refuse a plain body bound to a prompt just the same', async () => {
        const { parseBlockedDialog } = await import('./blocked-prompt.js');
        const { rig, deps, plain, typed, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ body: 'y', ifPrompt: parseBlockedDialog(BLOCKED)?.id }), deps)).toBe(false);

        expect(typed).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should still type what the phone sealed', async () => {
        const { rig, deps, typed } = await sealedOnlyListener();
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();
        const sealed = rig.phone.sealPush({ body: 'do the thing', cmd: { n: 1000, session: 'hwip-a', device: rig.me } }, getDevicePublicKey() ?? '');

        expect(await rig.listener.handlePush({
            pushId: 'p1', type: 'agent.command', isEncrypted: true, targetDeviceId: rig.me, agentSessionName: 'hwip-a',
            senderDeviceId: PHONE_ID, senderPublicKey: rig.phone.publicKey, body: sealed.body, deviceKeyMap: { [rig.me]: sealed.entry },
        }, deps)).toBe(true);

        expect(typed).toEqual(['do the thing']);
    });

    it('should refuse a plain body when the trust file cannot be read', async () => {
        const { rig, deps, plain, typed, reports } = await sealedOnlyListener();
        writeFileSync(join(TMP, 'trusted-devices.json'), '{ not json');

        expect(await rig.listener.handlePush(plain({ body: 'rm -rf ~' }), deps)).toBe(false);

        expect(typed).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should refuse named keys that come with a plain body: the text is not dropped on its own', async () => {
        const { rig, deps, plain, typed, keys, reports } = await sealedOnlyListener();

        expect(await rig.listener.handlePush(plain({ keys: ['enter'], body: 'rm -rf ~' }), deps)).toBe(false);

        expect(typed).toEqual([]);
        expect(keys).toEqual([]);
        expect(reports).toEqual([expect.objectContaining({ reason: 'e2ee_required' })]);
    });

    it('should type a plain body while the listener has never sealed (as before)', async () => {
        const rig = await setUp();
        const typed: string[] = [];

        expect(await rig.listener.handlePush(
            { pushId: 'p1', type: 'agent.command', targetDeviceId: rig.me, agentSessionName: 'hwip-a', body: 'do the thing' },
            {
                deviceId: () => rig.me, paneProbe: () => ({ command: 'claude', shellMarked: false }),
                inject: (_: string, text: string) => { typed.push(text); return true; }, rateLimit: () => true, paneCwd: () => null,
            },
        )).toBe(true);

        expect(typed).toEqual(['do the thing']);
    });

    it('should type a plain body on a listener with no device list to check against (as before)', async () => {
        const { rig, deps, plain, typed } = await sealedOnlyListener();
        rig.listener.setSubscriberTrust(null);

        expect(await rig.listener.handlePush(plain({ body: 'do the thing' }), deps)).toBe(true);

        expect(typed).toEqual(['do the thing']);
    });
});
