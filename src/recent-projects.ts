/**
 * The projects the phone can start a new session in (hwip docs/session-runs.md Q47, Q49), as the
 * `listener.sessions` report carries them.
 *
 * The phone never names a directory: it names a session, and the fresh start reads that session's
 * folder and agent back from this machine's registry (`recallSession` · `recallRun`). So each entry
 * is one agent of one project with the newest session it ran there. The list is newest first and
 * carries no times — a running session's `lastSeenAt` moves on every sweep, and a field that changes
 * every five seconds would defeat the report's unchanged-inventory gate.
 */

import { knownSessions, registryUnreadable } from './session-registry.js';

export interface RecentProject {
    /** The newest session of this project and agent: what a fresh start is asked from. */
    name: string;
    agentKind: string;
    /** Absent when the registry has none; the phone then calls the project by the session's name. */
    project?: string;
}

/** A short list: the projects a person works in lately, not every folder the machine ever ran one in. */
export const RECENT_PROJECTS_MAX = 12;

/** `<parent>.<pane digits>` — a subagent pane has no project of its own (tmux turns `.` in a name into `_`). */
const isSubagent = (name: string): boolean => /\.\d+$/.test(name);
/** A session a schedule started: starting from it would copy the scheduled run, not the project. */
const isScheduled = (name: string): boolean => name.includes('-sched-');

/**
 * Each project's agents, from the newest session of each, in the order `known` gives (newest first).
 *
 * A project with a session in `live` is listed without counting toward the 12: a running session's entry is always the
 * newest, so twelve running projects would leave no room for one the machine ran before (hwip docs/session-runs.md Q50).
 * Its entries still go out — the agents it ran before and does not run now are only here.
 */
export const recentProjects = (
    known: readonly { name: string; agentKind: string; project?: string }[],
    live: ReadonlySet<string> = new Set(),
): RecentProject[] => {
    const projectOf = (e: { name: string; project?: string }): string => e.project || e.name;
    const eligible = known.filter((e) => !isSubagent(e.name) && !isScheduled(e.name));
    // As the phone counts running: a scheduled run or a subagent is no running session of the project there.
    const running = new Set(eligible.filter((e) => live.has(e.name)).map(projectOf));
    const past = new Set<string>();
    const seen = new Set<string>();
    const listed: RecentProject[] = [];
    for (const e of eligible) {
        const project = projectOf(e);
        if (!running.has(project) && !past.has(project)) {
            if (past.size >= RECENT_PROJECTS_MAX) continue;
            past.add(project);
        }
        const key = `${project}\u0000${e.agentKind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        listed.push({ name: e.name, agentKind: e.agentKind, ...(e.project ? { project: e.project } : {}) });
    }
    return listed;
};

/**
 * The list for this report beside `live`, the sessions it reports running, or undefined when the registry would not read — an empty list would
 * clear what the server holds, and the phone would lose every project to start in.
 */
export const recentProjectsToReport = (
    live: ReadonlySet<string>,
    now: number = Date.now(),
): RecentProject[] | undefined => (registryUnreadable() ? undefined : recentProjects(knownSessions(now), live));
