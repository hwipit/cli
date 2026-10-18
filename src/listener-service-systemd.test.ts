import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListenerStop } from './listener-process.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The systemd half of listener-service, driven without a systemd: every
// systemctl call is recorded, and $HOME is a throwaway directory per case
// (listener-process reads it at import time, hence the fresh module graph).
const homes: string[] = [];
const originalHome = process.env.HOME;
const originalConfig = process.env.XDG_CONFIG_HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'hwip-listener-unit-'));
    homes.push(home);
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    vi.resetModules();
    const mod = await import('./listener-service.js');
    return { ...mod, home };
};

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

const touch = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    return path;
};

const SPEC = {
    nodePath: '/usr/bin/node',
    cliPath: '/usr/lib/node_modules/@hwip/cli/dist/cli.js',
    tmuxPath: '/usr/bin/tmux',
    logPath: '/home/someone/.hwip/listener.log',
    pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin',
    lang: 'C.UTF-8',
};

/** A recording systemd deps double; `pids` is one answer per `runningPid()` call. */
const unitOps = (opts: {
    pids: (number | null)[];
    fails?: string[];
    supported?: boolean;
    spec?: typeof SPEC | null;
    stopOutcome?: ListenerStop;
}) => {
    const calls: string[][] = [];
    const stopped: number[] = [];
    let pidIndex = 0;
    return {
        calls,
        stopped,
        deps: {
            supported: () => opts.supported ?? true,
            resolveSpec: () =>
                opts.spec === null
                    ? ({ ok: false, reason: 'tmux not found' } as const)
                    : ({ ok: true, value: opts.spec ?? SPEC } as const),
            runningPid: () => opts.pids[Math.min(pidIndex++, opts.pids.length - 1)] ?? null,
            stopListener: async (pid: number): Promise<ListenerStop> => {
                stopped.push(pid);
                return opts.stopOutcome ?? { kind: 'stopped' };
            },
            systemctl: (args: string[]) => {
                calls.push(args);
                const failed = (opts.fails ?? []).includes(args[0]);
                return { ok: !failed, stderr: failed ? `${args[0]} failed` : '' };
            },
            settle: async () => {},
        },
    };
};

describe('serviceManager', () => {
    it('is launchd on macOS without asking systemd anything', async () => {
        const m = await load();
        const asked = vi.fn(() => true);
        expect(m.serviceManager('darwin', asked)).toBe('launchd');
        expect(asked).not.toHaveBeenCalled();
    });

    it('is systemd on Linux only when a user manager answers', async () => {
        const m = await load();
        expect(m.serviceManager('linux', () => true)).toBe('systemd');
        // A container, or a shell with no login session, has none.
        expect(m.serviceManager('linux', () => false)).toBeNull();
    });

    it('is nothing elsewhere', async () => {
        const m = await load();
        expect(m.serviceManager('win32', () => true)).toBeNull();
    });
    it('asks nothing when the tests turn the detection off', async () => {
        const m = await load();
        // test-setup plants this switch; the test toggles it and puts the
        // planted value back, whatever the test does in between.
        const planted = process.env.HWIP_TEST_NO_SERVICE_MANAGER;
        process.env.HWIP_TEST_NO_SERVICE_MANAGER = '1';
        try {
            expect(m.serviceManager('linux')).toBeNull();
        } finally {
            if (planted === undefined) delete process.env.HWIP_TEST_NO_SERVICE_MANAGER;
            else process.env.HWIP_TEST_NO_SERVICE_MANAGER = planted;
        }
    });
});

describe('serviceUnitPath', () => {
    it('is the user unit directory under ~/.config by default', async () => {
        const m = await load();
        expect(m.serviceUnitPath()).toBe(join(m.home, '.config', 'systemd', 'user', 'app.hwip.listener.service'));
    });

    it('follows an absolute XDG_CONFIG_HOME and ignores a relative one', async () => {
        const m = await load();
        process.env.XDG_CONFIG_HOME = '/srv/conf';
        expect(m.serviceUnitPath()).toBe('/srv/conf/systemd/user/app.hwip.listener.service');
        process.env.XDG_CONFIG_HOME = 'conf';
        expect(m.serviceUnitPath()).toBe(join(m.home, '.config', 'systemd', 'user', 'app.hwip.listener.service'));
    });
});

describe('renderSystemdUnit', () => {
    it('starts with the user session and comes back only after a non-clean exit', async () => {
        const m = await load();
        const unit = m.renderSystemdUnit(SPEC);
        expect(unit).toMatch(/^\[Unit\]$/m);
        expect(unit).toMatch(/^\[Service\]$/m);
        expect(unit).toMatch(/^\[Install\]$/m);
        expect(unit).toMatch(/^WantedBy=default\.target$/m);
        expect(unit).toMatch(/^Restart=on-failure$/m);
        expect(unit).toMatch(/^RestartSec=30$/m);
    });

    it('runs the baked node and CLI with a PATH that reaches tmux, a UTF-8 LANG and the launch marker', async () => {
        const m = await load();
        const unit = m.renderSystemdUnit(SPEC);
        expect(unit).toContain('ExecStart="/usr/bin/node" "/usr/lib/node_modules/@hwip/cli/dist/cli.js" listener');
        expect(unit).toContain('Environment="PATH=/usr/bin:/bin:/usr/sbin:/sbin"');
        expect(unit).toContain('Environment="LANG=C.UTF-8"');
        expect(unit).toContain('Environment=HWIP_LISTENER_SERVICE=1');
    });

    it('sends both streams to the listener log', async () => {
        const m = await load();
        const unit = m.renderSystemdUnit(SPEC);
        expect(unit).toContain('StandardOutput=append:/home/someone/.hwip/listener.log');
        expect(unit).toContain('StandardError=append:/home/someone/.hwip/listener.log');
    });

    // systemd expands % specifiers everywhere and $VAR in ExecStart=; a path
    // holding either, or a quote or backslash, must reach the process as written.
    it('escapes what systemd would expand or unquote', async () => {
        const m = await load();
        const unit = m.renderSystemdUnit({ ...SPEC, nodePath: '/opt/my node/100%/$HOME/"q"\\b/node' });
        expect(unit).toContain('ExecStart="/opt/my node/100%%/$$HOME/\\"q\\"\\\\b/node"');
    });
    it('kills only the main process, so a tmux server the listener started under the unit survives stop and restart', async () => {
        const m = await load();
        expect(m.renderSystemdUnit(SPEC)).toMatch(/^KillMode=process$/m);
    });

    it('strips control characters so a hostile value cannot start new unit lines', async () => {
        const m = await load();
        const unit = m.renderSystemdUnit({ ...SPEC, lang: 'C.UTF-8\nKillMode=control-group', logPath: '/tmp/x\nWantedBy=evil' });
        expect((unit.match(/^KillMode=/gm) ?? []).length).toBe(1);
        expect(unit).not.toMatch(/^WantedBy=evil$/m);
        expect(unit).toMatch(/^WantedBy=default\.target$/m);
    });
});

describe('serviceStatus (systemd)', () => {
    it('reports not installed when no unit exists', async () => {
        const m = await load();
        const status = m.serviceStatus('systemd');
        expect(status).toMatchObject({ manager: 'systemd', supported: true, installed: false, nodePath: null });
        expect(status.plistPath).toBe(m.serviceUnitPath());
    });

    it('reads back what the installed unit runs, escapes included', async () => {
        const m = await load();
        const node = touch(join(m.home, 'my node', '100%', '$x', 'node'));
        const cli = touch(join(m.home, 'cli.js'));
        mkdirSync(dirname(m.serviceUnitPath()), { recursive: true });
        writeFileSync(m.serviceUnitPath(), m.renderSystemdUnit({ ...SPEC, nodePath: node, cliPath: cli, pathEnv: '/a b:/usr/bin' }));
        const status = m.serviceStatus('systemd');
        expect(status).toMatchObject({
            installed: true, label: 'app.hwip.listener.service', nodePath: node, cliPath: cli,
            pathEnv: '/a b:/usr/bin', langEnv: 'C.UTF-8', missing: [],
        });
    });

    it('names the programs a stale unit points at that no longer exist', async () => {
        const m = await load();
        const cli = touch(join(m.home, 'cli.js'));
        const gone = join(m.home, 'gone', 'node');
        mkdirSync(dirname(m.serviceUnitPath()), { recursive: true });
        writeFileSync(m.serviceUnitPath(), m.renderSystemdUnit({ ...SPEC, nodePath: gone, cliPath: cli }));
        expect(m.serviceStatus('systemd').missing).toEqual([gone]);
    });
    it('answers from the unit file even when no user bus is reachable', async () => {
        const m = await load();
        mkdirSync(dirname(m.serviceUnitPath()), { recursive: true });
        writeFileSync(m.serviceUnitPath(), m.renderSystemdUnit(SPEC));
        expect(m.serviceStatus(null)).toMatchObject({ manager: 'systemd', supported: true, installed: true });
    });
});

describe('installService (systemd)', () => {
    it('writes the unit, reloads, enables and restarts it, then sees the daemon stay up', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null, 5555] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(true);
        expect(readFileSync(m.serviceUnitPath(), 'utf-8')).toBe(m.renderSystemdUnit(SPEC));
        expect(calls).toEqual([['daemon-reload'], ['enable', 'app.hwip.listener.service'], ['restart', 'app.hwip.listener.service']]);
    });

    // Lingering is a system setting: the install says how, and never does it.
    it('explains lingering without turning it on', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null, 5555] });
        const r = await m.installService(deps);
        expect(r.notes.join('\n')).toContain('loginctl enable-linger');
        expect(calls.flat().join(' ')).not.toMatch(/linger/);
    });

    it('makes the log file before systemd opens it, readable by its owner alone', async () => {
        const m = await load();
        const before = process.umask(0o022);
        try {
            await m.installService(unitOps({ pids: [null, 5555] }).deps);
        } finally {
            process.umask(before);
        }
        expect(statSync(join(m.home, '.hwip', 'listener.log')).mode & 0o777).toBe(0o600);
    });

    // Restart=on-failure reads the clean exit of a listener that found another
    // one alive as "stay down", as KeepAlive does under launchd.
    it('stops an already-running listener before starting the unit', async () => {
        const m = await load();
        const { deps, stopped } = unitOps({ pids: [4242, 5555] });
        const r = await m.installService(deps);
        expect(stopped).toEqual([4242]);
        expect(r.notes).toContain('stopped the listener already running (pid 4242) so systemd can own it');
    });

    it('refuses without a user manager, touching nothing', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null], supported: false });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        expect(calls).toEqual([]);
        expect(existsSync(m.serviceUnitPath())).toBe(false);
    });

    it('refuses without writing a unit when the spec cannot be resolved', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null], spec: null });
        expect((await m.installService(deps)).ok).toBe(false);
        expect(calls).toEqual([]);
        expect(existsSync(m.serviceUnitPath())).toBe(false);
    });

    it('names the step systemd refused and goes no further', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null, 5555], fails: ['enable'] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/systemctl --user enable failed/);
        expect(calls.map((c) => c[0])).not.toContain('restart');
    });

    it('fails when no daemon is alive after the restart', async () => {
        const m = await load();
        const r = await m.installService(unitOps({ pids: [null, null] }).deps);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/did not stay up/);
    });

    it('never touches launchd', async () => {
        const m = await load();
        await m.installService(unitOps({ pids: [null, 5555] }).deps);
        expect(existsSync(m.servicePlistPath())).toBe(false);
    });
});

describe('uninstallService (systemd)', () => {
    it('stops and disables the unit, removes it, then reloads', async () => {
        const m = await load();
        await m.installService(unitOps({ pids: [null, 5555] }).deps);
        const { deps, calls } = unitOps({ pids: [5555] });
        const r = await m.uninstallService(deps);
        expect(r.ok).toBe(true);
        expect(calls).toEqual([['disable', '--now', 'app.hwip.listener.service'], ['daemon-reload']]);
        expect(existsSync(m.serviceUnitPath())).toBe(false);
    });

    it('is a no-op when no unit is installed', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [null] });
        const r = await m.uninstallService(deps);
        expect(r.notes.join(' ')).toMatch(/not installed/);
        expect(calls).toEqual([]);
    });
    it('removes the wants/ link itself when disable is refused, and says so', async () => {
        const m = await load();
        await m.installService(unitOps({ pids: [null, 5555] }).deps);
        const wants = join(dirname(m.serviceUnitPath()), 'default.target.wants');
        mkdirSync(wants, { recursive: true });
        writeFileSync(join(wants, 'app.hwip.listener.service'), '');
        const { deps, calls } = unitOps({ pids: [5555], fails: ['disable'] });
        const r = await m.uninstallService(deps);
        expect(r.ok).toBe(true);
        expect(calls).toEqual([['disable', '--now', 'app.hwip.listener.service'], ['daemon-reload']]);
        expect(existsSync(join(wants, 'app.hwip.listener.service'))).toBe(false);
        expect(existsSync(m.serviceUnitPath())).toBe(false);
        expect(r.notes.join(' ')).toMatch(/disable failed/);
        expect(r.notes.join(' ')).toMatch(/removed the default\.target\.wants\/ link directly/);
        expect(r.notes.join(' ')).toMatch(/whether the unit stopped is unknown/);
    });

    it('claims no link removal when there was no link to remove', async () => {
        const m = await load();
        await m.installService(unitOps({ pids: [null, 5555] }).deps);
        const { deps } = unitOps({ pids: [5555], fails: ['disable'] });
        const r = await m.uninstallService(deps);
        expect(r.ok).toBe(true);
        expect(r.notes.join(' ')).not.toMatch(/removed the default\.target\.wants\/ link/);
        expect(r.notes.join(' ')).toMatch(/whether the unit stopped is unknown/);
    });
});

describe('stopService / restartService (systemd)', () => {
    it('stops with stop, leaving the unit enabled for the next login', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [5555] });
        expect(m.stopService(deps).ok).toBe(true);
        expect(calls).toEqual([['stop', 'app.hwip.listener.service']]);
    });

    it('restarts with restart and names a refusal', async () => {
        const m = await load();
        const { deps, calls } = unitOps({ pids: [5555] });
        expect(m.restartService(deps).ok).toBe(true);
        expect(calls).toEqual([['restart', 'app.hwip.listener.service']]);
        const refused = m.restartService(unitOps({ pids: [5555], fails: ['restart'] }).deps);
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.reason).toBe('systemctl --user restart failed: restart failed');
    });
});

describe('quiet service-manager calls', () => {
    const seen: { program: string; args: string[]; opts: unknown }[] = [];
    // A recorded throwing execFileSync instead of a spy: node builtin
    // namespaces cannot be redefined, so the mock goes in by module.
    const loadQuiet = async () => {
        seen.length = 0;
        const home = mkdtempSync(join(tmpdir(), 'hwip-listener-unit-'));
        homes.push(home);
        process.env.HOME = home;
        delete process.env.XDG_CONFIG_HOME;
        vi.resetModules();
        vi.doMock('node:child_process', () => ({
            execFileSync: (program: string, args: string[], opts: unknown) => {
                seen.push({ program, args, opts });
                throw Object.assign(new Error('spawn ETIMEDOUT'), { signal: 'SIGTERM', stderr: Buffer.from('') });
            },
        }));
        try {
            return await import('./listener-service.js');
        } finally {
            vi.doUnmock('node:child_process');
        }
    };

    it('caps systemctl at five seconds and says so when it gives up', async () => {
        const m = await loadQuiet();
        const r = m.defaultSystemdOpDeps.systemctl(['show-environment']);
        expect(r.ok).toBe(false);
        expect(r.stderr).toMatch(/timed out after 5s/);
        expect(seen[0].program).toBe('systemctl');
        expect(seen[0].args).toEqual(['--user', 'show-environment']);
        expect(seen[0].opts).toMatchObject({ timeout: 5_000 });
    });

    it('leaves launchctl unbounded, exactly as before', async () => {
        const m = await loadQuiet();
        const r = m.defaultServiceOpDeps.launchctl(['bootout', 'gui/501/app.hwip.listener']);
        expect(r.ok).toBe(false);
        expect(seen[0].program).toBe('launchctl');
        expect('timeout' in (seen[0].opts as object)).toBe(false);
    });
});

describe('serviceHealthChecks (systemd)', () => {
    const status = {
        manager: 'systemd' as const, supported: true, installed: true, label: 'app.hwip.listener.service',
        plistPath: '/home/someone/.config/systemd/user/app.hwip.listener.service', nodePath: '/usr/bin/node',
        cliPath: '/usr/lib/node_modules/@hwip/cli/dist/cli.js', pathEnv: '/usr/bin:/bin', langEnv: 'C.UTF-8', missing: [],
    };

    it('names systemd, not launchd, for a unit that is not running', async () => {
        const m = await load();
        const rows = m.serviceHealthChecks(status, { tmuxOnPath: () => true, loaded: () => false });
        const warn = rows.filter((r) => r.state === 'warn');
        expect(warn).toHaveLength(1);
        expect(warn[0].label).toMatch(/systemd is not running it/);
        expect(rows.map((r) => r.label).join('\n')).not.toMatch(/launchd/);
    });

    it('passes every row on a healthy unit', async () => {
        const m = await load();
        const rows = m.serviceHealthChecks(status, { tmuxOnPath: () => true, loaded: () => true });
        expect(rows.map((r) => r.state)).toEqual(rows.map(() => 'pass'));
        expect(rows.at(-1)?.label).toBe('systemd is running the unit');
    });
});
