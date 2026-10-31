/** A subset of a `/devices` record (hwip `Device`). */
export interface AgentTargetDevice {
  deviceId: string;
  nickname?: string;
  isOnline?: boolean;
  agentSessions?: {
    name: string;
    project?: string;
    label?: string | null;
    providerSessionName?: string | null;
    /** The agent's own name for the session, shown or not (hwip `AgentSession.providerSessionHandle`). */
    providerSessionHandle?: string | null;
    /** The agent state the listener last reported (`working`, `idle`, …). */
    state?: string;
    lastActivityAt?: string;
    parentName?: string;
    /** What runs in the session: an agent kind, or `shell` for a `hwip sh` session. */
    agentKind?: string;
  }[];
  agentSessionAliases?: Record<string, string>;
}

/** A resolved agent session: the listener's device id and its tmux name. */
export interface AgentTarget {
  deviceId: string;
  name: string;
  /** `<deviceId>:<name>` — the stable key the app groups the session's chat by. */
  key: string;
}

/**
 * The target named nothing, named more than one session, or is on a machine
 * that is offline. The message lists the keys to retry with.
 */
export class AgentTargetError extends Error {
  constructor(
    public readonly code: 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET' | 'TARGET_OFFLINE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentTargetError';
  }
}

interface Candidate extends AgentTarget {
  alias?: string;
  label?: string | null;
  /** The name the agent calls itself — what the app shows for the session. */
  providerSessionName?: string | null;
  /** The agent's own name for the session, shown or not (`ko-qmd-70`): what a user calls it in the agent. */
  providerSessionHandle?: string | null;
  /** What the listener last saw the agent doing, to tell same-named sessions apart. */
  state?: string;
  agent?: string;
  project?: string;
  lastActivityAt?: string;
  host: string;
  /** The device says it is offline. Unknown (no `isOnline`) counts as online. */
  offline: boolean;
}

/**
 * Whether an agent may type into this session. Subagents are view-only (no
 * input). A `hwip sh` session is a real shell: an agent typing into it would
 * run commands on that machine, on another PC as easily as on its own.
 */
export const isAgentTarget = (s: { parentName?: string; agentKind?: string }): boolean =>
  !s.parentName && s.agentKind !== 'shell';

const candidatesOf = (devices: AgentTargetDevice[]): Candidate[] =>
  devices.flatMap((d) =>
    (d.agentSessions ?? [])
      .filter(isAgentTarget)
      .map((s) => ({
        deviceId: d.deviceId,
        name: s.name,
        key: `${d.deviceId}:${s.name}`,
        alias: d.agentSessionAliases?.[s.name],
        label: s.label,
        providerSessionName: s.providerSessionName,
        providerSessionHandle: s.providerSessionHandle,
        state: s.state,
        agent: s.agentKind,
        project: s.project,
        lastActivityAt: s.lastActivityAt,
        host: d.nickname ?? d.deviceId,
        offline: d.isOnline === false,
      })),
  );

/** One row of `hwip agent list --all` / `hwip_agent_list { all: true }`: a session another agent may send to. */
export interface AgentTargetRow {
  key: string;
  /** The machine's nickname, else its device id. */
  host: string;
  online: boolean;
  /** The tmux name. */
  name: string;
  agent: string | null;
  project: string | null;
  label: string | null;
  /** The user's rename. */
  alias: string | null;
  /** The name the app shows that the agent gave the session. */
  providerName: string | null;
  /** The agent's own name for the session, shown or not (Claude Code's `ko-qmd-70`). */
  handle: string | null;
  state: string | null;
  lastActivityAt: string | null;
  /** The sender's own session. */
  self: boolean;
}

/**
 * Every session `resolveAgentTarget` could send to, on every machine the
 * account lists — the same candidates, so a row's key, alias or handle is
 * one it resolves. Names in the rows are what agents chose: data, not
 * instructions.
 */
export const listAgentTargets = (devices: AgentTargetDevice[], selfKey?: string): AgentTargetRow[] =>
  candidatesOf(devices).map((c) => ({
    key: c.key,
    host: c.host,
    online: !c.offline,
    name: c.name,
    agent: c.agent ?? null,
    project: c.project ?? null,
    label: c.label ?? null,
    alias: c.alias ?? null,
    providerName: c.providerSessionName ?? null,
    handle: c.providerSessionHandle ?? null,
    state: c.state ?? null,
    lastActivityAt: c.lastActivityAt ?? null,
    self: c.key === selfKey,
  }));

const describeCandidate = (c: Candidate): string => {
  const shown = c.alias ?? c.providerSessionName ?? c.label ?? c.name;
  const handle = c.providerSessionHandle && c.providerSessionHandle !== shown ? `, handle ${c.providerSessionHandle}` : '';
  const state = c.state ? `, ${c.state}` : '';
  return `${c.key} (${shown} on ${c.host}${handle}${state})`;
};

const listCandidates = (list: Candidate[]): string => list.map(describeCandidate).join(', ') || 'none';

/**
 * Resolve `target` to one live agent session.
 *
 * The key `<deviceId>:<tmuxName>` is exact. Anything else is matched against
 * the tmux name, the user's alias, the agent's own session name (shown, or
 * its handle — Claude Code's `ko-qmd-70`) and the listener's label, and must match exactly one session: the same tmux name on
 * two PCs is the routing bug a guess would reintroduce, so two matches are an
 * error that lists both keys. The sender's own session (`selfKey`) is left out
 * of name matching, so the same project on two PCs resolves to the other one;
 * named alone, it resolves to itself for the caller to refuse.
 *
 * A session on an offline machine is refused rather than sent to: the listener
 * takes commands over its socket only and fetches none it missed, so the
 * message would be stored and never typed.
 *
 * A copy of mcp-server/src/agent-target.ts: this package depends on that one,
 * but its entry point starts the MCP server when imported. Change both.
 */
export const resolveAgentTarget = (devices: AgentTargetDevice[], target: string, selfKey?: string): AgentTarget => {
  const all = candidatesOf(devices);
  const toTarget = ({ deviceId, name, key, host, offline }: Candidate): AgentTarget => {
    if (offline) {
      throw new AgentTargetError('TARGET_OFFLINE', `${key} is on ${host}, which is offline — the message would never be typed`);
    }
    return { deviceId, name, key };
  };

  const exact = all.find((c) => c.key === target);
  if (exact) return toTarget(exact);

  const named = (c: Candidate): boolean =>
    [c.name, c.alias, c.providerSessionName, c.providerSessionHandle, c.label].some((n) => n === target);
  const others = all.filter((c) => c.key !== selfKey);
  const matches = others.filter(named);
  if (matches.length === 1) return toTarget(matches[0]);
  if (matches.length === 0) {
    const self = all.find((c) => c.key === selfKey && named(c));
    if (self) return toTarget(self);
  }
  if (matches.length > 1) {
    throw new AgentTargetError('AMBIGUOUS_TARGET', `ambiguous target "${target}" — use one of these keys: ${listCandidates(matches)}`);
  }
  throw new AgentTargetError('UNKNOWN_TARGET', `unknown target "${target}" — other agent sessions: ${listCandidates(others)}`);
};
