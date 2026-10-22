import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkoutOf } from './config.js';
import { agentLaunchEnv, detectProjectDir, detectProjectName, handOffExec, herdrEnvArgs, herdrSessionArgs, installedTmuxVersion, inPaneNote, planShellSession, tmuxMissingMessage, readShellSessionState, sanitizeLabel, shellTargets, sessionSidecarArgs, splitAgentOptions, targetForAgent, tmuxSessionName } from './wrapper.js';
import type { ProcessHandOff } from './wrapper.js';

// TMUX is in here for two reasons: targetForAgent branches on it, and a
// developer running the suite from inside tmux would otherwise have it set
// ambiently and fail every "outside tmux" case.
const ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR', 'TMUX', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] as const;
const originalEnv: Record<string, string | undefined> = {};
let originalCwd: string;

beforeEach(() => {
    for (const k of ENV_KEYS) {
        originalEnv[k] = process.env[k];
        delete process.env[k];
    }
    originalCwd = process.cwd();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (originalEnv[k] === undefined) delete process.env[k];
        else process.env[k] = originalEnv[k];
    }
    process.chdir(originalCwd);
});

describe('tmuxSessionName', () => {
    it('prefixes with hwip-', () => {
        expect(tmuxSessionName('myapp')).toBe('hwip-myapp');
    });

    // tmux 3.5a creates `hwip-foo.bar` as `hwip-foo_bar`; every `-t =<name>`
    // after that (sidecar, marker, probe) must use the name tmux holds.
    it('writes the name the way tmux stores it', () => {
        expect(tmuxSessionName('foo.bar')).toBe('hwip-foo_bar');
        expect(tmuxSessionName('a:b;c')).toBe('hwip-a_b_c');
    });
});

describe('detectProjectName', () => {
    it('uses CLAUDE_PROJECT_DIR basename when set', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project';
        expect(detectProjectName()).toBe('my-project');
    });

    it('strips trailing slashes from env path', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project/';
        expect(detectProjectName()).toBe('my-project');
    });

    it('CLAUDE_PROJECT_DIR wins over CURSOR_PROJECT_DIR', () => {
        process.env.CLAUDE_PROJECT_DIR = '/a/claude';
        process.env.CURSOR_PROJECT_DIR = '/b/cursor';
        expect(detectProjectName()).toBe('claude');
    });

    it('falls back to CURSOR_PROJECT_DIR when CLAUDE is unset', () => {
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-proj';
        expect(detectProjectName()).toBe('cursor-proj');
    });

    it('falls back to WINDSURF_PROJECT_DIR when neither claude nor cursor is set', () => {
        process.env.WINDSURF_PROJECT_DIR = '/work/wind-proj';
        expect(detectProjectName()).toBe('wind-proj');
    });

    it('falls back to cwd basename when no env is set and not a git repo', () => {
        // /tmp is not a git repo on most CI / dev boxes — git rev-parse fails,
        // and detectProjectName drops to cwd basename.
        process.chdir('/tmp');
        expect(detectProjectName()).toBe('tmp');
    });
});

describe('targetForAgent', () => {
    // Inside tmux the wrapper must not open a nested session — the listener
    // can't reach a session it didn't name, and nested prefixes are confusing.
    it('runs the agent in the current pane when already inside tmux', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        expect(targetForAgent('claude', ['--resume'])).toEqual({ kind: 'direct', cmd: 'claude', args: ['--resume'] });
    });

    it('opens a named tmux session when outside tmux', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-target-probe';
        const { kind, cmd, args } = targetForAgent('claude', []);
        expect(kind).toBe('tmux-new');
        expect(cmd).toBe('tmux');
        expect(args.slice(0, 4)).toEqual(['new', '-A', '-s', 'hwip-hwip-target-probe']);
    });

    // tmux joins trailing argv into one shell-command, so passthrough args are
    // quoted into a single string rather than passed as separate argv entries.
    it('shell-quotes passthrough args that carry spaces or quotes', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-quote-probe';
        const shellCmd = targetForAgent('claude', ['--resume', 'a b']).args.find((a) => a.startsWith('claude'));
        expect(shellCmd).toBe("claude --resume 'a b'");
    });

    it('leaves shell-safe args unquoted', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-plain-probe';
        const shellCmd = targetForAgent('claude', ['--resume']).args.find((a) => a.startsWith('claude'));
        expect(shellCmd).toBe('claude --resume');
    });

    // Claude Code's fullscreen renderer keeps its transcript off tmux's scrollback, where the phone pages history.
    it('starts Claude Code on the classic renderer, in a pane or a new session', () => {
        delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        expect(targetForAgent('claude', [], 'claude')).toEqual({
            kind: 'direct', cmd: 'claude', args: [], env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
        });
        delete process.env.TMUX;
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-classic-probe';
        const { args } = targetForAgent('claude', [], 'claude');
        const at = args.indexOf('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1');
        expect(args[at - 1]).toBe('-e');
        expect(at).toBeLessThan(args.indexOf('claude'));
        expect(targetForAgent('pi', [], 'pi', { detach: true }).args.join(' ')).not.toContain('CLAUDE_CODE');
    });

    it('keeps a renderer choice the launching shell made', () => {
        expect(agentLaunchEnv('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' })).toEqual({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' });
        expect(agentLaunchEnv('opencode', {})).toEqual({});
    });

    // `--label` pins the name: the caller wants this exact session next to
    // the user's own `hwip pi`, not a slot in the -2/-3 family.
    it('--label names the session hwip-<project>-<label> and skips the family scan', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        const { kind, args } = targetForAgent('pi', ['-n', 'x'], 'pi', { label: '20260914-PLAN-11-32-44-pi' });
        expect(kind).toBe('tmux-new');
        expect(args.slice(0, 4)).toEqual(['new', '-A', '-s', 'hwip-pi-config-20260914-PLAN-11-32-44-pi']);
    });

    // `-d` needs no TTY and fails loudly on a taken name; `-c` pins the cwd
    // because the tmux server's default-path is wherever it was first started.
    it('--detach creates the session without attaching, in the current directory', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        const { kind, cmd, args } = targetForAgent('pi', ['/skill:02-implement a.md'], 'pi', { detach: true, label: 'impl' });
        expect(kind).toBe('tmux-detached');
        expect(cmd).toBe('tmux');
        expect(args).toEqual(['new', '-d', '-s', 'hwip-pi-config-impl', '-c', '/work/pi-config',
            ...herdrEnvArgs('pi', {}, installedTmuxVersion()), "pi '/skill:02-implement a.md'",
            ';', 'set-option', '-t', '=hwip-pi-config-impl:', '@hwip_project', 'pi-config', ';', 'set-option', '-t', '=hwip-pi-config-impl:', '@hwip_session_label', 'impl']);
    });

    // `new -d` only creates, so the reuse candidate `findAvailableSession`
    // prefers (a detached session) would just fail on the name.
    it('--detach without a label takes a name no live session holds', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-detach-free-probe';
        const { kind, session } = targetForAgent('pi', [], 'pi', { detach: true });
        expect(kind).toBe('tmux-detached');
        expect(session).toBe('hwip-hwip-detach-free-probe');
    });

    it('the target carries its session name instead of leaving it to argv position', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { label: 'impl' }).session).toBe('hwip-pi-config-impl');
        expect(targetForAgent('pi', [], 'pi').session).toMatch(/^hwip-pi-config/);
    });

    // A label asks for a named session; the in-pane shortcut would drop it silently.
    // CLAUDE_PROJECT_DIR is read before the directory, so a worktree made for the session has to be handed in.
    it('a worktree names the session and sets the cwd, whatever CLAUDE_PROJECT_DIR says', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/app';
        const { args, session } = targetForAgent('claude', [], 'claude', { detach: true, projectDir: '/work/app-wt-feat-x' });
        expect(session).toBe('hwip-app-wt-feat-x');
        expect(args.slice(0, 6)).toEqual(['new', '-d', '-s', 'hwip-app-wt-feat-x', '-c', '/work/app-wt-feat-x']);
    });

    it('--label inside tmux still opens a tmux session', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { label: 'impl' }).kind).toBe('tmux-new');
    });

    // A Claude Code session launching the implementer runs inside tmux itself;
    // a detached launch never nests, so the direct-run shortcut must not fire.
    it('--detach still opens a tmux session when already inside tmux', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { detach: true, label: 'impl' }).kind).toBe('tmux-detached');
    });
});

describe('inPaneNote', () => {
    // Inside tmux the agent ran in the current pane with no word that the
    // listener — which reports only hwip-* sessions — would never show it.
    it('names --detach and running outside tmux for a pane the phone cannot see', () => {
        expect(inPaneNote('cc', 'main')).toBe(
            "hwip: running in this tmux pane, which the phone can't see — for a session it can, use `hwip cc --detach` or run outside tmux",
        );
        expect(inPaneNote('codex', null)).toContain('`hwip codex --detach`');
    });

    it('stays quiet in a hwip-* session, which the phone already sees', () => {
        expect(inPaneNote('cc', 'hwip-api-2')).toBeUndefined();
    });
});

describe('tmuxMissingMessage', () => {
    // A missing tmux used to come out as "'tmux' not found on PATH", after the
    // listener had already been started for sessions that could never exist.
    it.each([
        ['a command it can run', { kind: 'command', run: ['brew', 'install', 'tmux'], label: 'brew install tmux' }, 'Run: brew install tmux'],
        ['a manual step', { kind: 'manual', hint: 'sudo apt install tmux' }, 'sudo apt install tmux'],
    ] as const)('gives the install hint for %s', (_, plan, fix) => {
        expect(tmuxMissingMessage('cc', plan)).toBe(`hwip: tmux not found — \`hwip cc\` needs it. ${fix}`);
    });

    it('says nothing when tmux is there', () => {
        expect(tmuxMissingMessage('cc', { kind: 'present', path: '/usr/bin/tmux' })).toBeUndefined();
    });
});

describe('hwip sh: planShellSession / readShellSessionState', () => {
    const targets = (opts: { detach?: boolean } = {}) => {
        process.env.CLAUDE_PROJECT_DIR = '/tmp/app';
        return shellTargets('/bin/zsh', opts, false);
    };
    const marker = [';', 'set-option', '-t', '=hwip-app-sh:', '@hwip_shell', 'hwip-app-sh'];

    // `new -A` from inside tmux nests and exits 1 after the session already
    // exists, leaving a live shell behind an error. Inside tmux, never attach.
    it('does not attach from inside tmux, and does for a plain terminal', () => {
        process.env.CLAUDE_PROJECT_DIR = '/tmp/app';
        expect(shellTargets('/bin/zsh', {}, true).attach).toBeNull();
        expect(shellTargets('/bin/zsh', {}, false).attach?.args).toEqual(['attach-session', '-t', '=hwip-app-sh']);
        expect(shellTargets('/bin/zsh', { detach: true }, false).attach).toBeNull();
        expect(shellTargets('/bin/zsh', { label: 'ops' }, true).create.session).toBe('hwip-app-ops');
    });

    it('names the session for the project with the sh label, even from inside tmux', () => {
        process.env.TMUX = '/tmp/tmux-501/default,1,0';
        const { create, attach } = targets();
        expect([create.session, attach?.session]).toEqual(['hwip-app-sh', 'hwip-app-sh']);
    });

    // `new -d` fails on a taken name, so a session that appeared since the
    // probe is never attached to and marked. Every option names its session:
    // an untargeted `set-option` run from inside tmux lands on the caller's.
    it('creates a missing session detached, marker targeted at it, then attaches', () => {
        const { create, attach } = targets();
        const plan = planShellSession(create, attach, 'none');
        expect(plan).toEqual({ kind: 'create', args: [...create.args, ...marker], attach });
        expect(create.args.slice(0, 2)).toEqual(['new', '-d']);
        expect(create.args).not.toContain('-A');
    });

    it('creates and stops there for --detach', () => {
        const { create, attach } = targets({ detach: true });
        expect(planShellSession(create, attach, 'none')).toEqual({ kind: 'create', args: [...create.args, ...marker], attach: null });
    });

    it('reattaches its own shell session without creating or marking anything', () => {
        const { create, attach } = targets();
        expect(planShellSession(create, attach, 'marked')).toEqual({ kind: 'attach', target: attach });
    });

    // `!hwip sh --detach` from the phone is the bootstrap: running it twice must not fail.
    it('treats a detached launch of an existing shell session as done', () => {
        const { create, attach } = targets({ detach: true });
        expect(planShellSession(create, attach, 'marked')).toEqual({ kind: 'running' });
    });

    // Attaching would hand the user someone else's session, and marking it
    // would turn an agent session (or anything else) into a typable shell.
    it('refuses a session of that name that hwip sh did not open', () => {
        const { create, attach } = targets();
        expect(planShellSession(create, attach, 'unmarked')).toEqual({
            kind: 'refuse',
            reason: 'hwip-app-sh exists and is not a hwip sh session — pick another --label',
        });
    });

    describe('readShellSessionState', () => {
        const fakeTmux = (answers: { hasSession: number; shellOption?: string }) => {
            const calls: string[][] = [];
            const run = (args: string[]) => {
                calls.push(args);
                return args[0] === 'has-session'
                    ? { status: answers.hasSession, stdout: '' }
                    : { status: 0, stdout: `${answers.shellOption ?? ''}\n` };
            };
            return { calls, run };
        };

        it('is none when tmux has no session of that exact name', () => {
            const { calls, run } = fakeTmux({ hasSession: 1 });
            expect(readShellSessionState('hwip-app-sh', run)).toBe('none');
            expect(calls).toEqual([['has-session', '-t', '=hwip-app-sh']]);
        });

        // tmux 3.5a: `show-options -t =name` answers nothing — it reads the
        // target as a pane — and only `=name:` gives the session's own value.
        it('is marked when the session\'s own option names it, read without inheritance', () => {
            const { calls, run } = fakeTmux({ hasSession: 0, shellOption: 'hwip-app-sh' });
            expect(readShellSessionState('hwip-app-sh', run)).toBe('marked');
            expect(calls[1]).toEqual(['show-options', '-qv', '-t', '=hwip-app-sh:', '@hwip_shell']);
        });

        it('is unmarked with no option, or a value that is not its own name', () => {
            for (const shellOption of ['', '1', 'hwip-other-sh']) {
                expect(readShellSessionState('hwip-app-sh', fakeTmux({ hasSession: 0, shellOption }).run), shellOption).toBe('unmarked');
            }
        });
    });
});

describe('herdrSessionArgs', () => {
    const herdr = {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'wF:p1',
        HERDR_SOCKET_PATH: '/Users/u/.config/herdr/herdr.sock',
        HERDR_BIN_PATH: '/Users/u/.local/bin/herdr',
    };

    it('points the session at the herdr pane it is attached from', () => {
        expect(herdrSessionArgs('hwip-app', herdr)).toEqual([
            ';', 'set-option', '-t', '=hwip-app:', '@hwip_herdr_pane', 'wF:p1',
            ';', 'set-option', '-t', '=hwip-app:', '@hwip_herdr_socket', '/Users/u/.config/herdr/herdr.sock',
            ';', 'set-option', '-t', '=hwip-app:', '@hwip_herdr_bin', '/Users/u/.local/bin/herdr',
        ]);
    });

    // A reattach from a plain terminal must not leave a running agent reporting
    // to a herdr pane that now holds something else.
    it('clears every option outside herdr', () => {
        const unset = [
            ';', 'set-option', '-u', '-t', '=hwip-app:', '@hwip_herdr_pane',
            ';', 'set-option', '-u', '-t', '=hwip-app:', '@hwip_herdr_socket',
            ';', 'set-option', '-u', '-t', '=hwip-app:', '@hwip_herdr_bin',
        ];
        expect(herdrSessionArgs('hwip-app', {})).toEqual(unset);
        expect(herdrSessionArgs('hwip-app', { ...herdr, HERDR_ENV: '0' })).toEqual(unset);
        expect(herdrSessionArgs('hwip-app', { ...herdr, HERDR_PANE_ID: '' })).toEqual(unset);
    });

    it('clears an option herdr did not set', () => {
        const { HERDR_BIN_PATH: _, ...noBin } = herdr;
        expect(herdrSessionArgs('hwip-app', noBin).slice(-6)).toEqual([';', 'set-option', '-u', '-t', '=hwip-app:', '@hwip_herdr_bin']);
    });

    it('rides on the attaching launch', () => {
        const { args } = targetForAgent('claude', []);
        expect(args).toContain('@hwip_herdr_pane');
    });
});

// The agent's own env names its herdr pane for herdr's native integrations. Under tmux
// that env is the server's global one — the long-closed pane that started the server.
describe('herdrEnvArgs', () => {
    const herdr = {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'wF:p1',
        HERDR_SOCKET_PATH: '/Users/u/.config/herdr/herdr.sock',
        HERDR_BIN_PATH: '/Users/u/.local/bin/herdr',
        HERDR_TAB_ID: 'wF:t1',
        HERDR_WORKSPACE_ID: 'wF',
        HERDR_STARTUP_CWD: '/Users/u',
    };
    const env = (values: Record<string, string>): string[] => Object.entries(values).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const blank = env(Object.fromEntries(Object.keys(herdr).map((k) => [k, ''])));

    it('hands the attaching herdr pane to an agent herdr reports natively', () => {
        expect(herdrEnvArgs('codex', herdr, 'tmux 3.5a')).toEqual(env(herdr));
    });

    // hwip reports these itself; a second source on the same pane replaces hwip's label,
    // and its release drops both (measured, herdr 0.9.3).
    it('blanks the pane for an agent hwip reports itself', () => {
        expect(herdrEnvArgs('claude', herdr, 'tmux 3.5a')).toEqual(blank);
        expect(herdrEnvArgs('pi', herdr, 'tmux 3.5a')).toEqual(blank);
    });

    it('blanks the pane outside herdr', () => {
        expect(herdrEnvArgs('codex', {}, 'tmux 3.5a')).toEqual(blank);
        expect(herdrEnvArgs('codex', { ...herdr, HERDR_ENV: '0' }, 'tmux 3.5a')).toEqual(blank);
    });

    it('passes nothing to a tmux older than 3.2, which has no new-session -e', () => {
        expect(herdrEnvArgs('codex', herdr, 'tmux 3.1c')).toEqual([]);
        expect(herdrEnvArgs('codex', herdr, 'tmux 2.9a')).toEqual([]);
        expect(herdrEnvArgs('codex', herdr, '')).toEqual([]);
    });

    it('reads development builds as new enough', () => {
        expect(herdrEnvArgs('codex', herdr, 'tmux next-3.7')).toEqual(env(herdr));
        expect(herdrEnvArgs('codex', herdr, 'tmux master')).toEqual(env(herdr));
        expect(herdrEnvArgs('codex', herdr, 'tmux 3.10')).toEqual(env(herdr));
    });

    // Right before the shell command: tmux reads flags only up to it.
    it('rides on both launches, ahead of the shell command', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/hwip-herdr-env-probe';
        const before = (args: string[], n: number) => args.slice(args.indexOf('codex') - n, args.indexOf('codex'));
        const attached = herdrEnvArgs('codex', process.env, installedTmuxVersion());
        expect(before(targetForAgent('codex', [], 'codex').args, attached.length)).toEqual(attached);
        const detached = herdrEnvArgs('codex', {}, installedTmuxVersion());
        expect(before(targetForAgent('codex', [], 'codex', { detach: true, label: 'x' }).args, detached.length)).toEqual(detached);
    });
});

// A real repo and a linked worktree: what `git rev-parse` answers inside one
// is the whole question, and a stub would only restate the assumption.
describe('checkoutOf / sessionSidecarArgs', () => {
    let tmp: string;
    let main: string;
    let wt: string;
    let loose: string;
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

    beforeEach(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-wt-')));
        main = join(tmp, 'ko-qmd');
        wt = join(tmp, 'ko-qmd-wt-feat-x');
        // Claude Code's own worktrees live under the repo and are not named for it.
        loose = join(main, '.claude', 'worktrees', 'feature-y');
        execFileSync('git', ['init', '-q', main]);
        git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
        git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
        git(main, 'worktree', 'add', '-q', loose, '-b', 'feat/y');
    });

    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    it('names every checkout of a repo for its main checkout, and says which are linked', () => {
        expect(checkoutOf(main)).toEqual({ key: 'ko-qmd', linked: false, root: main });
        expect(checkoutOf(wt)).toEqual({ key: 'ko-qmd', linked: true, root: main });
        expect(checkoutOf(loose)).toEqual({ key: 'ko-qmd', linked: true, root: main });
        expect(checkoutOf(join(wt, '.git', '..'))).toEqual({ key: 'ko-qmd', linked: true, root: main });
    });

    // A git without `--path-format` echoes the unknown flag
    // back as a line and exits 0, shifting every answer by one.
    it('is null when git answers with anything but three absolute paths', () => {
        const echoed = (answer: string) => () => answer;
        expect(checkoutOf(main, echoed(`--path-format=absolute\n${main}\n.git\n.git\n`))).toBeNull();
        expect(checkoutOf(main, echoed(`${main}\n.git\n.git\n`))).toBeNull();
        expect(checkoutOf(main, echoed(''))).toBeNull();
    });

    // A bare-repo layout or a submodule has no `.git` checkout to be named
    // for; its worktrees stand as their own projects, as before.
    it('does not call a worktree linked when the repo has no main checkout', () => {
        const bare = join(tmp, 'repo.git');
        const bareWt = join(tmp, 'bare-wt');
        execFileSync('git', ['clone', '-q', '--bare', main, bare]);
        git(bare, 'worktree', 'add', '-q', bareWt, '-b', 'feat/z');
        expect(checkoutOf(bareWt)).toEqual({ key: 'bare-wt', linked: false, root: null });
        expect(sessionSidecarArgs('hwip-bare-wt', bareWt)).toEqual([]);
    });

    it('is null outside git', () => {
        expect(checkoutOf(tmp)).toBeNull();
        expect(checkoutOf(join(tmp, 'missing'))).toBeNull();
    });

    it('a worktree session named for its repo groups under it with the rest as the label', () => {
        expect(sessionSidecarArgs('hwip-ko-qmd-wt-feat-x', wt)).toEqual(
            [';', 'set-option', '-t', '=hwip-ko-qmd-wt-feat-x:', '@hwip_project', 'ko-qmd', ';', 'set-option', '-t', '=hwip-ko-qmd-wt-feat-x:', '@hwip_session_label', 'wt-feat-x']);
    });

    it('a worktree session with a name of its own groups under the repo with that name as the label', () => {
        expect(sessionSidecarArgs('hwip-feature-y', loose)).toEqual(
            [';', 'set-option', '-t', '=hwip-feature-y:', '@hwip_project', 'ko-qmd', ';', 'set-option', '-t', '=hwip-feature-y:', '@hwip_session_label', 'feature-y']);
    });

    it('a labelled session groups under its project', () => {
        expect(sessionSidecarArgs('hwip-ko-qmd-wt-feat-x-plan-pi', wt, 'plan-pi')).toEqual(
            [';', 'set-option', '-t', '=hwip-ko-qmd-wt-feat-x-plan-pi:', '@hwip_project', 'ko-qmd', ';', 'set-option', '-t', '=hwip-ko-qmd-wt-feat-x-plan-pi:', '@hwip_session_label', 'plan-pi']);
        expect(sessionSidecarArgs('hwip-ko-qmd-plan-pi', main, 'plan-pi')).toEqual(
            [';', 'set-option', '-t', '=hwip-ko-qmd-plan-pi:', '@hwip_project', 'ko-qmd', ';', 'set-option', '-t', '=hwip-ko-qmd-plan-pi:', '@hwip_session_label', 'plan-pi']);
        expect(sessionSidecarArgs('hwip-loose-plan-pi', join(tmp, 'loose'), 'plan-pi')).toEqual(
            [';', 'set-option', '-t', '=hwip-loose-plan-pi:', '@hwip_project', 'loose', ';', 'set-option', '-t', '=hwip-loose-plan-pi:', '@hwip_session_label', 'plan-pi']);
    });

    // The name already says it all; no options keeps these sessions reported exactly as before.
    it('adds nothing for a plain session in the main checkout or outside git', () => {
        expect(sessionSidecarArgs('hwip-ko-qmd-2', main)).toEqual([]);
        expect(sessionSidecarArgs('hwip-ko-qmd', main)).toEqual([]);
        expect(sessionSidecarArgs('hwip-scratch', join(tmp, 'scratch'))).toEqual([]);
    });
});

describe('splitAgentOptions', () => {
    it('reads --detach and --label off the front and leaves the agent args alone', () => {
        expect(splitAgentOptions(['--detach', '--label', 'impl', '-n', 'x', '/skill:simplify'])).toEqual({
            opts: { detach: true, label: 'impl' },
            rest: ['-n', 'x', '/skill:simplify'],
        });
        expect(splitAgentOptions(['--label=impl', '--resume'])).toEqual({ opts: { label: 'impl' }, rest: ['--resume'] });
    });

    it('stops at the first agent arg — a later --detach belongs to the agent', () => {
        expect(splitAgentOptions(['--resume', '--detach'])).toEqual({ opts: {}, rest: ['--resume', '--detach'] });
        expect(splitAgentOptions([])).toEqual({ opts: {}, rest: [] });
    });

    it('rejects an empty or flag-shaped label instead of naming the session hwip-<project>-', () => {
        expect(splitAgentOptions(['--label', '', 'x']).error).toMatch(/empty/);
        expect(splitAgentOptions(['--label=  ']).error).toMatch(/empty/);
        expect(splitAgentOptions(['--label', '--detach']).error).toMatch(/needs a value/);
        expect(splitAgentOptions(['--label']).error).toMatch(/needs a value/);
    });
});

describe('splitAgentOptions --wt', () => {
    it('reads --wt <name> and --wt=<name> off the front, the branch name untouched', () => {
        expect(splitAgentOptions(['--wt', 'feat/x', '--detach', '--resume'])).toEqual({
            opts: { worktree: 'feat/x', detach: true },
            rest: ['--resume'],
        });
        expect(splitAgentOptions(['--wt=a..b', '--label', 'l'])).toEqual({ opts: { worktree: 'a..b', label: 'l' }, rest: [] });
    });

    it('leaves a later --wt to the agent', () => {
        expect(splitAgentOptions(['--resume', '--wt', 'x'])).toEqual({ opts: {}, rest: ['--resume', '--wt', 'x'] });
    });

    it('rejects a missing, empty or flag-shaped name', () => {
        expect(splitAgentOptions(['--wt']).error).toMatch(/--wt needs a value/);
        expect(splitAgentOptions(['--wt', '--detach']).error).toMatch(/--wt needs a value/);
        expect(splitAgentOptions(['--wt', '']).error).toMatch(/--wt must not be empty/);
        expect(splitAgentOptions(['--wt=  ']).error).toMatch(/--wt must not be empty/);
    });

    it("does not take Claude Code's own --worktree", () => {
        expect(splitAgentOptions(['--worktree', 'x'])).toEqual({ opts: {}, rest: ['--worktree', 'x'] });
    });
});

describe('sanitizeLabel', () => {
    it('turns what tmux forbids in a session name into dashes', () => {
        expect(sanitizeLabel(' PLAN-11.32:44 ')).toBe('PLAN-11-32-44');
        // tmux reads an argv element ending in `;` as a command separator.
        expect(sanitizeLabel('x;')).toBe('x-');
    });
});

describe('detectProjectDir', () => {
    it('is the directory the session name comes from — env first, then cwd outside a repo', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project/';
        expect(detectProjectDir()).toBe('/Users/me/code/my-project');
        delete process.env.CLAUDE_PROJECT_DIR;
        process.chdir('/tmp');
        expect(detectProjectDir()).toBe(process.cwd());
    });
});

describe('handOffExec', () => {
    // A stand-in for process.execve, which the real signature types as never-
    // returning — a stub cannot honour that, so the cast is the whole fake.
    const execve = ((): never => { throw new Error('execve stub'); }) as ProcessHandOff;
    const env = { TERM: 'xterm-256color', PATH: '/usr/bin' };
    const tmuxNew = { env, kind: 'tmux-new' as const, stdinTTY: true, stdoutTTY: true };
    // The same stand-in, recording what it was called with before it throws.
    const recording = () => {
        const calls: unknown[][] = [];
        const spy = ((...a: unknown[]): never => { calls.push(a); throw new Error('execve stub'); }) as ProcessHandOff;
        return { calls, spy };
    };

    // The wrapper otherwise sits resident for the whole session doing nothing
    // but waiting on tmux. Handing the process over deletes it outright.
    it('never hands off a detached launch — the wrapper returns after tmux answers', () => {
        expect(handOffExec({ execve, env, kind: 'tmux-detached', stdinTTY: true, stdoutTTY: true })).toBeNull();
    });

    it('returns the exec when execve exists and both streams are a terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew })).not.toBeNull();
    });

    // node 22.15.1 execs with an empty environment when the env argument is
    // omitted, and tmux without TERM cannot open the terminal.
    it('passes the environment to execve explicitly', () => {
        const { calls, spy } = recording();
        expect(() => handOffExec({ execve: spy, ...tmuxNew })?.('/usr/bin/tmux', ['tmux', 'new'])).toThrow('execve stub');
        expect(calls).toEqual([['/usr/bin/tmux', ['tmux', 'new'], env]]);
    });

    // node <22.15 and Windows have no execve — those keep the spawn+wait path.
    it('refuses without execve', () => {
        expect(handOffExec({ execve: undefined, ...tmuxNew })).toBeNull();
    });

    // Losing stdout would lose whatever ensureListenerRunning printed: execve
    // runs no cleanup, and only a TTY is written synchronously on POSIX.
    it('refuses when stdout is not a terminal, whichever target it is', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdoutTTY: false })).toBeNull();
        expect(handOffExec({ execve, env, kind: 'direct', stdinTTY: true, stdoutTTY: false })).toBeNull();
    });

    // `tmux new` needs a terminal to attach to — that failure is the one the
    // spawn+wait path exists to explain, so it must not be handed off.
    it('refuses a tmux target without a stdin terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdinTTY: false })).toBeNull();
    });

    // Running the agent in the pane we are already in attaches nothing, so
    // stdin being a pipe is not this decision's business.
    it('hands off a direct target even without a stdin terminal', () => {
        const { calls, spy } = recording();
        const handOff = handOffExec({ execve: spy, env, kind: 'direct', stdinTTY: undefined, stdoutTTY: true });
        expect(() => handOff?.('/usr/bin/claude', ['claude'])).toThrow('execve stub');
        expect(calls).toEqual([['/usr/bin/claude', ['claude'], env]]);
    });

    // process.stdin.isTTY is `undefined`, not false, when stdin is a pipe.
    it('treats an undefined isTTY as not a terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdinTTY: undefined })).toBeNull();
    });
});
