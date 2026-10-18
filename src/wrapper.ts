/**
 * `hwip cc` / `hwip codex` / `hwip gemini` — spawn an agent inside a named
 * tmux session so the resident listener (`hwip listener`) can address it
 * by session name to inject messages later.
 *
 * The tmux session name follows `hwip-<project>` where <project> resolves
 * from CLAUDE/CURSOR/WINDSURF_PROJECT_DIR → git repo root → cwd basename.
 * When the wrapper is invoked from inside an existing tmux session
 * ($TMUX set) it skips the outer tmux to avoid nesting and execs the
 * agent directly — letting power users keep their own multiplexer setup.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import { basename } from 'path';
import { resolveCommand } from './agents.js';
import { planTmuxInstall, type TmuxInstallPlan } from './tmux-install.js';
import { cachedUpdateNotice, isNewer } from './check-update.js';
import { checkoutOf, groupOf, HERDR_SESSION_OPTIONS, PROJECT_DIR_ENV_VARS, resolvedEnv, SESSION_LABEL_OPTION, SESSION_PROJECT_OPTION, SESSION_SHELL_OPTION, tmuxName, VERSION } from './config.js';
import {
    awaitServiceListener,
    LISTENER_LAUNCH_ENV,
    LISTENER_LOG_FILE,
    listenerLogSize,
    otherListenerNote,
    runningListenerPid,
    runningListenerVersion,
    startFailure,
    startListenerDetached,
    stopListener,
    type ListenerStart,
} from './listener-process.js';
import { restartService, serviceInstalled } from './listener-service.js';
import type { RemoteAgent } from './remote-agents.js';
import { recallSession } from './session-registry.js';
import { ensureWorktree } from './worktree.js';

const FALLBACK_NAME = 'project';

/** basename(), with a stable fallback for edge paths like `/`. */
export const safeBasename = (path: string): string => basename(path) || FALLBACK_NAME;

/** The directory the session is named for: env > git root > cwd. Null when git is the answer and there is no repo. */
export const detectProjectDir = (): string => {
    for (const key of PROJECT_DIR_ENV_VARS) {
        const v = resolvedEnv(key);
        if (v) return v.replace(/\/+$/, '') || '/';
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root) return root;
    } catch { /* not a git repo — fall through */ }
    return process.cwd();
};

/** Resolve a project name for the tmux session: env > git root > cwd basename. */
export const detectProjectName = (): string => safeBasename(detectProjectDir());

/**
 * tmux commands, chained after `new`, that tell the listener which project
 * the session belongs to when its name does not say so: a `--label` tail and a
 * worktree's directory name both read as part of the project otherwise, and
 * each opened a card of its own. Nothing when the name already says it all, so
 * a plain family session is reported exactly as before. The rule is config
 * `groupOf`, which the listener also applies to sessions started without these.
 *
 * Each option names its session (`-t =<session>:`). An untargeted `set-option`
 * applies to the client's current session, and a launch from inside tmux (a
 * `--detach` from an agent's pane) would relabel the caller instead of the new
 * session (measured on tmux 3.5a).
 */
export const sessionSidecarArgs = (session: string, projectDir: string, label?: string): string[] => {
    const checkout = checkoutOf(projectDir);
    const group = label
        ? { project: checkout?.key ?? safeBasename(projectDir), label }
        : groupOf(session.slice('hwip-'.length), checkout);
    if (!group) return [];
    return [
        ';', 'set-option', '-t', sessionOptionTarget(session), SESSION_PROJECT_OPTION, group.project,
        ';', 'set-option', '-t', sessionOptionTarget(session), SESSION_LABEL_OPTION, group.label,
    ];
};

/**
 * tmux commands, chained after `new -A`, that point config
 * `HERDR_SESSION_OPTIONS` at the herdr pane this attach runs in, or clear them
 * outside herdr.
 */
export const herdrSessionArgs = (session: string, env: NodeJS.ProcessEnv = process.env): string[] => {
    const inHerdr = env.HERDR_ENV === '1' && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
    return Object.entries(HERDR_SESSION_OPTIONS).flatMap(([name, option]) => {
        const value = inHerdr ? env[name] : undefined;
        return [';', 'set-option', ...(value ? [] : ['-u']), '-t', sessionOptionTarget(session), option, ...(value ? [value] : [])];
    });
};

/**
 * The option target for one session by exact name. `=` stops a prefix match;
 * the trailing `:` makes `show-options`/`set-option`, which read `-t` as a
 * pane, take it as a session (tmux 3.5a: `-t =name` alone answers nothing).
 */
const sessionOptionTarget = (session: string): string => `=${session}:`;

/**
 * `hwip-<project>` — the canonical tmux session base name. tmux itself turns
 * `.` and `:` into `_` when it creates a session (3.5a: `hwip-foo.bar` becomes
 * `hwip-foo_bar`), so the name is written that way up front: every later
 * `-t =<name>` must match what tmux actually holds. `;` goes too — an argv
 * element ending in one is a tmux command separator.
 */
export const tmuxSessionName = (project: string): string => `hwip-${tmuxName(project)}`;

/**
 * Every live tmux session as `name → attached`, in one spawn.
 *
 * `tmux list-sessions` exits non-zero when no server is running; that is the
 * ordinary "first `hwip cc` after a reboot" case, not an error, and it means
 * an empty family.
 *
 * The format puts the 0/1 flag first so the name — which carries whatever the
 * project directory was called, spaces included — is everything after the
 * first space and needs no quoting.
 */
const liveSessions = (): Map<string, boolean> => {
    const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_attached} #{session_name}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = new Map<string, boolean>();
    if (r.status !== 0) return out;
    for (const line of (r.stdout ?? '').split('\n')) {
        const sep = line.indexOf(' ');
        if (sep < 0) continue;
        out.set(line.slice(sep + 1), line.slice(0, sep) === '1');
    }
    return out;
};

const MAX_SUFFIX_ATTEMPTS = 20;

/** The first name in the family no live session holds — for a launch that can only create. */
export const firstFreeSession = (base: string): string => {
    const live = liveSessions();
    return familyNames(base).find((name) => !live.has(name)) ?? `${base}-${MAX_SUFFIX_ATTEMPTS + 1}`;
};

/** `<base>`, `<base>-2`, `<base>-3`, … — the session family for one project. */
const familyNames = (base: string): string[] =>
    Array.from({ length: MAX_SUFFIX_ATTEMPTS }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));

/**
 * Pick a tmux session name that won't steal focus from another live
 * `hwip cc`. Strategy:
 *   - Reuse the **highest-numbered detached** session in the family.
 *   - Otherwise take the lowest name that doesn't exist yet (create new),
 *     so an all-attached family gets an independent `<base>-N`.
 *
 * Highest-detached rather than lowest is what keeps the family reachable.
 * The old scan walked the family in order and returned the first session that
 * was missing *or* detached, which meant a detached `<base>` ended the scan
 * every time: `<base>-2` could not be reached by any later `hwip cc`, not even
 * after `<base>` was used and exited (a missing `<base>` is taken fresh). A
 * session nobody can reach still holds a live agent — a Claude Code CLI plus
 * its MCP fleet, 250-550MB measured — so stranding one leaks memory the user
 * can neither see nor reclaim. Draining from the tail makes every suffix
 * reachable again: the tail goes first, and `<base>` is picked on the run
 * after that. Reuse also wins over a gap in the numbering, for the same
 * reason — a free `<base>-2` must not hide a detached `<base>-3`.
 *
 * Reclaiming is deliberately all this does. Killing a detached session would
 * take a live agent with it, and nothing here can tell "the user is done with
 * this" from "the user closed the terminal and will come back".
 */
export const findAvailableSession = (
    base: string,
    /** The agent about to be started. A detached session that is running a
     *  different one is not a slot for it — see `sameAgent` below. Omitted by
     *  callers that have no kind to match, which keeps the old behaviour. */
    agentKind?: string,
    /** Test seam: what this machine recorded about a session name. */
    recall: (name: string) => { agentKind: string } | null = recallSession,
): string => {
    const live = liveSessions();
    const family = familyNames(base);
    /**
     * Whether a detached session can host this agent.
     *
     * `tmux new -A` attaches to an existing session and DROPS the command it
     * was given, so reusing a detached session that is running claude for a
     * `hwip pi` puts the user in front of claude — silently, with pi never
     * started. The registry is the only thing on this machine that knows which
     * agent a name is running, so it decides.
     *
     * A name the registry has no record of is reusable: that is a session this
     * machine never swept (no listener, or one that started after it), and
     * refusing those would break the ordinary reattach for anyone not running
     * the daemon.
     *
     * A STALE record is the other way to be wrong: the daemon recorded claude
     * in this slot, the user has since started pi there by hand, and the sweep
     * has not run. Then a `hwip pi` skips the user's own detached session and
     * opens `-2`. That costs a reattach, where trusting the record the other way
     * costs an agent that never starts — so the record wins.
     */
    const sameAgent = (name: string): boolean => {
        if (!agentKind) return true;
        const known = recall(name);
        return !known || known.agentKind === agentKind;
    };
    for (let i = family.length - 1; i >= 0; i--) {
        if (live.get(family[i]) === false && sameAgent(family[i])) return family[i];
    }
    const free = family.find((name) => !live.has(name));
    if (free) return free;
    // Every name in the family is taken. `base` is the historical answer, and
    // `tmux new -A` on a taken name attaches instead of starting — fine when
    // whatever is there runs this agent, and the silent wrong-agent attach this
    // function exists to prevent when it does not. One name past the family is
    // the only answer left that actually starts the agent that was asked for.
    return sameAgent(base) ? base : `${base}-${MAX_SUFFIX_ATTEMPTS + 1}`;
};

export interface SpawnTarget {
    /**
     * `tmux-new` opens (or reattaches) a session and needs a terminal to
     * attach to; `direct` runs the agent in the pane we are already in and
     * does not. Several decisions downstream turn on which one this is, so
     * `targetForAgent` states it rather than letting them re-derive it from
     * `cmd === 'tmux'`.
     */
    kind: 'direct' | 'tmux-new' | 'tmux-detached';
    cmd: string;
    args: string[];
    /** The tmux session name for the two tmux kinds — carried, not re-read off argv. */
    session?: string;
}

/**
 * `hwip <agent> --detach --label <x> --wt <name> …` — the wrapper-owned flags. They
 * are read off the FRONT of the passthrough only, so an agent's own flags
 * (`pi -n`, `claude --resume`) and its positional messages pass untouched.
 */
export interface AgentLaunchOptions {
    /** Create the tmux session without attaching, print its name, exit 0. */
    detach?: boolean;
    /** Name the session `hwip-<project>-<label>` instead of the `-2/-3` family. */
    label?: string;
    /** `--wt <name>`: run in the git worktree for this branch, made next to the repo if it is not there. */
    worktree?: string;
    /** Set by `handleAgentSession` once the worktree exists — not a flag. The directory the session is named for, in place of `detectProjectDir()`. */
    projectDir?: string;
}

/**
 * tmux forbids `.` and `:` in session names; whitespace would split the target;
 * and an argv element ending in `;` is a tmux command separator.
 */
export const sanitizeLabel = (label: string): string => label.trim().replace(/[.:;\s]+/g, '-');

/** The wrapper's flags that take a value, and the option each one sets. */
const VALUE_FLAGS = { '--label': 'label', '--wt': 'worktree' } as const;
type ValueFlag = keyof typeof VALUE_FLAGS;

/**
 * A flag value the user typed, or the reason it cannot be one. Empty (`--label ''`)
 * would name the session `hwip-<project>-`, and a flag-shaped value
 * (`--label --detach`) is almost always a missing argument. A label is made
 * tmux-safe here; a branch name is passed on as typed, for git to judge.
 */
const takeValue = (flag: ValueFlag, raw: string | undefined): { value?: string; error?: string } => {
    if (raw === undefined || raw.startsWith('-')) {
        return { error: `${flag} needs a value (e.g. ${flag} ${flag === '--label' ? 'impl' : 'feat/x'})` };
    }
    const value = flag === '--label' ? sanitizeLabel(raw) : raw.trim();
    return value ? { value } : { error: `${flag} must not be empty` };
};

export const splitAgentOptions = (extra: string[]): { opts: AgentLaunchOptions; rest: string[]; error?: string } => {
    const opts: AgentLaunchOptions = {};
    let i = 0;
    while (i < extra.length) {
        const arg = extra[i];
        if (arg === '--detach') {
            opts.detach = true;
            i += 1;
            continue;
        }
        const flags = Object.keys(VALUE_FLAGS) as ValueFlag[]; // keys of a const object
        const spaced = flags.find((f) => arg === f);
        const joined = flags.find((f) => arg.startsWith(`${f}=`));
        const flag = spaced ?? joined;
        if (!flag) break;
        const taken = takeValue(flag, spaced ? extra[i + 1] : arg.slice(flag.length + 1));
        i += spaced ? 2 : 1;
        if (taken.error) return { opts, rest: extra.slice(i), error: taken.error };
        if (taken.value) opts[VALUE_FLAGS[flag]] = taken.value;
    }
    return { opts, rest: extra.slice(i) };
};

/** POSIX shell-quote so passthrough args survive being joined into a tmux shell-command string. */
const SHELL_SAFE = /^[\w\-./=:@%+,]+$/;
const shellQuote = (s: string): string =>
    s.length > 0 && SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export const targetForAgent = (
    agent: string,
    extra: string[],
    agentKind?: string,
    opts: AgentLaunchOptions = {},
): SpawnTarget => {
    // Already inside tmux → no nested session, just run the agent in the
    // current pane. Nested tmux prefix collisions are confusing and the
    // listener can't reach a session it didn't name anyway. A detached
    // launch is the exception: it never attaches, so nesting cannot happen,
    // and a Claude Code session driving `hwip pi --detach` from its own pane
    // is exactly where it runs from.
    // A label asks for a tmux session by name; running in the current pane
    // would drop that silently, so a label is the other exception.
    if (process.env.TMUX && !opts.detach && !opts.label) {
        return { kind: 'direct', cmd: agent, args: extra };
    }
    const projectDir = opts.projectDir ?? detectProjectDir();
    const base = tmuxSessionName(safeBasename(projectDir));
    // A label pins the name — the caller wants THIS session, not a slot in
    // the family (a plan-named implementer next to the user's own `hwip pi`).
    // A detached launch without one takes the first name the family does not
    // have: `findAvailableSession` prefers a detached session to REUSE, which
    // `new -d` cannot do (it only creates) — it would just fail on the name.
    // Otherwise reattach a detached session of this project when there is
    // one, else auto-suffix — lets the user keep `hwip cc` workflow simple
    // and still get independent sessions when opening multiple terminals in
    // the same project.
    const session = opts.label
        ? `${base}-${opts.label}`
        : opts.detach
            ? firstFreeSession(base)
            : findAvailableSession(base, agentKind);
    // tmux joins trailing argv into a single shell-command, so flags like
    // `--resume` would be eaten by tmux's own parser. Build one quoted
    // shell string instead, which tmux passes through verbatim.
    const shellCmd = [agent, ...extra].map(shellQuote).join(' ');
    // `-d`: create without attaching, so no TTY is needed and `new` fails
    // loudly on a taken name instead of `-A` silently attaching to whatever
    // runs there. `-c`: the agent's cwd must be the directory the session is
    // NAMED for — a launcher sitting in a subdirectory or another worktree
    // would otherwise get a session named for one tree running in another.
    const sidecar = sessionSidecarArgs(session, projectDir, opts.label);
    if (opts.detach) {
        return { kind: 'tmux-detached', cmd: 'tmux', args: ['new', '-d', '-s', session, '-c', projectDir, shellCmd, ...sidecar], session };
    }
    // `tmux new -A`: attach if the named session exists, else create it.
    return { kind: 'tmux-new', cmd: 'tmux', args: ['new', '-A', '-s', session, shellCmd, ...sidecar, ...herdrSessionArgs(session)], session };
};

// ── Background listener auto-start ────────────────────────────────────

/**
 * Whether the daemon on record is running a different build than the one
 * we're launching from. `npm i -g @hwip/cli` swaps dist/ but leaves the
 * live process untouched, so a daemon can stay days behind the installed
 * package — answering pushes (chat looks fine) while silently ignoring every
 * message subtype added since it booted. That is exactly how a pre-1.24
 * listener left the phone's live terminal spinning until a reboot.
 *
 * A missing stamp means the daemon predates version stamping, which puts it
 * behind by definition — treat unknown as drifted.
 *
 * Strictly "installed is newer", never a plain inequality: one account can
 * have several installs at different versions (nvm node versions, a repo
 * build alongside the global one), and `!==` would make each `hwip cc` kill
 * and respawn the other's daemon forever. An older `hwip cc` leaves a newer
 * daemon alone — downgrading it would reintroduce the very gap this closes.
 */
export const listenerVersionDrifted = (running: string | null, installed: string): boolean =>
    running === null || isNewer(installed, running);

/**
 * Whether the listener started this process for a schedule (`LISTENER_LAUNCH_ENV`), and the marker used up: left in the
 * environment it would reach the git hooks of a `--wt` worktree and the tmux server this launch may start, and so every pane after it.
 */
export const takeListenerLaunchMarker = (): boolean => {
    const set = process.env[LISTENER_LAUNCH_ENV] === '1';
    delete process.env[LISTENER_LAUNCH_ENV];
    return set;
};

/**
 * Make sure the phone-bridge daemon is running AND is the build we just
 * launched from. `hwip cc` is the right moment to replace a drifted one: the
 * user is starting fresh work rather than mid-task, so the ~1s restart window
 * (in which a push would be dropped — WS fan-out has no queue) costs nothing.
 */
export const ensureListenerRunning = async (launchedByListener: boolean = takeListenerLaunchMarker()): Promise<void> => {
    if (launchedByListener) return;
    const pid = runningListenerPid();
    const running = pid === null ? null : runningListenerVersion();
    if (pid !== null && !listenerVersionDrifted(running, VERSION)) return;

    // When the login-time service is installed, the service manager (launchd,
    // or under systemd the user manager) owns this process. Stopping its child
    // makes the manager start a replacement while we spawn our own, and the
    // two race through the singleton guard in handleListener — whichever
    // loses exits 0, and if that is the manager's child, KeepAlive either
    // flaps it every ThrottleInterval or reads the clean exit as deliberate
    // and gives up for the rest of the login session. Ask the manager to do
    // it instead; `kickstart -k` replaces a drifted daemon in one step.
    if (serviceInstalled()) {
        const owner = process.platform === 'linux' ? 'systemd' : 'launchd';
        const logOffset = listenerLogSize();
        const result = restartService();
        if (!result.ok) {
            console.error(`hwip: could not start the listener service — ${result.reason}`);
            return;
        }
        if (reportFailedStart(await awaitServiceListener(logOffset, pid))) return;
        if (pid === null) console.log(`hwip: listener started by ${owner} (log: ${LISTENER_LOG_FILE})`);
        else console.log(`hwip: listener ${running ?? '(pre-1.26)'} is stale — ${owner} restarting on ${VERSION}`);
        return;
    }

    if (pid !== null) {
        console.log(`hwip: listener ${running ?? '(pre-1.26)'} is stale — restarting on ${VERSION}`);
        const stopped = await stopListener(pid);
        // A pid that could not be checked was left running, and a new daemon
        // would only defer to it through the singleton guard.
        if (stopped.kind === 'unchecked') {
            console.error(`hwip: could not check pid ${pid} (${stopped.reason}) — left the old listener running`);
            return;
        }
        // Its stamps stay, so a new daemon would only defer to it.
        if (stopped.kind === 'other-listener') {
            console.error(`hwip: ${otherListenerNote(pid, stopped.script)}`);
            return;
        }
    }
    const started = await startListenerDetached();
    if (started.kind === 'not-spawned') {
        console.error('hwip: listener autostart failed — run `hwip listener` manually.');
    } else if (!reportFailedStart(started) && pid === null && started.kind === 'running') {
        console.log(`hwip: listener autostarted in background (log: ${LISTENER_LOG_FILE})`);
    }
};

/** Say why a just-started listener is not running; true when it said anything. */
const reportFailedStart = (started: ListenerStart): boolean => {
    const why = startFailure(started);
    if (why === null) return false;
    console.error(`hwip: the listener stopped right after starting — ${why}`);
    console.error(`      the phone cannot reach this session until it runs (log: ${LISTENER_LOG_FILE})`);
    return true;
};

/**
 * Launch the agent in a named tmux session (or directly if nested) and
 * forward its exit code. `extra` is appended to the agent invocation, so
 * `hwip cc --resume foo` runs `claude --resume foo` inside the session.
 * Returns when the agent exits.
 */
/** `process.execve` with the optionality resolved — see handOffExec. */
export type ProcessHandOff = NonNullable<typeof process.execve>;

/** The hand-off handOffExec returns: execve with the environment already bound. */
type HandOff = (file: string, argv: string[]) => never;

/**
 * The exec that replaces this process with the child, or null when the wrapper
 * has to stay and wait instead. Returning the function rather than a boolean
 * keeps one check where two would otherwise drift: the platform gate and the
 * policy are the same answer.
 *
 * `process.execve` is declared optional by @types/node, and is absent on node
 * <22.15 (added there) and on Windows (its doc: "not available on Windows or
 * IBM i"), so its presence covers both without a version check. `engines.node`
 * still allows 20.x, 22.13–22.14 and 23.5–23.10 (added in 22.15 and 23.11, per
 * the Node docs), so the spawn path below is not a transitional fallback — it
 * stays.
 *
 * `isTTY` is `undefined` rather than `false` on a pipe, hence every `=== true`.
 *
 * The environment is bound here rather than left to execve's default: node
 * 22.15.1 execs with an empty environment when the argument is omitted
 * (measured — 22.23.2 and 24.x inherit process.env), and a tmux started without
 * TERM dies with "open terminal failed: terminal does not support clear".
 */
export const handOffExec = (deps: {
    execve: ProcessHandOff | undefined;
    env: NodeJS.ProcessEnv;
    kind: SpawnTarget['kind'];
    stdinTTY: boolean | undefined;
    stdoutTTY: boolean | undefined;
}): HandOff | null => {
    // A detached launch returns after tmux answers — nothing to hand the terminal to.
    if (deps.kind === 'tmux-detached') return null;
    if (!deps.execve) return null;
    // execve runs no cleanup handler, and node only writes stdout synchronously
    // to a TTY on POSIX — anything buffered to a pipe would vanish with us.
    if (deps.stdoutTTY !== true) return null;
    // `tmux new` additionally needs a terminal of its own to attach to. That is
    // the failure the spawn path below exists to explain, so send it there.
    if (deps.kind === 'tmux-new' && deps.stdinTTY !== true) return null;
    const { execve, env } = deps;
    return (file, argv) => execve(file, argv, env);
};

/**
 * Inside tmux the agent runs in the current pane, and the listener reports
 * only `hwip-*` sessions — so unless this pane already sits in one, the phone
 * never sees the agent. Say so, and name the two ways to a session it does
 * see. `session` is this pane's tmux session, null when tmux would not say.
 */
export const inPaneNote = (subcommand: string, session: string | null): string | undefined =>
    session?.startsWith('hwip-')
        ? undefined
        : `hwip: running in this tmux pane, which the phone can't see — for a session it can, use \`hwip ${subcommand} --detach\` or run outside tmux`;

const currentTmuxSession = (): string | null => {
    try {
        // `-t` this pane: without it tmux answers for its current client,
        // which with several attached can be another session.
        const target = process.env.TMUX_PANE ? ['-t', process.env.TMUX_PANE] : [];
        return execFileSync('tmux', ['display-message', '-p', ...target, '#S'], { encoding: 'utf-8' }).trim() || null;
    } catch {
        return null;
    }
};

/**
 * What to say when tmux is missing — the install hint `hwip install` gives,
 * not just "not found". Undefined when tmux is there. Exported for tests.
 */
export const tmuxMissingMessage = (command: string, plan: TmuxInstallPlan): string | undefined => {
    if (plan.kind === 'present') return undefined;
    const fix = plan.kind === 'command' ? `Run: ${plan.label}` : plan.hint;
    return `hwip: tmux not found — \`hwip ${command}\` needs it. ${fix}`;
};

/** Checked before the listener is started: without tmux it has nothing to serve. */
const tmuxMissing = (command: string): string | undefined =>
    tmuxMissingMessage(command, planTmuxInstall({ resolve: resolveCommand, platform: process.platform }));

/** What `handleAgentSession` does to the machine, swappable in tests. */
export interface AgentSessionDeps {
    startListener?: () => Promise<void>;
    launch?: (target: SpawnTarget, what: string) => Promise<number>;
}

export const handleAgentSession = async (
    agent: RemoteAgent,
    extra: string[] = [],
    opts: AgentLaunchOptions = {},
    deps: AgentSessionDeps = {},
): Promise<number> => {
    // First of all, before `ensureWorktree` runs git (its hooks would inherit the marker).
    const launchedByListener = takeListenerLaunchMarker();
    // Best-effort: make sure the phone-bridge daemon is running, and running
    // the build we were launched from. The user shouldn't need to remember a
    // second command for the picker on their phone to work.
    const missing = tmuxMissing(agent.subcommands[0]);
    if (missing) {
        console.error(missing);
        return 127;
    }
    // Before the listener starts: a refused `--wt` should cost nothing.
    if (opts.worktree) {
        const made = await ensureWorktree({ dir: detectProjectDir(), name: opts.worktree });
        if (!made.ok) {
            console.error(`hwip: ${made.error}`);
            return made.usage ? 2 : 1;
        }
        console.error(`hwip: worktree ${made.path} (branch ${made.branch}) ${made.created ? 'created' : 'reused'}`);
        // `projectDir` is what the session is named for: CLAUDE_PROJECT_DIR, when set, would otherwise name it for the repo
        // the command was typed in.
        opts = { ...opts, projectDir: made.path };
    }
    // The daily update check rides along with the listener start, not after it.
    const [update] = await Promise.all([cachedUpdateNotice(), (deps.startListener ?? (() => ensureListenerRunning(launchedByListener)))()]);
    if (update) console.error(update);
    // The cwd is what a new tmux session (or the in-pane agent) starts in. After the listener start: a daemon
    // spawned from here would inherit the worktree as its cwd, and it is the one that later removes the directory.
    if (opts.worktree && opts.projectDir) process.chdir(opts.projectDir);
    const { kind, cmd, args, session } = targetForAgent(agent.binary, extra, agent.kind, opts);
    const note = kind === 'direct' ? inPaneNote(agent.subcommands[0], currentTmuxSession()) : undefined;
    if (note) console.error(note);

    // A pinned name skips `findAvailableSession`, and with it the registry
    // check that keeps `new -A` from attaching to a session running another
    // agent and dropping our command. Run that check here for the attach path.
    if (kind === 'tmux-new' && opts.label && session) {
        const known = recallSession(session);
        if (known && known.agentKind !== agent.kind) {
            console.error(`hwip: ${session} is running ${known.agentKind}, not ${agent.binary} — pick another --label`);
            return 1;
        }
    }

    return (deps.launch ?? launchTarget)({ kind, cmd, args, session }, agent.binary);
};

/**
 * Run a spawn target: a detached session is created and named, anything else
 * hands the terminal over (execve where it can, a waited child where not) and
 * forwards the exit code. `what` names the program in the detached message.
 */
const launchTarget = async ({ kind, cmd, args, session }: SpawnTarget, what: string): Promise<number> => {
    if (kind === 'tmux-detached' && session) {
        const r = spawnSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (r.error || r.status !== 0) {
            const why = r.error ? r.error.message : (r.stderr ?? '').trim() || `exit ${r.status}`;
            console.error(`hwip: could not start ${session} — ${why}`);
            return r.status ?? 1;
        }
        // The name is the contract: the caller attaches, kills, or injects by it.
        console.log(`hwip: ${what} started in tmux session ${session} (detached) — attach: tmux attach -t ${session}`);
        return 0;
    }

    // Hand the terminal over and stop existing. Waiting on the child is all
    // this process does for the rest of the session, and it holds a whole node
    // heap to do it — one resident process per `hwip cc`, purely to forward an
    // exit code that execve gives us for free by being the same process.
    const handOff = handOffExec({
        execve: process.execve,
        env: process.env,
        kind,
        stdinTTY: process.stdin.isTTY,
        stdoutTTY: process.stdout.isTTY,
    });
    if (handOff) {
        const file = resolveCommand(cmd);
        // execve does no PATH lookup, so resolving is mandatory — and the
        // resolve failing is the same fact the spawn path learns from ENOENT.
        if (!file) {
            console.error(`hwip: '${cmd}' not found on PATH`);
            return 127;
        }
        // Nothing buffered survives: execve runs no cleanup handler and fires
        // no exit event. Safe here only because stdout is a TTY, which node
        // writes synchronously on POSIX — every `hwip:` line above is already out.
        handOff(file, [cmd, ...args]);
    }

    return new Promise<number>((resolve) => {
        const start = Date.now();
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('exit', (code) => {
            const dur = Date.now() - start;
            // Short-lived non-zero exits are the symptom of "ran from a
            // pane that isn't a real TTY" (some IDE terminals). The user
            // otherwise just sees their shell return with `[exited]` and no
            // clue what went wrong. Only `tmux new` fails that way — telling
            // someone whose agent died inside a perfectly good pane to "run
            // from a plain shell pane" would send them after the wrong thing.
            if (kind === 'tmux-new' && code && code !== 0 && dur < 2000) {
                console.error(
                    `hwip: ${cmd} ${args.join(' ')} exited ${code} after ${dur}ms.\n` +
                    `  If this terminal is itself inside tmux (or an iTerm/Warp\n` +
                    `  tmux-integration pane), run \`hwip cc\` from a plain shell\n` +
                    `  pane instead — \`tmux new\` needs a real TTY to attach.`,
                );
            }
            resolve(code ?? 0);
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                console.error(`hwip: '${cmd}' not found on PATH`);
                resolve(127);
            } else {
                console.error(`hwip: failed to spawn ${cmd}: ${err.message}`);
                resolve(1);
            }
        });
    });
};

// ── hwip sh — a shell the phone may type into ────────────────────────

/** What tmux holds under a `hwip sh` session name. */
export type ShellSessionState = 'none' | 'marked' | 'unmarked';

/** A tmux call, injectable for tests. */
type RunTmux = (args: string[]) => { status: number | null; stdout: string; stderr?: string };

const runTmux: RunTmux = (args) => {
    const r = spawnSync('tmux', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error?.message ?? r.stderr ?? '' };
};

/**
 * How `hwip sh` proceeds, given what tmux holds under the name. `create` is
 * the detached target, `attach` the attaching one (null for `--detach`).
 *
 * A missing session is created with `new -d` and `@hwip_shell` set to its own
 * name in the same tmux call, so no sweep ever sees it unmarked, and `new -d`
 * fails on a taken name: a session that appeared since the probe is never
 * attached to and marked. The listener accepts the marker only when it names
 * the session, so a stray `set -g @hwip_shell …` cannot mark anything. A
 * session this command opened before is reattached (or, detached, left as it
 * is — running `!hwip sh --detach` twice from the phone must not fail). Any
 * other session under that name is refused: the marker would turn it into a
 * typable shell.
 */
export const planShellSession = (
    create: SpawnTarget,
    attach: SpawnTarget | null,
    state: ShellSessionState,
):
    | { kind: 'create'; args: string[]; attach: SpawnTarget | null }
    | { kind: 'attach'; target: SpawnTarget }
    | { kind: 'running' }
    | { kind: 'refuse'; reason: string } => {
    const session = create.session ?? '';
    if (state === 'unmarked') {
        return { kind: 'refuse', reason: `${session} exists and is not a hwip sh session — pick another --label` };
    }
    if (state === 'marked') return attach ? { kind: 'attach', target: attach } : { kind: 'running' };
    return {
        kind: 'create',
        args: [...create.args, ';', 'set-option', '-t', sessionOptionTarget(session), SESSION_SHELL_OPTION, session],
        attach,
    };
};

/**
 * Read the marker off the session itself. `show-options` without `-A` shows
 * only what is set on that session, never an inherited global value. A failed
 * `has-session` reads as "none", which is safe: creation is `new -d`, and it
 * fails on a name that does exist.
 */
export const readShellSessionState = (session: string, run: RunTmux = runTmux): ShellSessionState => {
    if (run(['has-session', '-t', `=${session}`]).status !== 0) return 'none';
    const r = run(['show-options', '-qv', '-t', sessionOptionTarget(session), SESSION_SHELL_OPTION]);
    return r.stdout.trim() === session ? 'marked' : 'unmarked';
};

/**
 * The two targets `hwip sh` works with. Inside tmux there is no attaching —
 * `new -A` would nest and exit 1 after the session already exists — so the
 * run is a detached one, as `--detach` is.
 */
export const shellTargets = (
    shell: string,
    opts: AgentLaunchOptions,
    inTmux: boolean = !!process.env.TMUX,
): { create: SpawnTarget; attach: SpawnTarget | null } => {
    const create = targetForAgent(shell, ['-l'], 'shell', { label: opts.label ?? 'sh', detach: true });
    const session = create.session ?? '';
    // `attach-session`, never `new -A`: a session that died since the probe
    // must not come back as a fresh, unmarked one.
    const attach: SpawnTarget = { kind: 'tmux-new', cmd: 'tmux', args: ['attach-session', '-t', `=${session}`], session };
    return { create, attach: opts.detach || inTmux ? null : attach };
};

/**
 * `hwip sh [--label x] [--detach]` — open (or reattach) `hwip-<project>-sh`
 * running the login shell, marked so the phone may type into it. The label
 * always pins a tmux session, so this never runs in the current pane.
 */
export const handleShellSession = async (opts: AgentLaunchOptions): Promise<number> => {
    const missing = tmuxMissing('sh');
    if (missing) {
        console.error(missing);
        return 127;
    }
    await ensureListenerRunning();
    const shell = process.env.SHELL || '/bin/sh';
    const { create, attach } = shellTargets(shell, opts);
    const session = create.session ?? '';
    const switchHint = (): void => {
        if (process.env.TMUX) console.log(`hwip: from this tmux: tmux switch-client -t ${session}`);
    };
    const plan = planShellSession(create, attach, readShellSessionState(session));
    if (plan.kind === 'refuse') {
        console.error(`hwip: ${plan.reason}`);
        return 1;
    }
    if (plan.kind === 'running') {
        console.log(`hwip: shell session ${session} is already running — attach: tmux attach -t ${session}`);
        switchHint();
        return 0;
    }
    if (plan.kind === 'attach') return launchTarget(plan.target, basename(shell));
    if (!plan.attach) {
        const code = await launchTarget({ ...create, args: plan.args }, basename(shell));
        if (code === 0) switchHint();
        return code;
    }
    const made = runTmux(plan.args);
    if (made.status !== 0) {
        console.error(`hwip: could not start ${session} — ${(made.stderr ?? '').trim() || `exit ${made.status}`}`);
        return made.status ?? 1;
    }
    return launchTarget(plan.attach, basename(shell));
};
