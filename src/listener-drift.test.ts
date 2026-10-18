import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTENER_LAUNCH_ENV, type ListenerStart } from './listener-process.js';
import { VERSION } from './config.js';

// The incident this guards: `npm i -g @hwip/cli` replaced the package but
// the daemon kept running the old build for a full day, answering pushes
// (so chat worked) while ignoring `agent.stream.start` entirely — the phone's
// live terminal just spun. Only a machine reboot cleared it. `hwip cc` now
// notices the drift and swaps the daemon out.
const proc = vi.hoisted(() => ({
    runningListenerPid: vi.fn<() => number | null>(() => null),
    runningListenerVersion: vi.fn<() => string | null>(() => null),
    stopListener: vi.fn(async () => ({ kind: 'stopped' as const })),
    startListenerDetached: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
    awaitServiceListener: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
}));

vi.mock('./listener-process.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-process.js')>()),
    runningListenerPid: () => proc.runningListenerPid(),
    runningListenerVersion: () => proc.runningListenerVersion(),
    stopListener: (pid: number) => proc.stopListener(pid),
    startListenerDetached: () => proc.startListenerDetached(),
    awaitServiceListener: () => proc.awaitServiceListener(),
    listenerLogSize: () => 0,
}));

const { ensureListenerRunning, listenerVersionDrifted } = await import('./wrapper.js');

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    proc.runningListenerPid.mockReturnValue(null);
    proc.runningListenerVersion.mockReturnValue(null);
    proc.startListenerDetached.mockResolvedValue({ kind: 'running' });
    proc.awaitServiceListener.mockResolvedValue({ kind: 'running' });
});

describe('listenerVersionDrifted', () => {
    it('is true when the installed package is newer than the daemon', () => {
        expect(listenerVersionDrifted('1.25.0', '1.26.0')).toBe(true);
    });

    it('is false when they match', () => {
        expect(listenerVersionDrifted('1.26.0', '1.26.0')).toBe(false);
    });

    // Several installs on one account (nvm node versions, a repo build next
    // to the global one) would otherwise kill and respawn each other's daemon
    // on every `hwip cc` — and downgrading a healthy newer daemon reopens the
    // gap this whole check exists to close.
    it('leaves a daemon newer than the caller alone', () => {
        expect(listenerVersionDrifted('1.26.0', '1.25.0')).toBe(false);
        expect(listenerVersionDrifted('1.26.0', '0.0.0-semantic-release')).toBe(false);
    });

    // No stamp ⇒ the daemon booted from a build that predates stamping,
    // which is by definition older than anything that writes one.
    it('treats an unstamped daemon as drifted', () => {
        expect(listenerVersionDrifted(null, '1.26.0')).toBe(true);
    });
});

describe('ensureListenerRunning', () => {
    it('leaves a current daemon alone', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(VERSION);
        await ensureListenerRunning();
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    // An unstamped daemon is the incident's shape: it booted from a build
    // that predates stamping, so it is stale by definition. (A concrete
    // older version can't be used here — VERSION is the unreplaced
    // semantic-release placeholder in a checkout, so nothing sorts below it.
    // The version comparison itself is covered above.)
    it('replaces a daemon left behind by an upgrade', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.startListenerDetached).toHaveBeenCalled();
    });

    // Order matters: two live daemons both answer the same pushes, so the
    // old one has to be confirmed gone before the new one starts.
    it('stops the old daemon before spawning the new one', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(proc.stopListener.mock.invocationCallOrder[0])
            .toBeLessThan(proc.startListenerDetached.mock.invocationCallOrder[0]);
    });

    it('does not spawn a replacement when the old pid could not be checked', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        proc.stopListener.mockResolvedValueOnce({ kind: 'unchecked', reason: 'ps ENOENT' } as never);
        await ensureListenerRunning();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    // The listener's own `hwip <agent> --detach` for a schedule: restarting its parent would end the launch.
    it('leaves a stale daemon alone when the listener itself is the caller', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        vi.stubEnv(LISTENER_LAUNCH_ENV, '1');
        try {
            await ensureListenerRunning();
        } finally {
            vi.unstubAllEnvs();
        }
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    // The tmux server a scheduled launch may start would keep the variable for every pane after it.
    it('takes the listener-launch marker out of the environment so tmux does not inherit it', async () => {
        vi.stubEnv(LISTENER_LAUNCH_ENV, '1');
        try {
            await ensureListenerRunning();
            expect(process.env[LISTENER_LAUNCH_ENV]).toBeUndefined();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('autostarts when nothing is running', async () => {
        await ensureListenerRunning();
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.startListenerDetached).toHaveBeenCalled();
    });

    // C4: a daemon that died on a missing key or tmux used to be announced
    // as "autostarted", and the phone silently lost the session.
    it('says why the daemon died instead of announcing it', async () => {
        proc.startListenerDetached.mockResolvedValue({
            kind: 'died', code: 3, line: 'hwip listener: API key required. Run `hwip install` or set HWIP_API_KEY.',
        });
        await ensureListenerRunning();
        expect(console.log).not.toHaveBeenCalled();
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('stopped right after starting — hwip listener: API key required');
    });

    it('names the exit code when the daemon logged nothing', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'died', code: 127, line: null });
        await ensureListenerRunning();
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('exited with code 127');
    });

    // Exit 0 is the singleton guard deferring to a daemon another `hwip cc`
    // started a moment earlier: one is running, which is all that matters.
    it('stays quiet when another daemon won the slot', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'deferred' });
        await ensureListenerRunning();
        expect(console.error).not.toHaveBeenCalled();
    });

    // Non-fatal by design: `hwip cc` still has to launch the agent.
    it('reports a failed spawn without throwing', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'not-spawned' });
        await expect(ensureListenerRunning()).resolves.toBeUndefined();
        expect(console.error).toHaveBeenCalled();
    });
});
