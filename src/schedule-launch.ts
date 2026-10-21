/**
 * Runs `hwip <agent> --detach …` for a scheduled session, as a child of the listener (F8). The child gets the schedule's
 * directory as its cwd and none of the project-dir env vars, so it resolves its project from that directory and not from
 * whatever shell once started the listener; and it is told it is the listener's own, so it does not "repair" the listener
 * that is running it (see `LISTENER_LAUNCH_ENV`). Its PATH also gets the directories the person's shell found agents in
 * (agent-dirs.ts): the service's own PATH has none of them.
 */

import { execFile as nodeExecFile } from 'child_process';
import { withAgentDirs } from './agent-dirs.js';
import { PROJECT_DIR_ENV_VARS } from './config.js';
import { LISTENER_LAUNCH_ENV, resolveCliPath } from './listener-process.js';
import type { LaunchResult } from './schedule-runner.js';

export interface LaunchDeps {
    execFile?: typeof nodeExecFile;
    cliPath?: () => string | null;
    env?: NodeJS.ProcessEnv;
    agentPath?: (path: string | undefined) => string;
}

export const launchHwip = (argv: string[], cwd: string, timeoutMs: number, deps: LaunchDeps = {}): Promise<LaunchResult> =>
    new Promise((resolve) => {
        const cliPath = (deps.cliPath ?? resolveCliPath)();
        if (!cliPath) return resolve({ ok: false, error: 'cannot find the hwip cli entry' });
        const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), [LISTENER_LAUNCH_ENV]: '1' };
        for (const key of PROJECT_DIR_ENV_VARS) delete env[key];
        env.PATH = (deps.agentPath ?? withAgentDirs)(env.PATH);
        (deps.execFile ?? nodeExecFile)(process.execPath, [cliPath, ...argv], { cwd, env, encoding: 'utf-8', timeout: timeoutMs }, (err, _stdout, stderr) => {
            resolve(err ? { ok: false, error: stderr || err.message } : { ok: true });
        });
    });
