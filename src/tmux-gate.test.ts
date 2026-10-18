import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `hwip cc` / `hwip sh` with no tmux: the install hint, exit 127, and no
// listener started for sessions that could never exist. Nothing here may spawn.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof import('child_process')>();
    const refuse = (cmd: string) => { spawned.push(cmd); throw new Error(`test must not spawn ${cmd}`); };
    return { ...real, spawn: refuse, spawnSync: refuse };
});

let bin: string;
let errors: string[];

beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'hwip-tmux-gate-'));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('TMUX', '');
    spawned.length = 0;
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
});

const CLAUDE = { kind: 'claude', displayName: 'Claude Code', binary: 'claude', subcommands: ['cc', 'claude'] } as never;

describe('tmux gate', () => {
    it('hwip cc exits 127 with the install hint and starts no listener', async () => {
        const { handleAgentSession } = await import('./wrapper.js');

        expect(await handleAgentSession(CLAUDE)).toBe(127);
        expect(errors.join('\n')).toMatch(/^hwip: tmux not found — `hwip cc` needs it\. /);
        expect(spawned).toEqual([]);
    });

    it('hwip sh does the same', async () => {
        const { handleShellSession } = await import('./wrapper.js');

        expect(await handleShellSession({})).toBe(127);
        expect(errors.join('\n')).toContain('`hwip sh` needs it');
        expect(spawned).toEqual([]);
    });
});

describe('resolveCommand without `which`', () => {
    // Minimal images have no `which`; tmux on PATH was then "not found".
    it('finds a command on PATH by walking it', async () => {
        const tmux = join(bin, 'tmux');
        writeFileSync(tmux, '#!/bin/sh\n');
        chmodSync(tmux, 0o755);
        const { resolveCommand } = await import('./agents.js');

        expect(resolveCommand('tmux')).toBe(tmux);
        expect(resolveCommand('nope')).toBeNull();
    });
});
