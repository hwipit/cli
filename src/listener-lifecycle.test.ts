import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenerStart } from './listener-process.js';

// `hwip listener --stop|--restart` is the supported way to replace a stale
// daemon. It must short-circuit before verifyTmux (stopping a daemon can't
// depend on a healthy tmux) and must never leave two listeners racing for the
// same pushes — so the restart path stops first, then spawns.
const proc = vi.hoisted(() => ({
    runningListenerPid: vi.fn<() => number | null>(() => null),
    stopListener: vi.fn(async () => ({ kind: 'stopped' as const })),
    startListenerDetached: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
    awaitServiceListener: vi.fn(async (): Promise<ListenerStart> => ({ kind: 'running' })),
    clearStaleListenerRuntime: vi.fn(),
}));

const svc = vi.hoisted(() => ({
    installService: vi.fn(async () => ({ ok: true, notes: [] as string[] })),
    uninstallService: vi.fn(async () => ({ ok: true, notes: [] as string[] })),
    serviceInstalled: vi.fn(() => false),
    restartService: vi.fn(() => ({ ok: true, notes: ['restarted'] })),
    stopService: vi.fn(() => ({ ok: true, notes: ['unloaded'] })),
    serviceStatus: vi.fn(() => ({
        supported: true,
        installed: false,
        label: 'app.hwip.listener',
        plistPath: '/tmp/app.hwip.listener.plist',
        nodePath: null as string | null,
        cliPath: null as string | null,
        pathEnv: null as string | null,
        missing: [] as string[],
    })),
}));

vi.mock('./listener-service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-service.js')>()),
    installService: () => svc.installService(),
    uninstallService: () => svc.uninstallService(),
    serviceStatus: () => svc.serviceStatus(),
    serviceInstalled: () => svc.serviceInstalled(),
    restartService: () => svc.restartService(),
    stopService: () => svc.stopService(),
}));

vi.mock('./listener-process.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-process.js')>()),
    runningListenerPid: () => proc.runningListenerPid(),
    stopListener: (pid: number) => proc.stopListener(pid),
    startListenerDetached: () => proc.startListenerDetached(),
    awaitServiceListener: () => proc.awaitServiceListener(),
    listenerLogSize: () => 0,
    clearStaleListenerRuntime: () => proc.clearStaleListenerRuntime(),
}));

const { handleListener } = await import('./listener.js');

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    proc.runningListenerPid.mockReturnValue(null);
    proc.startListenerDetached.mockResolvedValue({ kind: 'running' });
    proc.awaitServiceListener.mockResolvedValue({ kind: 'running' });
    svc.serviceInstalled.mockReturnValue(false);
    svc.restartService.mockReturnValue({ ok: true, notes: ['restarted'] });
});

describe('hwip listener --stop', () => {
    it('stops the running daemon without respawning it', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    it('clears a crashed daemon’s stamps when nothing is running', async () => {
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.clearStaleListenerRuntime).toHaveBeenCalled();
    });

    it('reports a pid file that pointed at another process instead of claiming a stop', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.stopListener.mockResolvedValueOnce({ kind: 'foreign', program: 'vim' } as never);
        const log = vi.mocked(console.log);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(log.mock.calls.flat().join('\n')).toContain('left pid 4242 alone');
    });

    // C73: stopping it is that checkout's call; starting one here would
    // put two daemons on the same pushes.
    it('leaves another checkout\'s listener running and does not start a second', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.stopListener.mockResolvedValueOnce({ kind: 'other-listener', script: '/w/cli-wt-x/dist/cli.js' } as never);
        expect(await handleListener({ restart: true })).toBe(1);
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('/w/cli-wt-x/dist/cli.js');
    });

    it('fails when it could not check the pid', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.stopListener.mockResolvedValueOnce({ kind: 'unchecked', reason: 'ps ENOENT' } as never);
        expect(await handleListener({ stop: true })).toBe(1);
    });

    it('says when the stop needed SIGKILL', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.stopListener.mockResolvedValueOnce({ kind: 'killed' } as never);
        const log = vi.mocked(console.log);
        await handleListener({ stop: true });
        expect(log.mock.calls.flat().join('\n')).toContain('stopped pid 4242 (forced)');
    });

    // Our own pid in the file is not "another listener" — killing it would
    // mean the command shooting itself.
    it('ignores a pid file pointing at this process', async () => {
        proc.runningListenerPid.mockReturnValue(process.pid);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).not.toHaveBeenCalled();
    });
});

describe('hwip listener --restart', () => {
    it('stops the old daemon before spawning the new one', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ restart: true })).toBe(0);
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.startListenerDetached).toHaveBeenCalled();
        expect(proc.stopListener.mock.invocationCallOrder[0])
            .toBeLessThan(proc.startListenerDetached.mock.invocationCallOrder[0]);
    });

    it('starts one even when nothing was running', async () => {
        expect(await handleListener({ restart: true })).toBe(0);
        expect(proc.startListenerDetached).toHaveBeenCalled();
    });

    it('exits 1 with the log line when the new daemon dies at once', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'died', code: 3, line: 'hwip listener: API key required.' });
        expect(await handleListener({ restart: true })).toBe(1);
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('API key required');
    });

    // Exit 0 inside the grace window is the singleton guard deferring to a
    // daemon that is already up — a listener is running, so this is success.
    it('treats a new daemon that deferred to a running one as restarted', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'deferred' });
        expect(await handleListener({ restart: true })).toBe(0);
    });

    it('fails loudly when the cli entry cannot be resolved', async () => {
        proc.startListenerDetached.mockResolvedValue({ kind: 'not-spawned' });
        expect(await handleListener({ restart: true })).toBe(1);
    });
});

// The login-time service is what stops a reboot from emptying the phone's
// picker. Its flags must route before verifyTmux and before anything that
// would start a daemon in *this* process.
describe('hwip listener service flags', () => {
    it('installs the service without starting a daemon here', async () => {
        expect(await handleListener({ 'install-service': true })).toBe(0);
        expect(svc.installService).toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    // A failed install must be a non-zero exit: the whole point of the
    // post-install check is that a silent failure looks identical to success.
    it('reports a failed install as an error exit', async () => {
        svc.installService.mockResolvedValueOnce({ ok: false, reason: 'tmux not found', notes: [] } as never);
        expect(await handleListener({ 'install-service': true })).toBe(1);
    });

    it('removes the service on --uninstall-service', async () => {
        expect(await handleListener({ 'uninstall-service': true })).toBe(0);
        expect(svc.uninstallService).toHaveBeenCalled();
    });

    it('reports when no service is installed', async () => {
        expect(await handleListener({ 'service-status': true })).toBe(0);
        expect(svc.serviceStatus).toHaveBeenCalled();
    });

    // Registered but pointing at a node that a version upgrade removed. The
    // job still shows in `launchctl list`, so the exit code is the signal.
    it('exits non-zero when the installed service points at something gone', async () => {
        svc.serviceStatus.mockReturnValueOnce({
            supported: true,
            installed: true,
            label: 'app.hwip.listener',
            plistPath: '/tmp/app.hwip.listener.plist',
            nodePath: '/gone/node',
            cliPath: '/tmp/cli.js',
            pathEnv: '/usr/bin',
            missing: ['/gone/node'],
        });
        expect(await handleListener({ 'service-status': true })).toBe(1);
    });
});

describe('hwip listener --stop/--restart with the service installed', () => {
    it('unloads through launchd instead of signalling the pid', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(svc.stopService).toHaveBeenCalled();
        expect(proc.stopListener).not.toHaveBeenCalled();
    });

    it('restarts through launchd instead of spawning', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ restart: true })).toBe(0);
        expect(svc.restartService).toHaveBeenCalled();
        expect(proc.startListenerDetached).not.toHaveBeenCalled();
    });

    it('reports a launchd failure as an error exit', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        svc.restartService.mockReturnValue({ ok: false, reason: 'not loaded', notes: [] } as never);
        expect(await handleListener({ restart: true })).toBe(1);
    });

    // C72: launchd restarts a daemon that dies on a missing or rejected key on
    // a loop, and --restart said "restarted" over it.
    it('exits 1 with the log line when the restarted daemon is not up', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        proc.awaitServiceListener.mockResolvedValue({ kind: 'not-up', line: 'hwip listener: auth failure (4001 bad key). Check API key.' });
        expect(await handleListener({ restart: true })).toBe(1);
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('auth failure (4001 bad key)');
    });

});

// The macOS wording is a contract: scripts and people grep it. Linux must
// stop borrowing it, so each branch is pinned — macOS byte for byte, Linux
// naming what is actually missing.
describe('hwip listener --service-status wording', () => {
    const capture = (): string[] => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.map(String).join(' ')));
        return lines;
    };
    const onPlatform = async (platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> => {
        const saved = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: platform });
        try {
            await run();
        } finally {
            Object.defineProperty(process, 'platform', saved as PropertyDescriptor);
        }
    };
    const status = (over: Record<string, unknown>) =>
        svc.serviceStatus.mockReturnValueOnce({
            installed: false,
            label: 'app.hwip.listener',
            plistPath: '/tmp/app.hwip.listener.plist',
            nodePath: null,
            cliPath: null,
            pathEnv: null,
            missing: [],
            ...over,
        } as never);

    it('keeps the macOS status output byte for byte', async () => {
        await onPlatform('darwin', async () => {
            status({ supported: true, installed: true, manager: 'launchd', nodePath: '/usr/bin/node', cliPath: '/tmp/cli.js', pathEnv: '/usr/bin' });
            const lines = capture();
            expect(await handleListener({ 'service-status': true })).toBe(0);
            expect(lines).toEqual([
                'hwip listener: app.hwip.listener installed',
                '  plist: /tmp/app.hwip.listener.plist',
                '  node:  /usr/bin/node',
                '  cli:   /tmp/cli.js',
                '  PATH:  /usr/bin',
            ]);
        });
    });

    it('keeps the macOS-only wording when a Mac has nothing', async () => {
        await onPlatform('darwin', async () => {
            status({ supported: false, installed: false, manager: 'launchd' });
            const lines = capture();
            expect(await handleListener({ 'service-status': true })).toBe(0);
            expect(lines).toEqual(['hwip listener: login-time service is macOS-only (launchd).']);
        });
    });

    it('names the unit, not the plist, for a systemd status', async () => {
        await onPlatform('linux', async () => {
            status({ supported: true, installed: true, manager: 'systemd', label: 'app.hwip.listener.service', plistPath: '/home/u/.config/systemd/user/app.hwip.listener.service', nodePath: '/usr/bin/node', cliPath: '/tmp/cli.js', pathEnv: '/usr/bin' });
            const lines = capture();
            expect(await handleListener({ 'service-status': true })).toBe(0);
            expect(lines[0]).toBe('hwip listener: app.hwip.listener.service installed');
            expect(lines[1]).toBe('  unit: /home/u/.config/systemd/user/app.hwip.listener.service');
        });
    });

    it('says the unit needs a user manager when the bus is gone on Linux', async () => {
        await onPlatform('linux', async () => {
            status({ supported: false, installed: true, manager: 'systemd' });
            const lines = capture();
            expect(await handleListener({ 'service-status': true })).toBe(0);
            expect(lines).toEqual(['hwip listener: the unit is installed but no systemd user manager answered — check `systemctl --user`.']);
        });
    });

    it('names systemd or launchd when Linux has neither', async () => {
        await onPlatform('linux', async () => {
            status({ supported: false, installed: false, manager: 'launchd' });
            const lines = capture();
            expect(await handleListener({ 'service-status': true })).toBe(0);
            expect(lines).toEqual(['hwip listener: login-time service needs systemd (`systemctl --user`) or macOS launchd.']);
        });
    });
});
