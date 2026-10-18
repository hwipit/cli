import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ensurePrivateDir, ensurePrivateFile, handBackToSudoUser } from './private-files.js';

/**
 * Process-level facts about the resident `hwip listener` daemon: where its
 * PID/version stamps live, whether one is alive, how to stop it and how to
 * respawn it detached.
 *
 * This lives OUTSIDE listener.ts on purpose. `wrapper.ts` (the `hwip cc` hot
 * path) needs all of it, and importing listener.ts there would drag `ws` +
 * the crypto stack into every agent launch. Same split as
 * listener-device-id.ts — one small module both sides can read.
 *
 * Why a version stamp at all: `npm i -g @hwip/cli` replaces the package on
 * disk but NOT the daemon already running from the old dist. That daemon
 * keeps answering pushes (so chat looks fine) while silently ignoring every
 * subtype added since it started — which is exactly how a pre-1.24 listener
 * left the phone's live terminal spinning until the machine was rebooted.
 * Stamping the version next to the PID makes that drift detectable.
 */

const HWIP_DIR = join(homedir(), '.hwip');
export const LISTENER_PID_FILE = join(HWIP_DIR, 'listener.pid');
/** CLI version the running daemon booted from. Absent ⇒ pre-stamp build. */
export const LISTENER_VERSION_FILE = join(HWIP_DIR, 'listener.version');
/**
 * The socket the running daemon actually connected to. A stamp rather than a
 * line in listener.log, because the log rotates at 5MB and a long-lived daemon
 * — exactly the one whose config edit has been outlived — loses its own startup
 * line to that rotation, which would silently switch the staleness check off.
 */
export const LISTENER_WS_URL_FILE = join(HWIP_DIR, 'listener.wsurl');
export const LISTENER_LOG_FILE = join(HWIP_DIR, 'listener.log');

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PID of the listener on record, or null when the file is missing or stale.
 * Stale PID files (process gone) read as "no listener" so a crashed daemon
 * never blocks the next autostart.
 */
export const runningListenerPid = (): number | null => {
    try {
        const pid = Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim());
        if (!Number.isFinite(pid) || pid <= 0) return null;
        process.kill(pid, 0); // signal 0 = existence check, throws when gone
        return pid;
    } catch {
        return null;
    }
};

/**
 * CLI version the running daemon started from, or null when unknown.
 * null is meaningful: every build before the stamp existed predates the
 * live-terminal protocol, so callers treat "unknown" as "stale".
 */
export const runningListenerVersion = (): string | null => {
    try {
        return readFileSync(LISTENER_VERSION_FILE, 'utf-8').trim() || null;
    } catch {
        return null;
    }
};

/** Claim the singleton slot for THIS process and stamp the version with it. */
export const writeListenerRuntime = (version: string, wsUrl?: string): void => {
    ensurePrivateDir(HWIP_DIR);
    writeFileSync(LISTENER_PID_FILE, String(process.pid));
    writeFileSync(LISTENER_VERSION_FILE, version);
    if (wsUrl) writeFileSync(LISTENER_WS_URL_FILE, wsUrl);
    for (const file of [LISTENER_PID_FILE, LISTENER_VERSION_FILE, ...(wsUrl ? [LISTENER_WS_URL_FILE] : [])]) handBackToSudoUser(file);
};

/** The socket the running daemon connected to, or null when it is unknown. */
export const runningListenerWsUrl = (): string | null => {
    if (runningListenerPid() === null) return null;
    try {
        return readFileSync(LISTENER_WS_URL_FILE, 'utf-8').trim() || null;
    } catch {
        return null;
    }
};

/**
 * Drop the PID/version stamps, but only when they still name `pid` — a
 * successor that already claimed the slot must not be trampled by a
 * predecessor's exit handler.
 */
export const clearListenerRuntime = (pid: number): void => {
    try {
        if (!existsSync(LISTENER_PID_FILE)) return;
        if (Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim()) !== pid) return;
        unlinkSync(LISTENER_PID_FILE);
        for (const stamp of [LISTENER_VERSION_FILE, LISTENER_WS_URL_FILE]) {
            try {
                unlinkSync(stamp);
            } catch { /* best-effort — a missing stamp is already the desired state */ }
        }
    } catch { /* best-effort */ }
};

/**
 * Drop stamps left behind by a daemon that died without running its exit
 * handler (crash, SIGKILL, reboot-era leftovers). No-op while one is alive.
 */
export const clearStaleListenerRuntime = (): void => {
    if (runningListenerPid() !== null) return;
    try {
        unlinkSync(LISTENER_PID_FILE);
    } catch { /* nothing to clear */ }
    try {
        unlinkSync(LISTENER_VERSION_FILE);
    } catch { /* nothing to clear */ }
};

/** What `ps` says about a pid. */
export type PidCommand =
    | { readonly kind: 'running'; readonly command: string }
    | { readonly kind: 'gone' }
    | { readonly kind: 'unchecked'; readonly reason: string };

export const commandOfPid = (pid: number): PidCommand => {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2_000 });
    if (result.error) return { kind: 'unchecked', reason: result.error.message };
    const command = result.stdout.trim();
    if (result.status === 0 && command) return { kind: 'running', command };
    // A missing pid is a bare non-zero exit; anything on stderr is ps itself
    // failing ("process id too large"), which says nothing about the pid.
    const complaint = result.stderr.trim();
    return complaint ? { kind: 'unchecked', reason: complaint } : { kind: 'gone' };
};

/**
 * True when a command line is hwip's listener daemon: the word before
 * `listener` is hwip's own script — the bin shim (`…/hwip`), the published
 * package's entry (`…/@hwip/cli/dist/cli.js`: global install, npx), or this
 * CLI's own file (a dev checkout). Any other `…/cli.js listener` (Zeph's runs
 * on the same machines), or a file that only sits under a `hwip*` directory,
 * does not pass. Exported for tests, which pass `ownCliPath`.
 */
export const isHwipListenerCommand = (command: string, ownCliPath: string | null = resolveCliPath()): boolean => {
    const words = command.trim().split(/\s+/);
    const at = words.indexOf('listener');
    if (at < 1) return false;
    const script = words[at - 1];
    // A shebang script shows up by its full path, so a bare `hwip` word is
    // some other command (`grep hwip listener`), not the shim.
    return script.endsWith('/hwip') || script.endsWith('/@hwip/cli/dist/cli.js') || script === ownCliPath;
};

/** Whether the pid in the pid file is still hwip's listener. */
export type ListenerPidCheck =
    | { readonly kind: 'ours' }
    | { readonly kind: 'gone' }
    /** Another process holds the pid — only its program name, since its
     *  arguments can hold secrets. */
    | { readonly kind: 'foreign'; readonly program: string }
    /** hwip's listener from another checkout or worktree
     *  (`…/cli-wt-x/dist/cli.js listener`), which `isHwipListenerCommand`
     *  cannot vouch for. Left running with its stamps — clearing them would
     *  let a second daemon start and answer every push twice. */
    | { readonly kind: 'other-listener'; readonly script: string }
    | { readonly kind: 'unchecked'; readonly reason: string };

/**
 * The pid file can outlive a crashed daemon and its pid be reused by any
 * process, so a pid is only ours while its command line says so.
 */
export const checkListenerPid = (
    pid: number,
    commandOf: (pid: number) => PidCommand = commandOfPid,
    isHwipScript: (script: string) => boolean = isHwipCliScript,
): ListenerPidCheck => {
    const found = commandOf(pid);
    if (found.kind !== 'running') return found;
    if (isHwipListenerCommand(found.command)) return { kind: 'ours' };
    const script = listenerScriptOf(found.command);
    if (script !== null && isHwipScript(script)) return { kind: 'other-listener', script };
    return { kind: 'foreign', program: basename(found.command.split(/\s+/)[0]) };
};

/**
 * Whether a script belongs to a checkout of this CLI: the nearest
 * package.json above it names `@hwip/cli`. That is what tells another hwip
 * worktree's `dist/cli.js` from Zeph's, which has the same shape.
 */
const isHwipCliScript = (script: string): boolean => {
    for (let dir = dirname(script), up = 0; up < 3; dir = dirname(dir), up++) {
        try {
            return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown }).name === '@hwip/cli';
        } catch { /* no package.json here: look one level up */ }
    }
    return false;
};

/** What every caller says about an `other-listener`. */
export const otherListenerNote = (pid: number, script: string): string =>
    `pid ${pid} is a hwip listener from another checkout (${script}) — left it running; stop it from there`;

/**
 * Any `<script>.js listener` command line: hwip's own, or one from another
 * checkout or worktree of it (`…/cli-wt-x/dist/cli.js listener`), which
 * `isHwipListenerCommand` cannot vouch for. Zeph's listener has the same
 * shape — deferring to it costs one start, a second hwip daemon costs every
 * push answered twice.
 */
const listenerScriptOf = (command: string): string | null => {
    const words = command.trim().split(/\s+/);
    const at = words.indexOf('listener');
    return at >= 1 && /\.[cm]?[jt]s$/.test(words[at - 1]) ? words[at - 1] : null;
};

/**
 * Whether the pid on record should be treated as a live listener: hwip's own
 * or listener-shaped command line, or one `ps` could not check — two daemons
 * answering the same pushes is the worse failure. `hwip verify` and the
 * startup guard ask the same question.
 */
export const isListenerPid = (pid: number, commandOf: (pid: number) => PidCommand = commandOfPid): boolean => {
    const found = commandOf(pid);
    if (found.kind !== 'running') return found.kind === 'unchecked';
    return isHwipListenerCommand(found.command) || listenerScriptOf(found.command) !== null;
};

/**
 * The pid of another hwip listener holding the singleton slot, or null. A pid
 * the OS handed to an unrelated process is not a listener: deferring to it
 * would end launchd's or `hwip cc`'s daemon with exit 0 and leave no listener
 * at all, so its stamps are cleared and the slot is free.
 */
export const otherListenerPid = (
    selfPid: number = process.pid,
    commandOf: (pid: number) => PidCommand = commandOfPid,
): number | null => {
    const pid = runningListenerPid();
    if (pid === null || pid === selfPid) return null;
    if (isListenerPid(pid, commandOf)) return pid;
    clearListenerRuntime(pid);
    return null;
};

export type ListenerStop =
    | { readonly kind: 'stopped' }
    /** It outlived the grace window and took SIGKILL. */
    | { readonly kind: 'killed' }
    | Exclude<ListenerPidCheck, { kind: 'ours' }>;

/**
 * Stop the daemon and wait for the process to actually go away — but only a
 * process that is still hwip's listener (`checkListenerPid`); anything else is
 * left alone and reported, and a pid file pointing at a stranger is cleared.
 * SIGTERM first so its exit handler clears the stamps, SIGKILL once the grace
 * window expires.
 *
 * Waiting matters: the caller's next move is spawning a replacement, and two
 * live daemons on one machine both answer the same pushes.
 */
export const stopListener = async (
    pid: number,
    commandOf: (pid: number) => PidCommand = commandOfPid,
    timeoutMs = 3_000,
): Promise<ListenerStop> => {
    const check = checkListenerPid(pid, commandOf);
    // The stamps name a daemon that is gone; left in place they would keep
    // the next daemon's singleton guard deferring to a stranger.
    if (check.kind === 'foreign') clearListenerRuntime(pid);
    if (check.kind !== 'ours') return check;
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return { kind: 'gone' };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(50);
        try {
            process.kill(pid, 0);
        } catch {
            clearListenerRuntime(pid);
            return { kind: 'stopped' };
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch { /* raced us to exit */ }
    clearListenerRuntime(pid);
    return { kind: 'killed' };
};

/**
 * Set by the listener on the `hwip <agent> --detach` it runs for a schedule. That child is the listener's own: when its
 * build is newer than the running listener's (after an upgrade) `ensureListenerRunning` would restart the listener, and
 * the restart would end the launch's own parent. With this set it leaves the listener alone, and removes the variable from
 * its environment so that nothing the launch starts after it (the tmux server, the agent) inherits it.
 */
export const LISTENER_LAUNCH_ENV = 'HWIP_LISTENER_LAUNCH';

/**
 * Path to the running cli.js entry. wrapper.js/listener.js sit next to cli.js
 * in dist/, so __dirname resolves it directly — independent of how the user
 * invoked us.
 *
 * `process.argv[1]` is unreliable here: when `hwip` runs via the npm-installed
 * bin shim (`/usr/local/bin/hwip` → cli.js via a wrapper script), argv[1] is
 * the shim path (`.../bin/hwip`), NOT `cli.js`. That made the original
 * `/cli\.(js|ts|mjs|cjs)$/` check silently reject the entry and the autospawn
 * never fired — the bug only surfaced once the user switched to the global
 * npm install.
 *
 * Fall back to argv[1] only when the __dirname-relative file doesn't exist
 * (some packaging where dist layout differs).
 */
export const resolveCliPath = (): string | null => {
    const local = join(__dirname, 'cli.js');
    if (existsSync(local)) return local;
    const entry = process.argv[1];
    if (entry && /cli\.(js|ts|mjs|cjs)$/.test(entry)) return entry;
    return null;
};

/**
 * Rotate the listener log once it grows past 5 MB. The daemon runs for days
 * and writes 2-3 lines per 5-s cycle, so without rotation the file climbs
 * into the tens of megabytes. Keep the previous window under `.old`.
 *
 * Copy-truncate rather than rename, because the writer is not always ours.
 * Under the login-time LaunchAgent, launchd opens `StandardOutPath` itself
 * and holds that fd for the life of the job: a rename moves the directory
 * entry and leaves launchd appending to the very same inode, now called
 * `.old`. The log the user tails would never shrink. Emptying the file in
 * place keeps the inode — and the fd — valid.
 */
const LISTENER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const rotateListenerLogIfLarge = (): void => {
    try {
        if (!existsSync(LISTENER_LOG_FILE)) return;
        if (statSync(LISTENER_LOG_FILE).size <= LISTENER_LOG_MAX_BYTES) return;
        copyFileSync(LISTENER_LOG_FILE, LISTENER_LOG_FILE + '.old');
        truncateSync(LISTENER_LOG_FILE, 0);
    } catch { /* best-effort */ }
};

/**
 * Launch `hwip listener` detached, with output appended to the listener log
 * so nothing is lost once we let go of it. Null when the cli entry couldn't
 * be resolved or the spawn failed.
 */
const spawnDetachedChild = (): ChildProcess | null => {
    const cliPath = resolveCliPath();
    if (!cliPath) return null;
    try {
        // The log can quote what the listener was handed; only its owner reads it.
        ensurePrivateDir(HWIP_DIR);
        ensurePrivateFile(LISTENER_LOG_FILE);
        const out = openSync(LISTENER_LOG_FILE, 'a');
        const child = spawn(process.execPath, [cliPath, 'listener'], {
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...process.env, HWIP_LISTENER_AUTOSTART: '1' },
        });
        // An async spawn failure (EACCES, EAGAIN) arrives as 'error' with no
        // 'exit'; unhandled, it would crash `hwip cc` mid-wait.
        child.once('error', () => {});
        child.unref();
        return child;
    } catch {
        return null;
    }
};

/**
 * How long a daemon `hwip cc` just spawned gets to fail. The fast deaths — no
 * key, no tmux, no socket URL — come before the daemon writes its pid file;
 * a rejected key closes the first socket within about a second.
 */
export const LISTENER_START_GRACE_MS = 1_500;

export type ListenerStart =
    | { readonly kind: 'running' }
    /** It exited 0: another daemon won the singleton slot, so one is running. */
    | { readonly kind: 'deferred' }
    /** It died inside the grace window; `line` is the last line it logged. */
    | { readonly kind: 'died'; readonly code: number | null; readonly line: string | null }
    /** launchd started it, and after the grace window it is not running. */
    | { readonly kind: 'not-up'; readonly line: string | null }
    | { readonly kind: 'not-spawned' };

/** Why a start failed, in one line for the user; null when a listener is up. */
export const startFailure = (started: ListenerStart): string | null => {
    switch (started.kind) {
        case 'running':
        case 'deferred':
            return null;
        case 'not-spawned':
            return 'it could not be launched';
        case 'died':
            return started.line ?? (started.code === null ? 'it was killed by a signal' : `it exited with code ${started.code}`);
        case 'not-up':
            return started.line ?? 'it is not running and logged nothing';
    }
};

/** Where the log ends now: what a start writes after this is that start's. */
export const listenerLogSize = (): number => {
    try {
        return statSync(LISTENER_LOG_FILE).size;
    } catch {
        return 0;
    }
};

/** The last non-blank line written to the log past `offset` (from the start if it shrank). */
const lastLogLineSince = (offset: number): string | null => {
    try {
        const log = readFileSync(LISTENER_LOG_FILE);
        const lines = log.subarray(log.length < offset ? 0 : offset).toString('utf-8').split('\n');
        return lines.map((line) => line.trim()).filter(Boolean).pop() ?? null;
    } catch {
        return null;
    }
};

/**
 * Spawn the daemon and watch it through the grace window. A daemon that dies
 * on a missing key, a missing tmux or a rejected key only says so in the log,
 * so `hwip cc` used to print "listener autostarted" over a dead one and the
 * phone silently lost control.
 */
export const startListenerDetached = async (
    spawnChild: () => Pick<ChildProcess, 'once' | 'exitCode'> | null = spawnDetachedChild,
    graceMs: number = LISTENER_START_GRACE_MS,
): Promise<ListenerStart> => {
    const offset = listenerLogSize();
    const child = spawnChild();
    if (!child) return { kind: 'not-spawned' };
    const code = await new Promise<number | null | undefined | 'spawn-error'>((settle) => {
        if (child.exitCode !== null) return settle(child.exitCode);
        const timer = setTimeout(() => settle(undefined), graceMs);
        child.once('exit', (exitCode: number | null) => {
            clearTimeout(timer);
            settle(exitCode);
        });
        // A failed spawn (missing node, EACCES) emits 'error' and never 'exit'.
        child.once('error', () => {
            clearTimeout(timer);
            settle('spawn-error');
        });
    });
    if (code === 'spawn-error') return { kind: 'not-spawned' };
    if (code === undefined) return { kind: 'running' };
    if (code === 0) return { kind: 'deferred' };
    return { kind: 'died', code, line: lastLogLineSince(offset) };
};

/** How long launchd gets to bring a kickstarted daemon as far as its pid file. */
export const LISTENER_SERVICE_START_MS = 5_000;

const SERVICE_POLL_MS = 250;

/**
 * After `launchctl kickstart`: launchd starts the daemon, so there is no child
 * to watch — only the pid file it writes once its key, tmux and socket URL
 * check out, and the log it says why in. A daemon that dies there is restarted
 * by launchd on a loop, and `hwip cc` used to report it "started". Waits for a
 * pid other than `previousPid` (the daemon `kickstart -k` replaced may still
 * be shutting down), then for the grace window a rejected key needs.
 */
export const awaitServiceListener = async (
    logOffset: number,
    previousPid: number | null,
    deps: { sleep: (ms: number) => Promise<void>; runningPid: () => number | null } = { sleep, runningPid: runningListenerPid },
    graceMs: number = LISTENER_START_GRACE_MS,
    startMs: number = LISTENER_SERVICE_START_MS,
): Promise<ListenerStart> => {
    const up = (): boolean => {
        const pid = deps.runningPid();
        return pid !== null && pid !== previousPid;
    };
    const notUp = (): ListenerStart => ({ kind: 'not-up', line: lastLogLineSince(logOffset) });
    for (let waited = 0; !up(); waited += SERVICE_POLL_MS) {
        if (waited >= startMs) return notUp();
        await deps.sleep(SERVICE_POLL_MS);
    }
    await deps.sleep(graceMs);
    return up() ? { kind: 'running' } : notUp();
};
