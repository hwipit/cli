import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAgentBySubcommand } from './remote-agents.js';
import { withTmpStateDir } from './test-state-dir.js';
import { LISTENER_LAUNCH_ENV } from './listener-process.js';
import { handleAgentSession, type SpawnTarget } from './wrapper.js';

withTmpStateDir('hwip-wt-launch-state-');

// `hwip cc --wt x --detach` as far as the launch: the real worktree and the real argv, with the listener
// and tmux themselves replaced (a fake `tmux` and a fake agent on PATH only get the checks for "is it installed" past).
describe('handleAgentSession --wt', () => {
    const cc = findAgentBySubcommand('cc')!;
    let tmp: string;
    let main: string;
    let cwd: string;
    const env = { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, TMUX: process.env.TMUX };

    beforeEach(() => {
        cwd = process.cwd();
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-wt-launch-')));
        main = join(tmp, 'app');
        execFileSync('git', ['init', '-q', main]);
        execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
        const bin = join(tmp, 'bin');
        execFileSync('mkdir', [bin]);
        for (const name of ['tmux', cc.binary]) {
            writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
            chmodSync(join(bin, name), 0o755);
        }
        process.env.PATH = `${bin}:${env.PATH}`;
        process.env.HWIP_NO_UPDATE_CHECK = '1';
        delete process.env.TMUX;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.chdir(cwd);
        process.env.PATH = env.PATH;
        if (env.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = env.CLAUDE_PROJECT_DIR;
        if (env.TMUX !== undefined) process.env.TMUX = env.TMUX;
        vi.restoreAllMocks();
        rmSync(tmp, { recursive: true, force: true });
    });

    it('starts the session in the new worktree, named for it, even with CLAUDE_PROJECT_DIR on the repo', async () => {
        process.env.CLAUDE_PROJECT_DIR = main;
        process.chdir(main);
        const wt = join(tmp, 'app-wt-feat-x');
        let cwdAtListenerStart = '';
        const launched: SpawnTarget[] = [];

        const code = await handleAgentSession(cc, [], { detach: true, worktree: 'feat/x' }, {
            startListener: async () => { cwdAtListenerStart = process.cwd(); },
            launch: async (target) => { launched.push(target); return 0; },
        });

        expect(code).toBe(0);
        expect(launched).toHaveLength(1);
        expect(launched[0]).toMatchObject({ kind: 'tmux-detached', cmd: 'tmux', session: 'hwip-app-wt-feat-x' });
        expect(launched[0]!.args.slice(0, 6)).toEqual(['new', '-d', '-s', 'hwip-app-wt-feat-x', '-c', wt]);
        expect(launched[0]!.args).toContain('@hwip_session_label');
        expect(launched[0]!.args[launched[0]!.args.indexOf('@hwip_project') + 1]).toBe('app');
        expect(realpathSync(process.cwd())).toBe(wt);
        // A daemon started from here would inherit the cwd, and that daemon is the one that removes the directory later.
        expect(realpathSync(cwdAtListenerStart)).toBe(main);
    });

    it('starts nothing, and says why, when the worktree is refused', async () => {
        process.chdir(main);
        const startListener = vi.fn(async () => undefined);
        const launch = vi.fn(async () => 0);

        const code = await handleAgentSession(cc, [], { detach: true, worktree: 'a..b' }, { startListener, launch });

        expect(code).toBe(2);
        expect(startListener).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith("hwip: 'a..b' is not a valid branch name");
    });

    // A scheduled launch carries the listener's marker; the git hooks `git worktree add` runs must not inherit it.
    it('has used up the listener-launch marker before git runs for --wt', async () => {
        const seen = join(tmp, 'marker-seen-by-hook');
        const hook = join(main, '.git', 'hooks', 'post-checkout');
        writeFileSync(hook, `#!/bin/sh\nprintf '%s' "\${${LISTENER_LAUNCH_ENV}-unset}" > '${seen}'\n`);
        chmodSync(hook, 0o755);
        process.chdir(main);
        process.env[LISTENER_LAUNCH_ENV] = '1';
        const startListener = vi.fn(async () => undefined);
        try {
            const code = await handleAgentSession(cc, [], { detach: true, worktree: 'feat/y' }, { startListener, launch: async () => 0 });
            expect(code).toBe(0);
            expect(readFileSync(seen, 'utf8')).toBe('unset');
            expect(process.env[LISTENER_LAUNCH_ENV]).toBeUndefined();
        } finally {
            delete process.env[LISTENER_LAUNCH_ENV];
        }
    });
});
