import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ensurePrivateDir, ensurePrivateFile, handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { LISTENER_LOG_FILE, otherListenerNote, resolveCliPath, runningListenerPid, sleep, stopListener, type ListenerStop } from './listener-process.js';
import { isSupportedNode, SUPPORTED_NODE } from './node-support.js';

/**
 * The listener as an OS service: a launchd LaunchAgent on macOS, a systemd user
 * unit on Linux, that starts it at user login so the phone's picker is populated
 * without anyone opening a terminal.
 *
 * Until this existed, the only thing that ever started the daemon was
 * `hwip cc` (wrapper.ts → startListenerDetached). After a reboot that means an
 * empty picker until the user happens to launch an agent — the machine is
 * online, the past sessions are on disk, and the app says "no agents".
 *
 * Two constraints shape this file:
 *
 * 1. **Node builtins only.** wrapper.ts reads `serviceInstalled()` on the
 *    `hwip cc` hot path, and the same rule that keeps listener.ts out of
 *    wrapper.ts (ws + the crypto stack on every agent launch) applies here.
 *    listener-process.ts is the one import, and it is builtins-only too.
 *
 * 2. **Everything the job needs is resolved at install time and baked into
 *    the plist.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
 *    nothing else — no shell profile, no homebrew prefix. `verifyTmux()`
 *    (listener.ts) exits 127 when tmux is not on PATH, so a plist without a
 *    baked PATH produces a service that dies at every login and is restarted
 *    forever by KeepAlive. The interpreter is baked for the same reason.
 */

/** Reverse-DNS launchd label. Lives on the user's machine once installed —
 *  renaming it orphans every plist already out there. */
export const SERVICE_LABEL = 'app.hwip.listener';

/** The systemd user unit: the same label, so every message that names
 *  SERVICE_LABEL names this unit too. */
export const SERVICE_UNIT = `${SERVICE_LABEL}.service`;

export type ServiceManager = 'launchd' | 'systemd';

/** What launchd itself puts on PATH. Ours is prepended, never replaces this. */
const LAUNCHD_BASE_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Interpreters to try when the CLI's own install prefix has none. */
const NODE_FALLBACKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

/**
 * Locale to fall back on when the shell has none, or has a non-UTF-8 one.
 *
 * launchd hands a job no LANG at all. tmux then runs in the C locale and
 * escapes every non-ASCII byte of its format output to `_` — including the
 * U+241F separator the session inventory is split on. The daemon starts
 * clean, tmux answers, and every session is discarded as unparseable: the
 * phone shows nothing while `launchctl list` and the log both look healthy.
 */
const FALLBACK_LANG = 'en_US.UTF-8';

/** tmux locations to try when the shell can't answer `command -v`. */
const TMUX_FALLBACKS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

/** Version-manager roots. A node under one of these is gone after the next
 *  upgrade, which silently breaks the service months later. */
const VERSION_MANAGER_DIRS = ['/.nvm/', '/.fnm/', '/.volta/', '/.nodenv/', '/.asdf/', '/.n/'];

export interface ServiceSpec {
    readonly nodePath: string;
    readonly cliPath: string;
    readonly tmuxPath: string;
    readonly logPath: string;
    /** PATH baked into the job: tmux dir, node dir, then launchd's own. */
    readonly pathEnv: string;
    /** UTF-8 locale baked into the job. Always UTF-8 — see resolveServiceSpec. */
    readonly lang: string;
}

export type SpecResolution =
    | { readonly ok: true; readonly value: ServiceSpec; readonly warning?: string }
    | { readonly ok: false; readonly reason: string };

/** The machine facts spec resolution needs, injectable so tests describe a
 *  machine instead of inheriting the developer's own. */
export interface ServiceEnv {
    readonly exists: (path: string) => boolean;
    /** Version (`v24.15.0`) of the node at `path`, or null when it won't run. */
    readonly nodeVersion: (path: string) => string | null;
    /** Absolute tmux path from the invoking shell's PATH, or null. */
    readonly whichTmux: () => string | null;
    readonly cliPath: () => string | null;
    /** The invoking shell's LANG, or undefined when it has none. */
    readonly lang: () => string | undefined;
}

export interface ServiceStatus {
    readonly manager: ServiceManager;
    readonly supported: boolean;
    readonly installed: boolean;
    readonly label: string;
    /** The file the service is registered from: the LaunchAgent plist, or under
     *  systemd the unit file. */
    readonly plistPath: string;
    /** Read back from the installed plist — null when nothing is installed. */
    readonly nodePath: string | null;
    readonly cliPath: string | null;
    readonly pathEnv: string | null;
    readonly langEnv: string | null;
    /** Programs the plist names that are no longer on disk. The shape a node
     *  upgrade leaves behind: registered, listed by launchctl, unable to run. */
    readonly missing: readonly string[];
}

/**
 * Which service manager can run the listener here. macOS always has launchd.
 * Linux has a systemd user manager only when one answers: a container, or a
 * shell without a login session, may have none.
 */
export const serviceManager = (
    platform: NodeJS.Platform = process.platform,
    // Tests set HWIP_TEST_NO_SERVICE_MANAGER so a detection never reaches the
    // real host — which may itself run a systemd user manager.
    userManagerAnswers: () => boolean = () =>
        process.env.HWIP_TEST_NO_SERVICE_MANAGER !== '1' && runSystemctl(['show-environment']).ok,
): ServiceManager | null => {
    if (platform === 'darwin') return 'launchd';
    return platform === 'linux' && userManagerAnswers() ? 'systemd' : null;
};

/** launchd on macOS, a systemd user manager on Linux. Every other platform is
 *  an explicit refusal, never a quiet success. */
export const serviceSupported = (): boolean => serviceManager() !== null;

export const servicePlistPath = (): string =>
    join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);

/** Where systemd's user manager reads a user's own units: `$XDG_CONFIG_HOME/systemd/user`,
 *  else `~/.config/systemd/user` (systemd.unit(5), user unit search path). */
export const serviceUnitPath = (): string => {
    const config = process.env.XDG_CONFIG_HOME;
    return join(config && isAbsolute(config) ? config : join(homedir(), '.config'), 'systemd', 'user', SERVICE_UNIT);
};

/** Read on the `hwip cc` hot path, so it goes by platform and checks a file —
 *  it never runs a program to ask whether systemd is there. */
export const serviceInstalled = (): boolean =>
    existsSync(process.platform === 'linux' ? serviceUnitPath() : servicePlistPath());

/** This user's launchd GUI domain, and our job within it. Not exported: every
 *  launchctl call lives in this file, and the label is an implementation
 *  detail of that. */
const serviceDomain = (): string => `gui/${process.getuid?.() ?? 0}`;
const serviceTarget = (): string => `${serviceDomain()}/${SERVICE_LABEL}`;

const nodeVersionOf = (path: string): string | null => {
    try {
        return execFileSync(path, ['-v'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
};

const whichTmuxFromShell = (): string | null => {
    try {
        // `/bin/sh -c` on purpose: `which` in an interactive zsh resolves the
        // user's tmux *alias*, which is not a path we can hand to launchd.
        const out = execFileSync('/bin/sh', ['-c', 'command -v tmux'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out.startsWith('/') ? out : null;
    } catch {
        return null;
    }
};

export const defaultServiceEnv: ServiceEnv = {
    exists: existsSync,
    nodeVersion: nodeVersionOf,
    whichTmux: whichTmuxFromShell,
    cliPath: resolveCliPath,
    lang: () => process.env.LANG,
};

/**
 * The interpreter that owns the CLI's install prefix.
 *
 * A global install lives at `<prefix>/lib/node_modules/@hwip/cli/dist/cli.js`
 * and its node is `<prefix>/bin/node`. Preferring it keeps the plist internally
 * consistent; picking whichever node happens to exist can pair a homebrew
 * interpreter with a `~/.local` install — a combination that works on the
 * machine that wrote it and breaks on the next one.
 */
const prefixNodeFor = (cliPath: string): string | null => {
    const marker = '/lib/node_modules/';
    const at = cliPath.indexOf(marker);
    if (at < 0) return null;
    return join(cliPath.slice(0, at), 'bin', 'node');
};

const isVersionManaged = (nodePath: string): boolean =>
    VERSION_MANAGER_DIRS.some((dir) => nodePath.includes(dir));

const dedupe = (values: string[]): string[] => [...new Set(values)];

/**
 * Decide what to bake into the plist, or say why we can't. Nothing is written
 * and nothing is registered — a caller that gets `ok: false` has touched
 * nothing on the machine.
 */
export const resolveServiceSpec = (env: ServiceEnv = defaultServiceEnv): SpecResolution => {
    const cliPath = env.cliPath();
    if (!cliPath) {
        return { ok: false, reason: 'could not resolve the hwip CLI entry (dist/cli.js) to run' };
    }

    const tmuxPath = env.whichTmux() ?? TMUX_FALLBACKS.find(env.exists) ?? null;
    if (!tmuxPath) {
        return { ok: false, reason: 'tmux not found — install tmux first (the listener drives tmux panes)' };
    }

    const prefixNode = prefixNodeFor(cliPath);
    const candidates = dedupe([...(prefixNode ? [prefixNode] : []), ...NODE_FALLBACKS, process.execPath]);
    // A node outside `engines` starts and dies, so it is not a candidate.
    const nodePath = candidates.find((c) => env.exists(c) && isSupportedNode(env.nodeVersion(c) ?? ''));
    if (!nodePath) {
        return { ok: false, reason: `no node found to run the listener with (needs ${SUPPORTED_NODE})` };
    }

    const pathEnv = dedupe([dirname(tmuxPath), dirname(nodePath), ...LAUNCHD_BASE_PATH]).join(':');
    const shellLang = env.lang();
    const lang = shellLang && /utf-?8$/i.test(shellLang) ? shellLang : FALLBACK_LANG;
    const spec: ServiceSpec = { nodePath, cliPath, tmuxPath, logPath: LISTENER_LOG_FILE, pathEnv, lang };

    if (isVersionManaged(nodePath)) {
        return {
            ok: true,
            value: spec,
            warning:
                `${nodePath} belongs to a node version manager — the service will stop working ` +
                `after a node upgrade. Re-run \`hwip listener --install-service\` if that happens ` +
                `(\`hwip verify\` reports it).`,
        };
    }
    return { ok: true, value: spec };
};

const escapeXml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const renderLaunchAgentPlist = (spec: ServiceSpec): string => {
    const s = (value: string): string => `<string>${escapeXml(value)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    ${s(SERVICE_LABEL)}
    <key>ProgramArguments</key>
    <array>
        ${s(spec.nodePath)}
        ${s(spec.cliPath)}
        <string>listener</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    ${s(spec.logPath)}
    <key>StandardErrorPath</key>
    ${s(spec.logPath)}
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        ${s(spec.pathEnv)}
        <key>LANG</key>
        ${s(spec.lang)}
        <key>HWIP_LISTENER_SERVICE</key>
        <string>1</string>
    </dict>
</dict>
</plist>
`;
};

const unescapeXml = (value: string): string =>
    value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** ProgramArguments strings, in order, from an installed plist. */
const readProgramArguments = (xml: string): string[] => {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
    if (!block) return [];
    return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]));
};

const readEnvValue = (xml: string, key: string): string | null => {
    const found = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(xml);
    return found ? unescapeXml(found[1]) : null;
};

const NOT_INSTALLED = {
    installed: false,
    nodePath: null,
    cliPath: null,
    pathEnv: null,
    langEnv: null,
    missing: [] as readonly string[],
} as const;

/**
 * What is registered on this machine and whether it can still run. The single
 * source `verify`, `--service-status` and the `hwip cc` branch all read, so
 * they can never disagree about whether a service is installed.
 */
export const serviceStatus = (manager: ServiceManager | null = serviceManager()): ServiceStatus => {
    // A unit file on disk outvotes a user bus that would not answer (a shell
    // with no login session): installed, only unmanageable from here — never
    // "macOS-only".
    if (manager === null && existsSync(serviceUnitPath())) manager = 'systemd';
    if (manager === 'systemd') return unitStatus();
    const plistPath = servicePlistPath();
    const base = { manager: 'launchd' as const, supported: manager === 'launchd', label: SERVICE_LABEL, plistPath };
    if (!existsSync(plistPath)) return { ...base, ...NOT_INSTALLED };

    let xml = '';
    try {
        xml = readFileSync(plistPath, 'utf-8');
    } catch {
        // The plist is there but unreadable — installed, nothing knowable.
        return { ...base, ...NOT_INSTALLED, installed: true };
    }
    const [nodePath = null, cliPath = null] = readProgramArguments(xml);
    const missing = [nodePath, cliPath].filter((p): p is string => !!p && !existsSync(p));
    return {
        ...base,
        installed: true,
        nodePath,
        cliPath,
        pathEnv: readEnvValue(xml, 'PATH'),
        langEnv: readEnvValue(xml, 'LANG'),
        missing,
    };
};

// ─── systemd unit ────────────────────────────────────────────────────

/** A quoted unit value: systemd’s C-style escapes (systemd.syntax(7), Quoting),
 *  and `%` doubled so no specifier expands (systemd.unit(5), Specifiers).
 *  Control characters are stripped first — a newline would start another unit
 *  line, and nothing holding one belongs in a value. */
const quoteUnit = (value: string): string =>
    `"${value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

/** A bare unit word (a log path after `append:`): specifiers doubled and
 *  control characters stripped, like quoteUnit. */
const plainUnitValue = (value: string): string =>
    value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/%/g, '%%');

/** An ExecStart= word: `$` doubled too, which ExecStart= would otherwise expand
 *  as a variable (systemd.service(5)). */
const execWord = (value: string): string => quoteUnit(value.replace(/\$/g, () => '$$'));

const unquoteUnit = (quoted: string): string => quoted.replace(/%%/g, '%').replace(/\\(.)/g, '$1');

/**
 * The unit holds what the plist holds, for the same reasons (see the top of
 * this file): absolute node and CLI paths, a PATH that reaches tmux — the user
 * manager's own PATH is whatever the distribution configured (systemd.exec(5),
 * $PATH) — and a UTF-8 LANG.
 *
 * - `Restart=on-failure` + `RestartSec=30` is `KeepAlive:{SuccessfulExit:false}`
 *   + `ThrottleInterval 30`: a crash comes back, a clean exit stays down
 *   (systemd.service(5), Restart=).
 * - `KillMode=process`: stop and restart kill the main process only. The
 *   default (`control-group`) would kill everything else left in the unit's
 *   cgroup — including the tmux server the listener started under this unit,
 *   and with it every agent session (launchd's detach spares it).
 *   systemd.kill(5) marks process "not recommended!", since it "allows
 *   processes to escape the service manager's lifecycle and resource
 *   management" — that escape is the point here: the tmux server is shared
 *   state, not a child of this service.
 * - `append:` keeps the daemon writing ~/.hwip/listener.log, which `hwip verify`
 *   and the log rotation know, instead of the journal (systemd.exec(5)).
 * - `WantedBy=default.target`: the user manager's main target, started with it
 *   at login (systemd.special(7), Special User Units).
 */
export const renderSystemdUnit = (spec: ServiceSpec): string => `[Unit]
Description=hwip listener (phone input to agent sessions)

[Service]
ExecStart=${execWord(spec.nodePath)} ${execWord(spec.cliPath)} listener
Restart=on-failure
RestartSec=30
KillMode=process
Environment=${quoteUnit(`PATH=${spec.pathEnv}`)}
Environment=${quoteUnit(`LANG=${spec.lang}`)}
Environment=HWIP_LISTENER_SERVICE=1
StandardOutput=append:${plainUnitValue(spec.logPath)}
StandardError=append:${plainUnitValue(spec.logPath)}

[Install]
WantedBy=default.target
`;

/** ExecStart= words, in order, from an installed unit. */
const readExecStart = (unit: string): string[] => {
    const line = /^ExecStart=(.*)$/m.exec(unit);
    if (!line) return [];
    return [...line[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquoteUnit(m[1]).replace(/\$\$/g, () => '$'));
};

const readUnitEnv = (unit: string, name: string): string | null => {
    const found = new RegExp(`^Environment="${name}=((?:[^"\\\\]|\\\\.)*)"$`, 'm').exec(unit);
    return found ? unquoteUnit(found[1]) : null;
};

const unitStatus = (): ServiceStatus => {
    const unitPath = serviceUnitPath();
    const base = { manager: 'systemd' as const, supported: true, label: SERVICE_UNIT, plistPath: unitPath };
    if (!existsSync(unitPath)) return { ...base, ...NOT_INSTALLED };

    let unit = '';
    try {
        unit = readFileSync(unitPath, 'utf-8');
    } catch {
        return { ...base, ...NOT_INSTALLED, installed: true };
    }
    const [nodePath = null, cliPath = null] = readExecStart(unit);
    const missing = [nodePath, cliPath].filter((p): p is string => !!p && !existsSync(p));
    return {
        ...base,
        installed: true,
        nodePath,
        cliPath,
        pathEnv: readUnitEnv(unit, 'PATH'),
        langEnv: readUnitEnv(unit, 'LANG'),
        missing,
    };
};

// ─── Service operations ──────────────────────────────────────────────

/**
 * Side effects the service operations need, injectable so tests can drive the
 * launchd sequence without a launchd.
 */
export interface ServiceOpDeps {
    readonly supported: () => boolean;
    readonly resolveSpec: () => SpecResolution;
    /** PID of a listener running right now, or null. */
    readonly runningPid: () => number | null;
    readonly stopListener: (pid: number) => Promise<ListenerStop>;
    readonly launchctl: (args: string[]) => { ok: boolean; stderr: string };
    readonly settle: (ms: number) => Promise<void>;
}

/** The same operations under systemd: `systemctl --user` instead of launchctl. */
export interface SystemdOpDeps extends Omit<ServiceOpDeps, 'launchctl'> {
    readonly systemctl: (args: string[]) => { ok: boolean; stderr: string };
}

export type ServiceOpResult =
    | { readonly ok: true; readonly notes: readonly string[] }
    | { readonly ok: false; readonly reason: string; readonly notes: readonly string[] };

/** How long to give launchd to get the daemon up before calling the install
 *  a failure. Generous: the daemon writes its pid file as its first act. */
const POST_INSTALL_SETTLE_MS = 3_000;
/** How often to look within that window. A fixed 3 s wait made every
 *  `hwip install` 3 s slower; the daemon is usually up in well under one. */
const POST_INSTALL_POLL_MS = 250;
/** How long one pid must stay up to count as started. */
const POST_INSTALL_STABLE_MS = 1_000;

/** A wedged user manager must not hang the CLI: every systemctl call — the
 *  systemd detection included — gets five seconds. launchctl stays unbounded,
 *  exactly as on main: execFileSync kills a timed-out child with SIGTERM and
 *  empty stderr, so capping launchctl would turn a macOS install into a
 *  silent "failed: no detail" where it used to wait (and usually succeed). */
const SYSTEMCTL_TIMEOUT_MS = 5_000;

const runQuiet = (program: string, args: string[], timeoutMs?: number): { ok: boolean; stderr: string } => {
    try {
        execFileSync(program, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) });
        return { ok: true, stderr: '' };
    } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
        if (timeoutMs !== undefined && (err as { signal?: string }).signal === 'SIGTERM') {
            const why = 'timed out after ' + timeoutMs / 1000 + 's';
            return { ok: false, stderr: stderr ? stderr + ' (' + why + ')' : why };
        }
        return { ok: false, stderr };
    }
};

const runLaunchctl = (args: string[]): { ok: boolean; stderr: string } => runQuiet('launchctl', args);
const runSystemctl = (args: string[]): { ok: boolean; stderr: string } =>
    runQuiet('systemctl', ['--user', ...args], SYSTEMCTL_TIMEOUT_MS);

export const defaultServiceOpDeps: ServiceOpDeps = {
    supported: serviceSupported,
    resolveSpec: () => resolveServiceSpec(),
    runningPid: runningListenerPid,
    stopListener: (pid) => stopListener(pid),
    launchctl: runLaunchctl,
    settle: sleep,
};

export const defaultSystemdOpDeps: SystemdOpDeps = {
    supported: serviceSupported,
    resolveSpec: () => resolveServiceSpec(),
    runningPid: runningListenerPid,
    stopListener: (pid) => stopListener(pid),
    systemctl: runSystemctl,
    settle: sleep,
};

type OpDeps = ServiceOpDeps | SystemdOpDeps;

const isSystemd = (deps: OpDeps): deps is SystemdOpDeps => 'systemctl' in deps;

/** Linux asks systemd, everything else launchd (whose `supported` refuses where there is none).
 *  Goes by platform alone: `hwip cc` reaches restartService through this. */
const defaultOpDeps = (): OpDeps => (process.platform === 'linux' ? defaultSystemdOpDeps : defaultServiceOpDeps);

const UNSUPPORTED =
    'the login-time service needs launchd (macOS) or a systemd user manager (Linux), and this machine has neither ' +
    '(run `hwip listener` yourself, or keep using `hwip cc` to autostart it)';

/** Lingering is a system setting, so this only says how (loginctl(1), enable-linger: a lingering user's
 *  manager is spawned at boot and kept around after logouts). */
const LINGER_NOTE =
    'systemd runs it while you are logged in: without lingering your user manager starts at login and stops after '
    + 'your last logout. On a machine nobody logs in to, keep it running with: sudo loginctl enable-linger $USER';

/** What the install says about a listener it found already running. */
const stopRunning = async (deps: OpDeps, notes: string[], manager: ServiceManager): Promise<void> => {
    const running = deps.runningPid();
    if (running === null) return;
    const stopped = await deps.stopListener(running);
    if (stopped.kind === 'stopped' || stopped.kind === 'killed') {
        notes.push(`stopped the listener already running (pid ${running}) so ${manager} can own it`);
    } else if (stopped.kind === 'other-listener') {
        notes.push(otherListenerNote(running, stopped.script));
    } else if (stopped.kind === 'foreign') {
        notes.push(`left pid ${running} alone: the listener's pid file points at another process (${stopped.program})`);
    } else if (stopped.kind === 'unchecked') {
        notes.push(`could not check pid ${running} (${stopped.reason}) — if it is the listener, kill ${running} and run: hwip listener --restart`);
    }
};

/** launchd creates the log it is pointed at under the umask, and systemd's `append:` opens it the same way:
 *  make it before, and private. */
const prepareLog = (): void => {
    ensurePrivateDir(dirname(LISTENER_LOG_FILE));
    ensurePrivateFile(LISTENER_LOG_FILE);
};

const writeServiceFile = (path: string, content: string, notes: string[]): void => {
    mkdirHandedBack(dirname(path));
    writeFileSync(path, content);
    handBackToSudoUser(path);
    notes.push(`wrote ${path}`);
};

/** A failure naming the step the service manager refused, or null. */
const registerLaunchAgent = (deps: ServiceOpDeps, spec: ServiceSpec, notes: string[]): ServiceOpResult | null => {
    // Nothing to unload before a first install — that failure is the normal path.
    deps.launchctl(['bootout', serviceTarget()]);
    prepareLog();
    const plistPath = servicePlistPath();
    writeServiceFile(plistPath, renderLaunchAgentPlist(spec), notes);

    const bootstrap = deps.launchctl(['bootstrap', serviceDomain(), plistPath]);
    if (!bootstrap.ok) {
        return { ok: false, reason: `launchctl bootstrap failed: ${bootstrap.stderr || 'no detail'}`, notes };
    }
    // Best-effort: a job disabled by an earlier `launchctl disable` (ours never
    // calls it, but a user's hand might have) would otherwise refuse to start.
    deps.launchctl(['enable', serviceTarget()]);

    const kickstart = deps.launchctl(['kickstart', '-k', serviceTarget()]);
    if (!kickstart.ok) {
        return { ok: false, reason: `launchctl kickstart failed: ${kickstart.stderr || 'no detail'}`, notes };
    }
    return null;
};

/**
 * The systemd steps, each of which must succeed:
 * - `daemon-reload`: the manager reads unit files on a reload, so a reinstall over
 *   a loaded unit would otherwise run the old one (systemd.unit(5)).
 * - `enable`: links the unit into `default.target.wants/` per its [Install]
 *   section — what starts it at login (systemctl(1), enable).
 * - `restart`: stops it if running, then starts it — `kickstart -k` (systemctl(1)).
 */
const registerUnit = (deps: SystemdOpDeps, spec: ServiceSpec, notes: string[]): ServiceOpResult | null => {
    prepareLog();
    writeServiceFile(serviceUnitPath(), renderSystemdUnit(spec), notes);
    for (const args of [['daemon-reload'], ['enable', SERVICE_UNIT], ['restart', SERVICE_UNIT]]) {
        const result = deps.systemctl(args);
        if (!result.ok) {
            return { ok: false, reason: `systemctl --user ${args[0]} failed: ${result.stderr || 'no detail'}`, notes };
        }
    }
    notes.push(LINGER_NOTE);
    return null;
};

/**
 * Register the service and get the daemon running under it.
 *
 * The order is load-bearing, not incidental:
 *
 * - **Any listener already running is stopped first.** `handleListener` exits
 *   **0** when it finds another listener alive, and it only does so quietly
 *   under HWIP_LISTENER_AUTOSTART, which a service does not have. So a
 *   kickstart into a live `hwip cc` daemon produces a clean exit, and
 *   `KeepAlive:{SuccessfulExit:false}` (systemd: `Restart=on-failure`) reads a
 *   clean exit as "stay down" — for the whole login session. The manager lists
 *   the job; nothing runs.
 * - **Nothing is written until the spec resolves.** A refusal leaves the
 *   machine exactly as it was.
 * - **The daemon is confirmed alive afterwards.** Without that check the
 *   failure above ships silently.
 *
 * The deps say which manager: launchctl for launchd, systemctl for systemd.
 */
export const installService = async (deps: OpDeps = defaultOpDeps()): Promise<ServiceOpResult> => {
    const notes: string[] = [];
    if (!deps.supported()) return { ok: false, reason: UNSUPPORTED, notes };

    const spec = deps.resolveSpec();
    if (!spec.ok) return { ok: false, reason: spec.reason, notes };
    if (spec.warning) notes.push(spec.warning);

    await stopRunning(deps, notes, isSystemd(deps) ? 'systemd' : 'launchd');

    const refused = isSystemd(deps) ? registerUnit(deps, spec.value, notes) : registerLaunchAgent(deps, spec.value, notes);
    if (refused) return refused;

    // Up = the same pid alive for a full second: a daemon that writes its pid
    // file and then dies on a bad key or a bind failure does so within that.
    let last: number | null = null;
    let since = 0;
    for (let waited = POST_INSTALL_POLL_MS; waited <= POST_INSTALL_SETTLE_MS; waited += POST_INSTALL_POLL_MS) {
        await deps.settle(POST_INSTALL_POLL_MS);
        const pid = deps.runningPid();
        if (pid === null || pid !== last) since = waited;
        else if (waited - since >= POST_INSTALL_STABLE_MS) return { ok: true, notes };
        last = pid;
    }
    return {
        ok: false,
        reason: `the service was registered but the listener did not stay up — see ${LISTENER_LOG_FILE}`,
        notes,
    };
};

/** Unregister the job and remove its file. Doing only one of the two leaves
 *  either a running service with no file or a file the manager ignores. */
export const uninstallService = async (deps: OpDeps = defaultOpDeps()): Promise<ServiceOpResult> => {
    const notes: string[] = [];
    const path = isSystemd(deps) ? serviceUnitPath() : servicePlistPath();
    if (!existsSync(path)) return { ok: true, notes: ['service not installed — nothing to remove'] };

    if (isSystemd(deps)) {
        // `--now` stops it as well as removing the `default.target.wants/` link (systemctl(1), disable).
        const disable = deps.systemctl(['disable', '--now', SERVICE_UNIT]);
        if (disable.ok) {
            notes.push(`stopped and disabled ${SERVICE_UNIT}`);
        } else {
            // The manager refused; the unit file is gone right after this, so
            // a left-behind wants/ link would dangle into every login.
            const wants = join(dirname(path), 'default.target.wants', SERVICE_UNIT);
            const hadLink = existsSync(wants);
            if (hadLink) rmSync(wants, { force: true });
            notes.push(`systemctl --user disable failed (${disable.stderr || 'no detail'})`
                + (hadLink ? ' — removed the default.target.wants/ link directly' : '')
                + `; whether the unit stopped is unknown — if the listener is still up,`
                + ` check with: systemctl --user status ${SERVICE_UNIT}`);
        }
    } else {
        deps.launchctl(['bootout', serviceTarget()]);
        notes.push(`unloaded ${SERVICE_LABEL}`);
    }
    rmSync(path, { force: true });
    notes.push(`removed ${path}`);
    if (isSystemd(deps)) deps.systemctl(['daemon-reload']);
    return { ok: true, notes };
};

/** One service-manager call reported as a ServiceOpResult, naming the
 *  subcommand in the failure so the user sees which step was refused. */
const ask = (deps: OpDeps, args: string[], note: string): ServiceOpResult => {
    const result = isSystemd(deps) ? deps.systemctl(args) : deps.launchctl(args);
    if (result.ok) return { ok: true, notes: [note] };
    const program = isSystemd(deps) ? 'systemctl --user' : 'launchctl';
    return { ok: false, reason: `${program} ${args[0]} failed: ${result.stderr || 'no detail'}`, notes: [] };
};

/**
 * Stop the service until the next login.
 *
 * launchd: `bootout` and not `disable` — disable writes to launchd's persistent
 * disabled database, survives logins, and leaves no obvious way back: a
 * `--stop` that quietly becomes permanent. Session-scoped is what stopping
 * should mean. systemd: `stop` leaves the unit enabled, so the user manager
 * starts it again the next time it starts itself.
 */
export const stopService = (deps: OpDeps = defaultOpDeps()): ServiceOpResult =>
    isSystemd(deps)
        ? ask(deps, ['stop', SERVICE_UNIT], `stopped ${SERVICE_UNIT} — it starts again with hwip listener --restart, or at your next login after a full logout`)
        : ask(deps, ['bootout', serviceTarget()], `unloaded ${SERVICE_LABEL} — it comes back at the next login`);

/** Restart the service in place. Both kill the running instance first, so this
 *  is also how a version-drifted daemon is replaced. */
export const restartService = (deps: OpDeps = defaultOpDeps()): ServiceOpResult =>
    isSystemd(deps)
        ? ask(deps, ['restart', SERVICE_UNIT], `restarted ${SERVICE_UNIT}`)
        : ask(deps, ['kickstart', '-k', serviceTarget()], `restarted ${SERVICE_LABEL}`);

// ─── Health ──────────────────────────────────────────────────────────

export interface ServiceHealthRow {
    readonly label: string;
    readonly state: 'pass' | 'warn' | 'fail';
}

/** The two live facts a health check can't read off the plist. */
export interface ServiceProbe {
    /** Can a process started with this PATH find tmux? */
    readonly tmuxOnPath: (pathEnv: string) => boolean;
    /** Is the service manager actually running the job right now? */
    readonly loaded: () => boolean;
}

const pathHasTmux = (pathEnv: string): boolean =>
    pathEnv.split(':').filter(Boolean).some((dir) => existsSync(join(dir, 'tmux')));

const jobIsLoaded = (): boolean => runLaunchctl(['print', serviceTarget()]).ok;

export const defaultServiceProbe: ServiceProbe = { tmuxOnPath: pathHasTmux, loaded: jobIsLoaded };

/** `is-active` exits 0 when the unit is running (systemctl(1)). */
export const systemdServiceProbe: ServiceProbe = {
    tmuxOnPath: pathHasTmux,
    loaded: () => runSystemctl(['is-active', '--quiet', SERVICE_UNIT]).ok,
};

/**
 * Why this exists: every way the service breaks leaves it looking installed.
 * `launchctl list` shows the job whether or not its interpreter still exists,
 * and a PATH without tmux makes the daemon exit 127 at every login while the
 * registration sits there unchanged. None of that is visible without asking.
 */
export const serviceHealthChecks = (
    status: ServiceStatus,
    probe: ServiceProbe = status.manager === 'systemd' ? systemdServiceProbe : defaultServiceProbe,
): ServiceHealthRow[] => {
    if (!status.supported) return [];
    if (!status.installed) {
        return [
            {
                label: 'no login-time service — after a reboot the phone sees nothing until you run `hwip cc` '
                    + '(add it: hwip listener --install-service)',
                state: 'warn',
            },
        ];
    }

    const rows: ServiceHealthRow[] = [{ label: `${status.label} registered`, state: 'pass' }];

    if (status.missing.length > 0) {
        rows.push({
            label: `service points at ${status.missing.join(', ')} — gone. Re-run: hwip listener --install-service`,
            state: 'fail',
        });
    } else {
        rows.push({ label: 'service programs still exist', state: 'pass' });
    }

    // launchd hands the job its own bare PATH, so tmux has to come from what
    // the plist baked in. Without it verifyTmux() exits 127 at every login.
    if (status.pathEnv && probe.tmuxOnPath(status.pathEnv)) {
        rows.push({ label: 'tmux reachable from the service PATH', state: 'pass' });
    } else {
        rows.push({
            label: 'tmux NOT on the service PATH — the daemon exits 127 at login. '
                + 'Re-run: hwip listener --install-service',
            state: 'fail',
        });
    }

    // Without a UTF-8 LANG, tmux escapes the U+241F field separator to `_` and
    // every session is dropped as unparseable — with nothing in the log that
    // says so except a raw line the user has no reason to read as fatal.
    if (status.langEnv && /utf-?8$/i.test(status.langEnv)) {
        rows.push({ label: 'service locale is UTF-8', state: 'pass' });
    } else {
        rows.push({
            label: 'service LANG is not UTF-8 — tmux mangles the session separator and every session is dropped. '
                + 'Re-run: hwip listener --install-service',
            state: 'fail',
        });
    }

    rows.push(
        status.manager === 'systemd'
            ? probe.loaded()
                ? { label: 'systemd is running the unit', state: 'pass' }
                : { label: 'registered but systemd is not running it — start it: hwip listener --restart', state: 'warn' }
            : probe.loaded()
                ? { label: 'launchd is running the job', state: 'pass' }
                : { label: 'registered but launchd is not running it — it returns at the next login', state: 'warn' },
    );

    return rows;
};
