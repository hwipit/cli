/**
 * The line `hwip cc` / `hwip pi` leaves once its tmux session has ended: the
 * command that picks the conversation back up (`claude --resume <id>`).
 */

import { REMOTE_AGENTS, type RemoteAgent } from './remote-agents.js';
import { recallRun, type KnownSession } from './session-registry.js';
import { sessionLiveness } from './tmux-liveness.js';
import { shellQuote } from './wrapper.js';

export interface ResumeHintDeps {
    recall: (name: string, agentKind: string) => KnownSession | null;
    /** Whether tmux still has the session: a detach returns from `tmux new` as well as an exit does. */
    alive: (name: string) => boolean;
    cwd: string;
}

const defaultDeps = (): ResumeHintDeps => ({
    recall: (name, kind) => recallRun(name, kind),
    // `unknown` included: no tmux server answering after `tmux new` returned is the last session gone with it.
    alive: (name) => sessionLiveness(name) === 'running',
    cwd: process.cwd(),
});

/**
 * What to print after the tmux session `session` of `agent` returned, or null
 * when there is nothing true to say. `since` is when this `hwip` launched (ms):
 * a record the sweep has not touched since is an earlier run of the same name,
 * whose conversation is not the one just closed. A session shorter than one
 * sweep has no record yet, and gets no line rather than a guess.
 */
export const resumeHint = (
    session: string,
    agent: Pick<RemoteAgent, 'kind' | 'binary' | 'subcommands' | 'resumeArgs'>,
    since: number,
    deps: ResumeHintDeps = defaultDeps(),
): string | null => {
    if (!agent.resumeArgs || deps.alive(session)) return null;
    const run = deps.recall(session, agent.kind);
    if (!run?.agentSessionId || Date.parse(run.lastSeenAt) < since) return null;
    const args = agent.resumeArgs(run.agentSessionId, run.cwd);
    if (!args) return null;
    const where = run.cwd === deps.cwd ? '' : ` in ${shellQuote(run.cwd)}`;
    const rest = args.map(shellQuote).join(' ');
    return `hwip: to resume${where}: ${agent.binary} ${rest}  (or hwip ${agent.subcommands[0]} ${rest})`;
};

/**
 * `hwip resume-hint --session <tmux name> --type <agent kind> --at <ms>` — the
 * call `withResumeHint` leaves after tmux. Not for people: it always exits 0,
 * so a missing record or a failed read never changes the agent's exit status.
 */
export const handleResumeHint = (args: Record<string, string | boolean>): number => {
    const agent = REMOTE_AGENTS.find((a) => a.kind === args.type);
    const since = Number(args.at);
    if (typeof args.session !== 'string' || !agent || !Number.isFinite(since)) return 0;
    try {
        const line = resumeHint(args.session, agent, since);
        if (line) console.log(line);
    } catch {
        return 0;
    }
    return 0;
};
