/**
 * A Claude conversation carried on in a new tmux session is the run it was
 * (hwip docs/session-runs.md §3): `exit` and then `hwip cc -c` — or `--resume`,
 * or the app's resume — starts another tmux session on the same conversation,
 * and the phone should keep one run, not show the first as an earlier one.
 *
 * Measured on Claude Code 2.1.300: `claude -c` keeps the conversation's
 * `sessionId` in a new process.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** tmux sessions that exist right now, with their `session_created`. */
let liveSessions: Array<{ name: string; created: string }> = [];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-sessions') {
        const format = a[a.indexOf('-F') + 1] ?? '';
        if (!a.includes('-F')) return { status: 0, stdout: '', stderr: '' };
        const rows = liveSessions.map((s) => (format.includes('session_created') ? `${s.name}\t${s.created}` : s.name));
        return { status: 0, stdout: rows.join('\n'), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'hwip-run-continue-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
const PROJECT_DIR = join(TMP, 'work', 'api');
mkdirSync(PROJECT_DIR, { recursive: true });

const { handleSessionForgetRequest, computeListenerDeviceId, continueRuns, knownSessionsToReport, knownSessionsFingerprint } = await import('./listener.js');
const { rememberSessions, knownSessions, continuedRunId } = await import('./session-registry.js');

const NAME = 'hwip-api';
const A = '1790000000';
const B = '1790003600';
const T = '1790007200';
const CONVERSATION = '34e85b28-3808-4504-bec0-da9ca546081b';
const OTHER = 'f80b8fa0-7cf2-47b4-a950-0ca65958eab8';
const iso = (sec: string) => new Date(Number(sec) * 1000).toISOString();

/** What the sweep hands the registry for one live session. */
const sighting = (runId: string, over: Record<string, unknown> = {}) => ({
    name: NAME,
    cwd: PROJECT_DIR,
    agentKind: 'claude',
    runId,
    startedAt: iso(runId),
    agentSessionId: CONVERSATION,
    ...over,
});

/** Run A, ended a while ago, with the conversation it last had. */
const endedA = () => rememberSessions([sighting(A)], Date.now() - 60_000);

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    liveSessions = [];
    rmSync(join(TMP, 'state'), { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe('continue: which run a new tmux session is', () => {
    it('is the earlier run whose conversation it carries on', () => {
        endedA();
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, CONVERSATION)).toBe(A);
    });

    it('is its own run for another conversation, none read, or another agent', () => {
        endedA();
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, OTHER)).toBe(T);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, undefined)).toBe(T);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, null)).toBe(T);
        expect(continuedRunId(knownSessions(), NAME, 'codex', T, CONVERSATION)).toBe(T);
        expect(continuedRunId(knownSessions(), 'hwip-web', 'claude', T, CONVERSATION)).toBe(T);
    });

    it('never takes a later run', () => {
        rememberSessions([sighting(T)], Date.now() - 60_000);
        expect(continuedRunId(knownSessions(), NAME, 'claude', A, CONVERSATION)).toBe(A);
    });

    it('takes the run that last had the conversation', () => {
        rememberSessions([sighting(A)], Date.now() - 120_000);
        rememberSessions([sighting(B, { agentSessionId: OTHER })], Date.now() - 60_000);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, CONVERSATION)).toBe(A);
    });

    it('stays its own run once it had a conversation of its own', () => {
        endedA();
        // Started fresh, then `/resume`d into A's conversation from inside: what it wrote first is its own.
        rememberSessions([sighting(T, { agentSessionId: OTHER })]);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, CONVERSATION)).toBe(T);
    });

    it('joins the run once a later sweep reads the conversation the first one could not', () => {
        endedA();
        rememberSessions([sighting(T, { agentSessionId: undefined })]);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, CONVERSATION)).toBe(A);
    });
});

describe('continue: what the registry keeps', () => {
    it('keeps one entry, the run\'s first start, and the tmux session it went on in', () => {
        endedA();
        rememberSessions([sighting(T, { agentSessionId: undefined })]);
        rememberSessions([{ ...sighting(A), startedAt: iso(T), tmuxRunId: T }]);

        const entries = knownSessions();
        expect(entries.map((e) => e.runId)).toEqual([A]);
        expect(entries[0]).toMatchObject({ runId: A, startedAt: iso(A), tmuxRunIds: [T], agentSessionId: CONVERSATION });
    });
});

describe('continue: what the server is told', () => {
    it('reports the tmux sessions the ended run went on in, and sees them as a change', () => {
        endedA();
        rememberSessions([{ ...sighting(A), tmuxRunId: T }], Date.now() - 30_000);

        const reported = knownSessionsToReport([]);
        expect(reported).toMatchObject([{ runId: A, tmuxRunIds: [T] }]);
        const unjoined = reported.map(({ tmuxRunIds: _joined, ...rest }) => rest);
        expect(knownSessionsFingerprint(reported)).not.toBe(knownSessionsFingerprint(unjoined));
    });
});

describe('continue: remembered across sweeps and restarts', () => {
    it('is the run the tmux session was joined to, when this sweep cannot read the conversation', () => {
        endedA();
        rememberSessions([{ ...sighting(A), tmuxRunId: T }]);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, undefined)).toBe(A);
        expect(continuedRunId(knownSessions(), NAME, 'claude', T, null)).toBe(A);
    });

    it('reports the joined run for the live session and what the recorder tags', () => {
        endedA();
        const sessions = [
            { name: NAME, agentKind: 'claude', createdAt: iso(T), runId: T },
            { name: `${NAME}.1`, parentName: NAME, agentKind: 'claude', createdAt: iso(T) },
        ];
        const recordable: Record<string, { path: string; kind: string; runId?: string }> = { [NAME]: { path: '/x.jsonl', kind: 'claude', runId: T } };

        continueRuns(sessions as never, recordable, (name) => (name === NAME ? CONVERSATION : undefined));

        expect(sessions[0]).toMatchObject({ runId: A, createdAt: iso(T) });
        expect(sessions[1]).not.toHaveProperty('runId');
        expect(recordable[NAME].runId).toBe(A);
    });
});

describe('continue: forget (agent.session.forget.request)', () => {
    const device = computeListenerDeviceId();
    const ask = (over: Record<string, unknown> = {}) => {
        const sent: Array<Record<string, unknown>> = [];
        handleSessionForgetRequest(
            { subtype: 'agent.session.forget.request', targetDeviceId: device, sessionName: NAME, requestId: 'f1', agentKind: 'claude', ...over },
            (data) => { sent.push(data); },
        );
        return sent.at(-1);
    };

    it('refuses the run that goes on in a new tmux session', () => {
        endedA();
        rememberSessions([{ ...sighting(A), tmuxRunId: T }]);
        liveSessions = [{ name: NAME, created: T }];

        expect(ask({ runId: A })).toMatchObject({ error: 'still_running' });
        expect(knownSessions().map((e) => e.runId)).toEqual([A]);
    });

    it('still forgets another ended run of the name', () => {
        rememberSessions([sighting(B, { agentSessionId: OTHER })], Date.now() - 120_000);
        endedA();
        rememberSessions([{ ...sighting(A), tmuxRunId: T }]);
        liveSessions = [{ name: NAME, created: T }];

        expect(ask({ runId: B })).toMatchObject({ forgotten: true });
        expect(knownSessions().map((e) => e.runId)).toEqual([A]);
    });
});
