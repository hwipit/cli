import { spawnSync } from 'node:child_process';
import { ASK_CONTEXT_SCREEN_WINDOW_LINES } from './ask-context.js';

/**
 * The terminal screen of a session as plain text, for `gatherAskContext`'s `screen` argument. It is the
 * listener's own `capture-pane` read (tmux `capture-pane -p`, no escapes) as a small function of its own, so
 * `listener.ts` stays as it is. Nothing is masked here — `composeAskContext` does that, once, over what this
 * returns. Nothing is sent, and a pane that cannot be read is `null`, never an error.
 */

/** The capture that does not answer within this is given up on; a hung server must not hold up a question. It does not cover the socket search `tmuxArgs` does first (the listener's own, with its own probes). */
const CAPTURE_TIMEOUT_MS = 3_000;
/** Longest capture that is read; a pane wider or taller than this is not a screen worth sending whole. */
const CAPTURE_MAX_BYTES = 1024 * 1024;

export interface ScreenDeps {
    /** The tmux target for a session name; `null` when the name resolves to no pane. */
    targetOf: (session: string) => string | null;
    /** Runs tmux with these arguments (the socket flag is the caller's). */
    tmux: (args: string[]) => { status: number | null; stdout: string };
}

/**
 * The last `ASK_CONTEXT_SCREEN_WINDOW_LINES` lines of the session's pane (history included), or `null`. `-J` joins
 * a line the pane wrapped: masking works line by line, and a token wider than the pane would otherwise be cut into
 * rows, each too short to be read as a token, with its tail left in the clear.
 */
export const captureAskScreen = (session: string, deps: ScreenDeps): string | null => {
    const target = deps.targetOf(session);
    if (target === null) return null;
    const run = deps.tmux(['capture-pane', '-p', '-J', '-t', target, '-S', `-${ASK_CONTEXT_SCREEN_WINDOW_LINES}`]);
    return run.status === 0 ? run.stdout : null;
};

/**
 * The real tmux. The listener's log goes quiet first: its tmux socket search prints to stdout, and a
 * `hwip ask` answer owns stdout (the same step `liveLocalAgentDeps` takes).
 */
export const liveScreenDeps = async (): Promise<ScreenDeps> => {
    const { silenceListenerLog, tmuxArgs, tmuxTargetFor } = await import('./listener.js');
    silenceListenerLog();
    return {
        targetOf: tmuxTargetFor,
        tmux: (args) => {
            const r = spawnSync('tmux', tmuxArgs(args), {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: CAPTURE_TIMEOUT_MS,
                maxBuffer: CAPTURE_MAX_BYTES,
            });
            return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
        },
    };
};
