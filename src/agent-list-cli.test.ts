import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `agent list` and `agent read` only read, so they are safe to run for real here: no config, no API key, a dead base URL and a PATH
// without tmux. It must answer on its own (never exit 3 for a missing key) and keep stdout to one JSON object.
let dir: string;
let bundle: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-agent-list-'));
    bundle = join(dir, 'cli.cjs');
    buildSync({
        entryPoints: [resolve(__dirname, 'cli.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        outfile: bundle,
        logLevel: 'silent',
    });
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [bundle, ...args], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 20_000,
        env: {
            HOME: dir,
            PATH: dirname(process.execPath),
            NODE_PATH: resolve(__dirname, '..', 'node_modules'),
            HWIP_BASE_URL: 'http://127.0.0.1:9',
        },
    });

describe('hwip agent list', () => {
    it('needs no API key: with no tmux it answers NO_TMUX as one JSON object, exit 1 (not 3)', () => {
        const result = runCli('agent', 'list', '--json');

        expect(result.status).toBe(1);
        const lines = result.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual({ v: 1, error: 'NO_TMUX', message: expect.stringContaining('tmux') });
    });

    it('says the same in text on stderr, nothing on stdout', () => {
        const result = runCli('agent', 'list');

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('no tmux server answered');
    });

    it('refuses a stray word as a usage error', () => {
        const result = runCli('agent', 'list', 'extra');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage: hwip agent list [--all] [--json]');
    });
    // Every machine is the server's device list, so --all is the one form that needs the key.
    it('lists every machine only with an API key: exit 3 without', () => {
        expect(runCli('agent', 'list', '--all', '--json').status).toBe(3);
    });

    it('answers LIST_FAILED for every machine when the server cannot be reached, as one JSON object, exit 1', () => {
        const result = runCli('--key', 'hwip_test_key', 'agent', 'list', '--all', '--json');

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout.trim())).toEqual({ v: 1, error: 'LIST_FAILED', message: expect.stringContaining('device list') });
    });
});

describe('hwip agent read', () => {
    it('needs a session word, and refuses one that looks like a flag, exit 2', () => {
        for (const args of [['agent', 'read'], ['agent', 'read', '--json']]) {
            const result = runCli(...args);
            expect(result.status, args.join(' ')).toBe(2);
            expect(result.stderr).toContain('Usage: hwip agent read <session>');
        }
        expect(runCli('agent', 'read', '--', '-x').status).toBe(2);
    });

    // `--all` belongs to `agent list`: the flag table is shared, so read refuses it rather than ignore it.
    it('refuses --all as a usage error, exit 2', () => {
        const result = runCli('agent', 'read', 'hwip-x', '--all');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--all');
    });

    it('refuses --all on agent send too, before any key is needed, exit 2', () => {
        const result = runCli('agent', '--all=true', 'send', 'hwip-x', 'hi');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--all');
    });

    it('refuses --turns on agent send, exit 2', () => {
        const result = runCli('agent', '--turns', '3', 'send', 'hwip-x', 'hi');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--turns');
    });

    it('takes --turns as a whole number from 1 to 20 only, exit 2', () => {
        for (const turns of ['0', '21', 'abc', '2.5', '-1']) {
            const result = runCli('agent', 'read', 'hwip-x', '--turns', turns);
            expect(result.status, turns).toBe(2);
            expect(result.stderr).toContain('--turns');
        }
    });

    it('names a key of another machine OTHER_DEVICE as one JSON object, exit 1, with no key and no tmux', () => {
        const result = runCli('agent', 'read', 'dev_listener_00000000:hwip-x', '--json');

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout.trim())).toEqual({ v: 1, error: 'OTHER_DEVICE', message: expect.stringContaining('this machine') });
    });

    it('answers NO_TMUX when tmux does not answer, exit 1 (not 3)', () => {
        const result = runCli('agent', 'read', 'hwip-x', '--json');

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout.trim())).toEqual({ v: 1, error: 'NO_TMUX', message: expect.any(String) });
    });
});
