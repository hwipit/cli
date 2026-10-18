import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// tmux is faked as in listener-stream-lease.test.ts: the inventory guard needs
// a pane running an agent, and the capture loop needs something to capture.
const FIELD_SEP = '␟';
const SESSIONS = ['hwip-a', 'hwip-b'];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
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
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'secret pane\n', stderr: '' };
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
    };
});

/**
 * The frames a sealed stream sends carry, inside the envelope, the session,
 * the capture stamp and the subscriber's nonce — the same values the relay
 * sees in the clear. A viewer compares the two, so a frame moved to another
 * stream or replayed from an earlier subscription does not open as this one.
 */
describe('sealed stream frames are bound to their stream', () => {
    let TMP: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
        TMP = mkdtempSync(join(tmpdir(), 'listener-stream-bound-'));
        process.env.HOME = TMP;
        vi.resetModules();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(async () => {
        const { stopAllStreams } = await import('./listener.js');
        stopAllStreams();
        vi.restoreAllMocks();
        rmSync(TMP, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    const subscribe = async (sessionName: string, nonce: string) => {
        const { handleStreamControl, computeListenerDeviceId, setSubscriberTrust } = await import('./listener.js');
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        const { trustEveryKey } = await import('../tests/helpers/trust.js');
        // What is under test here starts after the subscriber's key checked out.
        setSubscriberTrust(trustEveryKey);
        await initDeviceCrypto();
        const sent: Array<Record<string, unknown>> = [];
        handleStreamControl(
            {
                subtype: 'agent.stream.start', targetDeviceId: computeListenerDeviceId(), sessionName, renew: true,
                // Sealed for this device itself, so the test can open what it sends.
                subscriberPublicKey: getDevicePublicKey() ?? undefined, subscriberNonce: nonce,
            },
            (d) => sent.push(d),
        );
        return sent;
    };

    const firstFrame = async (sent: Array<Record<string, unknown>>) => {
        const isFrame = (f: Record<string, unknown>) => f.subtype === 'agent.stream.frame' && f.encrypted;
        await vi.waitFor(() => expect(sent.some(isFrame)).toBe(true), { timeout: 3000 });
        return sent.find(isFrame)!;
    };

    /** Opened as the subscriber (this device itself): a v2 frame, bound to its session. */
    const open = async (frame: Record<string, unknown>) => {
        const { openV2, getDevicePublicKey, isSealedV2 } = await import('./crypto.js');
        const self = getDevicePublicKey();
        if (!isSealedV2(frame.encrypted) || !self || typeof frame.sessionName !== 'string') throw new Error('not a v2 frame');
        return JSON.parse(await openV2('stream.frame', frame.encrypted, self, frame.sessionName)) as Record<string, unknown>;
    };

    it('seals the cleartext stamp and the subscription nonce with the pane', async () => {
        const frame = await firstFrame(await subscribe('hwip-a', 'Zmlyc3Q='));
        const sealed = await open(frame);
        expect(sealed).toMatchObject({ sessionName: 'hwip-a', nonce: 'Zmlyc3Q=', content: 'secret pane\n' });
        expect(sealed.seq).toBe(frame.seq);
        expect(sealed.epoch).toBe(frame.epoch);
        expect(frame).not.toHaveProperty('content');
    });

    it('takes the new nonce when the same session is subscribed again', async () => {
        await firstFrame(await subscribe('hwip-a', 'Zmlyc3Q='));
        const again = await firstFrame(await subscribe('hwip-a', 'c2Vjb25k'));
        expect((await open(again)).nonce).toBe('c2Vjb25k');
    });

    it.each([
        ['too long', 'x'.repeat(200)],
        ['empty', ''],
        ['not a string', 123],
    ])('ignores a nonce that is %s', async (_, nonce) => {
        const frame = await firstFrame(await subscribe('hwip-b', nonce as string));
        expect(await open(frame)).not.toHaveProperty('nonce');
    });
});
