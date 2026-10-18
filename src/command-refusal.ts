/**
 * Telling the phone why a command it sent was not typed (backlog C9).
 *
 * A refusal used to leave one log line on this machine, so the phone kept
 * showing "sent" for a command that never landed. The addressed listener now
 * answers on the ephemeral relay it already holds open, with
 *
 *     { subtype: 'agent.command.refused', sessionName, pushId, reason }
 *
 * (the relay broadcasts it to the account's devices and stamps `deviceId` with
 * this listener, as for every listener frame). The app matches it to the push
 * it sent by `pushId`. Codes only: never the command text, keys or paths. A
 * listener or an app that does not know the subtype ignores it; a code the app
 * does not know is shown as a generic refusal.
 *
 * Stream input (`agent.command.input`) already had its own answer, the
 * `input_rejected` stream-error frame; it carries the same codes in an
 * optional `reason` field.
 */

export const COMMAND_REFUSALS = [
  /** More commands for this session than the per-minute budget allows. */
  'rate_limited',
  /** No tmux session of that name on this machine. */
  'unknown_session',
  /** The session is a subagent pane: view-only, the phone cannot type into it. */
  'subagent_view_only',
  /** The pane sits at a shell prompt and is not an `hwip sh` session. */
  'shell_pane',
  /** An `hwip sh` session refuses the input: attachments, control characters, a newline in an insert. */
  'shell_input',
  /** A key name that is not on the allowed list. */
  'unknown_key',
  /** The command makes no sense as sent (empty, or an insert beside a body). */
  'invalid_command',
  /** A sealed attachment would not open or was missing, so the command was not typed. */
  'attachment_failed',
  /** A sealed command that did not check out: sender key, label, replay. */
  'sealed_rejected',
  /** The checks passed but tmux would not take the keystrokes. */
  'inject_failed',
  /** The command came in plaintext, and this listener only takes sealed ones (body, keys, insert or attachment). */
  'e2ee_required',
  /** The command was bound to a blocked prompt (`ifPrompt`) and the screen shows another one, or none. */
  'prompt_changed',
  /** A schedule request that is malformed, past a limit on one schedule, or names no schedule of that session. */
  'schedule_invalid',
  /** A schedule request that would make more schedules than a machine may have. */
  'schedule_limit',
  /** A valid schedule request this machine could not carry out: its schedule files or session record would not read or write. */
  'schedule_failed',
] as const;

export type CommandRefusal = (typeof COMMAND_REFUSALS)[number];

export interface CommandRefusedFrame {
  subtype: 'agent.command.refused';
  sessionName: string;
  pushId: string;
  reason: CommandRefusal;
}

/** A push chooses these two strings; the listener echoes no more than this of either. */
const MAX_ECHO_CHARS = 200;

/** The first MAX_ECHO_CHARS UTF-16 units, minus a surrogate pair the cap would cut in half. */
const capEcho = (text: string): string => {
  const cut = text.slice(0, MAX_ECHO_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

export const commandRefusedFrame = (
  sessionName: string,
  pushId: string,
  reason: CommandRefusal,
): CommandRefusedFrame => ({
  subtype: 'agent.command.refused',
  sessionName: capEcho(sessionName),
  pushId: capEcho(pushId),
  reason,
});

/** Reasons read off the plaintext of a sealed command, which the relay must not learn. */
const TEXT_DEPENDENT_REFUSALS: readonly CommandRefusal[] = ['shell_input', 'invalid_command', 'schedule_invalid', 'schedule_limit'];

/**
 * What the relay may learn. `shell_input` (a control character or newline in
 * the text), `invalid_command` (empty text) and the two schedule reasons (a
 * limit hit, a field wrong) are read off the text itself; for a sealed command
 * that would tell the relay something about plaintext it must not see, so they
 * go out as the generic `sealed_rejected`.
 */
export const reasonForPhone = (reason: CommandRefusal, sealed: boolean): CommandRefusal =>
  sealed && TEXT_DEPENDENT_REFUSALS.includes(reason) ? 'sealed_rejected' : reason;

/**
 * Reasons that come from the state of the session or the listener, never from
 * the text. Only these ride a stream `input_rejected` frame: its text may be
 * sealed, and a refusal that depends on it must not be told to the relay.
 */
const SESSION_STATE_REFUSALS: readonly CommandRefusal[] = [
  'rate_limited', 'unknown_session', 'subagent_view_only', 'shell_pane', 'inject_failed', 'prompt_changed',
];
export const isSessionStateRefusal = (reason: CommandRefusal): boolean => SESSION_STATE_REFUSALS.includes(reason);

/** Frames per session per minute. A phone flooding a session refuses itself blind past this; the log keeps counting. */
export const REFUSAL_FRAMES_PER_MINUTE = 30;
export const REFUSAL_WINDOW_MS = 60_000;

/** Sessions the limiter tracks inside one window; the scan per call is bounded by this. */
export const REFUSAL_TRACKED_SESSIONS = 256;

export interface RefusalLimiter {
  (key: string, now?: number): boolean;
  /** Sessions currently tracked. */
  size: () => number;
}

/** A sliding count per key: `max` yeses per `windowMs`, idle keys forgotten. */
export const createRefusalLimiter = (max: number, windowMs: number, maxKeys = REFUSAL_TRACKED_SESSIONS): RefusalLimiter => {
  const seen = new Map<string, number[]>();
  const allow = ((key: string, now: number = Date.now()): boolean => {
    for (const [k, stamps] of seen) {
      if (stamps.length === 0 || now - stamps[stamps.length - 1]! >= windowMs) seen.delete(k);
    }
    // A push picks the session name it asks about: past the cap, a name that is
    // not already tracked gets no frame rather than a map entry.
    if (!seen.has(key) && seen.size >= maxKeys) return false;
    const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      seen.set(key, recent);
      return false;
    }
    recent.push(now);
    seen.set(key, recent);
    return true;
  }) as RefusalLimiter;
  allow.size = () => seen.size;
  return allow;
};

/** The function the listener's WS loop hands `handlePush`: one frame per refusal, within the per-session limit. */
export const createRefusalReporter = (
  send: (data: Record<string, unknown>) => void,
  allow: RefusalLimiter,
): ((refusal: { sessionName: string; pushId: string; reason: CommandRefusal }) => void) =>
  ({ sessionName, pushId, reason }) => {
    if (!allow(sessionName)) return;
    send({ ...commandRefusedFrame(sessionName, pushId, reason) });
  };
