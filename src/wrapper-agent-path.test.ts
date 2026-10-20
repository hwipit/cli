import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAgentDirs } from './agent-dirs.js';
import { LISTENER_LAUNCH_ENV } from './listener-process.js';
import { findAgentBySubcommand } from './remote-agents.js';
import { withTmpStateDir } from './test-state-dir.js';
import { handleAgentSession } from './wrapper.js';

withTmpStateDir('hwip-agent-path-state-');

// A schedule's `hwip cc --detach` runs under the listener's PATH. When the agent is not on it, tmux still creates the
// session and the pane dies at once ("command not found"), which the listener could only report as "not there".
describe('handleAgentSession and the agent on PATH', () => {
    const cc = findAgentBySubcommand('cc')!;
    const env = { PATH: process.env.PATH, TMUX: process.env.TMUX };
    let tmp: string;
    let tools: string;
    let agents: string;
    const errors: string[] = [];

    const put = (dir: string, name: string): void => {
        writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n');
        chmodSync(join(dir, name), 0o755);
    };

    beforeEach(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-agent-path-')));
        tools = join(tmp, 'tools');
        agents = join(tmp, 'agents');
        mkdirSync(tools);
        mkdirSync(agents);
        put(tools, 'tmux');
        process.env.HWIP_NO_UPDATE_CHECK = '1';
        delete process.env.TMUX;
        errors.length = 0;
        vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    });

    afterEach(() => {
        process.env.PATH = env.PATH;
        if (env.TMUX !== undefined) process.env.TMUX = env.TMUX;
        delete process.env[LISTENER_LAUNCH_ENV];
        vi.restoreAllMocks();
        rmSync(tmp, { recursive: true, force: true });
    });

    it('starts no session, and says which program is missing, when a detached agent is not on PATH', async () => {
        process.env.PATH = tools;
        const launch = vi.fn(async () => 0);
        const code = await handleAgentSession(cc, [], { detach: true, label: 'sched-x' }, { startListener: async () => undefined, launch });
        expect(code).toBe(127);
        expect(launch).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain(`'${cc.binary}' not found on PATH`);
    });

    it('writes down where a launch typed in a shell found its agent', async () => {
        put(agents, cc.binary);
        process.env.PATH = `${tools}:${agents}`;
        await handleAgentSession(cc, [], { detach: true, label: 'x' }, { startListener: async () => undefined, launch: async () => 0 });
        expect(withAgentDirs('/usr/bin')).toBe(`/usr/bin:${agents}`);
    });

    it('writes nothing down for a launch the listener made', async () => {
        put(agents, cc.binary);
        process.env.PATH = `${tools}:${agents}`;
        process.env[LISTENER_LAUNCH_ENV] = '1';
        await handleAgentSession(cc, [], { detach: true, label: 'x' }, { startListener: async () => undefined, launch: async () => 0 });
        expect(withAgentDirs('/usr/bin')).toBe('/usr/bin');
    });
});
