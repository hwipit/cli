import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// cli.ts runs `main()` when it is loaded, so the help gate can only be seen by
// running the CLI. Only commands that stay harmless if the gate breaks are run
// here: with no config, no API key and a dead base URL, `notify` and `test` can
// do nothing but print an error. Never add uninstall, login, listener, install
// or an agent subcommand — a broken gate would run them for real.
let dir: string;
let bundle: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-help-'));
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

describe('help flags stop the command', () => {
    it.each([
        ['notify', '--help'],
        ['notify', '-h'],
        ['notify', '--title', 'x', '--help'],
        ['test', '--help'],
        ['-h', 'send', 'x', 'hi'],
        ['send', '--help', 'hi'],
        ['-h', 'agent', 'send', 'x', 'hi'],
        ['agent', 'send', '--help', 'hi'],
        ['agent', '--help'],
        ['help', 'agent'],
        ['schedule', '--help'],
        ['help', 'schedule'],
        ['ask-context', '--help'],
        ['help', 'ask-context'],
        ['file-view', '--help'],
        ['help', 'file-view'],
    ].map((args) => [args.join(' '), args] as const))('hwip %s prints the usage and exits 0', (_, args) => {
        const result = runCli(...args);

        expect(result.stdout).toContain('Usage: hwip');
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });

    // Nothing here can reach the network: no key, and a usage error comes first.
    it.each([[['agent']], [['agent', 'sned', 'x', 'hi']]])('hwip %s is a usage error, not a send', (args) => {
        const result = runCli(...args);

        expect(result.stderr).toContain('hwip agent: subcommands are send, list');
        expect(result.status).toBe(2);
    });

    // Through the real argument parser, which gives a missing word as '' — and with HOME in a temp folder, so the switch files stay there.
    it('hwip ask-context says on with no subcommand, and keeps its switch for the next run', () => {
        expect(runCli('ask-context')).toMatchObject({ status: 0, stdout: 'ask context: on\n' });
        expect(runCli('ask-context', '--json')).toMatchObject({ status: 0, stdout: 'ask context: on\n' });

        expect(runCli('ask-context', 'off')).toMatchObject({ status: 0, stdout: 'ask context: off (turned off for this project)\n' });
        expect(runCli('ask-context', 'status').stdout).toBe('ask context: off (turned off for this project)\n');

        // The project switch from above is still set, and it is read before the global one.
        expect(runCli('ask-context', 'off', '--global').stdout).toBe('ask context: off (turned off for this project)\n');
        expect(runCli('ask-context', 'on').stdout).toBe('ask context: off (turned off for every project)\n');
        expect(runCli('ask-context', 'on', '--global').stdout).toBe('ask context: on\n');
    });

    it('hwip ask-context show prints one JSON line: what a question asked here would carry, or why not', () => {
        // A temp folder in no repository, outside tmux: on, and nothing to carry.
        expect(runCli('ask-context', 'show')).toMatchObject({ status: 0, stdout: '{"context":null}\n', stderr: '' });

        runCli('ask-context', 'off');
        expect(runCli('ask-context', 'show')).toMatchObject({ status: 0, stdout: '{"context":null,"off":"project"}\n' });
        runCli('ask-context', 'on');

        expect(runCli('ask-context', 'show', '--global')).toMatchObject({ status: 2, stdout: '' });
    });

    // Through the real argument parser, with HOME in a temp folder so the switch files stay there.
    it('hwip file-view says on with no subcommand, and keeps its switch for the next run', () => {
        expect(runCli('file-view')).toMatchObject({ status: 0, stdout: 'file view: on\n' });
        expect(runCli('file-view', 'off')).toMatchObject({ status: 0, stdout: 'file view: off (turned off for this project)\n' });
        expect(runCli('file-view', 'status').stdout).toBe('file view: off (turned off for this project)\n');
        expect(runCli('file-view', 'off', '--global').stdout).toBe('file view: off (turned off for this project)\n');
        expect(runCli('file-view', 'on').stdout).toBe('file view: off (turned off for every project)\n');
        expect(runCli('file-view', 'on', '--global').stdout).toBe('file view: on\n');
        // The switch is its own: ask-context stayed on through all of it.
        expect(runCli('ask-context').stdout).toBe('ask context: on\n');
    });

    it('hwip file-view log with no listener log says there is nothing on record', () => {
        const result = runCli('file-view', 'log');
        expect(result).toMatchObject({ status: 0, stderr: '' });
        expect(result.stdout).toMatch(/^file view: no reads on record\n\(only a listener started by hwip cc or as a service writes /);
    });

    it('hwip file-view log fails, and does not say there are no reads, when the listener log cannot be read', () => {
        // A directory where the log should be: it is there, and reading it fails.
        mkdirSync(join(dir, '.hwip', 'listener.log'), { recursive: true });
        try {
            const result = runCli('file-view', 'log');
            expect(result.status).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('could not read the listener log');
        } finally {
            rmSync(join(dir, '.hwip'), { recursive: true, force: true });
        }
    });

    it('hwip file-view refuses --global with log, and an unknown subcommand', () => {
        expect(runCli('file-view', 'log', '--global')).toMatchObject({ status: 2, stdout: '' });
        const result = runCli('file-view', 'frobnicate');
        expect(result.stderr).toContain('hwip file-view:');
        expect(result.status).toBe(2);
    });

    // Nothing here reaches the state directory: an unknown subcommand is refused first.
    it('hwip ask-context frobnicate is a usage error', () => {
        const result = runCli('ask-context', 'frobnicate');

        expect(result.stderr).toContain('hwip ask-context:');
        expect(result.status).toBe(2);
    });

    it.each([[['schedule', 'frobnicate']], [['schedule', 'rm', '../x']], [['schedule', 'add', 'vim', '--at', '09:00']]])(
        'hwip %s is a usage error',
        (args) => {
            const result = runCli(...args);

            expect(result.stderr).toContain('hwip schedule:');
            expect(result.status).toBe(2);
        },
    );

    it('treats a bare -h like --help', () => {
        const result = runCli('-h');

        expect(result.stdout).toContain('Usage: hwip');
        expect(result.status).toBe(0);
    });
});
