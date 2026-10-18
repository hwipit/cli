/**
 * Presence — is the user away from the terminal?
 *
 * The TS twin of `plugin/hooks/gate.sh` hwip_is_away (hwipit/plugin): the
 * Claude Stop hook asks there, every `notify --auto` hook asks here, and both
 * must answer alike. The quiet dial silences routine pushes because the user is
 * watching the pane; an away user is not, so the answer becomes decidePush's
 * `away`. Keep the probe order and fallbacks in sync with the bash side — the
 * cases in presence.test.ts mirror its `away:` block in test-hwip-stop.sh.
 *
 * Away is the machine verdict below, or this session's own tmux pane being
 * hidden (`paneHidden`): a keyboard or a tmux client says the user is at the
 * desk, not which tmux session they are looking at.
 *
 * Threshold: HWIP_AWAY_SEC seconds (default 300, `0` disables, anything that is
 * not a whole number of at most 9 digits falls back to the default). Probes,
 * first answer wins:
 *   1. inside tmux and no client attached to the server at all → away. Any
 *      attached client means someone is at a tmux terminal, so switching the
 *      one client between sessions does not make the MACHINE read as away (the
 *      pane check above still asks about this session).
 *   2. not over SSH and ioreg reports HIDIdleTime (macOS) → that decides, and
 *      nothing below runs: tmux activity only sees keys typed into tmux, so a
 *      user reading a browser would look idle to it. Inside tmux, "over SSH"
 *      comes from the session environment (`show-environment`), which tmux
 *      refreshes on every attach — the process's own SSH_CONNECTION is frozen
 *      at server start.
 *   3. inside tmux → the newest client_activity (SSH and non-macOS hosts).
 * Anything else is present: an unreadable signal must never add a push.
 */
import { spawnSync } from 'child_process';
import type { GateMarker, GatePushMode } from './gate.js';

const AWAY_SEC_DEFAULT = 300;
const PROBE_TIMEOUT_MS = 2000;

export interface PresenceDeps {
  env: NodeJS.ProcessEnv;
  /** stdout of a probe command, or null when it fails, is missing, or times out. */
  run: (cmd: string, args: string[]) => string | null;
  now: () => number;
}

const runProbe = (cmd: string, args: string[]): string | null => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROBE_TIMEOUT_MS,
  });
  return r.status === 0 ? (r.stdout ?? '') : null;
};

const defaultDeps = (): PresenceDeps => ({ env: process.env, run: runProbe, now: Date.now });

const awayThresholdSec = (raw: string | undefined): number =>
  raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : AWAY_SEC_DEFAULT;

const hidIdleSec = (ioregOut: string | null): number | null => {
  const match = ioregOut?.match(/"HIDIdleTime" = (\d+)/);
  return match ? Math.floor(Number(match[1]) / 1e9) : null;
};

const newestActivitySec = (clientsOut: string): number | null => {
  const stamps = clientsOut.split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
  return stamps.length > 0 ? Math.max(...stamps) : null;
};

// null = tmux had no answer for the variable, so the process env decides.
const isOverSsh = (deps: PresenceDeps, inTmux: boolean): boolean => {
  const sessionVar = inTmux ? deps.run('tmux', ['show-environment', 'SSH_CONNECTION']) : null;
  if (sessionVar !== null) return sessionVar.startsWith('SSH_CONNECTION=');
  return Boolean(deps.env.SSH_CONNECTION);
};

/**
 * Is this session's tmux pane out of sight? Asks tmux about `$TMUX_PANE`:
 * `#{session_attached}` (clients on its session), `#{window_active}` (its
 * window is the session's current one), `#{pane_active}` and
 * `#{window_zoomed_flag}` (a different pane zoomed over it hides it; a split
 * that is merely not the active one is still on screen). A control-mode client
 * (iTerm2 `tmux -CC`) makes a non-current window look hidden while it is on
 * screen, so one attached anywhere reads as unknown; so does a window linked
 * into several sessions, which tmux reports for just one of them (not
 * detected). Anything short of a plain answer — not in tmux, no TMUX_PANE,
 * tmux silent, output that is not four numbers — is not hidden.
 */
const paneHidden = (deps: PresenceDeps): boolean => {
  const pane = deps.env.TMUX_PANE;
  if (!deps.env.TMUX || !pane) return false;
  const out = deps.run('tmux', [
    'display-message', '-p', '-t', pane,
    '#{session_attached} #{window_active} #{pane_active} #{window_zoomed_flag}',
  ]);
  if (out === null) return false;
  const fields = out.trim().split(/\s+/);
  if (fields.length !== 4 || !fields.every((f) => /^\d+$/.test(f))) return false;
  const [attached, windowActive, paneActive, zoomed] = fields.map(Number) as [number, number, number, number];
  const hidden = attached === 0 || windowActive === 0 || (zoomed !== 0 && paneActive === 0);
  if (!hidden) return false;
  const control = deps.run('tmux', ['list-clients', '-F', '#{client_control_mode}']);
  return !(control ?? '').split('\n').includes('1');
};

const machineAway = (deps: PresenceDeps, threshold: number): boolean => {
  // null = not in tmux, or no server answered; '' = a server with no clients.
  const clients = deps.env.TMUX ? deps.run('tmux', ['list-clients', '-F', '#{client_activity}']) : null;
  if (clients !== null && clients.trim() === '') return true;

  if (!isOverSsh(deps, clients !== null)) {
    // -r -k -d 1: just the IOHIDSystem node (~4 KB), not its ~380 KB subtree.
    const idle = hidIdleSec(deps.run('ioreg', ['-r', '-k', 'HIDIdleTime', '-d', '1', '-c', 'IOHIDSystem']));
    if (idle !== null) return idle >= threshold;
  }

  if (clients === null) return false;
  const newest = newestActivitySec(clients);
  if (newest === null) return false;
  return Math.floor(deps.now() / 1000) - newest >= threshold;
};

export const isAway = (deps: PresenceDeps = defaultDeps()): boolean => {
  const threshold = awayThresholdSec(deps.env.HWIP_AWAY_SEC);
  if (threshold === 0) return false;
  return machineAway(deps, threshold) || paneHidden(deps);
};

/**
 * Presence for decidePush, probed only where it can change the verdict: quiet
 * with no `high` marker is the one path that is otherwise silent.
 */
export const awayForGate = (
  pushMode: GatePushMode,
  marker: GateMarker,
  probe: () => boolean = isAway,
): boolean => pushMode === 'quiet' && marker !== 'high' && probe();
