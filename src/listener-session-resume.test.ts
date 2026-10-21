/**
 * Starting a finished session again, from the phone.
 *
 * This is the one remote path that creates a process rather than typing into
 * one, so the shape of the request matters more than usual: it carries a
 * session NAME and nothing else. Where to start, and what to start, come from
 * the registry this machine wrote while the session was alive. A phone — or a
 * relay posing as one — cannot name a directory, a command, or an argument.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIELD_SEP = '␟';
/** tmux sessions that exist right now. */
let liveSessions: string[] = [];
let tmuxCalls: string[][] = [];
let newSessionFails = false;

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-panes') {
        const rows = liveSessions
            .map((n, i) => [n, '0', '1700000000', '1700000000', '0', '0', `%${i}`, 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''].join(FIELD_SEP))
            .join('\n');
        return { status: 0, stdout: rows + '\n', stderr: '' };
    }
    if (a[0] === 'list-sessions') {
        // The `-F` form is the liveness question; the bare one is socket discovery.
        if (a.includes('-F')) return { status: 0, stdout: liveSessions.join('\n'), stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'new-session') {
        if (newSessionFails) return { status: 1, stdout: '', stderr: 'no server' };
        // A started session is live from then on, as it is in tmux.
        liveSessions.push(a[a.indexOf('-s') + 1]);
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'display-message') {
        const target = a[a.indexOf('-t') + 1];
        const session = liveSessions[Number(target.slice(1))] ?? target;
        if (a[4]?.includes('#{session_name}')) return { status: 0, stdout: ['node', session, ''].join(FIELD_SEP), stderr: '' };
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: 'node', stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'idle pane\n', stderr: '' };
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

const TMP = mkdtempSync(join(tmpdir(), 'hwip-resume-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
/** A directory that really exists — the recorded cwd has to still be there. */
const PROJECT_DIR = join(TMP, 'work', 'api');
mkdirSync(PROJECT_DIR, { recursive: true });

const { handleSessionResumeRequest, computeListenerDeviceId, knownSessionsToReport } = await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');
const { claudeProjectDirName, REMOTE_AGENTS } = await import('./remote-agents.js');

describe('agent.session.resume.request — starting a session that ended', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };

    const request = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.session.resume.request',
        targetDeviceId: device,
        sessionName: 'hwip-api',
        requestId: 'r1',
        ...over,
    });

    const ask = (over: Record<string, unknown> = {}) => {
        const claimed = handleSessionResumeRequest(request(over), send);
        return { claimed, reply: sent.at(-1) };
    };

    /** What the daemon remembered while the session was running. */
    const remember = (over: Record<string, unknown> = {}) =>
        rememberSessions([
            { name: 'hwip-api', cwd: PROJECT_DIR, agentKind: 'claude', project: 'api', ...over },
        ]);

    const newSessions = () => tmuxCalls.filter((c) => c[0] === 'new-session');

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });
    afterEach(() => vi.restoreAllMocks());

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleSessionResumeRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleSessionResumeRequest({}, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine', () => {
            remember();
            expect(ask({ targetDeviceId: 'dev_someone_else' }).claimed).toBe(false);
            expect(newSessions()).toEqual([]);
        });

        it('ignores a request with no requestId or no session', () => {
            expect(ask({ requestId: undefined }).claimed).toBe(false);
            expect(ask({ sessionName: undefined }).claimed).toBe(false);
        });
    });

    describe('what it will start', () => {
        it('starts the recorded agent in the recorded directory, detached', () => {
            remember();

            const { reply } = ask();

            expect(newSessions()).toEqual([
                ['new-session', '-d', '-s', 'hwip-api', '-c', PROJECT_DIR, 'claude'],
            ]);
            expect(reply).toMatchObject({
                subtype: 'agent.session.resume.result',
                requestId: 'r1',
                sessionName: 'hwip-api',
                resumed: true,
            });
        });

        // A labelled or worktree session lived with sidecar options; a fresh
        // tmux session has none, so without them it would come back in a card of its own.
        it('puts the recorded project and label back on a labelled session', () => {
            remember({ name: 'hwip-api', project: 'api-main', label: 'api' });

            ask();

            expect(newSessions()).toEqual([
                ['new-session', '-d', '-s', 'hwip-api', '-c', PROJECT_DIR, 'claude',
                    ';', 'set-option', '@hwip_project', 'api-main', ';', 'set-option', '@hwip_session_label', 'api'],
            ]);
        });

        // The registry IS the whitelist. A name this machine never wrote down
        // has no directory and no binary attached to it, and the daemon has
        // nothing else to fall back on — which is the point.
        it('refuses a session it never saw run', () => {
            remember();

            const { reply } = ask({ sessionName: 'hwip-not-mine' });

            expect(reply?.error).toBe('unknown_session');
            expect(newSessions()).toEqual([]);
        });

        it('refuses when the recorded directory is gone', () => {
            rememberSessions([
                { name: 'hwip-api', cwd: join(TMP, 'work', 'deleted'), agentKind: 'claude' },
            ]);

            const { reply } = ask();

            expect(reply?.error).toBe('missing_directory');
            expect(newSessions()).toEqual([]);
        });

        // agentKind is a wire enum that outlives installs: a record written by
        // a newer build, or for an agent since removed from the table, must not
        // become a command guess.
        it('refuses an agent kind it cannot resolve to a known binary', () => {
            remember({ agentKind: 'some-future-agent' });

            const { reply } = ask();

            expect(reply?.error).toBe('unknown_agent');
            expect(newSessions()).toEqual([]);
        });

        it('refuses a session that is already running', () => {
            remember();
            liveSessions = ['hwip-api'];

            const { reply } = ask();

            expect(reply?.error).toBe('already_running');
            expect(newSessions()).toEqual([]);
        });

        it('reports a tmux that refused to start it', () => {
            remember();
            newSessionFails = true;

            const { reply } = ask();

            expect(reply?.error).toBe('start_failed');
            expect(reply?.resumed).toBeUndefined();
        });
    });

    // Starting a process is the most expensive thing the phone can ask for, so
    // it is charged against the same per-session budget as an injected command
    // — a flood cannot be laundered through the cheaper path either way.
    it('refuses once the session budget is spent', async () => {
        const { checkRateLimit } = await import('./listener.js');
        remember();
        for (let i = 0; i < 40; i++) checkRateLimit('hwip-api', undefined, 4);

        const { reply } = ask();

        expect(reply?.error).toBe('rate_limited');
        expect(newSessions()).toEqual([]);
    });
});

/**
 * Which run of the slot to start. A tmux name can hold a run per agent, so the
 * phone names the row it tapped — and a name it cannot match is refused rather
 * than answered with something else.
 */
describe('agent.session.resume.request — naming the run', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };
    const ask = (over: Record<string, unknown> = {}) => {
        handleSessionResumeRequest(
            { subtype: 'agent.session.resume.request', targetDeviceId: device,
              sessionName: 'hwip-run', requestId: 'r1', ...over },
            send,
        );
        return sent.at(-1);
    };
    const newSessions = () => tmuxCalls.filter((c) => c[0] === 'new-session');

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        // A name of its own: the per-session rate bucket lives for the module,
        // and an earlier test in this file spends `hwip-api`'s.
        rememberSessions([{ name: 'hwip-run', cwd: PROJECT_DIR, agentKind: 'pi', project: 'api' }], Date.now() - 2_000);
        rememberSessions([{ name: 'hwip-run', cwd: PROJECT_DIR, agentKind: 'claude', project: 'api' }], Date.now() - 1_000);
    });
    afterEach(() => vi.restoreAllMocks());

    it('starts the run the request names, not the newest one', () => {
        const reply = ask({ agentKind: 'pi' });

        expect(reply).toMatchObject({ resumed: true });
        expect(newSessions()[0]?.at(-1)).toBe('pi');
    });

    it('refuses a named agent this machine has no record of', () => {
        // Falling back to the newest run here would start claude for a phone
        // that asked for pi — the silent wrong-agent start this path exists to
        // remove. The record can go (TTL, deletion, the row cap) while the
        // phone still shows the row.
        const reply = ask({ agentKind: 'codex' });

        expect(reply?.error).toBe('unknown_session');
        expect(newSessions()).toEqual([]);
    });

    it('starts the newest run when the request names no agent', () => {
        const reply = ask();

        expect(reply).toMatchObject({ resumed: true });
        expect(newSessions()[0]?.at(-1)).toBe('claude');
    });
});

/**
 * Resuming means the conversation, not just the binary. The id comes from the
 * registry — what the sweep read off the live pane — and reaches argv only as
 * a value the agent's own flag takes, after it has been checked to be an id.
 */
describe('agent.session.resume.request — the conversation it last had', () => {
    const device = computeListenerDeviceId();
    const CLAUDE_ID = '0b5f3c8e-1d2a-4c6b-9e7f-123456789abc';
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };
    const ask = () => {
        handleSessionResumeRequest(
            { subtype: 'agent.session.resume.request', targetDeviceId: device,
              sessionName: 'hwip-conv', requestId: 'r1' },
            send,
        );
        return sent.at(-1);
    };
    const remember = (agentKind: string, agentSessionId: string | null) =>
        rememberSessions([{ name: 'hwip-conv', cwd: PROJECT_DIR, agentKind, agentSessionId }]);
    /** What follows `-c <cwd>` in the one new-session call. */
    const launched = () => {
        const call = tmuxCalls.find((c) => c[0] === 'new-session') ?? [];
        return call.slice(call.indexOf('-c') + 2);
    };
    const claudeTranscript = (id: string) => {
        const dir = join(TMP, '.claude', 'projects', claudeProjectDirName(PROJECT_DIR));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
    };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    });
    afterEach(() => vi.restoreAllMocks());

    it('resumes the claude conversation the session last had', () => {
        claudeTranscript(CLAUDE_ID);
        remember('claude', CLAUDE_ID);

        expect(ask()).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude', '--resume', CLAUDE_ID]);
    });

    it('resumes the opencode conversation the session last had', () => {
        remember('opencode', 'ses_3f2a1b');

        expect(ask()).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['opencode', '--session', 'ses_3f2a1b']);
    });

    it('starts a fresh conversation when none was recorded', () => {
        remember('claude', null);

        expect(ask()).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude']);
    });

    it('starts a fresh conversation for an agent with no resume flag', () => {
        remember('pi', 'some-id');

        expect(ask()).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['pi']);
    });

    it('never puts a recorded conversation that is not an id into argv', () => {
        // The registry is a file on disk; a value starting with `-` would be
        // read by the agent as an option, not as the id its flag expects.
        for (const bad of ['-x', '--dangerously-skip-permissions', 'a b', 'x'.repeat(129)]) {
            tmuxCalls = [];
            liveSessions = [];
            rmSync(join(TMP, 'state'), { recursive: true, force: true });
            remember('opencode', bad);

            ask();
            expect(launched()).toEqual(['opencode']);
        }
    });

    it('takes claude’s conversation from the pane’s process, never the newest in its folder', () => {
        // The report may guess the newest transcript in the folder; that guess
        // can be another `claude` in the same directory, so a resume never gets it.
        claudeTranscript(CLAUDE_ID);
        const claude = REMOTE_AGENTS.find((a) => a.kind === 'claude')!;

        expect(claude.resolveSessionId?.(PROJECT_DIR)).toBe(CLAUDE_ID);
        expect(claude.resolveResumeId?.(PROJECT_DIR)).toBeNull();
    });

    it('starts claude fresh when the conversation is no longer on disk', () => {
        // `claude --resume <id>` with no such conversation exits at once — a
        // session reported resumed that is already gone.
        remember('claude', CLAUDE_ID);

        expect(ask()).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude']);
    });
});

/**
 * A run, not just a name: the earlier-runs fold lists each run of a name, and
 * starting one of them again means that run's conversation (docs/session-runs.md
 * Q41–Q46). The run id only selects among runs this machine recorded.
 */
describe('agent.session.resume.request — the run it names', () => {
    const device = computeListenerDeviceId();
    const OLD = '1b5f3c8e-1d2a-4c6b-9e7f-123456789abc';
    const NEW = '2c6f3c8e-1d2a-4c6b-9e7f-123456789abc';
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };
    const ask = (fields: Record<string, unknown>) => {
        handleSessionResumeRequest(
            { subtype: 'agent.session.resume.request', targetDeviceId: device,
              sessionName: 'hwip-runs', agentKind: 'claude', requestId: 'r1', ...fields },
            send,
        );
        return sent.at(-1);
    };
    const launched = () => {
        const call = tmuxCalls.find((c) => c[0] === 'new-session') ?? [];
        return call.slice(call.indexOf('-c') + 2);
    };
    const claudeTranscript = (id: string) => {
        const dir = join(TMP, '.claude', 'projects', claudeProjectDirName(PROJECT_DIR));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
    };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(join(TMP, '.claude'), { recursive: true, force: true });
        claudeTranscript(OLD);
        claudeTranscript(NEW);
        const t0 = Date.now() - 60_000;
        rememberSessions([{ name: 'hwip-runs', cwd: PROJECT_DIR, agentKind: 'claude', runId: '1785542400', agentSessionId: OLD }], t0);
        rememberSessions([{ name: 'hwip-runs', cwd: PROJECT_DIR, agentKind: 'claude', runId: '1785546000', agentSessionId: NEW }], t0 + 1000);
    });
    afterEach(() => vi.restoreAllMocks());

    it('the run it names: starts that run\'s conversation, not the newest', () => {
        expect(ask({ runId: '1785542400' })).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude', '--resume', OLD]);
    });

    it('the run it names: no run id still means the newest run', () => {
        expect(ask({})).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude', '--resume', NEW]);
    });

    it('the run it names: a run id the name never had is refused, not swapped for the newest', () => {
        expect(ask({ runId: '1785549999' })).toMatchObject({ error: 'unknown_session' });
        expect(tmuxCalls.some((c) => c[0] === 'new-session')).toBe(false);
    });

    it('the run it names: a run id without an agent still names that run', () => {
        expect(ask({ agentKind: undefined, runId: '1785542400' })).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude', '--resume', OLD]);
    });

    it('the run it names: a run id without an agent the name never had is refused', () => {
        expect(ask({ agentKind: undefined, runId: '1785549999' })).toMatchObject({ error: 'unknown_session' });
        expect(tmuxCalls.some((c) => c[0] === 'new-session')).toBe(false);
    });

    const startedAs = () => {
        const call = tmuxCalls.find((c) => c[0] === 'new-session') ?? [];
        return call[call.indexOf('-s') + 1];
    };

    it('next free name: a live name with a run id starts that conversation beside it', () => {
        liveSessions = ['hwip-runs'];
        expect(ask({ runId: '1785542400' })).toMatchObject({ resumed: true, sessionName: 'hwip-runs-2' });
        expect(startedAs()).toBe('hwip-runs-2');
        expect(launched()).toEqual(['claude', '--resume', OLD]);
    });

    it('next free name: skips every name of the family that is live', () => {
        liveSessions = ['hwip-runs', 'hwip-runs-2'];
        expect(ask({ runId: '1785542400' })).toMatchObject({ resumed: true, sessionName: 'hwip-runs-3' });
        expect(startedAs()).toBe('hwip-runs-3');
    });

    it('next free name: two resumes in a row do not take the same name', () => {
        liveSessions = ['hwip-runs'];
        expect(ask({ runId: '1785542400' })).toMatchObject({ resumed: true, sessionName: 'hwip-runs-2' });
        expect(ask({ runId: '1785546000' })).toMatchObject({ resumed: true, sessionName: 'hwip-runs-3' });
    });

    it('next free name: counts from the family base, not from a suffixed name', () => {
        rememberSessions([{ name: 'hwip-runs-2', cwd: PROJECT_DIR, agentKind: 'claude', runId: '1785547000', agentSessionId: OLD }]);
        liveSessions = ['hwip-runs', 'hwip-runs-2'];
        expect(ask({ sessionName: 'hwip-runs-2', runId: '1785547000' })).toMatchObject({ resumed: true, sessionName: 'hwip-runs-3' });
    });

    it('next free name: without a run id a live name is still refused', () => {
        liveSessions = ['hwip-runs'];
        expect(ask({})).toMatchObject({ error: 'already_running', sessionName: 'hwip-runs' });
        expect(tmuxCalls.some((c) => c[0] === 'new-session')).toBe(false);
    });

    it('the run it names: a run id that is not one is read as none', () => {
        expect(ask({ runId: '--resume=x' })).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['claude', '--resume', NEW]);
    });
});

/**
 * Agents past claude and opencode, each measured against its real binary
 * (docs/session-runs.md Q42): the id the sweep recorded starts that
 * conversation. codex and pi exit at once on an id they cannot find, so the
 * flag goes on only when the conversation is still on disk; hermes starts a
 * new one instead, the way opencode does.
 */
describe('agent.session.resume.request — an agent that resumes by its id', () => {
    const device = computeListenerDeviceId();
    const UUID = '01a15d37-ca9e-7b12-8ed6-5b974d70f586';
    const CODEX_ID = `rollout-2026-10-21T15-48-19-${UUID}`;
    const PI_ID = `2026-10-21T06-48-52-641Z_${UUID}`;
    const piFile = join(TMP, '.pi', 'agent', 'sessions', `--${PROJECT_DIR.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`, `${PI_ID}.jsonl`);
    let sent: Array<Record<string, unknown>>;
    const ask = (agentKind: string, agentSessionId: string) => {
        rememberSessions([{ name: 'hwip-ids', cwd: PROJECT_DIR, agentKind, agentSessionId }]);
        handleSessionResumeRequest(
            { subtype: 'agent.session.resume.request', targetDeviceId: device,
              sessionName: 'hwip-ids', agentKind, requestId: 'r1' },
            (data) => { sent.push(data); },
        );
        return sent.at(-1);
    };
    const launched = () => {
        const call = tmuxCalls.find((c) => c[0] === 'new-session') ?? [];
        return call.slice(call.indexOf('-c') + 2);
    };
    const write = (path: string) => {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '{}\n');
    };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        rmSync(join(TMP, '.codex'), { recursive: true, force: true });
        rmSync(join(TMP, '.pi'), { recursive: true, force: true });
        // Both stores follow an env override; a machine that sets one would
        // otherwise answer these from its real store.
        vi.stubEnv('CODEX_HOME', '');
        vi.stubEnv('PI_CODING_AGENT_DIR', '');
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('resumes by its id: codex takes the rollout\'s thread id, not its file name', () => {
        write(join(TMP, '.codex', 'sessions', '2026', '10', '21', `${CODEX_ID}.jsonl`));
        expect(ask('codex', CODEX_ID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['codex', 'resume', UUID]);
    });

    it('resumes by its id: codex starts fresh when the rollout is gone', () => {
        expect(ask('codex', CODEX_ID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['codex']);
    });

    it('resumes by its id: pi opens the session file the run wrote', () => {
        write(piFile);
        expect(ask('pi', PI_ID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['pi', '--session', piFile]);
    });

    it('resumes by its id: pi starts fresh when the session file is gone', () => {
        expect(ask('pi', PI_ID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['pi']);
    });

    it('resumes by its id: hermes takes the session id', () => {
        expect(ask('hermes', '20261021_155015_2b41a7')).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['hermes', '--resume', '20261021_155015_2b41a7']);
    });

    it('resumes by its id: the report says resumable exactly when the launch carries the id', () => {
        const rollout = join(TMP, '.codex', 'sessions', '2026', '10', '21', `${CODEX_ID}.jsonl`);
        write(rollout);
        expect(ask('codex', CODEX_ID)).toMatchObject({ resumed: true });
        expect(knownSessionsToReport([])[0]).toMatchObject({ name: 'hwip-ids', resumable: true });
        expect(launched()).toEqual(['codex', 'resume', UUID]);

        rmSync(rollout);
        tmuxCalls = [];
        liveSessions = [];
        expect(knownSessionsToReport([])[0]).toMatchObject({ name: 'hwip-ids', resumable: false });
        expect(ask('codex', CODEX_ID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['codex']);
    });

    it('resumes by its id: gemini, which takes no id, starts fresh', () => {
        expect(ask('gemini', UUID)).toMatchObject({ resumed: true });
        expect(launched()).toEqual(['gemini']);
    });
});
