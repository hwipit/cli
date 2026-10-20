import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// handleVerify end to end, with agent detection, the login service, the
// listener and the API stubbed out: what it prints and which API it pings.

const api = vi.hoisted(() => ({ opts: [] as Array<{ apiKey: string; baseUrl?: string }>, list: vi.fn() }));

vi.mock('./hwip-hook.js', () => ({
    HwipHook: class {
        constructor(opts: { apiKey: string; baseUrl?: string }) { api.opts.push(opts); }
        list = api.list;
    },
}));
const host = vi.hoisted(() => ({ missing: new Set<string>(), listenerPid: null as number | null, foreign: false }));

vi.mock('./agents.js', () => ({
    detectAgents: () => [],
    resolveCommand: (bin: string) => (host.missing.has(bin) ? null : `/usr/bin/${bin}`),
}));
vi.mock('./listener-service.js', () => ({ serviceHealthChecks: () => [], serviceStatus: () => ({}) }));
vi.mock('./listener-process.js', () => ({
    LISTENER_LOG_FILE: '/nonexistent/listener.log',
    runningListenerPid: () => host.listenerPid,
    isListenerPid: () => !host.foreign,
    runningListenerWsUrl: () => null,
}));

let home: string;
let logs: string[];

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwip-verify-flow-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
    vi.stubEnv('HWIP_API_KEY', 'env_key');
    vi.stubEnv('HWIP_BASE_URL', '');
    vi.stubEnv('HWIP_HOOK_ID', 'hook_1');
    vi.stubEnv('HWIP_WS_URL', '');
    vi.resetModules();
    api.opts = [];
    host.missing = new Set();
    host.listenerPid = null;
    host.foreign = false;
    api.list.mockReset().mockResolvedValue({ pushes: [], hasMore: false });
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
});

const verify = async (args: Record<string, string | boolean>) => {
    const { handleVerify } = await import('./verify.js');
    return handleVerify(args);
};

describe('hwip verify with a config.json that cannot be used', () => {
    const broken = '{ "baseUrl": "https://stage.example/v1", "turnHistory": false, }';
    const writeConfig = async (text: string, mode = 0o600) => {
        const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
        mkdirSync(join(home, '.hwip'), { recursive: true });
        writeFileSync(join(home, '.hwip', 'config.json'), text);
        chmodSync(join(home, '.hwip', 'config.json'), mode);
    };

    // The listener reads it as every option off; a user who only reads the listener log never sees that.
    it('fails a row that names the file and says the options are off', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeConfig(broken);

        const code = await verify({ json: true });

        const report = JSON.parse(logs[0]);
        const row = report.checks.find((c: { label: string }) => /config\.json is not valid JSON/.test(c.label));
        expect(row).toMatchObject({ section: 'Credentials', state: 'fail' });
        expect(row.label).toMatch(/options off \(turn history, keep-awake\).*fix it, or move it aside/);
        expect(code).toBe(1);
    });

    // The base URL the key belongs to may be the file's; a key from the environment is not sent to the default API instead.
    it('does not ping the default API with a key whose base URL it cannot know', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeConfig(broken);

        await verify({ ping: true, json: true });

        expect(api.opts).toEqual([]);
        const report = JSON.parse(logs[0]);
        expect(report.checks.some((c: { label: string }) => /base URL it may hold is unknown/.test(c.label))).toBe(true);
        expect(report.checks).toContainEqual({ section: 'API ping', label: expect.stringMatching(/^skipped — the key would go to the default API/), state: 'warn' });
    });

    // Resolved against the default API, the socket check would pass for a server the key may not belong to.
    it('does not call the default socket a pass when the base URL is unknown', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeConfig(broken);

        await verify({ json: true });

        const checks = JSON.parse(logs[0]).checks as Array<{ label: string; state: string }>;
        expect(checks.some((c) => /wss?:\/\//.test(c.label) && c.state === 'pass')).toBe(false);
        expect(checks).toContainEqual(expect.objectContaining({ state: 'warn', label: expect.stringMatching(/^WebSocket URL not checked/) }));
    });

    it('pings as asked when --base-url says where', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeConfig(broken);

        await verify({ ping: true, 'base-url': 'https://stage.example/v1' });

        expect(api.opts).toEqual([{ apiKey: 'env_key', baseUrl: 'https://stage.example/v1' }]);
    });

    it('has no such row for a good config', async () => {
        await writeConfig('{ "turnHistory": false }');

        const code = await verify({ json: true });

        expect(JSON.parse(logs[0]).checks.some((c: { label: string }) => /config\.json/.test(c.label))).toBe(false);
        expect(code).toBe(0);
    });
});

// C129: the file's key does not follow an address from the environment, and verify must not be the command that does.
describe('hwip verify with the config file\'s key and an address from the environment', () => {
    const writeFileKey = async () => {
        const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
        mkdirSync(join(home, '.hwip'), { recursive: true });
        writeFileSync(join(home, '.hwip', 'config.json'), '{ "apiKey": "ak_file" }');
        chmodSync(join(home, '.hwip', 'config.json'), 0o600);
        vi.stubEnv('HWIP_API_KEY', '');
    };
    const checks = () => JSON.parse(logs[0]).checks as Array<{ section: string; label: string; state: string }>;

    it('does not ping an HWIP_BASE_URL on another origin, and fails a row naming the origins', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeFileKey();
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');

        const code = await verify({ ping: true, json: true });

        expect(api.opts).toEqual([]);
        expect(checks()).toContainEqual(expect.objectContaining({ state: 'fail', label: expect.stringMatching(/HWIP_BASE_URL points at https:\/\/evil\.example, but the API key in .*belongs to https:\/\/api\.hwip\.app/) }));
        expect(code).toBe(1);
    });

    it('does not take the socket from an exported HWIP_WS_URL, and says so', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeFileKey();
        vi.stubEnv('HWIP_WS_URL', 'wss://evil.example/ws');

        await verify({ json: true });

        const rows = checks();
        expect(rows).toContainEqual(expect.objectContaining({ state: 'warn', label: expect.stringMatching(/^HWIP_WS_URL is not used: the API key in/) }));
        expect(rows).toContainEqual(expect.objectContaining({ state: 'pass', label: expect.stringMatching(/^wss:\/\/ws\.hwip\.app .*default/) }));
        expect(rows.some((r) => r.label.includes('evil.example'))).toBe(false);
    });

    it('still takes both from the environment when the key came with them', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeFileKey();
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_BASE_URL', 'https://stage.example/v1');
        vi.stubEnv('HWIP_WS_URL', 'wss://ws-stage.example');

        await verify({ ping: true, json: true });

        expect(api.opts).toEqual([{ apiKey: 'env_key', baseUrl: 'https://stage.example/v1' }]);
        expect(checks().some((r) => /ws-stage\.example/.test(r.label))).toBe(true);
    });
});

describe('hwip verify', () => {
    // `--json` was ignored: the human report came out instead.
    it('prints one JSON object, and nothing else, with --json', async () => {
        const code = await verify({ json: true });

        expect(logs).toHaveLength(1);
        const report = JSON.parse(logs[0]);
        expect(report).toMatchObject({ failed: 0, warnings: expect.any(Number) });
        expect(report.checks).toContainEqual({ section: 'Credentials', label: 'API key set (from HWIP_API_KEY)', state: 'pass' });
        expect(report.checks).toContainEqual({ section: 'Agents', label: 'no supported agents detected', state: 'warn' });
        expect(code).toBe(0);
    });

    // `--ping` used the saved key and base URL whatever the flags said.
    it('pings with --key and --base-url', async () => {
        await verify({ ping: true, key: 'flag_key', 'base-url': 'http://localhost:3000/v1' });

        expect(api.opts).toEqual([{ apiKey: 'flag_key', baseUrl: 'http://localhost:3000/v1' }]);
        expect(logs.join('\n')).toContain('API key set (from --key)');
    });

    it('pings with HWIP_BASE_URL when no flag names one', async () => {
        vi.stubEnv('HWIP_BASE_URL', 'http://staging.example/v1');
        await verify({ ping: true });

        expect(api.opts).toEqual([{ apiKey: 'env_key', baseUrl: 'http://staging.example/v1' }]);
    });

    // C4: verify had no row for either, so a dead daemon looked healthy.
    it('reports tmux and whether the listener is running', async () => {
        host.listenerPid = 4242;
        await verify({ json: true });
        const up = JSON.parse(logs.pop() as string).checks;
        expect(up).toContainEqual({ section: 'Runtime', label: 'tmux available (hwip cc and phone control run in it)', state: 'pass' });
        expect(up).toContainEqual({ section: 'Runtime', label: 'listener running (pid 4242)', state: 'pass' });

        host.missing.add('tmux');
        host.listenerPid = null;
        await verify({ json: true });
        const down = JSON.parse(logs.pop() as string).checks;
        expect(down).toContainEqual({ section: 'Runtime', label: 'tmux not found — hwip cc and phone control need it', state: 'warn' });
        expect(down).toContainEqual(expect.objectContaining({ section: 'Runtime', label: expect.stringContaining('listener not running'), state: 'warn' }));
    });

    // C101: a bare host in "wsUrl" used to pass, and the listener's own start then failed with an error that quoted the key.
    it('fails a WebSocket URL with no ws:// or wss:// scheme', async () => {
        await verify({ json: true, 'ws-url': 'ws.hwip.app' });

        const report = JSON.parse(logs.pop() as string);
        expect(report.checks).toContainEqual(expect.objectContaining({
            section: 'WebSocket', state: 'fail', label: expect.stringContaining('needs a scheme'),
        }));
        expect(report.failed).toBeGreaterThan(0);
    });

    // C103: a base URL typed without the s sends the key in the clear; verify says so without failing.
    it('warns about a plain http:// base URL and a plain ws:// socket, never about a local one', async () => {
        vi.stubEnv('HWIP_BASE_URL', 'http://staging.example/v1');
        await verify({ json: true, 'ws-url': 'ws://ws.staging.example' });
        const remote = JSON.parse(logs.pop() as string).checks;
        expect(remote).toContainEqual(expect.objectContaining({ state: 'warn', label: expect.stringContaining('staging.example is reached over plain http://') }));
        expect(remote).toContainEqual(expect.objectContaining({ state: 'warn', label: expect.stringContaining('WebSocket at ws.staging.example is reached over plain ws://') }));

        vi.stubEnv('HWIP_BASE_URL', 'http://localhost:3000/v1');
        await verify({ json: true, 'ws-url': 'ws://localhost:3001' });
        const local = JSON.parse(logs.pop() as string).checks;
        expect(local.filter((c: { label: string }) => c.label.includes('plain http://') || c.label.includes('plain ws://'))).toEqual([]);
    });

    it('does not call a reused pid a running listener', async () => {
        host.listenerPid = 4242;
        host.foreign = true;
        await verify({ json: true });
        const checks = JSON.parse(logs.pop() as string).checks;
        expect(checks).toContainEqual(expect.objectContaining({ label: expect.stringContaining('listener not running'), state: 'warn' }));
    });
});

// Auto session names need HWIP_AUTONAME in the agent's MCP entry, which only a
// `hwip install` from this release writes: an older install says nothing otherwise.
describe('hwip verify and auto session names', () => {
    const write = async (path: string[], text: string) => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true });
        writeFileSync(join(home, ...path), text);
    };
    const mcpRows = async () => {
        await verify({ json: true });
        return (JSON.parse(logs.pop() as string).checks as Array<{ section: string; label: string; state: string }>)
            .filter((check) => check.section === 'MCP registrations')
            .map(({ label, state }) => [label, state]);
    };

    it('asks for a reinstall where the flag is missing, and only for the agents it is set for', async () => {
        await write(['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { hwip: { command: 'hwip', args: ['mcp'], env: {} } } }));
        await write(['.codex', 'config.toml'], '[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\nenv = { HWIP_AUTONAME = "1" }\n');
        await write(['.config', 'opencode', 'opencode.json'], JSON.stringify({ mcp: { hwip: { type: 'local', command: ['hwip', 'mcp'] } } }));

        expect(await mcpRows()).toEqual([
            ['Cursor: launches `hwip mcp`', 'pass'],
            ['Cursor: auto session names off — Re-run: hwip install', 'warn'],
            ['OpenCode: launches `hwip mcp`', 'pass'],
            ['Codex CLI: launches `hwip mcp`', 'pass'],
        ]);
    });
});

describe('hwip verify and auto session names in codex', () => {
    it('asks for a reinstall when the codex entry has no flag', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\n');

        await verify({ json: true });
        const checks = JSON.parse(logs.pop() as string).checks;

        expect(checks).toContainEqual({ section: 'MCP registrations', label: 'Codex CLI: auto session names off — Re-run: hwip install', state: 'warn' });
    });
});
