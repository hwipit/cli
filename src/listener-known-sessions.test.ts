/**
 * What the daemon tells the phone about sessions it is no longer running.
 *
 * The phone used to work this out for itself by reading a page of recent
 * pushes, which answered a different question than the one being asked. This
 * machine already keeps the answer — the same registry the resume path reads —
 * so the report carries it and the list stops disagreeing with the button.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
            'resumable',
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

        expect(known).toEqual([{ name: 'hwip-api', agentKind: 'claude', project: 'api', runId: String(R1), startedAt: at(R1), resumable: false, lastSeenAt: at(R1 + 60) }]);
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

describe('the run title an ended run keeps (hwip docs/session-runs.md Q39)', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });
    const at = (sec: number) => new Date(sec * 1000).toISOString();
    const R1 = 1_790_000_000;
    const R2 = R1 + 3600;
    const sweep = (runId: number, seenAt: number, name?: { providerSessionName?: string | null; providerSessionNameSource?: 'user' | 'auto' }) =>
        rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', runId: String(runId), startedAt: at(runId), ...name }], seenAt * 1000);
    const endedRun = () => knownSessionsToReport([{ ...live('hwip-api'), runId: String(R2) }], (R2 + 60) * 1000)
        .find((k) => k.runId === String(R1));

    it('run title: reports the last name the agent gave the run, and who gave it', () => {
        sweep(R1, R1 + 10, { providerSessionName: 'Fix login', providerSessionNameSource: 'auto' });
        sweep(R1, R1 + 20, { providerSessionName: 'Fix login redirect', providerSessionNameSource: 'user' });
        sweep(R2, R2 + 10);

        expect(endedRun()).toMatchObject({ providerSessionName: 'Fix login redirect', providerSessionNameSource: 'user' });
    });

    it('run title: a sweep that read no name keeps the one the run had', () => {
        sweep(R1, R1 + 10, { providerSessionName: 'Fix login', providerSessionNameSource: 'auto' });
        sweep(R1, R1 + 20, { providerSessionName: null });
        sweep(R1, R1 + 30);
        sweep(R2, R2 + 10, { providerSessionName: 'Another run' });

        expect(endedRun()).toMatchObject({ providerSessionName: 'Fix login', providerSessionNameSource: 'auto' });
    });

    it('run title: a run never named reports none', () => {
        sweep(R1, R1 + 10);
        sweep(R2, R2 + 10, { providerSessionName: 'Another run' });

        const run = endedRun();
        expect(run).toBeDefined();
        expect(run).not.toHaveProperty('providerSessionName');
        expect(run).not.toHaveProperty('providerSessionNameSource');
    });

    it('run title: a name without a source is reported without one', () => {
        sweep(R1, R1 + 10, { providerSessionName: 'Fix login' });
        sweep(R2, R2 + 10);

        const run = endedRun();
        expect(run).toMatchObject({ providerSessionName: 'Fix login' });
        expect(run).not.toHaveProperty('providerSessionNameSource');
    });

    it('run title: a run carried on in a new tmux session keeps its name', () => {
        const T2 = R1 + 600;
        sweep(R1, R1 + 10, { providerSessionName: 'Fix login', providerSessionNameSource: 'user' });
        // `exit`, then `hwip cc -c`: the first sweep of the new tmux session has not read the conversation yet…
        rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', runId: String(T2), startedAt: at(T2), tmuxRunId: String(T2) }], (T2 + 5) * 1000);
        // …the next knows it is R1 again, before the agent has named anything.
        rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', runId: String(R1), startedAt: at(T2), tmuxRunId: String(T2) }], (T2 + 10) * 1000);
        sweep(R2, R2 + 10);

        expect(endedRun()).toMatchObject({ providerSessionName: 'Fix login', providerSessionNameSource: 'user' });
    });

    it('run title: a new name alone changes the fingerprint', () => {
        const base = { name: 'hwip-api', agentKind: 'claude', runId: String(R1), lastSeenAt: at(R1) };
        expect(knownSessionsFingerprint([{ ...base, providerSessionName: 'A' }]))
            .not.toBe(knownSessionsFingerprint([{ ...base, providerSessionName: 'B' }]));
        expect(knownSessionsFingerprint([{ ...base, providerSessionName: 'A', providerSessionNameSource: 'auto' }]))
            .not.toBe(knownSessionsFingerprint([{ ...base, providerSessionName: 'A', providerSessionNameSource: 'user' }]));
    });
});

/**
 * Whether starting an ended run again picks its conversation back up
 * (docs/session-runs.md Q43): the phone offers resume only where it does.
 * The same check that builds the resume flags, so the two cannot disagree.
 */
describe('the resumable flag an ended run carries', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    });
    const CWD = '/work/api';
    const ID = '1b5f3c8e-1d2a-4c6b-9e7f-123456789abc';
    const report = (agentKind: string, agentSessionId?: string) => {
        rememberSessions([{ name: 'hwip-api', cwd: CWD, agentKind, runId: '1790000000', agentSessionId }]);
        return knownSessionsToReport([])[0];
    };

    it('resumable: a claude run whose conversation is on disk', async () => {
        const { claudeProjectDirName } = await import('./remote-agents.js');
        const dir = join(TMP, '.claude', 'projects', claudeProjectDirName(CWD));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${ID}.jsonl`), '{}\n');

        expect(report('claude', ID)).toMatchObject({ resumable: true });
    });

    it('resumable: not a claude run whose conversation is gone', () => {
        expect(report('claude', ID)).toMatchObject({ resumable: false });
    });

    it('resumable: not a run with no conversation id', () => {
        expect(report('opencode')).toMatchObject({ resumable: false });
    });

    it('resumable: an opencode run with an id', () => {
        expect(report('opencode', 'ses_abc123')).toMatchObject({ resumable: true });
    });

    it('resumable: not an agent that takes no id', () => {
        expect(report('gemini', ID)).toMatchObject({ resumable: false });
    });

    it('resumable: a change re-sends the report', () => {
        const base = { name: 'hwip-api', agentKind: 'claude', lastSeenAt: '2026-10-21T00:00:00.000Z' };
        expect(knownSessionsFingerprint([{ ...base, resumable: true }]))
            .not.toBe(knownSessionsFingerprint([{ ...base, resumable: false }]));
    });
});
