import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `collectSessionsVerbose` does today, pinned before anyone splits it up
 * (improve-architecture candidate #4). Characterization, not specification:
 * each test fixes one behavior the sweep has now, and the neighbouring files
 * (subagent panes, shell sessions, pane pinning, in-process subagents) already
 * hold the rest. tmux is faked at `spawnSync`, the seam every sweep goes through;
 * `list-panes` answers with the 15-field rows the sweep asks for.
 */
const FIELD_SEP = '␟';
const TMP = mkdtempSync(join(tmpdir(), 'hwip-collect-sessions-'));
process.env.XDG_STATE_HOME = join(TMP, 'state');
// A developer's own override would make the socket probe test below depend on their shell.
delete process.env.HWIP_TMUX_SOCKET;

interface FakeRow {
    session: string;
    attached?: string;
    created?: string;
    activity?: string;
    win?: string;
    idx?: string;
    paneId?: string;
    current?: string;
    start?: string;
    path?: string;
}

/** One `list-panes -F` row, in the order the sweep's format string lists the fields. */
const paneRow = (r: FakeRow): string =>
    [r.session, r.attached ?? '0', r.created ?? '1700000000', r.activity ?? '1700000000', r.win ?? '0', r.idx ?? '0',
        r.paneId ?? '%0', r.current ?? 'node', r.start ?? 'claude', r.path ?? '/tmp/proj', '1234', '', '', '', ''].join(FIELD_SEP);

interface TmuxAnswer { status: number; stdout: string; stderr: string }
const answer = (...lines: string[]): TmuxAnswer => ({ status: 0, stdout: lines.join('\n') + '\n', stderr: '' });

let listPanes: TmuxAnswer = answer();
let tmuxCalls: string[][] = [];

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd !== 'tmux') return { status: 1, stdout: '', stderr: '' };
            const a = args?.[0] === '-S' ? args.slice(2) : (args ?? []);
            tmuxCalls.push([...a]);
            if (a[0] === 'list-panes') return listPanes;
            if (a[0] === 'capture-pane') return { status: 0, stdout: '$ \n', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        },
    };
});

const listener = await import('./listener.js');
const { recallSession, rememberSessions, knownSessions } = await import('./session-registry.js');
const { REMOTE_AGENTS } = await import('./remote-agents.js');

let logSpy: ReturnType<typeof vi.spyOn>;
const logged = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const probes = (): number => tmuxCalls.filter((c) => c[0] === 'list-sessions').length;

describe('collectSessionsVerbose — what the sweep does today', () => {
    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        listener.resetSessionStates();
        tmuxCalls = [];
        listPanes = answer();
    });
    afterEach(() => vi.restoreAllMocks());

    describe('when tmux does not answer', () => {
        // Rows on stdout of a failed call are not trusted: a half-dead server may print stale ones.
        it('reports nothing, whatever stdout carries', () => {
            listPanes = { status: 1, stdout: paneRow({ session: 'hwip-stale' }) + '\n', stderr: 'no server running' };
            expect(listener.collectSessionsVerbose()).toEqual({
                sessions: [], rejected: [], targets: {}, subagentTranscripts: {}, recordable: {},
            });
        });

        it('logs the status and the stderr it got', () => {
            listPanes = { status: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/default\n' };
            listener.collectSessionsVerbose();
            expect(logged()).toContain('tmux list-panes failed: status=1, stderr=no server running on /tmp/tmux-501/default');
        });

        // Without this the listener stays pinned to a dead socket and reports 0 sessions forever.
        it('makes the next sweep look for the socket again', () => {
            listPanes = answer(paneRow({ session: 'hwip-app' }));
            listener.collectSessionsVerbose();
            listener.collectSessionsVerbose();
            const warm = probes();
            listPanes = { status: 1, stdout: '', stderr: 'gone' };
            listener.collectSessionsVerbose();
            expect(probes()).toBe(warm); // the failing sweep itself does not probe
            listPanes = answer(paneRow({ session: 'hwip-app' }));
            listener.collectSessionsVerbose();
            expect(probes()).toBe(warm + 1);
        });
    });

    describe('rows it cannot read', () => {
        const bad = paneRow({ session: 'hwip-bad', paneId: '%9' }).split(FIELD_SEP).slice(0, 14).join(FIELD_SEP);

        it('drops a row with the wrong number of fields and keeps the others', () => {
            listPanes = answer(paneRow({ session: 'hwip-ok', paneId: '%1' }), bad);
            const result = listener.collectSessionsVerbose();
            expect(result.sessions.map((s) => s.name)).toEqual(['hwip-ok']);
            expect(result.targets).toEqual({ 'hwip-ok': '%1' });
            expect(result.rejected).toEqual([]);
        });

        it('logs how many rows it dropped', () => {
            listPanes = answer(paneRow({ session: 'hwip-ok' }), bad);
            listener.collectSessionsVerbose();
            expect(logged()).toContain('tmux list-panes: skipped 1 malformed row(s)');
        });

        it('says so when the separator did not survive the trip', () => {
            listPanes = answer('hwip-app claude /tmp/proj');
            const result = listener.collectSessionsVerbose();
            expect(result.sessions).toEqual([]);
            expect(logged()).toContain('tmux list-panes output missing FIELD_SEP');
            expect(logged()).toContain('"hwip-app claude /tmp/proj"');
        });
    });

    describe('which sessions it looks at', () => {
        // A machine full of plain tmux sessions must not fill the verbose log or the rejection list.
        it('ignores a session that is not named hwip-* without a word', () => {
            listPanes = answer(
                paneRow({ session: 'dev', paneId: '%1', current: 'zsh', start: 'zsh' }),
                paneRow({ session: 'work', paneId: '%2', current: 'node', start: 'claude' }),
            );
            const result = listener.collectSessionsVerbose();
            expect(result.sessions).toEqual([]);
            expect(result.rejected).toEqual([]);
            expect(result.targets).toEqual({});
        });

        it('lists sessions in the order tmux listed them, not sorted', () => {
            listPanes = answer(
                paneRow({ session: 'hwip-zeta', paneId: '%1' }),
                paneRow({ session: 'hwip-alpha', paneId: '%2' }),
            );
            expect(listener.collectSessionsVerbose().sessions.map((s) => s.name)).toEqual(['hwip-zeta', 'hwip-alpha']);
        });

        it('names a pane with no agent as `null` when tmux has no commands for it', () => {
            listPanes = answer(paneRow({ session: 'hwip-empty', current: '', start: '' }));
            expect(listener.collectSessionsVerbose().rejected).toEqual([
                { name: 'hwip-empty', reason: 'no agent in pane (start=null, current=null)' },
            ]);
        });
    });

    describe('the main pane of a session', () => {
        // A window or pane index tmux prints as something else than a count sorts after every real one.
        it('puts a pane with an unreadable index after the panes with one', () => {
            listPanes = answer(
                paneRow({ session: 'hwip-app', paneId: '%1', win: 'x', idx: '0' }),
                paneRow({ session: 'hwip-app', paneId: '%2', win: '0', idx: '5' }),
            );
            expect(listener.collectSessionsVerbose().targets['hwip-app']).toBe('%2');
        });

        it('is where the registry gets the directory from, not the first pane', () => {
            listPanes = answer(
                paneRow({ session: 'hwip-cwd', paneId: '%1', idx: '0', current: 'zsh', start: 'zsh', path: '/tmp/other' }),
                paneRow({ session: 'hwip-cwd', paneId: '%2', idx: '1', current: 'node', start: 'claude', path: '/tmp/proj' }),
            );
            listener.collectSessionsVerbose();
            expect(recallSession('hwip-cwd')).toMatchObject({ cwd: '/tmp/proj', agentKind: 'claude' });
        });

        // A resume hands this id to `claude --resume`, so only an id read off
        // this pane's own process goes into the registry — never the reported
        // one, which may be a guess at the newest conversation in the folder.
        it('records the conversation a resume can pick up, not the reported one', () => {
            const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
            vi.spyOn(claude, 'resolveSessionId').mockReturnValue('folder-guess');
            vi.spyOn(claude, 'resolveResumeId').mockReturnValue('conv-exact');
            listPanes = answer(paneRow({ session: 'hwip-conv' }));

            listener.collectSessionsVerbose();

            expect(recallSession('hwip-conv')?.agentSessionId).toBe('conv-exact');
        });

        // The registry is where an ended run's title comes from (hwip docs/session-runs.md Q39):
        // a sweep that reads the agent's name must write it down, or the run ends nameless.
        it('run title: records the name the agent gave the session, and who gave it', () => {
            const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
            vi.spyOn(claude, 'resolveSessionName').mockReturnValue({ name: 'Fix login', source: 'user' });
            listPanes = answer(paneRow({ session: 'hwip-named' }));

            listener.collectSessionsVerbose();

            expect(recallSession('hwip-named')).toMatchObject({ providerSessionName: 'Fix login', providerSessionNameSource: 'user' });
        });

        it('records no conversation that two panes both answer to', () => {
            // opencode resolves the busiest session in the folder, so two panes
            // there can both name one conversation — resuming either would
            // write into the other's.
            const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
            vi.spyOn(claude, 'resolveResumeId').mockReturnValue('conv-shared');
            listPanes = answer(
                paneRow({ session: 'hwip-twin', paneId: '%1' }),
                paneRow({ session: 'hwip-twin-2', paneId: '%2' }),
            );

            listener.collectSessionsVerbose();

            expect(recallSession('hwip-twin')?.agentSessionId).toBeUndefined();
            expect(recallSession('hwip-twin-2')?.agentSessionId).toBeUndefined();
        });

        it('forgets the conversation a pane had alone once another pane answers to it too', () => {
            const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
            vi.spyOn(claude, 'resolveResumeId').mockReturnValue('conv-was-mine');
            listPanes = answer(paneRow({ session: 'hwip-solo', paneId: '%1' }));
            listener.collectSessionsVerbose();
            expect(recallSession('hwip-solo')?.agentSessionId).toBe('conv-was-mine');

            listPanes = answer(
                paneRow({ session: 'hwip-solo', paneId: '%1' }),
                paneRow({ session: 'hwip-solo-2', paneId: '%2' }),
            );
            listener.collectSessionsVerbose();

            expect(recallSession('hwip-solo')?.agentSessionId).toBeUndefined();
        });

        it('records no conversation when only a guess was read', () => {
            const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
            vi.spyOn(claude, 'resolveSessionId').mockReturnValue('folder-guess');
            vi.spyOn(claude, 'resolveResumeId').mockReturnValue(null);
            listPanes = answer(paneRow({ session: 'hwip-conv-guess' }));

            listener.collectSessionsVerbose();

            expect(recallSession('hwip-conv-guess')?.agentSessionId).toBeUndefined();
        });
    });

    describe('the clock fields of a session', () => {
        // Panes of one session repeat the session-level fields; the first row is the one the sweep keeps.
        it('takes attached, created and activity from the first row, as ISO times', () => {
            listPanes = answer(
                paneRow({ session: 'hwip-app', paneId: '%1', idx: '0', attached: '1', created: '1700000000', activity: '1700000100' }),
                paneRow({ session: 'hwip-app', paneId: '%2', idx: '1', attached: '0', created: '1800000000', activity: '1800000100' }),
            );
            const [s] = listener.collectSessionsVerbose().sessions;
            expect(s.attached).toBe(true);
            expect(s.createdAt).toBe(new Date(1700000000 * 1000).toISOString());
            expect(s.lastActivityAt).toBe(new Date(1700000100 * 1000).toISOString());
        });

        it('leaves a time out rather than invent one when tmux gives none that counts', () => {
            listPanes = answer(paneRow({ session: 'hwip-app', created: '0', activity: 'soon' }));
            const [s] = listener.collectSessionsVerbose().sessions;
            expect(s.createdAt).toBeUndefined();
            expect(s.lastActivityAt).toBeUndefined();
        });
    });
});

describe('collectSessionsVerbose — a conversation carried on in a new tmux session', () => {
    const NAME = 'hwip-cont';
    const A = '1790000000';
    const T = '1790007200';
    const CONVERSATION = '34e85b28-3808-4504-bec0-da9ca546081b';
    const iso = (sec: string) => new Date(Number(sec) * 1000).toISOString();

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        listener.resetSessionStates();
        listPanes = answer(paneRow({ session: NAME, created: T, paneId: '%5' }));
    });
    afterEach(() => vi.restoreAllMocks());

    it('reports the earlier run once the conversation is read, and leaves no entry for the new tmux session', () => {
        rememberSessions([{ name: NAME, cwd: '/tmp/proj', agentKind: 'claude', runId: A, startedAt: iso(A), agentSessionId: CONVERSATION }], Date.now() - 60_000);
        const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;
        const resume = vi.spyOn(claude, 'resolveResumeId').mockReturnValue(null);

        // The agent has not written its record yet: the new tmux session is its own run for now.
        expect(listener.collectSessionsVerbose().sessions.find((s) => s.name === NAME)?.runId).toBe(T);

        resume.mockReturnValue(CONVERSATION);
        expect(listener.collectSessionsVerbose().sessions.find((s) => s.name === NAME)?.runId).toBe(A);
        expect(knownSessions().filter((e) => e.name === NAME)).toEqual([
            expect.objectContaining({ runId: A, startedAt: iso(A), tmuxRunIds: [T], agentSessionId: CONVERSATION }),
        ]);

        // A later sweep that cannot read the conversation stays on the run.
        resume.mockReturnValue(null);
        expect(listener.collectSessionsVerbose().sessions.find((s) => s.name === NAME)?.runId).toBe(A);
    });
});
