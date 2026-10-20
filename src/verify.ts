import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectAgents, resolveCommand } from './agents.js';
import { configIgnoredBecause, keyIsFromFile, loadConfig, resolveBaseUrl, resolvedEnv, resolveHookId, VERSION } from './config.js';
import { serviceHealthChecks, serviceStatus, type ServiceHealthRow } from './listener-service.js';
import { HwipHook } from './hwip-hook.js';
import { parseJsonc } from './jsonc-doc.js';
import { describeNotifyFailure, isTransientNotifyFailure, readNotifyFailure } from './notify-failure.js';
import { hasHwipAutoName, readHwipMcpArgv } from './codex-config.js';
import { AUTONAME_ENV, MCP_LAUNCH_ARGV } from './mcp-command.js';
import {
    isListenerPid, LISTENER_LOG_FILE, runningListenerPid, runningListenerWsUrl as stampedListenerWsUrl,
} from './listener-process.js';
import { insecureUrlWarning } from './insecure-url.js';
import { redactSecrets } from './redact.js';
import {
    DEFAULT_API_BASE, endpointStage, legacyWsEnvNotice, parseListenerStartUrl, resolveWsUrlDetailed,
    type WsUrlSource, wsUrlProblem,
} from './ws-url.js';
import { flagOn } from './args.js';

const HOME = homedir();

// The service health rows already carry exactly this shape, and every check
// here is recorded the same way — one declaration, not two kept in step by hand.
type Check = ServiceHealthRow;

/** A settings file's value — `{}` for an empty file and without an editor's BOM,
 *  comments and trailing commas allowed, as the installer reads it; undefined
 *  when it is missing or does not parse. */
const readJson = (filePath: string): unknown => {
    try {
        return parseJsonc(readFileSync(filePath, 'utf-8'));
    } catch {
        return undefined;
    }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Is the hwip plugin installed in Claude Code, or a `hwip` MCP server registered in ~/.claude.json? Exported for tests. */
export const claudeHasHwip = (home: string): boolean => {
    const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    const plugins = isPlainObject(installed) ? installed.plugins : undefined;
    const installs = isPlainObject(plugins) ? plugins['hwip@hwip'] : undefined;
    // An array of installs (v2), or one install object (v1).
    if ((Array.isArray(installs) && installs.length > 0) || isPlainObject(installs)) return true;
    const claude = readJson(join(home, '.claude.json'));
    const servers = isPlainObject(claude) ? claude.mcpServers : undefined;
    return isPlainObject(servers) && 'hwip' in servers;
};

/** Does a shared rule file contain the Hwip managed block? */
const hasManagedBlock = (filePath: string): boolean => {
    try {
        return readFileSync(filePath, 'utf-8').includes('HWIP:START');
    } catch {
        return false;
    }
};

// Per-agent: report whether the rule artifact Hwip installs is present.
const AGENT_RULE_PRESENT: Record<string, () => boolean> = {
    // The plugin `hwip install` adds, or an MCP server registered by hand —
    // not any mention of "hwip" anywhere in ~/.claude.json (a project path).
    claude: () => claudeHasHwip(HOME),
    cursor: () => existsSync(join(HOME, '.cursor', 'rules', 'hwip.mdc')),
    windsurf: () => hasManagedBlock(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md')),
    gemini: () => hasManagedBlock(join(HOME, '.gemini', 'GEMINI.md')),
    codex: () => hasManagedBlock(join(HOME, '.codex', 'AGENTS.md')),
    copilot: () => existsSync(join(HOME, '.copilot', 'instructions', 'hwip.instructions.md')),
    cline: () => existsSync(join(HOME, '.cline', 'rules', 'hwip.md')),
    aider: () => existsSync(join(HOME, '.hwip', 'aider-conventions.md')),
    pi: () => hasManagedBlock(join(HOME, '.pi', 'agent', 'AGENTS.md')),
    opencode: () => hasManagedBlock(join(HOME, '.config', 'opencode', 'AGENTS.md')),
};

/** Codex keeps its registry in TOML, so its reader is text-level — the table
 *  shape lives in codex-config.ts, which install and uninstall share. */
export const readCodexMcpArgv = (filePath: string): string[] | null => {
    try {
        return readHwipMcpArgv(readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
};

const readCodexAutoName = (filePath: string): boolean => {
    try {
        return hasHwipAutoName(readFileSync(filePath, 'utf-8'));
    } catch {
        return false;
    }
};

/**
 * Where each agent records the MCP launch, and how to read it back — the row
 * carries its own reader because codex keeps its registry in TOML while every
 * other agent keeps it in JSON.
 * `agent` matches the label `detectAgents` uses so one report never names the
 * same agent two ways. Cursor/Windsurf/OpenCode are files the installer writes
 * itself; the Gemini row is READ-ONLY — `hwip install` shells out to
 * `gemini mcp add`, so this path is the gemini CLI's own storage layout,
 * confirmed by reading the file it produced, not something Hwip chose.
 */
const MCP_REGISTRIES: ReadonlyArray<{
    agent: string;
    path: string;
    argv: (path: string) => string[] | null | typeof UNREADABLE;
    /** Agents the installer turns auto session names on for; absent = not this agent's (it titles itself). */
    autoName?: (path: string) => boolean;
}> = [
    { agent: 'Cursor', path: join(HOME, '.cursor', 'mcp.json'), argv: (p) => registeredMcpArgv(p, 'mcpServers'), autoName: (p) => registeredAutoName(p, 'mcpServers') },
    { agent: 'Windsurf', path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), argv: (p) => registeredMcpArgv(p, 'mcpServers'), autoName: (p) => registeredAutoName(p, 'mcpServers') },
    { agent: 'Gemini CLI', path: join(HOME, '.gemini', 'settings.json'), argv: (p) => registeredMcpArgv(p, 'mcpServers'), autoName: (p) => registeredAutoName(p, 'mcpServers') },
    { agent: 'OpenCode', path: join(HOME, '.config', 'opencode', 'opencode.json'), argv: (p) => registeredMcpArgv(p, 'mcp') },
    { agent: 'Codex CLI', path: join(HOME, '.codex', 'config.toml'), argv: readCodexMcpArgv, autoName: readCodexAutoName },
];

/** A registry file that exists but is not a JSON object — its hwip entry, if any, is unknowable. */
export const UNREADABLE = 'unreadable';

/**
 * The launch argv a registry file records for hwip, verbatim — null when the
 * file is absent or has no hwip entry, `UNREADABLE` when it exists but is not
 * a JSON object. Two schemas in the wild:
 * `command` + `args` (Cursor/Windsurf/Gemini) and `command` as a whole array
 * (opencode). Returned as-is on purpose: a stale entry is only detectable if
 * the reader does not normalize it into the shape it expects.
 */
export const registeredMcpArgv = (filePath: string, key: string): string[] | null | typeof UNREADABLE => {
    if (!existsSync(filePath)) return null;
    const data = readJson(filePath);
    if (!isPlainObject(data)) return UNREADABLE;
    const container = data[key] as Record<string, unknown> | undefined;
    const entry = container?.hwip as { command?: unknown; args?: unknown } | undefined;
    if (!entry) return null;
    if (Array.isArray(entry.command)) return entry.command.map(String);
    if (typeof entry.command !== 'string') return null;
    return [entry.command, ...(Array.isArray(entry.args) ? entry.args.map(String) : [])];
};

/** Whether a JSON registry's hwip entry sets HWIP_AUTONAME=1 — false for a
 *  missing file or entry, which `registeredMcpArgv` reports on its own. */
export const registeredAutoName = (filePath: string, key: string): boolean => {
    if (!existsSync(filePath)) return false;
    const data = readJson(filePath);
    if (!isPlainObject(data)) return false;
    const servers = data[key];
    const entry = isPlainObject(servers) ? servers.hwip : undefined;
    return isPlainObject(entry) && isPlainObject(entry.env) && entry.env[AUTONAME_ENV] === '1';
};

/**
 * Can this launch binary actually be run? Registered commands come out of a
 * config file, so unlike everywhere else in the CLI they can be an absolute
 * path — `which` is the wrong question for one of those, hence the split.
 * The bare-name half is `resolveCommand`; neither half touches a shell, so a
 * path with a space in it stays one word and a `;` in the file stays inert.
 */
export const binaryResolves = (bin: string): boolean => {
    if (!bin.includes('/')) return resolveCommand(bin) !== null;
    try {
        accessSync(bin, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/**
 * What a recorded registration is worth right now. `unresolvable` outranks
 * `stale`: a stale entry still starts a server (through the npm launcher this
 * release exists to delete), an unresolvable one starts nothing at all and
 * takes the agent's whole hwip toolset down with it, silently — the config is
 * read once at install time and never checked again.
 */
export type McpRegistration =
    | { readonly state: 'current' }
    | { readonly state: 'stale'; readonly argv: string[] }
    | { readonly state: 'unresolvable'; readonly argv: string[] }
    | { readonly state: 'unreadable'; readonly path: string };

/** null = this agent has no hwip registration at all, so there is nothing to report. */
export const classifyMcpRegistration = (
    argv: string[] | null,
    isOnPath: (bin: string) => boolean,
): McpRegistration | null => {
    if (!argv || argv.length === 0) return null;
    if (!isOnPath(argv[0])) return { state: 'unresolvable', argv };
    const isCanonical = argv.length === MCP_LAUNCH_ARGV.length
        && argv.every((token, i) => token === MCP_LAUNCH_ARGV[i]);
    return isCanonical ? { state: 'current' } : { state: 'stale', argv };
};

/** The registries that actually hold a hwip entry, classified. Agents that were
 *  never installed drop out here so the report has no row for them. */
const activeMcpRegistrations = (
    isOnPath: (bin: string) => boolean,
): Array<{ agent: string; result: McpRegistration; namesSessions?: boolean }> =>
    MCP_REGISTRIES.flatMap((registry): Array<{ agent: string; result: McpRegistration; namesSessions?: boolean }> => {
        const argv = registry.argv(registry.path);
        if (argv === UNREADABLE) return [{ agent: registry.agent, result: { state: 'unreadable', path: registry.path } as const }];
        const result = classifyMcpRegistration(argv, isOnPath);
        return result ? [{ agent: registry.agent, result, namesSessions: registry.autoName?.(registry.path) }] : [];
    });

/** Where a resolved WebSocket URL came from, in the user's terms. */
const WS_SOURCE_LABEL: Record<WsUrlSource, string> = {
    flag: '--ws-url',
    config: '~/.hwip/config.json',
    'env-deprecated': 'HWIP_WS_URL (deprecated)',
    default: 'built-in default',
};

/**
 * The URL the live daemon connected to, or null when none is running.
 *
 * The stamp first; the log only as a fallback, for a daemon started by a build
 * that predates the stamp. Reading the log alone was not enough — it rotates at
 * 5MB, and the daemon whose startup line has been rotated away is precisely the
 * long-lived one whose config edit this check exists to catch.
 */
const liveListenerWsUrl = (): string | null => {
    if (runningListenerPid() === null) return null;
    const stamped = stampedListenerWsUrl();
    if (stamped) return stamped;
    try {
        return parseListenerStartUrl(readFileSync(LISTENER_LOG_FILE, 'utf-8'));
    } catch {
        return null;
    }
};

export const handleVerify = async (args: Record<string, string | boolean>): Promise<number> => {
    const doPing = flagOn(args, 'ping');
    // `--json`: the same checks as one JSON object on stdout, nothing else.
    const json = flagOn(args, 'json');
    const say = (line: string) => { if (!json) console.log(line); };
    const checks: Array<Check & { section: string }> = [];
    let current = '';
    const section = (name: string) => {
        current = name;
        say(`\n  ${name}:`);
    };
    const record = (label: string, state: Check['state']) => {
        checks.push({ section: current, label, state });
        say(`    ${state === 'pass' ? '✓' : state === 'warn' ? '!' : '✗'} ${label}`);
    };
    // A bare flag parses as `true`, which is no key and no URL.
    const flag = (name: string): string | undefined => (typeof args[name] === 'string' ? args[name] : undefined);

    say(`\n  Hwip verify — v${VERSION}`);

    // ── Credentials ──────────────────────────────────────────────
    section('Credentials');
    const config = loadConfig();
    // Resolved as every other command resolves them (cli.ts createHook), so
    // `--ping` tests the key and the API the user's commands actually use.
    const keySource = flag('key') ? '--key' : resolvedEnv('HWIP_API_KEY') ? 'HWIP_API_KEY' : config.apiKey ? '~/.hwip/config.json' : null;
    const apiKey = flag('key') || resolvedEnv('HWIP_API_KEY') || config.apiKey;
    const fileKey = keyIsFromFile(flag('key'), config);
    // A config.json that cannot be used is a failure of its own, whatever else resolves: the listener runs with its options off.
    const ignored = configIgnoredBecause();
    if (ignored) {
        record(`${ignored} — the listener runs with its options off (turn history, keep-awake) and nothing writes over it: fix it, or move it aside`, 'fail');
    }
    let baseUrl = DEFAULT_API_BASE;
    let baseKnown = true;
    try {
        baseUrl = resolveBaseUrl(flag('base-url'), config, fileKey);
    } catch (err) {
        baseKnown = false;
        record(err instanceof Error ? err.message : String(err), 'fail');
    }
    const hookId = resolveHookId();
    const baseInsecure = insecureUrlWarning(baseUrl);
    record(keySource ? `API key set (from ${keySource})` : 'API key not set (--key, HWIP_API_KEY or ~/.hwip/config.json)',
        apiKey ? 'pass' : 'fail');
    record(hookId
        ? 'HWIP_HOOK_ID is set (two-way hwip_ask enabled)'
        : 'HWIP_HOOK_ID not set (notify-only — set it for remote control)',
        hookId ? 'pass' : 'warn');
    if (baseInsecure) record(baseInsecure.replace(/^hwip: /, ''), 'warn');

    // ── Runtime ──────────────────────────────────────────────────
    // One resolution per binary: `hwip` alone was being looked up five times
    // (twice here, once per registry below), and each lookup is a spawn.
    const resolved = new Map<string, boolean>();
    const resolves = (bin: string): boolean => {
        const cached = resolved.get(bin);
        if (cached !== undefined) return cached;
        const found = binaryResolves(bin);
        resolved.set(bin, found);
        return found;
    };

    section('Runtime');
    const hasNode = resolves('node');
    const hasNpx = resolves('npx');
    const hasHwip = resolves('hwip');
    record(hasNode ? 'node available' : 'node not found', hasNode ? 'pass' : 'fail');
    record(hasNpx ? 'npx available (hook fallback when hwip is off PATH)' : 'npx not found',
        hasNpx ? 'pass' : 'warn');
    // Not a warning any more: `hwip mcp` IS the MCP server, so a hwip that
    // isn't on PATH means no MCP tools at all, not just a slower first call.
    record(hasHwip
        ? 'hwip CLI on PATH (runs the MCP server and the hooks)'
        : 'hwip CLI not on PATH — MCP tools will not start. Reinstall: npm i -g @hwip/cli',
        hasHwip ? 'pass' : 'fail');
    // Notify-only setups need neither, so both are warnings. The listener
    // dies on a missing key or tmux and says so only in its log.
    const hasTmux = resolves('tmux');
    record(hasTmux
        ? 'tmux available (hwip cc and phone control run in it)'
        : 'tmux not found — hwip cc and phone control need it',
        hasTmux ? 'pass' : 'warn');
    // A reused pid is alive too: only a listener's command line counts, as in
    // the daemon's own startup guard.
    const pidOnRecord = runningListenerPid();
    const listenerPid = pidOnRecord !== null && isListenerPid(pidOnRecord) ? pidOnRecord : null;
    record(listenerPid !== null
        ? `listener running (pid ${listenerPid})`
        : `listener not running — the phone cannot reach agent sessions; \`hwip cc\` starts it (log: ${LISTENER_LOG_FILE})`,
        listenerPid !== null ? 'pass' : 'warn');

    // ── Login-time service ───────────────────────────────────────
    // Optional, so a missing one is a warning. A broken one is not: every way
    // it breaks still looks installed from the outside.
    const serviceRows = serviceHealthChecks(serviceStatus());
    if (serviceRows.length > 0) {
        section('Login-time service');
        for (const row of serviceRows) record(row.label, row.state);
    }

    // ── WebSocket ────────────────────────────────────────────────
    // The phone's Agents list is fed over this socket, so a machine on the
    // wrong stage is simply absent from the app with nothing to explain it.
    section('WebSocket');
    const wsBaseUrl = baseUrl;
    const staleWsEnv = legacyWsEnvNotice(config, process.env, fileKey ? { baseUrl: wsBaseUrl } : undefined);
    if (staleWsEnv) record(staleWsEnv.replace(/^hwip: /, ''), 'warn');
    const ws = resolveWsUrlDetailed(args, config, wsBaseUrl, fileKey);
    if (!baseKnown) {
        record('WebSocket URL not checked — it and the API base may be set in the config.json that cannot be read', 'warn');
    } else if (!ws) {
        record('no WebSocket URL, and none can be guessed for a custom API base — set "wsUrl" in ~/.hwip/config.json', 'fail');
    } else {
        const wsProblem = wsUrlProblem(ws.url);
        const wsInsecure = wsProblem ? null : insecureUrlWarning(ws.url);
        record(wsProblem ?? `${redactSecrets(ws.url)} (from ${WS_SOURCE_LABEL[ws.source]})`, wsProblem ? 'fail' : 'pass');
        if (wsInsecure) record(wsInsecure.replace(/^hwip: /, ''), 'warn');

        // Socket on one stage and REST on another splits the device: pushes go
        // one way, the agent list the other, and neither half looks broken.
        const wsStage = endpointStage(ws.url);
        const apiStage = endpointStage(wsBaseUrl);
        record(wsStage === apiStage
            ? `API base is the same stage (${apiStage})`
            : `stage mismatch — socket is ${wsStage}, API base is ${apiStage} (${wsBaseUrl}). Pushes and the agent list would land in different environments`,
            wsStage === apiStage ? 'pass' : 'warn');

        // The daemon reads this once, at startup. Editing the config does
        // nothing to a listener that has been up since before the edit — which
        // looks exactly like the config not being read at all.
        const live = liveListenerWsUrl();
        if (live && live !== ws.url) {
            record(`the running listener is on ${live}, not the resolved URL — restart it: hwip listener --restart`, 'warn');
        }
    }

    // ── MCP registrations ────────────────────────────────────────
    const registrations = activeMcpRegistrations(resolves);
    if (registrations.length > 0) {
        section('MCP registrations');
        for (const { agent, result, namesSessions } of registrations) {
            if (result.state === 'current') {
                record(`${agent}: launches \`${MCP_LAUNCH_ARGV.join(' ')}\``, 'pass');
                // Installed before auto session names: the agent never titles its sessions.
                if (namesSessions === false) record(`${agent}: auto session names off — Re-run: hwip install`, 'warn');
            }
            else if (result.state === 'stale') {
                record(`${agent}: still launches \`${result.argv.join(' ')}\` — one extra resident process per session. Re-run: hwip install`, 'warn');
            } else if (result.state === 'unresolvable') {
                record(`${agent}: launches \`${result.argv[0]}\`, which is not on PATH — hwip tools will not load. Re-run: hwip install`, 'fail');
            } else {
                // Not "unregistered": an entry in a file nothing can parse is unknown, not absent.
                record(`${agent}: could not read ${result.path} as a JSON object — check its hwip entry by hand`, 'warn');
            }
        }
    }

    // ── Last push ────────────────────────────────────────────────
    // Hooks run `hwip notify` with stderr discarded, so this record is the only
    // trace a failed push leaves (notify-failure.ts). A good push deletes it.
    section('Push delivery');
    const lastFailure = readNotifyFailure();
    if (lastFailure) {
        record(describeNotifyFailure(lastFailure), isTransientNotifyFailure(lastFailure) ? 'warn' : 'fail');
    } else {
        record('no failed push since the last successful one', 'pass');
    }

    // ── Per-agent config ─────────────────────────────────────────
    section('Agents');
    const detected = detectAgents().filter((a) => a.detected);
    if (detected.length === 0) {
        record('no supported agents detected', 'warn');
    }
    for (const agent of detected) {
        const present = AGENT_RULE_PRESENT[agent.id]?.() ?? false;
        record(`${agent.name}: ${present ? 'Hwip rules installed' : 'Hwip rules NOT installed — run: hwip install'}`,
            present ? 'pass' : 'warn');
    }

    // ── Optional live API ping ───────────────────────────────────
    if (doPing) {
        section('API ping');
        if (!apiKey) {
            record('skipped — no API key', 'warn');
        } else if (!baseKnown) {
            record('skipped — the key would go to the default API, not necessarily the one it belongs to', 'warn');
        } else {
            try {
                const hook = new HwipHook({ apiKey, baseUrl });
                await hook.list({ limit: 1 });
                record('API reachable, key accepted', 'pass');
            } catch (err) {
                record(`API call failed: ${err instanceof Error ? err.message : 'unknown'}`, 'fail');
            }
        }
    }

    // ── Summary ──────────────────────────────────────────────────
    const fails = checks.filter((c) => c.state === 'fail').length;
    const warns = checks.filter((c) => c.state === 'warn').length;
    if (json) {
        console.log(JSON.stringify({ version: VERSION, failed: fails, warnings: warns, checks }, null, 2));
    } else if (fails === 0 && warns === 0) {
        console.log('\n  ✓ All checks passed.\n');
    } else {
        console.log(`\n  ${fails} failed, ${warns} warnings.${doPing ? '' : ' (run with --ping to test the API)'}\n`);
    }
    return fails === 0 ? 0 : 1;
};
