import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentDirsPath, rememberAgentDir, withAgentDirs } from './agent-dirs.js';

describe('agent dirs', () => {
    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'hwip-agent-dirs-'));
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = saved;
    });

    it('adds the directory a shell found an agent in to a PATH that lacks it', () => {
        rememberAgentDir('/home/me/.local/bin/claude');
        expect(withAgentDirs('/usr/bin:/bin')).toBe('/usr/bin:/bin:/home/me/.local/bin');
    });

    it('keeps one entry per directory, and leaves a PATH that has it as it is', () => {
        rememberAgentDir('/home/me/.local/bin/claude');
        rememberAgentDir('/home/me/.local/bin/pi');
        rememberAgentDir('/opt/oc/bin/opencode');
        expect(withAgentDirs('/home/me/.local/bin:/usr/bin')).toBe('/home/me/.local/bin:/usr/bin:/opt/oc/bin');
        expect(JSON.parse(readFileSync(agentDirsPath(), 'utf-8'))).toEqual(['/home/me/.local/bin', '/opt/oc/bin']);
    });

    it('is the PATH unchanged when nothing was written down, and a PATH when there was none', () => {
        expect(withAgentDirs('/usr/bin')).toBe('/usr/bin');
        rememberAgentDir('/a/bin/claude');
        expect(withAgentDirs(undefined)).toBe('/a/bin');
    });

    it('ignores a file others can write, and entries that are not absolute directories', () => {
        rememberAgentDir('/a/bin/claude');
        writeFileSync(agentDirsPath(), JSON.stringify(['/a/bin', 'rel/bin', 7, '/b/bin']));
        expect(withAgentDirs('/usr/bin')).toBe('/usr/bin:/a/bin:/b/bin');
        chmodSync(agentDirsPath(), 0o666);
        expect(withAgentDirs('/usr/bin')).toBe('/usr/bin');
    });

    it('writes nothing through a link, nor into a file it would not read back', () => {
        const target = join(process.env.XDG_STATE_HOME!, 'elsewhere');
        writeFileSync(target, 'theirs');
        rememberAgentDir('/a/bin/claude');
        chmodSync(agentDirsPath(), 0o666);
        rememberAgentDir('/b/bin/claude');
        expect(JSON.parse(readFileSync(agentDirsPath(), 'utf-8'))).toEqual(['/a/bin']);
        const linked = mkdtempSync(join(tmpdir(), 'hwip-agent-dirs-link-'));
        process.env.XDG_STATE_HOME = linked;
        mkdirSync(join(linked, 'hwip'));
        symlinkSync(target, agentDirsPath());
        rememberAgentDir('/c/bin/claude');
        expect(readFileSync(target, 'utf-8')).toBe('theirs');
    });

    it('ignores a relative binary path', () => {
        rememberAgentDir('claude');
        expect(withAgentDirs('/usr/bin')).toBe('/usr/bin');
    });
});
