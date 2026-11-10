/**
 * The projects the phone can start a new session in (hwip docs/session-runs.md Q47, Q49).
 *
 * The report used to carry every ended run (`knownSessions`) and the phone built its project list from
 * that. The phone no longer shows ended runs, so the report carries only what the list needs: the
 * projects this machine ran lately, each agent of a project once, with the session to start it from.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

const TMP = mkdtempSync(join(tmpdir(), 'hwip-recent-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { recentProjects, recentProjectsToReport, RECENT_PROJECTS_MAX } = await import('./recent-projects.js');
const { rememberSessions } = await import('./session-registry.js');
const { stateDir } = await import('./gate.js');
const { planSessionsReport } = await import('./sessions-report.js');

/** A registry entry, newest first as `knownSessions` returns them. */
const entry = (name: string, agentKind = 'claude', project = name.replace(/^hwip-/, '')) => ({
    name,
    agentKind,
    ...(project ? { project } : {}),
    lastSeenAt: '2026-11-02T00:00:00.000Z',
});

describe('recentProjects', () => {
    it('lists each project once per agent, newest first, from the newest session', () => {
        expect(recentProjects([
            entry('hwip-api-2', 'claude', 'api'),
            entry('hwip-web', 'codex', 'web'),
            entry('hwip-api', 'claude', 'api'),
            entry('hwip-api', 'pi', 'api'),
        ])).toEqual([
            { name: 'hwip-api-2', agentKind: 'claude', project: 'api' },
            { name: 'hwip-web', agentKind: 'codex', project: 'web' },
            { name: 'hwip-api', agentKind: 'pi', project: 'api' },
        ]);
    });

    it('groups a session with no project under its own name', () => {
        expect(recentProjects([entry('scratch', 'claude', ''), entry('scratch', 'claude', '')]))
            .toEqual([{ name: 'scratch', agentKind: 'claude' }]);
    });

    it('leaves out subagents and scheduled runs, which no session starts from', () => {
        expect(recentProjects([
            entry('hwip-api.3', 'claude', 'api'),
            entry('hwip-api-sched-1a2b', 'claude', 'api'),
            entry('hwip-api', 'claude', 'api'),
        ])).toEqual([{ name: 'hwip-api', agentKind: 'claude', project: 'api' }]);
    });

    it(`stops at ${RECENT_PROJECTS_MAX} projects, keeping every agent of the ones it lists`, () => {
        const many = Array.from({ length: RECENT_PROJECTS_MAX + 3 }, (_, i) => entry(`hwip-p${i}`));
        const listed = recentProjects([...many, entry('hwip-p0', 'codex', 'p0')]);

        expect(new Set(listed.map((p) => p.project)).size).toBe(RECENT_PROJECTS_MAX);
        expect(listed.at(-1)).toEqual({ name: 'hwip-p0', agentKind: 'codex', project: 'p0' });
        expect(listed.some((p) => p.project === `p${RECENT_PROJECTS_MAX}`)).toBe(false);
    });

    it('lists projects that run now on top of the twelve, so they never crowd out one the machine ran before', () => {
        const running = Array.from({ length: RECENT_PROJECTS_MAX }, (_, i) => entry(`hwip-r${i}`));
        const past = Array.from({ length: RECENT_PROJECTS_MAX + 1 }, (_, i) => entry(`hwip-p${i}`));
        const listed = recentProjects([...running, entry('hwip-r0-2', 'pi', 'r0'), ...past], new Set(running.map((e) => e.name)));

        expect(new Set(listed.map((p) => p.project)).size).toBe(2 * RECENT_PROJECTS_MAX);
        // A running project keeps the agent it ran before and does not run now.
        expect(listed).toContainEqual({ name: 'hwip-r0-2', agentKind: 'pi', project: 'r0' });
        expect(listed.some((p) => p.project === `p${RECENT_PROJECTS_MAX}`)).toBe(false);
    });

    it('counts a project whose only live session is a scheduled run or a subagent as a past one', () => {
        const past = Array.from({ length: RECENT_PROJECTS_MAX }, (_, i) => entry(`hwip-p${i}`));
        const listed = recentProjects(
            [entry('hwip-s-sched-1a2b', 'claude', 's'), entry('hwip-s.3', 'claude', 's'), entry('hwip-s', 'claude', 's'), ...past],
            new Set(['hwip-s-sched-1a2b', 'hwip-s.3']),
        );

        expect(listed[0]).toEqual({ name: 'hwip-s', agentKind: 'claude', project: 's' });
        expect(new Set(listed.map((p) => p.project)).size).toBe(RECENT_PROJECTS_MAX);
    });
});

describe('recentProjectsToReport', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });

    it('reads what this machine ran from the registry', () => {
        rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', project: 'api' }]);

        expect(recentProjectsToReport(new Set())).toEqual([{ name: 'hwip-api', agentKind: 'claude', project: 'api' }]);
    });

    it('is an empty list on a machine that never ran a session', () => {
        expect(recentProjectsToReport(new Set())).toEqual([]);
    });

    /** An empty list would wipe what the server holds, and the phone would lose every project to start in. */
    it('says nothing when the registry would not read', () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(join(stateDir(), 'known-sessions.json'), '{ half written');

        expect(recentProjectsToReport(new Set())).toBeUndefined();
    });
});

describe('the report carries recentProjects, not knownSessions', () => {
    const sessions = [{ name: 'hwip-api' }];
    const recent = [{ name: 'hwip-api', agentKind: 'claude', project: 'api' }];

    it('in the one message', () => {
        const [message] = planSessionsReport(sessions, recent).messages.map((m) => JSON.parse(m));

        expect(message.data).toEqual({ sessions, recentProjects: recent });
    });

    it('leaves the field out when there is nothing to say', () => {
        const [message] = planSessionsReport(sessions, undefined).messages.map((m) => JSON.parse(m));

        expect(message.data).toEqual({ sessions });
    });
});
