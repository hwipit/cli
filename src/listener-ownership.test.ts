import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenerStart } from './listener-process.js';

/**
 * Who owns the listener process, from the `hwip cc` side.
 * (The `hwip listener --stop|--restart` side lives in listener-lifecycle.test.ts,
 * next to the rest of handleListenerLifecycle.)
 *
 * launchd is the owner. Anything that SIGTERMs its child makes launchd restart
 * that child while the caller spawns its own, and the two race through the
 * singleton guard in handleListener: the loser exits 0, and if the loser is
 * launchd's, KeepAlive either flaps it every ThrottleInterval or — reading a
 * clean exit as deliberate — gives up for the rest of the login session.
 *
 * So every path that used to spawn or kill must ask launchd instead.
 */
const proc = vi.hoisted(() => ({
    runningListenerPid: vi.fn<() => number | null>(() => null),
    runningListenerVersion: vi.fn<() => string | null>(() => null),
    stopListener: vi.fn(async () => ({ kind: 'stopped' as const })),
    startListenerDetached: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
    awaitServiceListener: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
    clearStaleListenerRuntime: vi.fn(),
}));

const svc = vi.hoisted(() => ({
    serviceInstalled: vi.fn(() => false),
    restartService: vi.fn(() => ({ ok: true, notes: ['restarted'] })),
    stopService: vi.fn(() => ({ ok: true, notes: ['unloaded'] })),
}));

vi.mock('./listener-process.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-process.js')>()),
    runningListenerPid: () => proc.runningListenerPid(),
    runningListenerVersion: () => proc.runningListenerVersion(),
    stopListener: (pid: number) => proc.stopListener(pid),
    startListenerDetached: () => proc.startListenerDetached(),
    awaitServiceListener: () => proc.awaitServiceListener(),
    listenerLogSize: () => 0,
    clearStaleListenerRuntime: () => proc.clearStaleListenerRuntime(),
}));

vi.mock('./listener-service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-service.js')>()),
    serviceInstalled: () => svc.serviceInstalled(),
    restartService: () => svc.restartService(),
    stopService: () => svc.stopService(),
}));

const { ensureListenerRunning } = await import('./wrapper.js');

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
    svc.serviceInstalled.mockReturnValue(false);
    svc.restartService.mockReturnValue({ ok: true, notes: ['restarted'] });
});

describe('ensureListenerRunning with the service installed', () => {
    it('asks launchd to start it instead of spawning a second daemon', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        await ensureListenerRunning();
        expect(svc.restartService).toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    // C72: launchd restarts a daemon that dies on a missing or rejected key on
    // a loop; `hwip cc` said "started by launchd" over it.
    it('says why when the daemon launchd started is not up', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.awaitServiceListener.mockResolvedValue({ kind: 'not-up', line: 'hwip listener: API key required.' });
        await ensureListenerRunning();
        expect(console.log).not.toHaveBeenCalled();
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('stopped right after starting — hwip listener: API key required.');
    });

    // The drift path is the dangerous one: it is the only place that used to
    // SIGTERM a live daemon, which under launchd is SIGTERM-ing launchd's child.
    it('replaces a version-drifted daemon through launchd, never SIGTERM', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.runningListenerPid.mockReturnValue(4242);
        // No version stamp = predates stamping = drifted by definition.
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(svc.restartService).toHaveBeenCalled();
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    it('leaves an up-to-date daemon alone', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue('999.0.0');
        await ensureListenerRunning();
        expect(svc.restartService).not.toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });
});

describe('ensureListenerRunning without the service', () => {
    it('still spawns detached, unchanged', async () => {
        await ensureListenerRunning();
        expect(proc.startListenerDetached).toHaveBeenCalled();
        expect(svc.restartService).not.toHaveBeenCalled();
    });

    it('does not start a second daemon beside another checkout\'s listener', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        proc.stopListener.mockResolvedValueOnce({ kind: 'other-listener', script: '/w/cli-wt-x/dist/cli.js' } as never);
        await ensureListenerRunning();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    it('still stops a drifted daemon before respawning', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.startListenerDetached).toHaveBeenCalled();
    });
});
