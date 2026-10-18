import { spawnSync } from 'child_process';
import { basename } from 'path';
import { matchAgentByPaneCommand, type RegisteredRemoteAgent } from './remote-agents.js';
import { tmuxArgs } from './tmux-socket.js';

export interface PaneInfo {
    currentCommand: string | null;
    startCommand: string | null;
    currentPath: string | null;
    panePid: number | null;
}

// U+241F "Symbol for Unit Separator" — a *printable* Unicode glyph
// (3-byte UTF-8) that visually represents the C0 Unit Separator but is
// itself a normal character. Critical detail: tmux 3.5a's `-F` format
// escapes raw control bytes (0x00-0x1F) like `\037` for terminal safety,
// which broke an earlier `'\x1f'` separator — the byte we passed never
// arrived at the consumer end. A printable Unicode char passes through
// verbatim and won't appear in any real session name or filesystem path.
export const FIELD_SEP = '␟';

// ─── Pane targets ───────────────────────────────────────────────────
// A bare `-t <session>` resolves to whichever pane has FOCUS, so the moment a
// second pane exists in a `hwip-*` session (pi-interactive-subagents splits
// one off for every subagent), capture and input silently follow the user's
// focus instead of the agent. The inventory sweep pins each session to its
// main pane id, and every `-t` call site goes through `tmuxTargetFor` so the
// pinning cannot be bypassed by one call site forgetting it.

/** Session name → pinned pane id, replaced wholesale by each inventory sweep. */
export let targetsBySession = new Map<string, string>();

/**
 * A subagent session name: `<session>.<pane id digits>` (`hwip-hwip.48`).
 * tmux forbids `.` in session names, so the shape cannot collide; `#` would
 * break the server's stream-sub keys and `:` is the web key separator.
 */
export const isSubagentSessionName = (name: string): boolean => /^hwip-.+\.\d+$/.test(name);

/** Store the latest sweep's name → pane-id map (see `CollectResult.targets`). */
export const recordTargets = (targets: Record<string, string> | null | undefined): void => {
    targetsBySession = new Map(Object.entries(targets ?? {}));
};

/**
 * Subagent name → the transcript it writes, for the ones that have no pane
 * (`CollectResult.subagentTranscripts`). The addressing map above answers for
 * pane subagents; this one answers for in-process ones, and it is deliberately
 * NOT `targets`: a row in there is a pane every write path may address, and
 * these rows have nothing to address.
 */
export let subagentTranscriptsBySession = new Map<string, string>();

export const recordSubagentTranscripts = (paths: Record<string, string> | null | undefined): void => {
    subagentTranscriptsBySession = new Map(Object.entries(paths ?? {}));
};

/** The transcript of an in-process subagent, or null for anything else. */
export const subagentTranscriptFor = (name: string): string | null =>
    subagentTranscriptsBySession.get(name) ?? null;

/**
 * The tmux target for a wire session name: its pinned pane id when the last
 * sweep saw the session, else the name itself (a session younger than one
 * sweep, or tmux unreachable at startup — today's resolution, active pane).
 *
 * A SUBAGENT name is the one exception: it resolves ONLY through the map, and
 * an unknown one is null — because tmux parses `hwip-hwip.48` as session
 * `hwip-hwip`, pane INDEX 48, and silently falls back to the active pane when
 * that index is missing (measured: `display -t hwip-hwip.99` → main pane,
 * exit 0). Every caller treats null as "gone": no spawn, refusal, or capture
 * failure — never a write to whichever pane happens to be focused.
 */
export const tmuxTargetFor = (name: string): string | null => {
    const hit = targetsBySession.get(name);
    if (hit !== undefined) return hit;
    return isSubagentSessionName(name) ? null : name;
};

export const readPaneInfo = (session: string): PaneInfo => {
    const target = tmuxTargetFor(session);
    if (target === null) return { currentCommand: null, startCommand: null, currentPath: null, panePid: null };
    const r = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', target,
        `#{pane_current_command}${FIELD_SEP}#{pane_start_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return { currentCommand: null, startCommand: null, currentPath: null, panePid: null };
    const parts = (r.stdout ?? '').trim().split(FIELD_SEP);
    if (parts.length !== 4) return { currentCommand: null, startCommand: null, currentPath: null, panePid: null };
    const [current, start, path, pid] = parts;
    const parsedPid = Number(pid);
    return {
        currentCommand: current || null,
        startCommand: start || null,
        currentPath: path || null,
        panePid: Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null,
    };
};

/**
 * Strip the surrounding quotes tmux uses when serialising commands
 * with spaces. `tmux display-message -p '#{pane_start_command}'`
 * outputs `"claude --resume xxx"` (literal double-quotes around the
 * whole shell-command form the wrapper passed). Without unwrapping,
 * the leading `"` made the basename check fail and the listener
 * skipped the session as 'no agent in pane'.
 */
const unwrapQuotes = (cmd: string): string => {
    const m = cmd.match(/^"(.+)"$/) || cmd.match(/^'(.+)'$/);
    return m ? m[1] : cmd;
};

const firstTokenBasename = (cmd: string | null): string => {
    if (!cmd) return '';
    const stripped = unwrapQuotes(cmd.trim());
    return basename(stripped.split(/\s+/)[0] || '');
};

/**
 * Identify the agent from the tmux pane. Prefer `pane_start_command`
 * because the foreground process is usually `node`/`python3` (the
 * interpreter), which doesn't tell us *what* was launched. Fall back to
 * `pane_current_command` when start_command is empty — tmux clears
 * start_command in some re-attach cases, especially when a pre-existing
 * session was joined via `tmux new -A` instead of being created fresh.
 * That fallback is safe because only the literal binaries registered in
 * remote-agents.ts are accepted as a match.
 */
export const detectRemoteAgent = (info: PaneInfo): RegisteredRemoteAgent | null =>
    matchAgentByPaneCommand(firstTokenBasename(info.startCommand))
    ?? matchAgentByPaneCommand(firstTokenBasename(info.currentCommand))
    ?? null;
