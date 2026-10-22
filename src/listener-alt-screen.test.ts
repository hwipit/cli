import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// A pane in the alternate screen (a full-screen TUI such as Claude Code's
// fullscreen renderer) keeps no tmux scrollback, so the phone cannot page its
// history. The listener says which screen the pane is on, and turns the
// phone's wheel keys into wheel input for the TUI to scroll itself.
//
// tmux is faked wholesale, as in listener-stream-cadence.test.ts.
const FIELD_SEP = '␟';
const SESSIONS = ['hwip-a'];

/** The stream tick's geometry answer: cursor_x, cursor_y, pane_height, history_size, alternate_on. */
let geometry = '';
let paneText = 'a steady pane\n';
const sendKeys: string[][] = [];

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
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: 'node', stderr: '' };
        if (a[4]?.startsWith('#{cursor_x}')) return { status: 0, stdout: geometry, stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: paneText, stderr: '' };
    if (a[0] === 'send-keys') {
        sendKeys.push([...a]);
        return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
};

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

const TMP = mkdtempSync(join(tmpdir(), 'hwip-alt-screen-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    parsePaneGeometry,
    buildStreamFrame,
    handleStreamControl,
    stopAllStreams,
    computeListenerDeviceId,
    STREAM_GEOMETRY_FORMAT,
    STREAM_INTERVAL_MS,
} = await import('./listener.js');

describe('alternate screen frame', () => {
    it('reads the screen the pane is on from the tick it already makes', () => {
        expect(STREAM_GEOMETRY_FORMAT).toContain('#{alternate_on}');
        expect(parsePaneGeometry('12,3,55,0,1')).toEqual({
            x: 12, y: 3, height: 55, historySize: 0, alternateScreen: true,
        });
        expect(parsePaneGeometry('12,3,55,842,0')).toEqual({
            x: 12, y: 3, height: 55, historySize: 842, alternateScreen: false,
        });
    });

    // An older tmux, or a format it does not know, answers an empty field. Not
    // known is not "normal screen": the viewer would page a history that is
    // not there or stop paging one that is.
    it('leaves the screen unknown when tmux does not say', () => {
        expect(parsePaneGeometry('12,3,55,842')).toEqual({ x: 12, y: 3, height: 55, historySize: 842 });
        expect(parsePaneGeometry('12,3,55,842,')).toEqual({ x: 12, y: 3, height: 55, historySize: 842 });
        expect(parsePaneGeometry('12,3,55,842,x')).toEqual({ x: 12, y: 3, height: 55, historySize: 842 });
    });

    it('carries the screen in a plaintext frame', async () => {
        const frame = await buildStreamFrame({ content: 'pane', truncated: false }, 'hwip-a', undefined, { alternateScreen: true });
        expect(frame).toMatchObject({ alternateScreen: true, content: 'pane' });
    });

    it('leaves the field out when the screen is unknown', async () => {
        const frame = await buildStreamFrame({ content: 'pane', truncated: false }, 'hwip-a', undefined, {});
        expect(frame).not.toHaveProperty('alternateScreen');
    });

    // A viewer of a sealed stream reads only the sealed copy, so the field has
    // to be inside the envelope, not just beside it.
    it('seals the screen with the pane', async () => {
        const { initDeviceCrypto, getDevicePublicKey, openV2, isSealedV2 } = await import('./crypto.js');
        await initDeviceCrypto();
        const self = getDevicePublicKey() ?? '';
        const frame = await buildStreamFrame(
            { content: 'pane', truncated: false }, 'hwip-a', self, { alternateScreen: true }, { seq: 1, epoch: 1 },
        );
        expect(frame).not.toHaveProperty('content');
        const envelope = frame?.encrypted;
        if (!isSealedV2(envelope)) throw new Error('not a v2 envelope');
        const sealed = JSON.parse(await openV2('stream.frame', envelope, self, 'hwip-a'));
        expect(sealed).toMatchObject({ content: 'pane', alternateScreen: true });
        expect(frame).toMatchObject({ alternateScreen: true });
    });

    describe('on the stream', () => {
        const device = computeListenerDeviceId();
        let sent: Array<Record<string, unknown>>;
        const send = (data: Record<string, unknown>) => { sent.push(data); };
        const frames = () => sent.filter((f) => typeof f.content === 'string');

        beforeEach(() => {
            vi.useFakeTimers();
            vi.spyOn(console, 'log').mockImplementation(() => {});
            sent = [];
            paneText = 'a steady pane\n';
        });
        afterEach(() => {
            stopAllStreams();
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        // A TUI that opens its alternate screen over an identical first paint
        // changes nothing the text and cursor gate looks at; the viewer would
        // keep paging a history that is gone.
        it('sends a frame when only the screen changed', async () => {
            geometry = '0,0,1,0,0';
            handleStreamControl({ subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'hwip-a', renew: true }, send);
            await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
            expect(frames()).toHaveLength(1);
            expect(frames().at(-1)).toMatchObject({ alternateScreen: false });

            geometry = '0,0,1,0,1';
            await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
            expect(frames()).toHaveLength(2);
            expect(frames().at(-1)).toMatchObject({ alternateScreen: true });

            await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS * 3);
            expect(frames()).toHaveLength(2);
        });
    });
});
