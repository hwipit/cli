/**
 * Each run's seq block (hwip docs/session-runs.md Q24), the runs kept per name
 * (Q25), and forgetting one ended run while the name runs again (Q29).
 *
 * The server reads a run's conversation from the key range between the
 * smallest and the largest seq the run was handed, so the listener has to
 * remember both across restarts, report them with each run, and never let a
 * bound move inward: a block reported too narrow hides chunks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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

const TMP = mkdtempSync(join(tmpdir(), 'hwip-run-seqs-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
const PROJECT_DIR = join(TMP, 'work', 'api');
mkdirSync(PROJECT_DIR, { recursive: true });

const { noteRunSeqs, runSeqsByRun, runSeqsKey } = await import('./run-seqs.js');
const { handleSessionForgetRequest, computeListenerDeviceId, knownSessionsToReport, withRunSeqs } = await import('./listener.js');
const { rememberSessions, knownSessions, MAX_RUNS_PER_NAME } = await import('./session-registry.js');
const { createTurnRecorder } = await import('./turn-recorder.js');
const { projectTranscriptEntries } = await import('./transcript-tail.js');
const { turnRingPath } = await import('./turn-ring.js');

const NAME = 'hwip-api';
const A = '1790000000';
const B = '1790003600';
const iso = (sec: string) => new Date(Number(sec) * 1000).toISOString();

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    liveSessions = [];
    rmSync(join(TMP, 'state'), { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe('a run\'s seq block', () => {
    it('only widens: the first seq goes down, the last up', () => {
        noteRunSeqs(NAME, A, 10, 12);
        noteRunSeqs(NAME, A, 13, 15);
        noteRunSeqs(NAME, A, 4, 5);
        expect(runSeqsByRun().get(runSeqsKey(NAME, A))).toEqual({ firstSeq: 4, lastSeq: 15 });
    });

    it('keeps each run of one name apart', () => {
        noteRunSeqs(NAME, A, 1, 9);
        noteRunSeqs(NAME, B, 5, 7);
        noteRunSeqs(NAME, A, 10, 10); // the earlier run's tail, read after the next one started
        expect(runSeqsByRun().get(runSeqsKey(NAME, A))).toEqual({ firstSeq: 1, lastSeq: 10 });
        expect(runSeqsByRun().get(runSeqsKey(NAME, B))).toEqual({ firstSeq: 5, lastSeq: 7 });
    });

    it('outlives the recorder\'s own state: it is on disk, apart from it', () => {
        noteRunSeqs(NAME, A, 3, 8);
        rmSync(join(TMP, 'state', 'hwip', 'turn-recorder'), { recursive: true, force: true });
        expect(runSeqsByRun().get(runSeqsKey(NAME, A))).toEqual({ firstSeq: 3, lastSeq: 8 });
    });

    it('drops a run unseen for the registry\'s TTL', () => {
        const now = Date.parse('2026-10-18T00:00:00Z');
        noteRunSeqs(NAME, A, 1, 2, now - 31 * 24 * 3600_000);
        noteRunSeqs(NAME, B, 3, 4, now);
        expect([...runSeqsByRun().keys()]).toEqual([runSeqsKey(NAME, B)]);
    });

    it('is what the recorder hands out, per run', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-run-seqs-rec-'));
        const file = join(dir, 'a.jsonl');
        const line = (text: string, sec: number) =>
            `${JSON.stringify({ timestamp: new Date(sec * 1000).toISOString(), type: 'user', message: { role: 'user', content: text } })}\n`;
        writeFileSync(file, line('hello', 1790000010));
        const noted: Array<[string, string, number, number]> = [];
        const uploads: number[] = [];
        let clock = 1_790_000_100_000;
        const recorder = createTurnRecorder({
            dir: join(dir, 'state'),
            deviceId: () => 'dev_listener',
            projectorFor: () => projectTranscriptEntries,
            recipients: async () => [{ deviceId: 'dev_phone', publicKey: 'k' }],
            seal: async (plaintext) => ({ body: plaintext, deviceKeyMap: { dev_phone: 'x' }, senderPublicKey: 'k' }),
            upload: async (_key, chunk) => { uploads.push(chunk.seq); return { kind: 'ok' }; },
            noteSeqs: (name, runId, first, last) => { noted.push([name, runId, first, last]); },
            log: () => {},
            now: () => clock,
        });
        try {
            recorder.observe({ [NAME]: { path: file, kind: 'claude', runId: A } });
            for (let i = 0; i < 5; i++) { clock += 1000; await recorder.tick(); }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(uploads.length).toBeGreaterThan(0);
        expect(noted).toEqual([[NAME, A, Math.min(...uploads), Math.max(...uploads)]]);
    });
});

describe('the report', () => {
    const live = { name: NAME, attached: true, agentKind: 'claude', project: 'api', createdAt: iso(B), runId: B };

    it('names the running run\'s first seq, and an ended run\'s whole block', () => {
        rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId: A, startedAt: iso(A) }]);
        noteRunSeqs(NAME, A, 1, 9);
        noteRunSeqs(NAME, B, 5, 7);

        expect(withRunSeqs([live as never])[0]).toMatchObject({ runId: B, firstSeq: 5 });
        expect(withRunSeqs([live as never])[0]).not.toHaveProperty('lastSeq');
        expect(knownSessionsToReport([live as never])).toEqual([
            expect.objectContaining({ name: NAME, runId: A, firstSeq: 1, lastSeq: 9 }),
        ]);
    });

    it('names no block for a run that has recorded nothing', () => {
        rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId: A, startedAt: iso(A) }]);
        expect(withRunSeqs([live as never])[0]).not.toHaveProperty('firstSeq');
        expect(knownSessionsToReport([live as never])[0]).not.toHaveProperty('firstSeq');
    });
});

describe('runs kept per name', () => {
    it('keeps the newest ten', () => {
        expect(MAX_RUNS_PER_NAME).toBe(10);
        const start = Date.parse('2026-10-18T00:00:00Z');
        for (let i = 0; i < 12; i++) {
            const runId = String(1790000000 + i * 3600);
            rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId, startedAt: iso(runId) }], start + i * 60_000);
        }
        const runs = knownSessions(start + 12 * 60_000).map((e) => e.runId);
        expect(runs).toHaveLength(10);
        expect(runs[0]).toBe(String(1790000000 + 11 * 3600));
    });
});

describe('forget one ended run (agent.session.forget.request)', () => {
    const device = computeListenerDeviceId();
    const ask = (over: Record<string, unknown> = {}) => {
        const sent: Array<Record<string, unknown>> = [];
        handleSessionForgetRequest(
            { subtype: 'agent.session.forget.request', targetDeviceId: device, sessionName: NAME, requestId: 'f1', agentKind: 'claude', ...over },
            (data) => { sent.push(data); },
        );
        return sent.at(-1);
    };
    const remember = () => {
        rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId: A, startedAt: iso(A) }], Date.now() - 60_000);
        rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId: B, startedAt: iso(B) }]);
    };
    const runsLeft = () => knownSessions().map((e) => e.runId).sort();

    it('forgets an ended run while the name runs another', () => {
        remember();
        liveSessions = [{ name: NAME, created: B }];

        expect(ask({ runId: A })).toMatchObject({ forgotten: true });
        expect(runsLeft()).toEqual([B]);
    });

    it('refuses the run that is running', () => {
        remember();
        liveSessions = [{ name: NAME, created: B }];

        expect(ask({ runId: B })).toMatchObject({ error: 'still_running' });
        expect(runsLeft()).toEqual([A, B]);
    });

    it('refuses a running name when the request names no run', () => {
        remember();
        liveSessions = [{ name: NAME, created: B }];

        expect(ask()).toMatchObject({ error: 'still_running' });
        expect(runsLeft()).toEqual([A, B]);
    });

    it('keeps the running run\'s scrollback when the registry has not written that run down yet', () => {
        rememberSessions([{ name: NAME, cwd: PROJECT_DIR, agentKind: 'claude', runId: A, startedAt: iso(A) }]);
        liveSessions = [{ name: NAME, created: B }];
        const ring = turnRingPath(NAME);
        mkdirSync(dirname(ring), { recursive: true });
        writeFileSync(ring, '{}\n');

        expect(ask({ runId: A })).toMatchObject({ forgotten: true });
        expect(existsSync(ring)).toBe(true);
    });

    it('refuses when tmux cannot say which run is going', () => {
        remember();
        liveSessions = [{ name: NAME, created: 'soon' }];
        expect(ask({ runId: A })).toMatchObject({ error: 'still_running' });
        expect(runsLeft()).toEqual([A, B]);
    });

    it('forgets the run once and answers unknown the second time', () => {
        remember();
        liveSessions = [{ name: NAME, created: B }];

        expect(ask({ runId: A })).toMatchObject({ forgotten: true });
        expect(ask({ runId: A, requestId: 'f2' })).toMatchObject({ error: 'unknown_session' });
    });
});
