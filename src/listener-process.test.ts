import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module resolves its paths from homedir() at import time, so each case
// gets a throwaway $HOME and a fresh module graph.
const homes: string[] = [];
const originalHome = process.env.HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'hwip-listener-proc-'));
    homes.push(home);
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./listener-process.js');
    mkdirSync(join(home, '.hwip'), { recursive: true });
    return { ...mod, home };
};

/** A pid that is guaranteed dead: spawn something trivial and let it exit. */
const deadPid = async (): Promise<number> => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.on('exit', resolve));
    return child.pid as number;
};

/** A pid that is guaranteed alive until stopped. */
const livePid = (): { pid: number; exited: Promise<void> } => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return { pid: child.pid as number, exited };
};

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

describe('listener runtime stamps', () => {
    it('writes the pid and the version stamp together', async () => {
        const m = await load();
        m.writeListenerRuntime('9.9.9');
        expect(readFileSync(m.LISTENER_PID_FILE, 'utf-8')).toBe(String(process.pid));
        expect(m.runningListenerPid()).toBe(process.pid);
        expect(m.runningListenerVersion()).toBe('9.9.9');
    });

    it('reports no listener when the stamp is missing', async () => {
        const m = await load();
        expect(m.runningListenerPid()).toBeNull();
        expect(m.runningListenerVersion()).toBeNull();
    });

    it('treats a stale pid file as no listener', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(await deadPid()));
        expect(m.runningListenerPid()).toBeNull();
    });

    // The drift check reads "no version stamp" as "older than the stamp
    // itself", so an empty file must not read as a valid version.
    it('reads an empty version stamp as unknown', async () => {
        const m = await load();
        m.writeListenerRuntime('');
        expect(m.runningListenerVersion()).toBeNull();
    });
});

describe('clearListenerRuntime', () => {
    it('clears our own stamps', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearListenerRuntime(process.pid);
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        expect(existsSync(m.LISTENER_VERSION_FILE)).toBe(false);
    });

    // A predecessor's exit handler must not delete the slot a successor
    // already claimed — that would void the singleton guard.
    it('leaves a successor’s stamps alone', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearListenerRuntime(process.pid + 1);
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
    });
});

describe('clearStaleListenerRuntime', () => {
    it('keeps the stamps of a live listener', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearStaleListenerRuntime();
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
    });

    it('clears the stamps of a dead one', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(await deadPid()));
        m.clearStaleListenerRuntime();
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        expect(existsSync(m.LISTENER_VERSION_FILE)).toBe(false);
    });
});

describe('stopListener', () => {
    const LISTENER = '/usr/local/bin/node /usr/local/lib/node_modules/@hwip/cli/dist/cli.js listener';
    const asListener = () => ({ kind: 'running' as const, command: LISTENER });

    it('kills a live listener and waits for it to be gone', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(pid));
        expect(await m.stopListener(pid, asListener)).toEqual({ kind: 'stopped' });
        await exited;
        expect(() => process.kill(pid, 0)).toThrow();
        // A stop clears the slot so the next start isn't blocked by it.
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
    });

    it('reports a process that is already gone', async () => {
        const m = await load();
        expect(await m.stopListener(await deadPid())).toEqual({ kind: 'gone' });
    });

    // The pid file outlives a crashed daemon, and its pid can be reused.
    it('leaves a live process that is not the listener alone, naming only its program', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            const outcome = await m.stopListener(pid);
            expect(outcome).toEqual({ kind: 'foreign', program: 'node' });
            expect(() => process.kill(pid, 0)).not.toThrow();
            // The stale pid file goes, so the next daemon does not defer to it.
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    // C73: a daemon from another worktree of this CLI is still hwip's. Its
    // stamps going would let `hwip cc` start a second one, and both would
    // answer every push.
    it('leaves another checkout\'s hwip listener running, stamps and all', async () => {
        const m = await load();
        const checkout = join(m.home, 'cli-wt-x');
        mkdirSync(join(checkout, 'dist'), { recursive: true });
        writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: '@hwip/cli' }));
        const script = join(checkout, 'dist', 'cli.js');
        const { pid, exited } = livePid();
        try {
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            const outcome = await m.stopListener(pid, () => ({ kind: 'running', command: `node ${script} listener` }));
            expect(outcome).toEqual({ kind: 'other-listener', script });
            expect(() => process.kill(pid, 0)).not.toThrow();
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
            expect(m.otherListenerNote(pid, script)).toContain('another checkout');
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    // Zeph's listener has the same `…/dist/cli.js listener` shape; a pid it
    // reused is a stranger, and its stamps go as before.
    it('clears the stamps when a listener-shaped pid belongs to another package', async () => {
        const m = await load();
        const checkout = join(m.home, 'zeph-cli');
        mkdirSync(join(checkout, 'dist'), { recursive: true });
        writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: '@zeph-to/cli' }));
        const { pid, exited } = livePid();
        try {
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            const outcome = await m.stopListener(pid, () => ({ kind: 'running', command: `node ${join(checkout, 'dist', 'cli.js')} listener` }));
            expect(outcome).toEqual({ kind: 'foreign', program: 'node' });
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    it('does not signal a pid it could not check', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            const outcome = await m.stopListener(pid, () => ({ kind: 'unchecked', reason: 'spawnSync ps ENOENT' }));
            expect(outcome).toEqual({ kind: 'unchecked', reason: 'spawnSync ps ENOENT' });
            expect(() => process.kill(pid, 0)).not.toThrow();
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });
});

describe('isHwipListenerCommand', () => {
    const OWN_CLI = '/Users/me/workspace/hwipit/cli/dist/cli.js';

    it.each([
        ['the login-time service and hwip cc', '/usr/local/bin/node /usr/local/lib/node_modules/@hwip/cli/dist/cli.js listener', true],
        ['the bin shim (hwip listener)', 'node /opt/homebrew/bin/hwip listener', true],
        ['npx', 'node /Users/me/.npm/_npx/1a2b/node_modules/@hwip/cli/dist/cli.js listener', true],
        ['this dev checkout', `node ${OWN_CLI} listener`, true],
        ['another dev checkout', 'node /Users/me/workspace/hwipit/cli-wt-old/dist/cli.js listener', false],
        ['another program under a hwip* directory', 'node /Users/me/workspace/hwipit/tools/serve.js listener', false],
        ["Zeph's listener", 'node /Users/me/.local/lib/node_modules/@zeph-to/cli/dist/cli.js listener', false],
        ['another program', 'vim notes.txt', false],
        ['a word that only looks like hwip', 'grep hwip-notes listener', false],
        ['a bare hwip word', 'man hwip listener', false],
    ])('recognises %s: %s', async (_, command, expected) => {
        const m = await load();
        expect(m.isHwipListenerCommand(command, OWN_CLI)).toBe(expected);
    });
});

describe('commandOfPid', () => {
    it('reads a command line from ps, and gone for a free pid', async () => {
        const m = await load();
        // Only ESRCH means free: EPERM is a live process of another user.
        const isFree = (pid: number) => {
            try {
                process.kill(pid, 0);
                return false;
            } catch (err) {
                return err instanceof Error && 'code' in err && err.code === 'ESRCH';
            }
        };
        const freePid = Array.from({ length: 1000 }, (_, i) => 99_000 - i).find(isFree) ?? 99_000;

        expect(m.commandOfPid(process.pid)).toMatchObject({ kind: 'running', command: expect.stringMatching(/node/) });
        expect(m.commandOfPid(freePid)).toEqual({ kind: 'gone' });
    });

    // macOS ps answers a pid beyond its range on stderr ("process id too
    // large") — checked there; Linux procps words it differently.
    it.runIf(process.platform === 'darwin')('reports a ps complaint as unchecked, not gone', async () => {
        const m = await load();
        expect(m.commandOfPid(2 ** 22 + 7)).toMatchObject({ kind: 'unchecked' });
    });
});

/**
 * Under the login-time LaunchAgent, launchd holds the daemon's stdout fd open
 * on `listener.log`. Renaming the file leaves that fd writing to the same inode
 * under its new name — the log the user tails never shrinks, and the daemon
 * runs for weeks. Rotation has to keep the inode and empty it.
 */
describe('rotateListenerLogIfLarge', () => {
    it('empties the log in place and keeps the old contents beside it', async () => {
        const m = await load();
        const big = 'x'.repeat(6 * 1024 * 1024);
        writeFileSync(m.LISTENER_LOG_FILE, big);
        const inodeBefore = statSync(m.LISTENER_LOG_FILE).ino;

        m.rotateListenerLogIfLarge();

        // Same file, now empty — the fd launchd holds keeps working.
        expect(existsSync(m.LISTENER_LOG_FILE)).toBe(true);
        expect(statSync(m.LISTENER_LOG_FILE).size).toBe(0);
        expect(statSync(m.LISTENER_LOG_FILE).ino).toBe(inodeBefore);
        expect(readFileSync(`${m.LISTENER_LOG_FILE}.old`, 'utf-8')).toHaveLength(big.length);
    });

    it('leaves a log under the threshold alone', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_LOG_FILE, 'small');
        m.rotateListenerLogIfLarge();
        expect(readFileSync(m.LISTENER_LOG_FILE, 'utf-8')).toBe('small');
        expect(existsSync(`${m.LISTENER_LOG_FILE}.old`)).toBe(false);
    });

    it('is a no-op when there is no log yet', async () => {
        const m = await load();
        expect(() => m.rotateListenerLogIfLarge()).not.toThrow();
        expect(existsSync(m.LISTENER_LOG_FILE)).toBe(false);
    });
});

// C33: the startup guard used to defer to any live pid in the pid file, so a
// reused pid ended launchd's daemon with exit 0 and left no listener at all.
describe('otherListenerPid', () => {
    const LISTENER = '/usr/local/bin/node /usr/local/lib/node_modules/@hwip/cli/dist/cli.js listener';

    it('defers to a live hwip listener', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            m.writeListenerRuntime('1.0.0');
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            expect(m.otherListenerPid(process.pid, () => ({ kind: 'running', command: LISTENER }))).toBe(pid);
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    it('frees the slot when the pid now belongs to another program', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            m.writeListenerRuntime('1.0.0');
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            expect(m.otherListenerPid(process.pid, () => ({ kind: 'running', command: '/usr/bin/vim notes.md' }))).toBeNull();
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
            expect(existsSync(m.LISTENER_VERSION_FILE)).toBe(false);
            expect(() => process.kill(pid, 0)).not.toThrow();
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    // Another checkout or worktree of hwip runs `…/cli-wt-x/dist/cli.js
    // listener`, which isHwipListenerCommand cannot vouch for; clearing its
    // stamps would start a second daemon next to it.
    it('defers to a listener from another checkout', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            const other = '/usr/local/bin/node /Users/me/hwipit/cli-wt-x/dist/cli.js listener';
            expect(m.otherListenerPid(process.pid, () => ({ kind: 'running', command: other }))).toBe(pid);
            expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    it('still defers when ps could not check the pid', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        try {
            writeFileSync(m.LISTENER_PID_FILE, String(pid));
            expect(m.otherListenerPid(process.pid, () => ({ kind: 'unchecked', reason: 'ps ENOENT' }))).toBe(pid);
        } finally {
            process.kill(pid, 'SIGKILL');
            await exited;
        }
    });

    it('ignores its own pid and a dead one', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_PID_FILE, String(process.pid));
        expect(m.otherListenerPid(process.pid, () => { throw new Error('must not run ps'); })).toBeNull();
        writeFileSync(m.LISTENER_PID_FILE, String(await deadPid()));
        expect(m.otherListenerPid(process.pid, () => { throw new Error('must not run ps'); })).toBeNull();
    });
});

// C4: the daemon dies on a missing key or tmux before writing its pid file,
// and says why only in the log. These children are fakes: nothing is spawned.
describe('startListenerDetached', () => {
    const fakeChild = (exitCode: number | null = null) => {
        const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
        child.exitCode = exitCode;
        return child;
    };

    it('reports the last line the dying daemon logged, not older runs', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_LOG_FILE, 'hwip listener: auth failure (4001 old). Check API key.\n');
        const child = fakeChild();
        const started = m.startListenerDetached(() => {
            setTimeout(() => {
                appendFileSync(m.LISTENER_LOG_FILE, 'hwip listener: API key required. Run `hwip install` or set HWIP_API_KEY.\n\n');
                child.emit('exit', 3);
            }, 10);
            return child;
        }, 5_000);
        expect(await started).toEqual({
            kind: 'died', code: 3, line: 'hwip listener: API key required. Run `hwip install` or set HWIP_API_KEY.',
        });
    });

    it('gives no line when the daemon died silently', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_LOG_FILE, 'an older run\n');
        expect(await m.startListenerDetached(() => fakeChild(127), 5_000)).toEqual({ kind: 'died', code: 127, line: null });
    });

    it('calls a daemon still up after the grace window running', async () => {
        const m = await load();
        expect(await m.startListenerDetached(() => fakeChild(), 20)).toEqual({ kind: 'running' });
    });

    it('reads exit 0 as deferring to a daemon that is already up', async () => {
        const m = await load();
        expect(await m.startListenerDetached(() => fakeChild(0), 5_000)).toEqual({ kind: 'deferred' });
    });

    // node emits 'error' and never 'exit' when the spawn itself fails.
    it('reports a spawn that failed asynchronously', async () => {
        const m = await load();
        const child = fakeChild();
        const started = m.startListenerDetached(() => {
            setTimeout(() => child.emit('error', new Error('spawn node ENOENT')), 10);
            return child;
        }, 5_000);
        expect(await started).toEqual({ kind: 'not-spawned' });
    });

    it('reports a daemon killed by a signal as died', async () => {
        const m = await load();
        const child = fakeChild();
        const started = m.startListenerDetached(() => {
            setTimeout(() => child.emit('exit', null, 'SIGKILL'), 10);
            return child;
        }, 5_000);
        expect(await started).toEqual({ kind: 'died', code: null, line: null });
    });

    it('reports a spawn that never happened', async () => {
        const m = await load();
        expect(await m.startListenerDetached(() => null)).toEqual({ kind: 'not-spawned' });
    });
});

// C72: after `launchctl kickstart` there is no child to watch, only the pid
// file and the log. These use fakes: nothing is started or slept on.
describe('awaitServiceListener', () => {
    it('reports a daemon that is not up with the line it logged since the kickstart', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_LOG_FILE, 'an older run\n');
        const offset = m.listenerLogSize();
        appendFileSync(m.LISTENER_LOG_FILE, 'hwip listener: auth failure (4001 bad key). Check API key.\n');
        const started = await m.awaitServiceListener(offset, null, { sleep: async () => {}, runningPid: () => null });
        expect(started).toEqual({ kind: 'not-up', line: 'hwip listener: auth failure (4001 bad key). Check API key.' });
        expect(m.startFailure(started)).toBe('hwip listener: auth failure (4001 bad key). Check API key.');
    });

    it('calls a daemon with a live pid running', async () => {
        const m = await load();
        expect(await m.awaitServiceListener(0, null, { sleep: async () => {}, runningPid: () => 4242 })).toEqual({ kind: 'running' });
    });

    /** A pid file read through a fake clock: `pidAt(ms)` is what it names then. */
    const clocked = (pidAt: (ms: number) => number | null) => {
        let now = 0;
        return { sleep: async (ms: number) => { now += ms; }, runningPid: () => pidAt(now) };
    };

    // `kickstart -k` replaces the daemon; the old one can still be shutting
    // down, pid file and all, while the new one dies on its key.
    it('does not take the replaced daemon, still shutting down, for the new one', async () => {
        const m = await load();
        const started = await m.awaitServiceListener(0, 4242, clocked(() => 4242));
        expect(started.kind).toBe('not-up');
    });

    it('waits for a daemon slow to write its pid, then gives it the grace window', async () => {
        const m = await load();
        expect(await m.awaitServiceListener(0, 4242, clocked((ms) => (ms < 3_000 ? 4242 : 5151)))).toEqual({ kind: 'running' });
    });

    it('reports a new daemon that dies inside the grace window', async () => {
        const m = await load();
        const started = await m.awaitServiceListener(0, null, clocked((ms) => (ms < 1_000 ? 5151 : null)));
        expect(started.kind).toBe('not-up');
    });

    it('names the cause when nothing was logged', async () => {
        const m = await load();
        expect(m.startFailure({ kind: 'not-up', line: null })).toBe('it is not running and logged nothing');
        expect(m.startFailure({ kind: 'died', code: null, line: null })).toBe('it was killed by a signal');
        expect(m.startFailure({ kind: 'died', code: 127, line: null })).toBe('it exited with code 127');
        expect(m.startFailure({ kind: 'deferred' })).toBeNull();
    });
});
