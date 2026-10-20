import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// A window a phone watches is sized to the phone while the phone is its latest
// user, and gets its width back when the phone leaves or a desktop client is
// used. tmux is faked: the window's width, attached-client count and client
// activity are the only state the contract turns on.
const FIELD_SEP = '␟';
const SESSION = 'hwip-a';
/** `activity`: each attached client's `#{client_activity}`, in seconds. */
const win: { attached: number; width: number; activity: number[] } = { attached: 0, width: 120, activity: [] };
const tmuxCalls: string[][] = [];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : [...args];
    tmuxCalls.push(a);
    if (a[0] === 'list-panes') {
        const row = [SESSION, String(win.attached), '1700000000', '1700000000', '0', '0', '%0', 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''];
        return { status: 0, stdout: row.join(FIELD_SEP) + '\n', stderr: '' };
    }
    if (a[0] === 'display-message') {
        const format = a[a.length - 1];
        if (format.includes('#{window_width}')) {
            return { status: 0, stdout: [win.attached, 1, win.width].join(FIELD_SEP), stderr: '' };
        }
        if (format.includes('#{session_name}')) return { status: 0, stdout: ['node', SESSION, ''].join(FIELD_SEP), stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'resize-window') {
        win.width = Number(a[a.indexOf('-x') + 1]);
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'list-clients') return { status: 0, stdout: win.activity.map((t) => `${t}\n`).join(''), stderr: '' };
    if (a[0] === 'send-keys') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'idle pane\n', stderr: '' };
    if (a[0] === 'set-option' || a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const { handleStreamControl, handleCommandInput, stopAllStreams, computeListenerDeviceId } = await import('./listener.js');

describe('stream — a watched window fits the phone while it is the latest user', () => {
    const device = computeListenerDeviceId();
    const control = (subtype: string, extra: Record<string, unknown> = {}) =>
        handleStreamControl({ subtype, targetDeviceId: device, sessionName: SESSION, renew: true, ...extra }, () => {});
    const resizes = () => tmuxCalls.filter((c) => c[0] === 'resize-window').map((c) => c[c.indexOf('-x') + 1]);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        win.attached = 0;
        win.width = 120;
        win.activity = [];
        tmuxCalls.length = 0;
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('sizes the window to the phone on start and gives the width back on stop', () => {
        control('agent.stream.start', { cols: 45 });
        expect(win.width).toBe(45);

        control('agent.stream.stop');
        expect(win.width).toBe(120);
        expect(tmuxCalls).toContainEqual(['set-option', '-w', '-u', '-t', '%0', 'window-size']);
    });

    it('does not bounce the width when the same phone subscribes again', () => {
        control('agent.stream.start', { cols: 45 });
        control('agent.stream.start', { cols: 45 });
        expect(resizes()).toEqual(['45']);
    });

    it('follows the phone on renew and lets go once a desktop attaches', () => {
        control('agent.stream.start', { cols: 45 });
        control('agent.stream.renew', { cols: 80 });
        expect(win.width).toBe(80);

        win.attached = 1;
        control('agent.stream.renew', { cols: 80 });
        expect(resizes()).toEqual(['45', '80']);
        expect(tmuxCalls.at(-2)).toEqual(['set-option', '-w', '-u', '-t', '%0', 'window-size']);
    });

    it('fits an attached session the desktop has not used since the phone opened it', () => {
        vi.setSystemTime(1_000_000_000);
        win.attached = 1;
        win.activity = [999_000];
        control('agent.stream.start', { cols: 45 });
        expect(resizes()).toEqual(['45']);
    });

    it('phone input takes the width back after the desktop used the session', () => {
        vi.setSystemTime(1_000_000_000);
        win.attached = 1;
        win.activity = [999_000];
        control('agent.stream.start', { cols: 45 });

        // A key pressed on the desktop: the next renew hands the window to tmux, which sizes it to the client.
        win.activity = [1_000_002];
        vi.setSystemTime(1_000_005_000);
        control('agent.stream.renew', { cols: 45 });
        expect(tmuxCalls).toContainEqual(['set-option', '-w', '-u', '-t', '%0', 'window-size']);
        win.width = 120;

        vi.setSystemTime(1_000_010_000);
        handleCommandInput({ subtype: 'agent.command.input', targetDeviceId: device, sessionName: SESSION, seq: 1, epoch: 1, keys: ['down'] }, () => {});
        expect(resizes()).toEqual(['45', '45']);
        expect(win.width).toBe(45);
    });

    it('reopening the mirror takes the width back after the desktop used the session', () => {
        vi.setSystemTime(1_000_000_000);
        win.attached = 1;
        win.activity = [999_000];
        control('agent.stream.start', { cols: 45 });
        win.activity = [1_000_002];
        vi.setSystemTime(1_000_005_000);
        control('agent.stream.renew', { cols: 45 });
        win.width = 120;

        vi.setSystemTime(1_000_010_000);
        control('agent.stream.start', { cols: 45 });
        expect(resizes()).toEqual(['45', '45']);
    });

    it('hands the window back on a renew that keeps the width while several phones watch', () => {
        vi.setSystemTime(1_000_000_000);
        win.attached = 1;
        win.activity = [999_000];
        control('agent.stream.start', { cols: 45, deviceId: 'phone-a' });
        control('agent.stream.start', { cols: 45, deviceId: 'phone-b' });
        const unsets = () => tmuxCalls.filter((c) => c[0] === 'set-option' && c.includes('window-size')).length;
        expect(unsets()).toBe(0);

        win.activity = [1_000_002];
        vi.setSystemTime(1_000_005_000);
        control('agent.stream.renew', { cols: 45, deviceId: 'phone-a' });
        expect(unsets()).toBe(1);
    });

    it('resizes nothing for a viewer that sends no width', () => {
        control('agent.stream.start');
        control('agent.stream.stop');
        expect(resizes()).toEqual([]);
    });
});
