import { buildSync } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// cli.ts runs `main()` when it is loaded, so its output can only be seen by
// running the CLI. Only `list` and `notify` run here, against a local server
// that answers every request: neither can reach a real account or device.
let dir: string;
let bundle: string;
let server: Server;
let baseUrl: string;
const requests: string[] = [];
const sentBodies: Record<string, unknown>[] = [];

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-run-'));
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
    // The one signed-in phone every send is sealed for: a real P-256 key, or sealing fails.
    const phone = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const phoneKey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('spki', phone.publicKey))).toString('base64');
    server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url === '/devices') {
            res.end(JSON.stringify({ data: [{ deviceId: 'dev_phone', type: 'ios', publicKey: phoneKey }] }));
            return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/pushes')) {
            res.end(JSON.stringify({
                data: [
                    { pushId: 'p1', type: 'note', isEncrypted: true, body: '{"ciphertext":"AAAB","iv":"x"}', createdAt: '2026-10-02T00:00:00Z' },
                    { pushId: 'p2', type: 'hook', title: 'Task done', createdAt: '2026-10-02T00:00:00Z' },
                    { pushId: 'p3', type: 'note', createdAt: '2026-10-02T00:00:00Z' },
                ],
                pagination: { hasMore: false },
            }));
            return;
        }
        if (req.method === 'GET' && req.url === '/channels') {
            res.end(JSON.stringify({
                data: [
                    { channelId: 'ch_mine', name: 'Releases', ownerId: 'me-0000000000', isOwner: true, isPublic: true, subscriberCount: 4, webhookSecret: 'whsec_secret' },
                    { channelId: 'ch_a', name: 'Same', ownerId: 'me-0000000000', isOwner: true, isPublic: false, subscriberCount: 0 },
                    { channelId: 'ch_b', name: 'Same', ownerId: 'other-1111111', isOwner: false, isPublic: true, subscriberCount: 9 },
                    { channelId: 'ch_c', name: 'Dup', ownerId: 'me-0000000000', isOwner: true, isPublic: true, subscriberCount: 1 },
                    { channelId: 'ch_d', name: 'Dup', ownerId: 'me-0000000000', isOwner: true, isPublic: true, subscriberCount: 1 },
                    { channelId: 'ch_foreign', name: 'Theirs', ownerId: 'other-1111111', isOwner: false, isPublic: true, subscriberCount: 9 },
                ],
            }));
            return;
        }
        if (req.method === 'POST' && req.url === '/pushes/send') {
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', () => {
                const body = JSON.parse(raw) as Record<string, unknown>;
                sentBodies.push(body);
                if (body.channelId === 'ch_hidden') {
                    res.statusCode = 403;
                    res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not channel owner' } }));
                    return;
                }
                res.end(JSON.stringify({ data: { pushId: 'sent' } }));
            });
            return;
        }
        res.end(JSON.stringify({ data: { pushId: 'sent' } }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
});

const runCliIn = (cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> =>
    new Promise((done) => {
        const child = spawn(process.execPath, [bundle, ...args], {
            cwd,
            env: {
                HOME: dir,
                PATH: dirname(process.execPath),
                NODE_PATH: resolve(__dirname, '..', 'node_modules'),
                HWIP_API_KEY: 'ak_test',
                HWIP_BASE_URL: baseUrl,
                HWIP_NO_UPDATE_CHECK: '1',
                ...env,
            },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('close', (status) => done({ stdout, stderr, status }));
    });

const runCliWith = (env: Record<string, string>, ...args: string[]) => runCliIn(dir, env, ...args);

const runCli = (...args: string[]) => runCliWith({}, ...args);

describe('hwip list', () => {
    // C26: an encrypted push has no plaintext title, and read as "(no title)".
    it('labels an encrypted push instead of calling it untitled', async () => {
        const result = await runCli('list');

        expect(result.status).toBe(0);
        const lines = result.stdout.split('\n');
        expect(lines.find((line) => line.includes('p1'))).toContain('[encrypted]');
        expect(lines.find((line) => line.includes('p2'))).toContain('Task done');
        expect(lines.find((line) => line.includes('p3'))).toContain('(no title)');
    });
});

describe('hwip channel list', () => {
    it('lists the channels without the record fields it does not show', async () => {
        const result = await runCli('channel', 'list');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ch_mine');
        expect(result.stdout).toContain('Releases');
        expect(result.stdout).toContain('4 subscribers');
        expect(result.stdout).toContain('private');
        expect(result.stdout.split('\n').find((l) => l.includes('ch_mine'))).toContain('yours');
        expect(result.stdout.split('\n').find((l) => l.includes('ch_foreign'))).toContain('following');
        expect(result.stdout).not.toContain('whsec_');
    });

    it('prints the list as JSON', async () => {
        const result = await runCli('channel', 'list', '--json');

        const channels = JSON.parse(result.stdout) as { channelId: string }[];
        expect(channels.map((c) => c.channelId)).toEqual(['ch_mine', 'ch_a', 'ch_b', 'ch_c', 'ch_d', 'ch_foreign']);
        expect(channels.map((c) => (c as { isOwner?: boolean }).isOwner)).toEqual([true, true, false, true, true, false]);
        expect(result.stdout).not.toContain('whsec_');
    });

    it('wants the word list', async () => {
        const result = await runCli('channel');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage: hwip channel list');
    });
});

describe('hwip notify --channel', () => {
    it('sends to the channel a name resolves to, in the clear, and says so', async () => {
        sentBodies.length = 0;
        const result = await runCli('notify', '--channel', 'Releases', '--title', 'v1', '--body', 'shipped');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Push sent to "Releases" (ch_mine): sent');
        expect(result.stderr).toContain('plain text');
        expect(sentBodies).toEqual([{ title: 'v1', body: 'shipped', type: 'hook', channelId: 'ch_mine' }]);
    });

    it('keeps stdout to the JSON with --json', async () => {
        const result = await runCli('notify', '--channel', 'ch_mine', '--title', 'v1', '--json');

        expect(JSON.parse(result.stdout)).toEqual({ pushId: 'sent', channelId: 'ch_mine', encrypted: false, status: 'ok' });
    });

    it('picks the channel it owns when a followed one has the same name', async () => {
        sentBodies.length = 0;
        const result = await runCli('notify', '--channel', 'Same', '--title', 'x');

        expect(result.status).toBe(0);
        expect(sentBodies).toEqual([{ title: 'x', type: 'hook', channelId: 'ch_a' }]);
    });

    it('sends nothing for a name two owned channels share', async () => {
        sentBodies.length = 0;
        const result = await runCli('notify', '--channel', 'Dup', '--title', 'x');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('ch_c, ch_d');
        expect(sentBodies).toEqual([]);
    });

    it('sends nothing without a title or body, or with an agent-session flag', async () => {
        sentBodies.length = 0;
        const bare = await runCli('notify', '--channel', 'Releases');
        const auto = await runCli('notify', '--channel', 'Releases', '--title', 'x', '--device', 'dev_1');

        expect(bare.status).toBe(2);
        expect(auto.status).toBe(2);
        expect(sentBodies).toEqual([]);
    });

    it('sends nothing to a channel it only follows, by name or by id', async () => {
        sentBodies.length = 0;
        const byName = await runCli('notify', '--channel', 'Theirs', '--title', 'x');
        const byId = await runCli('notify', '--channel', 'ch_foreign', '--title', 'x');

        expect(byName.status).toBe(2);
        expect(byName.stderr).toContain('do not own');
        expect(byId.status).toBe(2);
        expect(byId.stderr).toContain('do not own');
        expect(sentBodies).toEqual([]);
    });

    it('explains the server refusing a channel the list does not show', async () => {
        const result = await runCli('notify', '--channel', 'ch_hidden', '--title', 'x');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Not channel owner');
        expect(result.stderr).toContain("only the channel's owner can send to it");
    });
});

describe('the config file\'s key and an HWIP_BASE_URL on another origin (C129)', () => {
    const configFile = (): string => join(dir, '.hwip', 'config.json');
    beforeAll(() => {
        mkdirSync(join(dir, '.hwip'), { recursive: true });
        writeFileSync(configFile(), '{ "apiKey": "ak_file" }', { mode: 0o600 });
    });
    afterAll(() => rmSync(join(dir, '.hwip'), { recursive: true, force: true }));

    it('sends no request with it, and says which origins', async () => {
        requests.length = 0;
        const result = await runCliWith({ HWIP_API_KEY: '' }, 'list');

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/HWIP_BASE_URL points at http:\/\/127\.0\.0\.1:\d+, but the API key in .*config\.json belongs to https:\/\/api\.hwip\.app/);
        expect(requests).toEqual([]);
    });

    it('goes ahead for a key given with the address, or a --base-url', async () => {
        requests.length = 0;
        expect((await runCliWith({}, 'list')).status).toBe(0);
        expect((await runCliWith({ HWIP_API_KEY: '', HWIP_BASE_URL: '' }, 'list', '--base-url', baseUrl)).status).toBe(0);
        expect(requests.length).toBe(2);
    });
});

describe('yes/no flags', () => {
    // C118: stops before the command does anything, and says which flag and which value.
    it('stops a value that is neither yes nor no, before a request is made', async () => {
        requests.length = 0;
        const result = await runCli('notify', '--auto=maybe', '--title', 'x');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('hwip notify: --auto takes true or false (or nothing, which is true), not "maybe"');
        expect(requests).toEqual([]);
    });

    it('stops `uninstall --dry-run=maybe` before it removes or even announces anything', async () => {
        const result = await runCli('uninstall', '--dry-run=maybe');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--dry-run takes true or false');
        expect(result.stdout).not.toContain('Hwip uninstall');
    });

    it('does not echo a key that was typed after a yes/no flag', async () => {
        const result = await runCli('install', '--relogin', 'ak_abcdef123456');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--relogin takes true or false');
        expect(result.stderr).not.toContain('ak_abcdef123456');
        expect(result.stderr).toContain('ak_***');
    });

    it('answers a bad `--version` value like any other bad flag value (exit 2), not with a crash', async () => {
        const result = await runCli('list', '--version=maybe');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('hwip list: --version takes true or false');
    });

    it('reads `--json=true` like `--json`', async () => {
        const result = await runCli('list', '--json=true');

        expect(result.status).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
});

describe('unknown flags', () => {
    // C40: a typo used to vanish, and the push went out with the default title.
    it('warns about a flag the command does not read, and still runs it', async () => {
        requests.length = 0;
        const result = await runCli('notify', '--titel', 'Deploy done', '--body', 'b');

        expect(result.stderr).toContain('hwip notify: unknown flag --titel (ignored)');
        expect(result.status).toBe(0);
        expect(requests).toContain('GET /devices');
        expect(requests).toContain('POST /pushes/send');
    });

    it('stays quiet for flags the command reads', async () => {
        const result = await runCli('list', '--limit', '3', '--json');

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
});

// C111/C112: where a command sends the key when `~/.hwip/config.json` says so, and when it cannot be read.
describe('the base URL in config.json', () => {
    const config = (text: string | null) => {
        mkdirSync(join(dir, '.hwip'), { recursive: true });
        rmSync(join(dir, '.hwip', 'config.json'), { force: true });
        if (text !== null) writeFileSync(join(dir, '.hwip', 'config.json'), text, { mode: 0o600 });
    };
    const NO_BASE = { HWIP_BASE_URL: '' };
    afterAll(() => config(null));

    it('is where `list` sends the key', async () => {
        config(JSON.stringify({ baseUrl }));
        requests.length = 0;

        const result = await runCliWith(NO_BASE, 'list');

        expect(result.status).toBe(0);
        expect(requests.some((r) => r.startsWith('GET /pushes'))).toBe(true);
    });

    it('stops a command when it cannot be read, instead of sending the key to the default API', async () => {
        config(`{ "baseUrl": "${baseUrl}", }`);
        requests.length = 0;

        const result = await runCliWith(NO_BASE, 'list');

        expect(result.status).not.toBe(0);
        expect(result.stderr + result.stdout).toMatch(/config\.json is not valid JSON.*--base-url/);
        expect(requests).toEqual([]);
    });

    it('goes ahead when the flag says where', async () => {
        config(`{ "baseUrl": "${baseUrl}", }`);
        requests.length = 0;

        const result = await runCliWith(NO_BASE, 'list', '--base-url', baseUrl);

        expect(result.status).toBe(0);
        expect(requests.some((r) => r.startsWith('GET /pushes'))).toBe(true);
    });

    // `hwip trust` shows fingerprints from this machine's key; only `trust <deviceId>` asks the API.
    // C150: a broken configuration is said once instead of an empty list that reads as "no devices".
    it('does not stop `hwip trust`, which has no API to reach, but says a broken base URL once', async () => {
        config(`{ "baseUrl": "${baseUrl}", }`);

        const result = await runCliWith(NO_BASE, 'trust');

        expect(result.stdout + result.stderr).toMatch(/hwip trust: .*base URL it may hold/);
    });

    it('is where `hwip trust <deviceId>` looks the device up', async () => {
        config(JSON.stringify({ baseUrl }));
        requests.length = 0;

        await runCliWith(NO_BASE, 'trust', 'dev_other');

        expect(requests.some((r) => r.startsWith('GET /devices'))).toBe(true);
    });

    it('stops `hwip trust <deviceId>`, which does, with the reason', async () => {
        config(`{ "baseUrl": "${baseUrl}", }`);
        requests.length = 0;

        const result = await runCliWith(NO_BASE, 'trust', 'dev_other');

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/hwip trust: .*config\.json is not valid JSON.*--base-url/);
        expect(requests).toEqual([]);
    });
});

// F7: `--wt` is refused before anything is made or started. A tmux that only exits 0 is enough to get past the
// "tmux not found" check; the listener and the agent are never reached, which is the point of these cases.
describe('--wt refusals', () => {
    let bin: string;
    let repos: string;
    beforeAll(() => {
        bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        repos = mkdtempSync(join(dir, 'repos-'));
    });
    // git is the one real tool the refusals need.
    const withFakeTmux = () => ({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` });

    it('hwip sh takes no --wt', async () => {
        const result = await runCli('sh', '--wt', 'x');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("'hwip sh' takes only --label <x> and --detach");
    });

    it('outside git: says why, exit 1', async () => {
        const result = await runCliIn(repos, withFakeTmux(), 'cc', '--wt', 'x', '--detach');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('hwip: --wt needs a git checkout with a main worktree');
    });

    it('an invalid branch name: exit 2, no worktree', async () => {
        const repo = join(repos, 'app');
        execFileSync('git', ['init', '-q', repo]);

        const result = await runCliIn(repo, withFakeTmux(), 'cc', '--wt', 'a..b');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("'a..b' is not a valid branch name");
        expect(readdirSync(repos)).toEqual(['app']);
    });

    it('a name that is missing: exit 2', async () => {
        const result = await runCliIn(repos, withFakeTmux(), 'cc', '--wt', '--detach');

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('--wt needs a value');
    });
});

describe('hwip worktree', () => {
    let bin: string;
    let repos: string;
    let main: string;
    let clean: string;
    let dirty: string;
    const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf-8' });
    let socket: string;
    // findTmuxSocket probes HWIP_TMUX_SOCKET first and stops at the first yes.
    // Without one, a fake tmux that fails sends it through discovery
    // (tmux-socket.ts): one `tmux -S <file> list-sessions` per socket file
    // under tmux-<uid>/ — twice for /tmp and /private/tmp — a second probe
    // pass for the diagnostic, then `ps` and `lsof`. On a machine with many
    // dead sockets that is hundreds of spawns and seconds per run(), against
    // this suite's 5s budget (measured 2026-10-09: 83 sockets, 335 tmux spawns,
    // 3.2-3.8s a test). So the fake answers yes to exactly that probe; every
    // other call, `list-sessions -F` included, is still the test's own script.
    const fakeTmux = (script: string) =>
        writeFileSync(join(bin, 'tmux'), `#!/bin/sh\n[ "$*" = "-S ${socket} list-sessions" ] && exit 0\n${script}\n`, { mode: 0o755 });
    const run = (...args: string[]) =>
        runCliIn(main, { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HWIP_TMUX_SOCKET: socket }, ...args);
    const row = (path: string, branch: string, baseSha: string) =>
        ({ path, root: main, branch, baseSha, createdBranch: true, createdAt: '2026-10-09T00:00:00Z', sessionSeenAt: '2026-10-09T00:30:00Z' });

    beforeAll(() => {
        bin = join(dir, 'wtbin');
        mkdirSync(bin);
        socket = join(dir, 'tmux.sock');
        repos = realpathSync(mkdtempSync(join(dir, 'wt-repos-')));
        main = join(repos, 'app');
        execFileSync('git', ['init', '-q', main]);
        git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
        clean = join(repos, 'app-wt-clean');
        dirty = join(repos, 'app-wt-dirty');
        git(main, 'worktree', 'add', '-q', clean, '-b', 'clean');
        git(main, 'worktree', 'add', '-q', dirty, '-b', 'dirty');
        writeFileSync(join(dirty, 'notes.txt'), 'unsaved');
        const base = git(main, 'rev-parse', 'HEAD').trim();
        const state = join(dir, '.local', 'state', 'hwip');
        mkdirSync(state, { recursive: true });
        writeFileSync(join(state, 'worktrees.json'), JSON.stringify([row(clean, 'clean', base), row(dirty, 'dirty', base)]));
    });

    it('lists what it made and what keeps each', async () => {
        fakeTmux('exit 0');

        const result = await run('worktree');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`${clean}  (clean)  clean`);
        expect(result.stdout).toContain(`${dirty}  (dirty)  1 uncommitted or untracked`);
    });

    it('shows a session that is in a worktree as in use', async () => {
        fakeTmux(`printf '%s\\n' '${join(dirty, 'sub')}' '${clean}'`);

        const result = await run('worktree');

        expect(result.stdout).toContain(`${clean}  (clean)  in use`);
        expect(result.stdout).toContain(`${dirty}  (dirty)  in use`);
    });

    it('clean --dry-run says what it would do and changes nothing', async () => {
        fakeTmux('exit 0');
        const before = git(main, 'worktree', 'list');

        const result = await run('worktree', 'clean', '--dry-run');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Would remove ${clean}`);
        expect(result.stdout).toContain(`Kept ${dirty} — 1 uncommitted or untracked`);
        expect(git(main, 'worktree', 'list')).toBe(before);
    });

    it('does nothing when tmux cannot be asked, rather than reading it as no sessions', async () => {
        fakeTmux("echo 'error connecting to /tmp/tmux-0/default (Permission denied)' >&2; exit 1");
        const before = git(main, 'worktree', 'list');

        const result = await run('worktree', 'clean');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('nothing was judged');
        expect(git(main, 'worktree', 'list')).toBe(before);
    });

    it('lists without tmux, only unable to say which are in use', async () => {
        fakeTmux("echo 'error connecting to /tmp/tmux-0/default (Permission denied)' >&2; exit 1");

        const result = await run('worktree');

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('"in use" is not shown');
        expect(result.stdout).toContain(`${dirty}  (dirty)  1 uncommitted or untracked`);
    });

    it('rejects what it does not know, before it asks anything', async () => {
        expect((await run('worktree', 'prune')).status).toBe(2);
        const dry = await run('worktree', '--dry-run');
        expect(dry.status).toBe(2);
        expect(dry.stderr).toContain("belongs to 'hwip worktree clean'");
    });

    it('clean removes what nothing keeps and leaves the rest', async () => {
        fakeTmux('echo "no server running on /tmp/tmux-0/default" >&2; exit 1');

        const result = await run('worktree', 'clean');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Removed ${clean} (branch clean deleted)`);
        expect(result.stdout).toContain(`Kept ${dirty}`);
        expect(existsSync(clean)).toBe(false);
        expect(existsSync(join(dirty, 'notes.txt'))).toBe(true);
    });
});
