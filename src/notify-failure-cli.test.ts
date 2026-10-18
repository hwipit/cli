import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyFailurePath, readNotifyFailure, recordNotifyFailure } from './notify-failure.js';
import { withTmpStateDir } from './test-state-dir.js';

// The wiring in cli.ts, driven through the real command dispatch: cli.ts runs
// main() on import, so each case sets argv, imports it fresh and catches the
// process.exit. HOME is a temp dir and no key is set anywhere, and fetch is
// replaced with one that throws — no case can reach a server.

const stateHome = withTmpStateDir('hwip-notify-cli-');
const ENV_KEYS = ['HOME', 'HWIP_API_KEY', 'HWIP_BASE_URL', 'HWIP_HOOK_ID', 'CLAUDE_PROJECT_DIR', 'TMUX'] as const;
const saved: Record<string, string | undefined> = {};
let home = '';
let project = '';

beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    home = mkdtempSync(join(tmpdir(), 'hwip-notify-cli-home-'));
    project = join(home, 'project');
    mkdirSync(project);
    process.env.HOME = home;
    process.env.CLAUDE_PROJECT_DIR = project;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

/** Run `hwip <args>` in-process; resolves with the exit code. */
const runCli = async (...args: string[]): Promise<number> => {
    const originalArgv = process.argv;
    process.argv = ['node', 'hwip', ...args];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
        return await new Promise<number>((resolve) => {
            vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                resolve(code ?? 0);
                return undefined as never;
            }) as typeof process.exit);
            void import('./cli.js');
        });
    } finally {
        process.argv = originalArgv;
    }
};

const muteProject = (): void => {
    const hash = execFileSync('cksum', { input: project, encoding: 'utf-8' }).split(' ')[0];
    mkdirSync(join(stateHome(), 'hwip'), { recursive: true });
    writeFileSync(join(stateHome(), 'hwip', `muted-${hash}`), '');
};

describe('hwip notify writes the record only for a real push attempt', () => {
    it('records no-key when there is no API key', async () => {
        expect(await runCli('notify', '--title', 't', '--body', 'b')).toBe(3);

        expect(readNotifyFailure()?.kind).toBe('no-key');
    });

    it('leaves the record alone on a muted project', async () => {
        recordNotifyFailure({ kind: 'auth', status: 401, code: 'AUTHENTICATION_ERROR' });
        muteProject();

        expect(await runCli('notify', '--title', 't')).toBe(0);

        expect(readNotifyFailure()?.kind).toBe('auth');
    });

    it('leaves the record alone when --auto gates the push out', async () => {
        expect(await runCli('notify', '--auto', '--marker', 'skip', '--pushmode-default', 'normal', '--title', 't')).toBe(0);

        expect(existsSync(notifyFailurePath())).toBe(false);
    });

    it('records a push that could not reach the server', async () => {
        expect(await runCli('notify', '--key', 'ak_test', '--base-url', 'https://api.invalid', '--title', 't')).toBe(1);

        expect(readNotifyFailure()?.kind).toBe('network');
    });

    it('hwip test records no-key too', async () => {
        expect(await runCli('test')).toBe(3);

        expect(readNotifyFailure()?.kind).toBe('no-key');
    });
});

describe('hwip verify shows the record', () => {
    it('prints the failure under Push delivery', async () => {
        recordNotifyFailure({ kind: 'quota', status: 403, code: 'QUOTA_EXCEEDED' }, new Date('2026-10-02T00:00:00Z'));
        const lines: string[] = [];

        const originalArgv = process.argv;
        process.argv = ['node', 'hwip', 'verify'];
        vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await new Promise<void>((resolve) => {
                vi.spyOn(process, 'exit').mockImplementation((() => { resolve(); return undefined as never; }) as typeof process.exit);
                void import('./cli.js');
            });
        } finally {
            process.argv = originalArgv;
        }

        const out = lines.join('\n');
        expect(out).toContain('Push delivery:');
        expect(out).toContain('✗ last push failed at 2026-10-02T00:00:00.000Z: push quota used up (HTTP 403)');
    });
});

// The record a pin replacement leaves (key-changes.ts) is taken only where a person reads stderr.
describe('a recorded key change', () => {
    const RECORD = '{"v":1,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z","name":"iPhone"}]}\n';
    const recordPath = (): string => join(home, '.hwip', 'key-changes.json');
    let restoreTTY: () => void = () => undefined;

    const stderrIsTTY = (isTTY: boolean): void => {
        const before = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
        Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true });
        restoreTTY = () => {
            if (before) Object.defineProperty(process.stderr, 'isTTY', before);
            else delete (process.stderr as { isTTY?: boolean }).isTTY;
        };
    };

    beforeEach(() => {
        mkdirSync(join(home, '.hwip'), { recursive: true });
        writeFileSync(recordPath(), RECORD);
    });
    afterEach(() => restoreTTY());

    it('is left for the plugin when stderr is not a terminal (a hook)', async () => {
        stderrIsTTY(false);
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runCli('notify', '--title', 't');

        expect(existsSync(recordPath())).toBe(true);
        expect(writes.mock.calls.flat().join('')).not.toContain('changed its encryption key');
    });

    it.each(['notify', 'verify', 'trust', 'test', 'ask'])('is shown once and cleared by hwip %s at a terminal', async (command) => {
        stderrIsTTY(true);
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runCli(command);

        expect(existsSync(recordPath())).toBe(false);
        expect(writes.mock.calls.flat().filter((w) => String(w).includes('changed its encryption key'))).toEqual([
            'hwip: iPhone changed its encryption key — the new key is trusted. Not expecting that (app reinstalled?) Check it: hwip trust\n',
        ]);
    });

    it('is not taken by a command that is not one a person reads', async () => {
        stderrIsTTY(true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runCli('list');

        expect(existsSync(recordPath())).toBe(true);
    });
});
