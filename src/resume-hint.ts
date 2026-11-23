/**
 * The line `hwip cc` / `hwip pi` leaves once its tmux client returns: the
 * command that picks the conversation back up (`claude --resume <id>`) when the
 * session ended, or how to reattach when it was only detached.
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
    /** Whether the shell `tmux new` returned to is itself inside tmux (`$TMUX`). */
    inTmux: boolean;
}

const defaultDeps = (): ResumeHintDeps => ({
    recall: (name, kind) => recallRun(name, kind),
    // `unknown` included: no tmux server answering after `tmux new` returned is the last session gone with it.
    alive: (name) => sessionLiveness(name) === 'running',
    cwd: process.cwd(),
    inTmux: Boolean(process.env.TMUX),
});

/**
 * What to print after the tmux client of session `session` of `agent` returned,
 * or null when there is nothing true to say. `since` is when this `hwip`
 * launched (ms): a record the sweep has not touched since is an earlier run of
 * the same name, whose conversation is not the one just closed. A session
 * shorter than one sweep has no record yet, and gets no resume line rather than
 * a guess. A session still running was detached (`prefix d`): it gets the
 * reattach command, and a warning that resuming its conversation by id would
 * start a second copy of it in the same directory.
 */
export const resumeHint = (
    session: string,
    agent: Pick<RemoteAgent, 'kind' | 'binary' | 'subcommands' | 'resumeArgs'>,
    since: number,
    deps: ResumeHintDeps = defaultDeps(),
): string | null => {
    const resume = resumeCommand(session, agent, since, deps);
    if (deps.alive(session)) {
        const reattach = `tmux ${deps.inTmux ? 'switch-client' : 'attach'} -t ${shellQuote(session)}`;
        const line = `hwip: ${session} still running — reattach: ${reattach}`;
        if (!resume) return line;
        return `${line}\nhwip: do not run ${resume.command} while it runs — that starts a second copy of the same conversation`;
    }
    if (!resume) return null;
    const where = resume.cwd === deps.cwd ? '' : ` in ${shellQuote(resume.cwd)}`;
    return `hwip: to resume${where}: ${resume.command}  (or hwip ${agent.subcommands[0]} ${resume.rest})`;
};

/** The agent's own command that resumes this launch's conversation, when the sweep recorded one. */
const resumeCommand = (
    session: string,
    agent: Pick<RemoteAgent, 'kind' | 'binary' | 'resumeArgs'>,
    since: number,
    deps: ResumeHintDeps,
): { command: string; rest: string; cwd: string } | null => {
    if (!agent.resumeArgs) return null;
    const run = deps.recall(session, agent.kind);
    if (!run?.agentSessionId || Date.parse(run.lastSeenAt) < since) return null;
    const args = agent.resumeArgs(run.agentSessionId, run.cwd);
    if (!args) return null;
    const rest = args.map(shellQuote).join(' ');
    return { command: `${agent.binary} ${rest}`, rest, cwd: run.cwd };
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
