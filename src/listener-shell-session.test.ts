import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * `hwip sh` sessions in the inventory sweep. tmux is faked: each pane row
 * carries the session's `@hwip_shell` option as the 15th field, the way the
 * sweep's `list-panes -F` asks for it.
 */
const FIELD_SEP = '␟';
const TMP = mkdtempSync(join(tmpdir(), 'hwip-shell-session-'));
process.env.XDG_STATE_HOME = join(TMP, 'state');

interface FakePane {
    session: string;
    paneId: string;
    current: string;
    start: string;
    project?: string;
    sessionLabel?: string;
    /** true = the marker names this session (`hwip sh`); a string = a foreign value, as a `set -g` would leave. */
    shell?: boolean | string;
}

let panes: FakePane[] = [];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-panes') {
        const rows = panes.map((p) =>
            [p.session, '0', '1700000000', '1700000000', '0', '0', p.paneId, p.current, p.start, '/tmp/proj', '1234',
                '', p.project ?? '', p.sessionLabel ?? '', p.shell === true ? p.session : p.shell || ''].join(FIELD_SEP));
        return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: '$ \n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const listener = await import('./listener.js');
const { recallSession } = await import('./session-registry.js');

describe('hwip sh sessions in the sweep', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        listener.resetSessionStates();
        panes = [
            { session: 'hwip-app', paneId: '%0', current: 'node', start: 'claude', project: 'app' },
            { session: 'hwip-app-sh', paneId: '%1', current: 'zsh', start: '/bin/zsh -l', project: 'app', sessionLabel: 'sh', shell: true },
        ];
    });
    afterEach(() => vi.restoreAllMocks());

    it('reports a marked session as `shell`, grouped under its project, with its pane pinned', () => {
        const result = listener.collectSessionsVerbose();
        const shell = result.sessions.find((s) => s.name === 'hwip-app-sh');
        expect(shell).toMatchObject({ agentKind: 'shell', project: 'app', label: 'sh' });
        expect(result.targets['hwip-app-sh']).toBe('%1');
        expect(result.rejected).toEqual([]);
    });

    it('never reports an unmarked hwip session at a shell as `shell`', () => {
        panes = [
            // An agent that exited: still its agent kind (start command), and the inject guard refuses it.
            { session: 'hwip-app', paneId: '%0', current: 'zsh', start: 'claude' },
            // A plain shell someone named hwip-*: no agent, no marker — rejected as before.
            { session: 'hwip-plain', paneId: '%1', current: 'zsh', start: 'zsh' },
            // A marker inherited from `set -g @hwip_shell 1` names no session: not marked.
            { session: 'hwip-global', paneId: '%2', current: 'zsh', start: 'zsh', shell: '1' },
        ];
        const result = listener.collectSessionsVerbose();
        expect(result.sessions.map((s) => [s.name, s.agentKind])).toEqual([['hwip-app', 'claude']]);
        expect(result.rejected.map((r) => r.name)).toEqual(['hwip-plain', 'hwip-global']);
    });

    // No state: the server arms a completion push on working → idle and a
    // `gone` push on exit, and a shell going quiet is not news (user, 2026-09-27).
    it('stays `shell` while a program runs in it, and reports no state', () => {
        panes[1] = { ...panes[1], current: 'claude' };
        const shell = listener.collectSessionsVerbose().sessions.find((s) => s.name === 'hwip-app-sh');
        expect(shell?.agentKind).toBe('shell');
        expect(shell).not.toHaveProperty('state');
    });

    // A shell is not resumable: the resume path starts a registered agent
    // binary, and the phone must never be offered a dead shell to revive.
    it('is never written to the known-sessions registry', () => {
        listener.collectSessionsVerbose();
        expect(recallSession('hwip-app')).toMatchObject({ agentKind: 'claude' });
        expect(recallSession('hwip-app-sh')).toBeNull();
    });
});
