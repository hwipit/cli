import { describe, expect, it } from 'vitest';
import { LISTENER_LAUNCH_ENV } from './listener-process.js';
import { launchHwip, type LaunchDeps } from './schedule-launch.js';
import { LAUNCH_TIMEOUT_MS, LAUNCH_WT_TIMEOUT_MS } from './schedule-runner.js';

type Exec = NonNullable<LaunchDeps['execFile']>;
type Done = (err: Error | null, stdout: string, stderr: string) => void;

const fakeExec = (outcome: { err: Error | null; stderr: string }) => {
    const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
    const execFile = ((file: string, args: string[], options: Record<string, unknown>, done: Done) => {
        calls.push({ file, args, options });
        done(outcome.err, '', outcome.stderr);
    }) as unknown as Exec;
    return { calls, execFile };
};

describe('launchHwip', () => {
    it('runs node on the cli with the arguments as they are, in the schedule directory, with a timeout', async () => {
        const { calls, execFile } = fakeExec({ err: null, stderr: '' });
        const result = await launchHwip(['cc', '--detach', '--label', 'x', '; rm -rf ~'], '/work/app', LAUNCH_TIMEOUT_MS, { execFile, cliPath: () => '/cli.js', env: {} });
        expect(result).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.file).toBe(process.execPath);
        expect(calls[0]!.args).toEqual(['/cli.js', 'cc', '--detach', '--label', 'x', '; rm -rf ~']);
        expect(calls[0]!.options).toMatchObject({ cwd: '/work/app', timeout: LAUNCH_TIMEOUT_MS });
    });

    it('gives up after the timeout it is told, so a worktree launch can be given longer', async () => {
        const { calls, execFile } = fakeExec({ err: null, stderr: '' });
        await launchHwip(['cc', '--wt', 'feat/x'], '/work/app', LAUNCH_WT_TIMEOUT_MS, { execFile, cliPath: () => '/cli.js', env: {} });
        expect(calls[0]!.options.timeout).toBe(LAUNCH_WT_TIMEOUT_MS);
    });

    it('drops the project-dir variables of the shell that started the listener and says the child is the listener\'s own', async () => {
        const { calls, execFile } = fakeExec({ err: null, stderr: '' });
        await launchHwip(['cc'], '/work/app', LAUNCH_TIMEOUT_MS, {
            execFile,
            cliPath: () => '/cli.js',
            env: { CLAUDE_PROJECT_DIR: '/elsewhere', CURSOR_PROJECT_DIR: '/elsewhere', WINDSURF_PROJECT_DIR: '/elsewhere', HOME: '/home/me' },
        });
        const env = calls[0]!.options.env as NodeJS.ProcessEnv;
        expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
        expect(env.CURSOR_PROJECT_DIR).toBeUndefined();
        expect(env.WINDSURF_PROJECT_DIR).toBeUndefined();
        expect(env.HOME).toBe('/home/me');
        expect(env[LISTENER_LAUNCH_ENV]).toBe('1');
    });

    it('puts the directories the person\'s shell found agents in on the child\'s PATH', async () => {
        const { calls, execFile } = fakeExec({ err: null, stderr: '' });
        await launchHwip(['cc'], '/w', LAUNCH_TIMEOUT_MS, { execFile, cliPath: () => '/cli.js', env: { PATH: '/usr/bin' }, agentPath: (path) => `${path}:/home/me/.local/bin` });
        expect((calls[0]!.options.env as NodeJS.ProcessEnv).PATH).toBe('/usr/bin:/home/me/.local/bin');
    });

    it('is a failure with the child\'s stderr when it exits non-zero, else with the error message', async () => {
        const withStderr = fakeExec({ err: new Error('Command failed'), stderr: 'claude: command not found' });
        expect(await launchHwip(['cc'], '/w', LAUNCH_TIMEOUT_MS, { execFile: withStderr.execFile, cliPath: () => '/cli.js' })).toEqual({ ok: false, error: 'claude: command not found' });
        const without = fakeExec({ err: new Error('spawn ENOENT'), stderr: '' });
        expect(await launchHwip(['cc'], '/w', LAUNCH_TIMEOUT_MS, { execFile: without.execFile, cliPath: () => '/cli.js' })).toEqual({ ok: false, error: 'spawn ENOENT' });
    });

    it('is a failure, and runs nothing, when the cli entry cannot be found', async () => {
        const { calls, execFile } = fakeExec({ err: null, stderr: '' });
        expect(await launchHwip(['cc'], '/w', LAUNCH_TIMEOUT_MS, { execFile, cliPath: () => null })).toEqual({ ok: false, error: 'cannot find the hwip cli entry' });
        expect(calls).toEqual([]);
    });
});
