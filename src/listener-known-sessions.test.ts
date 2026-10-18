/**
 * What the daemon tells the phone about sessions it is no longer running.
 *
 * The phone used to work this out for itself by reading a page of recent
 * pushes, which answered a different question than the one being asked. This
 * machine already keeps the answer — the same registry the resume path reads —
 * so the report carries it and the list stops disagreeing with the button.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'hwip-known-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    knownSessionsToReport,
    knownSessionsFingerprint,
    KNOWN_SESSIONS_REPORTED,
    runIdOfEpoch,
} = await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');

/** A live-inventory entry, as `collectSessions` would report it. */
const live = (name: string) => ({
    name,
    attached: false,
    agentKind: 'claude' as const,
    project: 'proj',
});

describe('known sessions in the inventory report', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });

    const remember = (names: string[], at?: number) =>
        rememberSessions(
            names.map((name) => ({ name, cwd: '/work/proj', agentKind: 'claude', project: 'proj' })),
            at,
        );

    it('reports what this machine has run', () => {
        remember(['hwip-api', 'hwip-web']);

        expect(knownSessionsToReport([]).map((k) => k.name).sort()).toEqual([
            'hwip-api',
            'hwip-web',
        ]);
    });

    /**
     * Not just tidiness. A live session's `lastSeenAt` moves every sweep, and a
     * field that changes every five seconds would defeat the report's
     * unchanged-inventory gate — the daemon would write to the device record
     * all day for a list nobody watched change.
     */
    it('leaves out the sessions that are running right now', () => {
        remember(['hwip-api', 'hwip-web']);

        const reported = knownSessionsToReport([live('hwip-api')]);

        expect(reported.map((k) => k.name)).toEqual(['hwip-web']);
    });

    it('keeps the same fingerprint while nothing has changed', () => {
        remember(['hwip-api', 'hwip-web']);
        const first = knownSessionsFingerprint(knownSessionsToReport([live('hwip-api')]));

        // A later sweep of the same machine, with the live session still live.
        const second = knownSessionsFingerprint(knownSessionsToReport([live('hwip-api')]));

        expect(second).toBe(first);
    });

    it('changes fingerprint when a session ends', () => {
        remember(['hwip-api', 'hwip-web']);
        const whileRunning = knownSessionsFingerprint(knownSessionsToReport([live('hwip-api')]));

        const afterItEnded = knownSessionsFingerprint(knownSessionsToReport([]));

        expect(afterItEnded).not.toBe(whileRunning);
    });

    /**
     * The registry keeps a cwd because resume needs somewhere to start the
     * agent. Nothing off this machine needs a filesystem path, and sending one
     * would hand the relay a map of the user's disk for no behaviour in return.
     */
    it('never sends the directory off this machine', () => {
        remember(['hwip-api']);

        const [reported] = knownSessionsToReport([]);

        expect(reported).not.toHaveProperty('cwd');
        expect(Object.keys(reported).sort()).toEqual([
            'agentKind',
            'lastSeenAt',
            'name',
            'project',
        ]);
    });

    it('sends the newest, and no more than the cap', () => {
        const names = Array.from({ length: KNOWN_SESSIONS_REPORTED + 5 }, (_, i) => `hwip-${i}`);
        // One per minute, oldest first, so "newest" is unambiguous.
        names.forEach((name, i) => remember([name], Date.parse('2026-08-10T00:00:00Z') + i * 60_000));

        const reported = knownSessionsToReport([], Date.parse('2026-08-10T02:00:00Z'));

        expect(reported).toHaveLength(KNOWN_SESSIONS_REPORTED);
        expect(reported[0].name).toBe(`hwip-${names.length - 1}`);
    });

    it('reports nothing on a machine that has run nothing', () => {
        expect(knownSessionsToReport([])).toEqual([]);
    });
});

/**
 * A tmux name outlives the agent that held it. Excluding a live session by
 * NAME alone also hid the ended run of the previous occupant — which is the
 * report-side half of the bug the registry's run key fixes.
 */
describe('a slot that has held two agents', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });

    it('still reports the ended pi run while claude holds the name', () => {
        rememberSessions(
            [{ name: 'hwip-api', cwd: '/work/proj', agentKind: 'pi', project: 'proj' }],
            1_000,
        );
        rememberSessions(
            [{ name: 'hwip-api', cwd: '/work/proj', agentKind: 'claude', project: 'proj' }],
            2_000,
        );

        const reported = knownSessionsToReport([live('hwip-api')], 3_000);

        // The live claude run is out (its lastSeenAt moves every sweep); the pi
        // run that ended in that same slot is a past session and stays in.
        expect(reported.map((k) => [k.name, k.agentKind])).toEqual([['hwip-api', 'pi']]);
    });
});

describe('separate runs in the report (hwip docs/session-runs.md)', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });
    const at = (sec: number) => new Date(sec * 1000).toISOString();
    const R1 = 1_790_000_000;
    const R2 = R1 + 3600;
    const remember = (runId: number, seenAt: number) =>
        rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', project: 'api', runId: String(runId), startedAt: at(runId) }], seenAt);

    it('reports the ended run of a name the same agent runs again, with its run id and start', () => {
        remember(R1, (R1 + 60) * 1000);
        remember(R2, (R2 + 60) * 1000);

        const known = knownSessionsToReport([{ ...live('hwip-api'), runId: String(R2) }], (R2 + 60) * 1000);

        expect(known).toEqual([{ name: 'hwip-api', agentKind: 'claude', project: 'api', runId: String(R1), startedAt: at(R1), lastSeenAt: at(R1 + 60) }]);
    });

    it('reports up to fifty', () => {
        expect(KNOWN_SESSIONS_REPORTED).toBe(50);
    });

    it('sees a different run as a change', () => {
        const base = { name: 'hwip-api', agentKind: 'claude', lastSeenAt: at(R1) };
        expect(knownSessionsFingerprint([{ ...base, runId: String(R1) }]))
            .not.toBe(knownSessionsFingerprint([{ ...base, runId: String(R2) }]));
    });
});

describe('separate runs: the run id', () => {
    it('is the run id the server derives from createdAt for a listener that sends none', () => {
        // hwip server/src/shared/utils/sessionRun.ts `runIdOf` (hwip f9c5e1ca), copied: no import across repos.
        expect(runIdOfEpoch('1792310400')).toBe('1792310400');
        const serverRunIdOf = (createdAt: string) => String(Math.floor(Date.parse(createdAt) / 1000));
        for (const epoch of ['1792310400', '1', '1700000000']) {
            expect(runIdOfEpoch(epoch)).toBe(serverRunIdOf(new Date(Number(epoch) * 1000).toISOString()));
        }
        expect(runIdOfEpoch(undefined)).toBeUndefined();
        expect(runIdOfEpoch('0')).toBeUndefined();
    });
});
