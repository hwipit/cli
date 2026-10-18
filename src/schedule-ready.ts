/**
 * Whether a scheduled session's agent may be typed at (F8). A prompt typed into a terminal that is still starting up
 * is lost or lands in the wrong place, and one typed into a dialog answers it: Enter on a trust or permission prompt
 * accepts the default, with nobody there to read it. So the only sign this feature accepts is the agent's own state
 * rules saying `idle` for the screen as it is now. An agent without an `idle` rule is never typed at — a screen that
 * has stopped changing proves nothing, a static dialog stops changing too.
 *
 * The rules are the bundled ones, never the OTA manifest. A phone's input is typed by a person who has seen the
 * screen; a schedule is typed by nobody. The OTA manifest is checked for its shape only (not signed) and replaces
 * the bundle whole, so a rule set it carried could call an approval dialog `idle` and have the user's prompt plus
 * Enter typed into it. Phone input and state reports keep using the OTA rules.
 *
 * One idle read is not enough either: a dialog can open after the composer is drawn (codex shows its start-up
 * dialogs before the composer, but nothing promises every dialog does), and a read taken just before it opened says
 * `idle`. So a session is ready only when two reads in a row — the last poll's and this one, taken right before the
 * prompt is typed — show the same screen and the rules call it `idle`. Any change in between starts over. Digits are
 * left out of the comparison, so a footer's clock, cost or token count does not keep a resting agent from ever being
 * ready. The earlier read counts only while it is recent: a schedule's next run starts under the same session name,
 * and its first read must not pair with the last screen of the run before.
 */

import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import { evaluateState, type DetectionManifest } from './agent-state.js';
import type { AgentKind } from './remote-agents.js';
import { PROMPT_POLL_MS } from './schedule-runner.js';

export interface ReadyDeps {
    /** The pane's foreground program is the agent of this kind (not the shell it started from). */
    foregroundIsAgent: (session: string, agentKind: string) => boolean;
    /** The pane's text as it is now, or null when it cannot be read. */
    screenOf: (session: string) => string | null;
    /** The detection rules' verdict on that text. */
    stateOf: (screen: string, agentKind: string) => string;
    now?: () => number;
}

/** How old the earlier of the two reads may be: two polls, so one slow tick still pairs and a past run never does. */
export const READ_PAIR_MAX_MS = 2 * PROMPT_POLL_MS;

/** A screen as the two reads compare it: digits do not count. */
const settledForm = (screen: string): string => screen.replace(/\p{Nd}/gu, '0');

/** Whether the rules in `manifest` can ever say `idle` for `kind`: a rule that is on, and that decides the state. */
export const hasIdleRule = (manifest: DetectionManifest, kind: string): boolean => {
    const disabled = new Set(manifest.disabledRuleIds ?? []);
    return (manifest.agents[kind as AgentKind] ?? []).some((rule) => rule.state === 'idle' && !rule.skipStateUpdate && !disabled.has(rule.id));
};

/** The kinds among `kinds` that a prompt can be scheduled for. */
export const promptableKinds = (manifest: DetectionManifest, kinds: readonly string[]): string[] =>
    kinds.filter((kind) => hasIdleRule(manifest, kind));

export const createReadyCheck = (deps: ReadyDeps): ((session: string, agentKind: string) => boolean) => {
    const now = deps.now ?? Date.now;
    /** Per session, the idle screen the previous read saw and when. */
    const lastIdle = new Map<string, { screen: string; at: number }>();
    return (session, agentKind) => {
        const screen = deps.foregroundIsAgent(session, agentKind) ? deps.screenOf(session) : null;
        const previous = lastIdle.get(session);
        if (screen === null || deps.stateOf(screen, agentKind) !== 'idle') {
            lastIdle.delete(session);
            return false;
        }
        const at = now();
        const form = settledForm(screen);
        if (previous?.screen !== form || at - previous.at > READ_PAIR_MAX_MS) {
            lastIdle.set(session, { screen: form, at });
            return false;
        }
        // Spent: if the prompt then fails to go in, the next try reads twice again.
        lastIdle.delete(session);
        return true;
    };
};

/** Whether a schedule may carry a prompt for `kind`: the bundled rules have an `idle` rule for it. */
export const canPromptKind = (kind: string): boolean => hasIdleRule(DEFAULT_MANIFEST, kind);

/** `promptableKinds` over the bundled rules — what `schedule add --prompt` accepts. */
export const promptableScheduleKinds = (kinds: readonly string[]): string[] => promptableKinds(DEFAULT_MANIFEST, kinds);

/** The state the bundled rules give a pane's text. */
export const scheduleScreenState = (content: string, kind: string): string =>
    evaluateState(content, kind as AgentKind, DEFAULT_MANIFEST).state;
