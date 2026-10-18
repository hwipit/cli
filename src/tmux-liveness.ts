import { spawnSync } from 'child_process';
import type { SessionLiveness } from './session-registry.js';
import { isSubagentSessionName, subagentTranscriptsBySession, targetsBySession } from './tmux-pane.js';
import { tmuxArgs } from './tmux-socket.js';

/**
 * Every session name the tmux server currently holds, or null when there was no
 * server to ask — the binary is missing, or nothing answers on the socket this
 * process resolved.
 *
 * Null is not an empty list. `has-session` cannot tell the two apart: against a
 * socket with nobody behind it it exits 1 — the same answer it gives for a name
 * that ended (measured 2026-09-18). That matters because socket discovery falls
 * back to the default socket, and a cron or launchd process that cannot see the
 * user's server would otherwise call every live session an ended one.
 */
export const liveSessionNames = (): string[] | null => {
    const probe = spawnSync('tmux', tmuxArgs(['list-sessions', '-F', '#{session_name}']), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A server with zero sessions does not exist — tmux exits with the last one
    // — so a non-zero status here is always "no server answered", never "none".
    if (probe.error || probe.status !== 0) return null;
    return (probe.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
};

/**
 * The three-state answer, for callers that destroy something on "ended".
 *
 * "tmux says no such session" and "no tmux answered" are not the same fact, and
 * only one of them means the session is over. Collapsing them lets a missing
 * binary or a socket nobody is behind read as "everything has ended" — which,
 * on the delete path, is an irreversible deletion justified by a failure to ask.
 *
 * Asking for the whole list rather than `has-session -t =<name>` is what makes
 * the distinction available at all, and the name comparison is then exact by
 * construction — a tmux TARGET falls back to prefix and fnmatch matching, so
 * with `hwip-hwipit` running an ended `hwip-hwip` used to answer "running".
 */
export const sessionLiveness = (name: string): SessionLiveness => {
    if (isSubagentSessionName(name)) {
        const known = targetsBySession.has(name) || subagentTranscriptsBySession.has(name);
        return known ? 'running' : 'ended';
    }
    const names = liveSessionNames();
    if (names === null) return 'unknown';
    return names.includes(name) ? 'running' : 'ended';
};

/**
 * Whether this machine currently holds a session by this name. A subagent
 * pane cannot be asked with has-session: tmux would parse `hwip-x.48` as
 * session `hwip-x`, pane index 48 and answer for the WRONG thing (or exit 1
 * for a missing index) — so subs are answered from the sweep's target map,
 * which is exactly what "a pane we can address without ambiguity" means.
 *
 * An in-process subagent has no pane to address at all, so it is answered from
 * the transcript map instead. Both maps are the same statement — the last sweep
 * saw this thing — and the split is which of the two the sweep could record.
 */
/** Exported for the same reason as `sessionLiveness` above: the subagent branch is
 *  the load-bearing one, and a test has to be able to reach it.
 *  Unknown means "not running" here, which is what its callers — resume,
 *  exit, stream targeting — already do with a session they cannot find. The
 *  paths that DELETE ask `sessionLiveness` instead and refuse on unknown. */
export const sessionExists = (name: string): boolean => sessionLiveness(name) === 'running';
