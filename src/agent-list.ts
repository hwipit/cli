import { flagOn } from './args.js';
import { agentSessionContext } from './agent-session.js';
import { isAgentTarget, listAgentTargets, type AgentTargetDevice, type AgentTargetRow } from './agent-target.js';
import type { AgentState } from './agent-state.js';
import { listenerDeviceId } from './listener-device-id.js';

/**
 * `hwip agent list` — the agent sessions running on THIS machine. It looks at tmux
 * and the screens through the listener's own sweep and nothing else: no server,
 * no relay, no API key, and nothing typed into a session. Another PC's sessions
 * stay out of reach on purpose (the E2E trust boundary).
 *
 * The sweep (`collectSessionsVerbose`) ends by refreshing the local session record
 * (`$XDG_STATE_HOME/hwip/known-sessions.json`, the listener's resume whitelist). That
 * write belongs to the listener alone: the file is written in place, so a second writer
 * can leave the listener a half-written file. `liveLocalAgentDeps` switches it off for
 * this process (`keepRegistryUntouched`), which keeps `listener.ts` as it is.
 */

/** The part of a listener session row this command reads. */
export interface ListedSession {
    name: string;
    attached: boolean;
    agentKind: string;
    parentName?: string;
    project: string;
    label?: string | null;
    providerSessionName?: string | null;
    providerSessionHandle?: string | null;
    state?: AgentState;
    lastActivityAt?: string;
}

export interface LocalAgentDeps {
    /** One sweep of the local tmux server: every `hwip-*` session with its kind and state. */
    collect: () => ListedSession[];
    deviceId: () => string;
    /** The key of the session this process runs in, or null outside tmux. */
    selfKey: () => string | null;
    /** Whether tmux answered at all. Asked only when the sweep found nothing. */
    tmuxVisible: () => boolean;
    /** Awaited, so a large JSON line is flushed before the process exits. */
    out: (text: string) => void | Promise<void>;
    err: (line: string) => void;
}

/** One row of the `--json` contract (version 1). */
export interface AgentListEntry {
    key: string;
    name: string;
    agent: string;
    project: string;
    label: string | null;
    providerName: string | null;
    /** The agent's own name for the session, shown or not (Claude Code's `ko-qmd-70`) — a name `agent send` takes. */
    handle: string | null;
    state: AgentState | null;
    attached: boolean;
    lastActivityAt: string | null;
    self: boolean;
}

export type AgentListResult =
    | { ok: true; v: 1; device: string; sessions: AgentListEntry[] }
    | { ok: false; code: 'NO_TMUX'; message: string };

export const NO_TMUX_MESSAGE = 'no tmux server answered — no agent sessions can be listed or read on this machine';

export const listLocalAgents = (deps: LocalAgentDeps): AgentListResult => {
    const device = deps.deviceId();
    const self = deps.selfKey();
    const sessions = deps
        .collect()
        .filter(isAgentTarget)
        .map(
            (s): AgentListEntry => ({
                key: `${device}:${s.name}`,
                name: s.name,
                agent: s.agentKind,
                project: s.project,
                label: s.label ?? null,
                providerName: s.providerSessionName ?? null,
                handle: s.providerSessionHandle ?? null,
                state: s.state ?? null,
                attached: s.attached,
                lastActivityAt: s.lastActivityAt ?? null,
                self: `${device}:${s.name}` === self,
            }),
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // An empty sweep is either "no agent runs" or "tmux was not reachable"; only the second is an error.
    if (sessions.length === 0 && !deps.tmuxVisible()) return { ok: false, code: 'NO_TMUX', message: NO_TMUX_MESSAGE };
    return { ok: true, v: 1, device, sessions };
};

/**
 * The agent names its session itself (`/rename`), so the text may hold escape sequences a terminal would act on, or bidi
 * overrides and zero-width characters that make one name read as another — the set the server's `oneLine` strips.
 */
// eslint-disable-next-line no-control-regex -- stripping them is the point
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ');

const renderList = (sessions: AgentListEntry[]): string => {
    if (sessions.length === 0) return 'no agent sessions on this machine';
    const rows = sessions.map((s) => [s.key, s.agent, s.state ?? '-', `${printable(s.providerName ?? s.label ?? '-')}${s.self ? ' (this session)' : ''}`]);
    const table = [['KEY', 'AGENT', 'STATE', 'NAME'], ...rows];
    const widths = [0, 1, 2].map((col) => Math.max(...table.map((r) => r[col]!.length)));
    return table.map((r) => [...widths.map((w, col) => r[col]!.padEnd(w)), r[3]].join('  ')).join('\n');
};

export const runAgentList = async (opts: { json: boolean }, deps: LocalAgentDeps): Promise<number> => {
    const result = listLocalAgents(deps);
    if (!result.ok) {
        if (opts.json) await deps.out(JSON.stringify({ v: 1, error: result.code, message: result.message }));
        else deps.err(`hwip agent list: ${result.message}`);
        return 1;
    }
    if (opts.json) await deps.out(JSON.stringify({ v: result.v, device: result.device, sessions: result.sessions }));
    else await deps.out(renderList(result.sessions));
    return 0;
};

/** What `hwip agent list --all` needs: the account's device list, and the key of the session it runs in. */
export interface AllAgentDeps {
    /** `GET /devices`; throws when the list cannot be fetched. */
    listDevices: () => Promise<AgentTargetDevice[]>;
    selfKey: () => string | null;
    out: (text: string) => void | Promise<void>;
    err: (line: string) => void;
}

const renderAll = (rows: AgentTargetRow[]): string => {
    if (rows.length === 0) return 'no agent sessions on any machine';
    const nameOf = (r: AgentTargetRow): string => {
        const shown = r.alias ?? r.providerName ?? r.label ?? '-';
        const handle = r.handle && r.handle !== shown ? ` [${r.handle}]` : '';
        return printable(`${shown}${handle}${r.online ? '' : ' (offline)'}${r.self ? ' (this session)' : ''}`);
    };
    // Every cell is another machine's report, the key and agent kind included.
    const table = [['KEY', 'HOST', 'AGENT', 'STATE', 'NAME'], ...rows.map((r) => [printable(r.key), printable(r.host), printable(r.agent ?? '-'), printable(r.state ?? '-'), nameOf(r)])];
    const widths = [0, 1, 2, 3].map((col) => Math.max(...table.map((r) => r[col]!.length)));
    return table.map((r) => [...widths.map((w, col) => r[col]!.padEnd(w)), r[4]].join('  ')).join('\n');
};

/**
 * `hwip agent list --all` — every session `hwip agent send` could reach, on every
 * machine the account lists, read from the server's device list (the same one a
 * send resolves its target in). Names only: no conversation leaves its machine.
 */
export const runAgentListAll = async (opts: { json: boolean }, deps: AllAgentDeps): Promise<number> => {
    let rows: AgentTargetRow[];
    try {
        // No session key (outside tmux): there is no own session, so no row is `self` — as in the local list.
        rows = listAgentTargets(await deps.listDevices(), deps.selfKey() ?? undefined);
    } catch (e) {
        const message = `could not read the device list: ${e instanceof Error ? e.message : String(e)}`;
        if (opts.json) await deps.out(JSON.stringify({ v: 1, error: 'LIST_FAILED', message }));
        else deps.err(`hwip agent list --all: ${message}`);
        return 1;
    }
    if (opts.json) await deps.out(JSON.stringify({ v: 1, all: true, sessions: rows }));
    else await deps.out(renderAll(rows));
    return 0;
};

/** Write to stdout and wait for it: `main` calls `process.exit` right after, which cuts off a pipe's tail. */
export const writeStdout = (text: string): Promise<void> =>
    new Promise((resolve) => {
        process.stdout.write(`${text}\n`, () => resolve());
    });

/**
 * The real sweep. The listener's log goes quiet first (its tmux socket search
 * prints to stdout, which `--json` must keep to one object) and the OTA agent
 * rules are read from the cache, else every non-claude session reports no state
 * — the same two steps the inventory worker takes before it sweeps.
 */
export const liveLocalAgentDeps = async (): Promise<LocalAgentDeps> => {
    const { collectSessionsVerbose, liveSessionNames, silenceListenerLog } = await import('./listener.js');
    const { syncManifestFromCache } = await import('./agent-rules-fetch.js');
    const { keepRegistryUntouched } = await import('./session-registry.js');
    silenceListenerLog();
    keepRegistryUntouched();
    return {
        collect: () => {
            syncManifestFromCache();
            return collectSessionsVerbose().sessions;
        },
        deviceId: listenerDeviceId,
        selfKey: () => {
            const context = agentSessionContext();
            return context ? `${context.agentDeviceId}:${context.agentSessionName}` : null;
        },
        tmuxVisible: () => liveSessionNames() !== null,
        out: writeStdout,
        err: (line) => console.error(line),
    };
};

export const handleAgentList = async (args: Record<string, string | boolean>): Promise<number> => {
    // `--turns` belongs to `agent read`; the flag table is shared by the `agent` subcommands, so it is refused here.
    if (args._arg2 || args.turns !== undefined) {
        console.error('Usage: hwip agent list [--all] [--json]');
        return 2;
    }
    return runAgentList({ json: flagOn(args, 'json') }, await liveLocalAgentDeps());
};

export const handleAgentListAll = async (
    args: Record<string, string | boolean>,
    hook: { listDevices: () => Promise<AgentTargetDevice[]> },
): Promise<number> => {
    if (args._arg2 || args.turns !== undefined) {
        console.error('Usage: hwip agent list [--all] [--json]');
        return 2;
    }
    return runAgentListAll(
        { json: flagOn(args, 'json') },
        {
            listDevices: () => hook.listDevices(),
            selfKey: () => {
                const context = agentSessionContext();
                return context ? `${context.agentDeviceId}:${context.agentSessionName}` : null;
            },
            out: writeStdout,
            err: (line) => console.error(line),
        },
    );
};
