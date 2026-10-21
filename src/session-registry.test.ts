/**
 * The registry is the whitelist behind remote resume: a resume request names a
 * session, and everything else — which directory, which binary — is read back
 * from what this machine observed itself. So what it stores, and what it
 * refuses to store, is a security property, not bookkeeping.
 */

import { chmodSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { withTmpStateDir } from './test-state-dir.js';

withTmpStateDir('hwip-registry-');

const {
    appendTurnRing,
    readTurnRing,
    turnRingDir,
} = await import('./turn-ring.js');

const {
    rememberSessions,
    recallRun,
    recallSession,
    knownSessions,
    isKnownSession,
    knownSessionsPath,
    forgetSession,
    forgetEnded,
    MAX_KNOWN_SESSIONS,
    KNOWN_SESSION_TTL_MS,
} = await import('./session-registry.js');

const T0 = Date.parse('2026-08-01T00:00:00.000Z');

const live = (over: Record<string, unknown> = {}) => ({
    name: 'hwip-api',
    cwd: '/Users/me/work/api',
    agentKind: 'claude',
    project: 'api',
    ...over,
});

describe('session registry', () => {
    it('remembers where a session ran and what ran there', () => {
        rememberSessions([live()], T0);

        expect(recallSession('hwip-api', T0)).toEqual({
            name: 'hwip-api',
            cwd: '/Users/me/work/api',
            agentKind: 'claude',
            project: 'api',
            lastSeenAt: '2026-08-01T00:00:00.000Z',
        });
    });

    it('knows nothing about a name it never saw', () => {
        rememberSessions([live()], T0);

        expect(recallSession('hwip-somewhere-else', T0)).toBeNull();
        expect(isKnownSession('hwip-somewhere-else', T0)).toBe(false);
    });

    // An entry with no directory cannot say where to start the agent, so it is
    // not a resume target — remembering it would only produce a row that fails
    // when tapped.
    it('skips a session whose directory could not be read', () => {
        rememberSessions([live({ cwd: null })], T0);

        expect(knownSessions(T0)).toEqual([]);
    });

    it('follows a session that moved directory rather than pinning the first sighting', () => {
        rememberSessions([live()], T0);
        rememberSessions([live({ cwd: '/Users/me/work/api-v2' })], T0 + 1000);

        expect(recallSession('hwip-api', T0 + 1000)?.cwd).toBe('/Users/me/work/api-v2');
        expect(knownSessions(T0 + 1000)).toHaveLength(1);
    });

    it('keeps sessions it saw in earlier sweeps', () => {
        rememberSessions([live({ name: 'hwip-api' })], T0);
        rememberSessions([live({ name: 'hwip-web' })], T0 + 1000);

        expect(knownSessions(T0 + 1000).map((e) => e.name)).toEqual(['hwip-web', 'hwip-api']);
    });

    it('forgets a session it has not seen for a month', () => {
        rememberSessions([live()], T0);

        const later = T0 + KNOWN_SESSION_TTL_MS + 1;
        expect(recallSession('hwip-api', later)).toBeNull();
        expect(knownSessions(later)).toEqual([]);
    });

    it('keeps the most recent names when the cap is reached', () => {
        for (let i = 0; i < MAX_KNOWN_SESSIONS + 5; i++) {
            rememberSessions([live({ name: `hwip-${i}` })], T0 + i * 1000);
        }

        const all = knownSessions(T0 + 1_000_000);
        expect(all).toHaveLength(MAX_KNOWN_SESSIONS);
        expect(all[0].name).toBe(`hwip-${MAX_KNOWN_SESSIONS + 4}`);
        // The oldest names are the ones dropped.
        expect(all.some((e) => e.name === 'hwip-0')).toBe(false);
    });

    it('survives a registry file that is not what it expects', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{ this is not json');

        expect(knownSessions(T0)).toEqual([]);
        // And a later sweep repairs it rather than failing forever.
        rememberSessions([live()], T0);
        expect(recallSession('hwip-api', T0)?.cwd).toBe('/Users/me/work/api');
    });

    it('drops rows that are missing the fields a resume needs', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify([
                { name: 'hwip-good', cwd: '/w/good', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                { name: 'hwip-nocwd', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                { cwd: '/w/noname', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                'not even an object',
            ]),
        );

        expect(knownSessions(T0).map((e) => e.name)).toEqual(['hwip-good']);
    });

    it('writes a file only this account can read', () => {
        rememberSessions([live()], T0);

        // The registry names the user's project directories; other accounts on
        // the machine have no business reading them.
        expect(statSync(knownSessionsPath()).mode & 0o077).toBe(0);
    });
});

/**
 * Forgetting is what "delete" means on this side: the entry leaves the file,
 * so the session stops being offered and — because this file is the resume
 * whitelist — stops being startable. `rememberSessions` only writes down
 * sessions that are running, so a session that has ended stays forgotten.
 */
describe('forgetSession', () => {
    it('drops the named session and keeps the rest', () => {
        rememberSessions([live(), live({ name: 'hwip-web', cwd: '/Users/me/work/web' })], T0);

        expect(forgetSession('hwip-api')).toBe('forgotten');
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['hwip-web']);
    });

    it('takes the session out of the resume whitelist', () => {
        rememberSessions([live()], T0);

        forgetSession('hwip-api');

        expect(isKnownSession('hwip-api', T0)).toBe(false);
        expect(recallSession('hwip-api', T0)).toBeNull();
    });

    it('takes the chat scrollback with it', () => {
        rememberSessions([live(), live({ name: 'hwip-web', cwd: '/Users/me/work/web' })], T0);
        appendTurnRing('hwip-api', [{ kind: 'text', text: 'a week of prompts' }]);
        appendTurnRing('hwip-web', [{ kind: 'text', text: 'still watched' }]);

        forgetSession('hwip-api');

        // Forgetting a session everywhere except the one file holding a week of
        // its prompts and tool targets is not forgetting it.
        expect(readTurnRing('hwip-api')).toEqual([]);
        expect(readTurnRing('hwip-web')).toEqual([{ kind: 'text', text: 'still watched' }]);
    });

    it('says so when it never knew the name, and writes nothing', () => {
        rememberSessions([live()], T0);

        expect(forgetSession('hwip-never')).toBe('unknown');
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['hwip-api']);
    });

    it('is safe on a machine with no registry at all', () => {
        expect(forgetSession('hwip-api')).toBe('unknown');
    });

    it('says the scrollback stayed when its file will not delete', () => {
        rememberSessions([live()], T0);
        appendTurnRing('hwip-api', [{ kind: 'text', text: 'a week of prompts' }]);
        // Read-only directory: the file is there and unlink fails, which is
        // exactly the case where answering a flat "forgotten" would be a lie
        // about where the user's prompts are.
        chmodSync(turnRingDir(), 0o500);

        try {
            expect(forgetSession('hwip-api')).toBe('scrollback_kept');
        } finally {
            chmodSync(turnRingDir(), 0o700);
        }
    });
});

/**
 * A registry row outlives the tmux session that put it there: nothing deletes
 * it until the phone deletes the row or the 30 days run out, so a machine that
 * runs agents under a fresh name per task collects rows for sessions that ended
 * weeks ago. This is the sweep that answers that — and it judges by NAME, since
 * a name that is still running is one `rememberSessions` writes straight back.
 */
describe('forgetEnded', () => {
    const allEnded = () => 'ended' as const;
    const empty = { forgotten: [], scrollbackKept: [], kept: [], unreachable: [] };

    it('drops every name tmux no longer has, naming each one once', () => {
        rememberSessions([live(), live({ name: 'hwip-web', cwd: '/Users/me/work/web' })], T0);
        // A second run under a name already listed: the name is reported and
        // deleted once, not once per run.
        rememberSessions([live({ agentKind: 'pi' })], T0 + 1000);

        const result = forgetEnded(allEnded, T0 + 1000);

        expect(result.forgotten.sort()).toEqual(['hwip-api', 'hwip-web']);
        expect(result.kept).toEqual([]);
        expect(knownSessions(T0 + 1000)).toEqual([]);
    });

    it('keeps the names that are still running', () => {
        rememberSessions([live(), live({ name: 'hwip-web', cwd: '/Users/me/work/web' })], T0);

        const result = forgetEnded((name) => (name === 'hwip-web' ? 'running' : 'ended'), T0);

        expect(result.forgotten).toEqual(['hwip-api']);
        expect(result.kept).toEqual(['hwip-web']);
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['hwip-web']);
    });

    it('spares the ended run of a name another agent still holds', () => {
        // Judged by name, not by run: `forgetSession(name)` takes every run of
        // the name, and the live one would be written straight back anyway.
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'claude' })], T0 + 1000);

        const result = forgetEnded(() => 'running', T0 + 1000);

        expect(result.forgotten).toEqual([]);
        expect(result.kept).toEqual(['hwip-api']);
        expect(knownSessions(T0 + 1000)).toHaveLength(2);
    });

    // "tmux could not be asked" is not "the session ended". Deleting on it
    // would take a live session's record and its chat history on the strength
    // of a failed question.
    it('leaves a name alone when the caller could not find out', () => {
        rememberSessions([live(), live({ name: 'hwip-web', cwd: '/Users/me/work/web' })], T0);

        const result = forgetEnded((name) => (name === 'hwip-api' ? 'unknown' : 'ended'), T0);

        expect(result.unreachable).toEqual(['hwip-api']);
        expect(result.forgotten).toEqual(['hwip-web']);
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['hwip-api']);
    });

    it('names the sessions whose scrollback would not delete', () => {
        rememberSessions([live()], T0);
        appendTurnRing('hwip-api', [{ kind: 'text', text: 'a week of prompts' }]);
        chmodSync(turnRingDir(), 0o500);

        try {
            const result = forgetEnded(allEnded, T0);

            // The row is gone either way — but a sweep that answers a flat
            // "forgotten" hides where a week of prompts still is.
            expect(result.forgotten).toEqual(['hwip-api']);
            expect(result.scrollbackKept).toEqual(['hwip-api']);
        } finally {
            chmodSync(turnRingDir(), 0o700);
        }
    });

    it('reports an empty registry as nothing to do', () => {
        expect(forgetEnded(allEnded, T0)).toEqual(empty);
    });
});

/**
 * A tmux name is a slot, not a session. The wrapper hands `hwip-api` to
 * whichever agent asks for that project next, so one row per name meant the
 * newcomer erased what the last agent did there — the past list then answered
 * with the wrong agent, and the ended run was neither resumable nor readable.
 */
describe('one row per run, not per name', () => {
    it('keeps the pi run when claude takes the same tmux name', () => {
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'claude' })], T0 + 1000);

        expect(knownSessions(T0 + 1000).map((e) => e.agentKind).sort()).toEqual(['claude', 'pi']);
    });

    it('still replaces the run when the same agent is seen again', () => {
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'pi', cwd: '/Users/me/work/api-v2' })], T0 + 1000);

        const rows = knownSessions(T0 + 1000);
        expect(rows).toHaveLength(1);
        expect(rows[0].cwd).toBe('/Users/me/work/api-v2');
    });

    it('recalls the run the caller names, and the newest when it names none', () => {
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'claude' })], T0 + 1000);

        expect(recallRun('hwip-api', 'pi', T0 + 1000)?.agentKind).toBe('pi');
        expect(recallSession('hwip-api', T0 + 1000)?.agentKind).toBe('claude');
        expect(recallRun('hwip-api', 'codex', T0 + 1000)).toBeNull();
    });

    it('recallRun with a runId recalls that run of the name, not the newest', () => {
        rememberSessions([live({ agentKind: 'claude', runId: '1785542400', agentSessionId: 'conv-old' })], T0);
        rememberSessions([live({ agentKind: 'claude', runId: '1785546000', agentSessionId: 'conv-new' })], T0 + 1000);

        expect(recallRun('hwip-api', 'claude', T0 + 1000)?.agentSessionId).toBe('conv-new');
        expect(recallRun('hwip-api', 'claude', T0 + 1000, '1785542400')?.agentSessionId).toBe('conv-old');
    });

    it('recallRun with a runId the name never had recalls nothing', () => {
        rememberSessions([live({ agentKind: 'claude', runId: '1785542400' })], T0);

        expect(recallRun('hwip-api', 'claude', T0 + 1000, '1785549999')).toBeNull();
        expect(recallRun('hwip-api', 'pi', T0 + 1000, '1785542400')).toBeNull();
    });

    it('deletes only the run named, and keeps the chat scrollback the other one shares', () => {
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'claude' })], T0 + 1000);
        appendTurnRing('hwip-api', [{ kind: 'text', text: 'a week of prompts' }]);

        expect(forgetSession('hwip-api', 'pi')).toBe('forgotten');
        expect(knownSessions(T0 + 1000).map((e) => e.agentKind)).toEqual(['claude']);
        // The ring is per NAME: dropping the pi row must not take claude's
        // history with it.
        expect(readTurnRing('hwip-api')).toHaveLength(1);
    });

    it('deletes every run of the name when the caller names no agent', () => {
        rememberSessions([live({ agentKind: 'pi' })], T0);
        rememberSessions([live({ agentKind: 'claude' })], T0 + 1000);

        expect(forgetSession('hwip-api')).toBe('forgotten');
        expect(knownSessions(T0 + 1000)).toEqual([]);
    });
});

describe('separate runs of one name (hwip docs/session-runs.md)', () => {
    const run = (runId: string, over: Record<string, unknown> = {}) =>
        live({ runId, startedAt: new Date(Number(runId) * 1000).toISOString(), ...over });
    const R1 = String(T0 / 1000);
    const R2 = String(T0 / 1000 + 3600);

    it('keeps the same agent in the same slot twice as two remembered runs', () => {
        rememberSessions([run(R1)], T0 + 60_000);
        rememberSessions([run(R2)], T0 + 3_660_000);

        expect(knownSessions(T0 + 3_660_000).map((e) => e.runId)).toEqual([R2, R1]);
        expect(knownSessions(T0 + 3_660_000)[1]).toMatchObject({ runId: R1, startedAt: new Date(T0).toISOString() });
    });

    it('folds the entry a run had before runs were recorded into that run', () => {
        // Written by an older listener while this run was already going.
        rememberSessions([live()], T0 + 30_000);
        rememberSessions([run(R1)], T0 + 60_000);

        expect(knownSessions(T0 + 60_000)).toHaveLength(1);
        expect(knownSessions(T0 + 60_000)[0]!.runId).toBe(R1);
    });

    it('keeps an older runless entry from before this run as its own past session', () => {
        rememberSessions([live()], T0 - 60_000);
        rememberSessions([run(R1)], T0 + 60_000);

        expect(knownSessions(T0 + 60_000).map((e) => e.runId)).toEqual([R1, undefined]);
    });

    it('keeps the newest ten runs of a name', () => {
        for (let i = 0; i < 12; i++) rememberSessions([run(String(T0 / 1000 + i * 100))], T0 + i * 100_000);

        const runs = knownSessions(T0 + 1_200_000).map((e) => e.runId);
        expect(runs).toHaveLength(10);
        expect(runs[0]).toBe(String(T0 / 1000 + 1100));
    });

    it('forgets one run and leaves the other', () => {
        rememberSessions([run(R1)], T0 + 60_000);
        rememberSessions([run(R2)], T0 + 3_660_000);

        expect(forgetSession('hwip-api', 'claude', R1)).toBe('forgotten');
        expect(knownSessions(T0 + 3_660_000).map((e) => e.runId)).toEqual([R2]);
    });
});

/**
 * A resume that starts the agent fresh hands the phone an empty chat where the
 * work it tapped used to be. The id of the conversation a run last had is what
 * lets the listener pick that work back up — and only an id this machine read
 * off the live pane, never one a request carries.
 */
describe('the conversation a run last had', () => {
    it('remembers the conversation id the sweep read', () => {
        rememberSessions([live({ agentSessionId: 'conv-1' })], T0);

        expect(recallSession('hwip-api', T0)?.agentSessionId).toBe('conv-1');
    });

    it('keeps the conversation when a later sweep of the same run could not read it', () => {
        // The resolver comes up empty between a pane starting and the agent
        // writing its record; that gap must not erase what was known.
        rememberSessions([live({ agentSessionId: 'conv-1' })], T0);
        rememberSessions([live({ agentSessionId: undefined })], T0 + 1000);

        expect(recallSession('hwip-api', T0 + 1000)?.agentSessionId).toBe('conv-1');
    });

    it('forgets the conversation once the sweep finds it is not this run’s alone', () => {
        rememberSessions([live({ agentSessionId: 'conv-1' })], T0);
        rememberSessions([live({ agentSessionId: null })], T0 + 1000);

        expect(recallSession('hwip-api', T0 + 1000)?.agentSessionId).toBeUndefined();
    });

    it('follows the run to its newer conversation', () => {
        rememberSessions([live({ agentSessionId: 'conv-1' })], T0);
        rememberSessions([live({ agentSessionId: 'conv-2' })], T0 + 1000);

        expect(recallSession('hwip-api', T0 + 1000)?.agentSessionId).toBe('conv-2');
    });

    it('drops the conversation when the run turns up in another directory', () => {
        // The name is a reused slot: a run seen elsewhere is not the run that
        // had that conversation, and opencode would open it from any folder.
        rememberSessions([live({ agentKind: 'opencode', agentSessionId: 'ses_api' })], T0);
        rememberSessions([live({ agentKind: 'opencode', cwd: '/Users/me/work/web', agentSessionId: undefined })], T0 + 1000);

        expect(recallSession('hwip-api', T0 + 1000)?.agentSessionId).toBeUndefined();
    });

    it('does not hand one agent’s conversation to another agent under the same name', () => {
        rememberSessions([live({ agentKind: 'opencode', agentSessionId: 'ses_open' })], T0);
        rememberSessions([live({ agentKind: 'claude', agentSessionId: undefined })], T0 + 1000);

        expect(recallRun('hwip-api', 'claude', T0 + 1000)?.agentSessionId).toBeUndefined();
        expect(recallRun('hwip-api', 'opencode', T0 + 1000)?.agentSessionId).toBe('ses_open');
    });

    it('reads a registry written before runs carried a conversation id', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify([
                { name: 'hwip-old', cwd: '/w/old', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
            ]),
        );

        const row = recallSession('hwip-old', T0);
        expect(row?.cwd).toBe('/w/old');
        expect(row?.agentSessionId).toBeUndefined();
    });
});

describe('session registry: run title', () => {
    it('run title: a file entry keeps its run but loses a name or source that is not what it expects', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify([
                { name: 'hwip-a', cwd: '/w/a', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z', providerSessionName: 42, providerSessionNameSource: 'user' },
                { name: 'hwip-b', cwd: '/w/b', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z', providerSessionName: 'Fix login', providerSessionNameSource: 'robot' },
                { name: 'hwip-c', cwd: '/w/c', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z', providerSessionName: 'Ship it', providerSessionNameSource: 'auto' },
            ]),
        );

        const byName = new Map(knownSessions(T0).map((e) => [e.name, e]));
        expect(byName.get('hwip-a')).not.toHaveProperty('providerSessionName');
        expect(byName.get('hwip-a')).not.toHaveProperty('providerSessionNameSource');
        expect(byName.get('hwip-b')).toMatchObject({ providerSessionName: 'Fix login' });
        expect(byName.get('hwip-b')).not.toHaveProperty('providerSessionNameSource');
        expect(byName.get('hwip-c')).toMatchObject({ providerSessionName: 'Ship it', providerSessionNameSource: 'auto' });
    });
});
