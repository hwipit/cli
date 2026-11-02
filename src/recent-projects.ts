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

/** Each project's agents, from the newest session of each, in the order `known` gives (newest first). */
export const recentProjects = (
    known: readonly { name: string; agentKind: string; project?: string }[],
): RecentProject[] => {
    const projects = new Set<string>();
    const seen = new Set<string>();
    const listed: RecentProject[] = [];
    for (const e of known) {
        if (isSubagent(e.name) || isScheduled(e.name)) continue;
        const project = e.project || e.name;
        if (!projects.has(project)) {
            if (projects.size >= RECENT_PROJECTS_MAX) continue;
            projects.add(project);
        }
        const key = `${project}\u0000${e.agentKind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        listed.push({ name: e.name, agentKind: e.agentKind, ...(e.project ? { project: e.project } : {}) });
    }
    return listed;
};

/**
 * The list for this report, or undefined when the registry would not read — an empty list would
 * clear what the server holds, and the phone would lose every project to start in.
 */
export const recentProjectsToReport = (now: number = Date.now()): RecentProject[] | undefined =>
    registryUnreadable() ? undefined : recentProjects(knownSessions(now));
