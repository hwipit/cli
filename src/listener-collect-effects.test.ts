import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a `collectSessionsVerbose` sweep leaves behind besides its result
 * (improve-architecture candidate #4, the part `listener-collect-sessions.test.ts`
 * does not reach): the per-session state it keeps between sweeps, the fallback
 * labels of subagent panes, and what it writes to the registry.
 *
 * Characterization, one behavior per test. tmux is faked at `spawnSync`; the
 * foreground-agent lookup is answered from a ps table built out of the fake panes,
 * the way `listener-subagent.test.ts` does it, so no real `ps` or tmux runs.
 * "Fresh" state is read off `stateChangedAt`: a session whose state entry survived
 * keeps the time it was first seen, one whose entry was dropped starts over.
 */
const FIELD_SEP = '␟';
const TMP = mkdtempSync(join(tmpdir(), 'hwip-collect-effects-'));
// The in-process subagent scan walks a real `$HOME/.claude/projects` tree (see listener-subagent-transcript.test.ts).
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
delete process.env.HWIP_TMUX_SOCKET;

vi.mock('./remote-agents.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./remote-agents.js')>();
    let table: import('./remote-agents.js').ProcTable | null = null;
    return {
        ...actual,
        foregroundAgentFor: (pid: number) => actual.foregroundAgentFor(pid, table),
        __setProcTable: (t: import('./remote-agents.js').ProcTable | null) => {
            table = t;
        },
    };
});

interface FakePane {
    session: string;
    paneId: string;
    idx: number;
    current: string;
    start: string;
    pid: number;
    path?: string;
    /** @hwip_pane_label — what a subagent sets on its own pane. */
    label?: string;
    project?: string;
    sessionLabel?: string;
    /** The `comm` of the process holding the pane's tty foreground; none = a plain prompt. */
    fg?: string;
    /** The session's `@hwip_shell` option, as the 15th field. */
    shell?: boolean;
}

let panes: FakePane[] = [];
let listPanesFails = false;
let unreadable = new Set<string>();

let nextPid = 1000;
/** The main pane of an agent session: `claude` is what the sweep detects. */
const main = (session: string, extra: Partial<FakePane> = {}): FakePane => ({
    session, paneId: '%0', idx: 0, current: 'node', start: 'claude', pid: (nextPid += 10), ...extra,
});
/** A split pane whose foreground process group runs `fg`, the way a subagent pane does. */
const sub = (session: string, paneId: string, fg: string, extra: Partial<FakePane> = {}): FakePane => ({
    session, paneId, idx: Number(paneId.slice(1)), current: 'bash', start: 'zsh', pid: (nextPid += 10), fg, ...extra,
});

/** `ps -axo pid=,ppid=,pgid=,tpgid=,lstart=,comm=` rows: a login zsh, and `fg` running in its own foreground group. */
const psTable = (): string =>
    panes
        .filter((p) => p.fg)
        .flatMap((p) => [
            `  ${p.pid}     1   ${p.pid}   ${p.pid + 5} Fri Aug  7 11:12:59 2026 zsh`,
            `  ${p.pid + 1}   ${p.pid}   ${p.pid + 5}   ${p.pid + 5} Fri Aug  7 11:12:59 2026 ${p.fg}`,
        ])
        .join('\n');

const rowOf = (p: FakePane): string =>
    [p.session, '0', '1700000000', '1700000000', '0', String(p.idx), p.paneId, p.current, p.start, p.path ?? '/tmp/proj',
        String(p.pid), p.label ?? '', p.project ?? '', p.sessionLabel ?? '', p.shell ? p.session : ''].join(FIELD_SEP);

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd !== 'tmux') return { status: 1, stdout: '', stderr: '' };
            const a = args?.[0] === '-S' ? args.slice(2) : (args ?? []);
            if (a[0] === 'list-panes') {
                if (listPanesFails) return { status: 1, stdout: panes.map(rowOf).join('\n') + '\n', stderr: 'no server running' };
                return { status: 0, stdout: panes.map(rowOf).join('\n') + '\n', stderr: '' };
            }
            if (a[0] === 'capture-pane') {
                return unreadable.has(a[a.indexOf('-t') + 1])
                    ? { status: 1, stdout: '', stderr: "can't find pane" }
                    : { status: 0, stdout: '$ \n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        },
    };
});

const listener = await import('./listener.js');
const remoteAgents = (await import('./remote-agents.js')) as typeof import('./remote-agents.js') & {
    __setProcTable: (t: import('./remote-agents.js').ProcTable | null) => void;
};
const { recallSession } = await import('./session-registry.js');

const sweep = () => {
    remoteAgents.__setProcTable(remoteAgents.parseProcTable(psTable()));
    return listener.collectSessionsVerbose();
};
const byName = (name: string) => sweep().sessions.find((s) => s.name === name);
const iso = (ms: number): string => new Date(ms).toISOString();

const T0 = Date.parse('2026-10-09T01:00:00Z');
const HOUR = 3_600_000;

/**
 * A Claude Code parent transcript for a pane running in `cwd`, plus subagent files beside it. Files that are
 * already there stay, so a later call adds a subagent to the ones an earlier sweep saw. `ageSec` is how long
 * before the (frozen) clock the subagent last wrote: the scan numbers the most recent first.
 */
const writeSubagents = (cwd: string, agents: Array<{ id: string; ageSec: number }>): void => {
    const projectDir = join(TMP, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
    const sessionId = '962a64bb-b1bd-4a4c-9ce5-d4bab12e1567';
    const dir = join(projectDir, sessionId, 'subagents');
    mkdirSync(dir, { recursive: true });
    const launch = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] } };
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify(launch)}\n`);
    for (const { id, ageSec } of agents) {
        const file = join(dir, `agent-${id}.jsonl`);
        writeFileSync(file, `${JSON.stringify({ type: 'assistant', isSidechain: true })}\n`);
        utimesSync(file, (T0 - ageSec * 1000) / 1000, (T0 - ageSec * 1000) / 1000);
    }
};
/** Which subagent file each in-process subagent name points at, after one sweep. */
const numbered = (): Record<string, string> =>
    Object.fromEntries(Object.entries(sweep().subagentTranscripts).map(([name, path]) => [name, /agent-(\w+)\.jsonl$/.exec(path)?.[1] ?? path]));

describe('collectSessionsVerbose — what a sweep keeps and writes', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        listener.resetSessionStates();
        panes = [];
        listPanesFails = false;
        unreadable = new Set();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('the state it keeps between sweeps', () => {
        it('keeps a session’s state across sweeps while the session stays', () => {
            panes = [main('hwip-st-stay')];
            expect(byName('hwip-st-stay')?.stateChangedAt).toBe(iso(T0));
            vi.setSystemTime(T0 + HOUR);
            expect(byName('hwip-st-stay')?.stateChangedAt).toBe(iso(T0));
        });

        it('starts a session over when it comes back after a sweep that did not list it', () => {
            panes = [main('hwip-st-gone')];
            sweep();
            panes = [];
            vi.setSystemTime(T0 + HOUR);
            sweep();
            panes = [main('hwip-st-gone')];
            vi.setSystemTime(T0 + 2 * HOUR);
            expect(byName('hwip-st-gone')?.stateChangedAt).toBe(iso(T0 + 2 * HOUR));
        });

        // The session is still in tmux but no longer an agent session (the agent exited into a shell).
        it('starts a session over when it was only rejected in between', () => {
            panes = [main('hwip-st-rej')];
            sweep();
            panes = [main('hwip-st-rej', { current: 'zsh', start: 'zsh' })];
            vi.setSystemTime(T0 + HOUR);
            expect(sweep().rejected.map((r) => r.name)).toEqual(['hwip-st-rej']);
            panes = [main('hwip-st-rej')];
            vi.setSystemTime(T0 + 2 * HOUR);
            expect(byName('hwip-st-rej')?.stateChangedAt).toBe(iso(T0 + 2 * HOUR));
        });

        it('keeps the state of a subagent pane too, not only of the main session', () => {
            panes = [main('hwip-st-sub'), sub('hwip-st-sub', '%5', 'pi')];
            expect(byName('hwip-st-sub.5')?.stateChangedAt).toBe(iso(T0));
            vi.setSystemTime(T0 + HOUR);
            expect(byName('hwip-st-sub.5')?.stateChangedAt).toBe(iso(T0));
        });

        it('reports no state for a session whose pane cannot be read', () => {
            panes = [main('hwip-st-cap')];
            unreadable = new Set(['%0']);
            const s = byName('hwip-st-cap');
            expect(s).toBeDefined();
            expect(s?.state).toBeUndefined();
            expect(s?.stateChangedAt).toBeUndefined();
        });

        it('starts a session over when one capture of its pane failed in between', () => {
            panes = [main('hwip-st-cap2')];
            sweep();
            unreadable = new Set(['%0']);
            vi.setSystemTime(T0 + HOUR);
            sweep();
            unreadable = new Set();
            vi.setSystemTime(T0 + 2 * HOUR);
            expect(byName('hwip-st-cap2')?.stateChangedAt).toBe(iso(T0 + 2 * HOUR));
        });
    });

    describe('the label of a subagent pane', () => {
        const labels = (session: string): Array<[string, string | undefined]> =>
            sweep().sessions.filter((s) => s.parentName === session).map((s) => [s.name, s.label]);

        it('falls back to the agent’s name and a number', () => {
            panes = [main('hwip-lb-one'), sub('hwip-lb-one', '%1', 'pi')];
            expect(labels('hwip-lb-one')).toEqual([['hwip-lb-one.1', 'Pi 1']]);
        });

        // Panes are numbered by pane id as a number: `%10` is newer than `%9`, whatever string order says.
        it('numbers panes by pane id as a number, not as text', () => {
            panes = [main('hwip-lb-ord'), sub('hwip-lb-ord', '%10', 'pi'), sub('hwip-lb-ord', '%9', 'pi'), sub('hwip-lb-ord', '%2', 'pi')];
            expect(labels('hwip-lb-ord')).toEqual([
                ['hwip-lb-ord.2', 'Pi 1'],
                ['hwip-lb-ord.9', 'Pi 2'],
                ['hwip-lb-ord.10', 'Pi 3'],
            ]);
        });

        it('lets a pane that named itself keep its own label', () => {
            panes = [main('hwip-lb-own'), sub('hwip-lb-own', '%1', 'pi', { label: 'Scout' })];
            expect(labels('hwip-lb-own')).toEqual([['hwip-lb-own.1', 'Scout']]);
        });

        // The next unnamed pane is "Pi 2", not "Pi 1": the number counts panes of that agent, not unnamed ones.
        it('counts a pane that named itself when numbering the ones that did not', () => {
            panes = [main('hwip-lb-cnt'), sub('hwip-lb-cnt', '%1', 'pi', { label: 'Scout' }), sub('hwip-lb-cnt', '%2', 'pi')];
            expect(labels('hwip-lb-cnt')).toEqual([['hwip-lb-cnt.1', 'Scout'], ['hwip-lb-cnt.2', 'Pi 2']]);
        });

        it('treats a label of only spaces as no label', () => {
            panes = [main('hwip-lb-ws'), sub('hwip-lb-ws', '%1', 'pi', { label: '   ' })];
            expect(labels('hwip-lb-ws')).toEqual([['hwip-lb-ws.1', 'Pi 1']]);
        });

        it('numbers each agent on its own', () => {
            panes = [
                main('hwip-lb-kind'),
                sub('hwip-lb-kind', '%1', 'pi'),
                sub('hwip-lb-kind', '%2', 'claude'),
                sub('hwip-lb-kind', '%3', 'pi'),
            ];
            expect(labels('hwip-lb-kind').map(([, l]) => l)).toEqual(['Pi 1', 'Claude Code 1', 'Pi 2']);
        });

        it('starts at 1 again in every session', () => {
            panes = [
                main('hwip-lb-s1'), sub('hwip-lb-s1', '%1', 'pi'),
                main('hwip-lb-s2', { paneId: '%2' }), sub('hwip-lb-s2', '%3', 'pi'),
            ];
            const result = sweep();
            expect(result.sessions.filter((s) => s.parentName).map((s) => s.label)).toEqual(['Pi 1', 'Pi 1']);
        });
    });

    // The scan remembers which number each in-process subagent got. Numbers are handed out most recent first,
    // so a scan that was kept shows in the order: the older subagent keeps its number, the newer one comes after.
    describe('the numbers of in-process subagents', () => {
        it('are handed out again from 1 when the session left in between', () => {
            panes = [main('hwip-sc-left', { path: '/tmp/sc-left' })];
            writeSubagents('/tmp/sc-left', [{ id: 'aaaa', ageSec: 120 }]);
            expect(numbered()).toEqual({ 'hwip-sc-left.1': 'aaaa' });
            panes = [];
            sweep();
            writeSubagents('/tmp/sc-left', [{ id: 'bbbb', ageSec: 10 }]);
            panes = [main('hwip-sc-left', { path: '/tmp/sc-left' })];
            expect(numbered()).toEqual({ 'hwip-sc-left.1': 'bbbb', 'hwip-sc-left.2': 'aaaa' });
        });

        it('are kept when the session was only rejected in between', () => {
            panes = [main('hwip-sc-rej', { path: '/tmp/sc-rej' })];
            writeSubagents('/tmp/sc-rej', [{ id: 'aaaa', ageSec: 120 }]);
            expect(numbered()).toEqual({ 'hwip-sc-rej.1': 'aaaa' });
            panes = [main('hwip-sc-rej', { path: '/tmp/sc-rej', current: 'zsh', start: 'zsh' })];
            sweep();
            writeSubagents('/tmp/sc-rej', [{ id: 'bbbb', ageSec: 10 }]);
            panes = [main('hwip-sc-rej', { path: '/tmp/sc-rej' })];
            expect(numbered()).toEqual({ 'hwip-sc-rej.1': 'aaaa', 'hwip-sc-rej.2': 'bbbb' });
        });
    });

    describe('what it writes to the registry', () => {
        it('does not remember a subagent pane', () => {
            panes = [main('hwip-rg-sub'), sub('hwip-rg-sub', '%5', 'pi')];
            expect(sweep().sessions.map((s) => s.name)).toContain('hwip-rg-sub.5');
            expect(recallSession('hwip-rg-sub')).not.toBeNull();
            expect(recallSession('hwip-rg-sub.5')).toBeNull();
        });

        it('does not remember a shell session', () => {
            panes = [main('hwip-rg-sh', { current: 'zsh', start: 'zsh', project: 'rg', sessionLabel: 'sh', shell: true })];
            expect(sweep().sessions.map((s) => s.agentKind)).toEqual(['shell']);
            expect(recallSession('hwip-rg-sh')).toBeNull();
        });

        it('does not remember a session it rejected', () => {
            panes = [main('hwip-rg-rej', { current: 'zsh', start: 'zsh' })];
            expect(sweep().rejected.map((r) => r.name)).toEqual(['hwip-rg-rej']);
            expect(recallSession('hwip-rg-rej')).toBeNull();
        });

        it('keeps a session after it ended — that is what a resume reads', () => {
            panes = [main('hwip-rg-end', { path: '/tmp/rg-end' })];
            sweep();
            panes = [];
            sweep();
            expect(recallSession('hwip-rg-end')).toMatchObject({ cwd: '/tmp/rg-end' });
        });

        it('writes nothing from a sweep tmux did not answer', () => {
            panes = [main('hwip-rg-fail')];
            listPanesFails = true;
            expect(sweep().sessions).toEqual([]);
            expect(recallSession('hwip-rg-fail')).toBeNull();
        });

        it('does not remember a session whose pane directory is unreadable', () => {
            panes = [main('hwip-rg-nocwd', { path: '' })];
            expect(sweep().sessions.map((s) => s.name)).toEqual(['hwip-rg-nocwd']);
            expect(recallSession('hwip-rg-nocwd')).toBeNull();
        });
    });
});
