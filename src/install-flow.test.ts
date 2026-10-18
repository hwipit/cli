import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// handleInstall end to end, with the network, agent detection, tmux and the
// login service stubbed out: what it saves and the exit code it returns.

const api = vi.hoisted(() => ({ list: vi.fn(), notify: vi.fn() }));
const agents = vi.hoisted(() => ({ detected: [] as Array<{ id: string; name: string; detected: boolean }> }));

vi.mock('./hwip-hook.js', () => ({
    HwipHook: class {
        list = api.list;
        notify = api.notify;
    },
}));
vi.mock('./agents.js', () => ({ detectAgents: () => agents.detected, resolveCommand: () => '/usr/bin/true' }));
const tmux = vi.hoisted(() => ({ missing: false }));
vi.mock('./tmux-install.js', () => ({
    ensureTmux: async (deps: { report: { ok: (m: string) => void; fail: (m: string) => void } }) => {
        if (tmux.missing) deps.report.fail('tmux not found — `hwip cc` needs it. sudo apt install tmux');
        else deps.report.ok('tmux found');
    },
    planTmuxInstall: () => ({}),
}));
vi.mock('./listener-service.js', () => ({ serviceSupported: () => false, installService: () => {} }));

let home: string;
let errors: string[];
let logs: string[];
const configFile = () => join(home, '.hwip', 'config.json');

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwip-install-flow-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
    vi.stubEnv('HWIP_API_KEY', '');
    vi.stubEnv('HWIP_HOOK_ID', '');
    vi.stubEnv('HWIP_BASE_URL', '');
    vi.resetModules();
    api.list.mockReset().mockResolvedValue({ pushes: [], hasMore: false });
    api.notify.mockReset().mockResolvedValue({ pushId: 'push_1' });
    agents.detected = [];
    tmux.missing = false;
    errors = [];
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
});

const install = async (args: Record<string, string | boolean>) => {
    const { handleInstall } = await import('./installer.js');
    return handleInstall(args);
};

describe('hwip install', () => {
    // A wrong key used to be saved, followed by "Done!" and exit 0.
    it('saves nothing and exits 3 when the API rejects the key', async () => {
        const { AuthenticationError } = await import('./errors.js');
        api.list.mockRejectedValue(new AuthenticationError('Invalid API key'));

        expect(await install({ key: 'ak_wrong' })).toBe(3);
        expect(existsSync(configFile())).toBe(false);
        expect(api.notify).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('the API rejected this key (Invalid API key). Nothing was saved.');
    });

    // An offline machine can still be set up; the failed test push says so.
    it('saves the key when the check cannot reach the API, and exits 1 on the failed test push', async () => {
        api.list.mockRejectedValue(new Error('fetch failed'));
        api.notify.mockRejectedValue(new Error('fetch failed'));

        expect(await install({ key: 'ak_1' })).toBe(1);
        expect(JSON.parse(readFileSync(configFile(), 'utf-8')).apiKey).toBe('ak_1');
        expect(logs.join('\n')).toContain('Test failed: fetch failed');
        expect(logs.join('\n')).toContain('Done, but 1 step needs you');
    });

    // CI and containers that only need the hooks used to pass; a missing tmux
    // there is a note, not a failed step.
    it('exits 0 on a scripted install without tmux', async () => {
        tmux.missing = true;

        expect(await install({ key: 'ak_1' })).toBe(0);
        expect(logs.join('\n')).toContain('· tmux not found');
    });

    it('exits 0 when every step went through', async () => {
        expect(await install({ key: 'ak_1' })).toBe(0);
        expect(logs.join('\n')).toContain('Done! Restart your agents.');
    });

    // C107: a config.json that is not JSON used to load as {}; the install then replaced it with the new key alone.
    it('leaves a config.json it cannot read as JSON alone, and says so before asking anything', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const broken = '{ "apiKey": "ak_old", "wsUrl": "wss://ws.example", }';
        mkdirSync(join(home, '.hwip'), { recursive: true });
        writeFileSync(configFile(), broken);

        expect(await install({ key: 'ak_1' })).toBe(1);

        expect(readFileSync(configFile(), 'utf-8')).toBe(broken);
        expect(api.list).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain(configFile());
        expect(errors.join('\n')).toMatch(/not valid JSON.*fix it, or move it aside/);
    });

    // Without a terminal the picker threw, and that read as a clean "Cancelled." exit 0.
    it('is a usage error, before saving anything, when the agent picker has no terminal', async () => {
        agents.detected = [{ id: 'claude', name: 'Claude Code', detected: true }];
        const was = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
            expect(await install({})).toBe(2);
        } finally {
            if (was) Object.defineProperty(process.stdin, 'isTTY', was);
            else delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
        expect(errors.join('\n')).toContain('choosing agents needs a terminal');
        expect(existsSync(configFile())).toBe(false);
    });
});
