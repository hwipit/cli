/**
 * C112: where a key goes is decided in one place, `resolveBaseUrl` (config.ts), because a
 * config.json that cannot be read may hold the base URL the key belongs to. A command that
 * resolves it on its own (`flag || env || config.baseUrl || DEFAULT`) falls to the default API.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('base URL resolution', () => {
    // agent-rules-fetch reads the public detection manifest and sends no key; installer.ts only gets here
    // after `configWriteProblem` has stopped a config.json it cannot read (handleInstall). login-address.ts reads
    // the file's own address only to name a host the sign-in callback may repeat; it sends no key.
    const ALLOWED = new Set(['config.ts', 'agent-rules-fetch.ts', 'installer.ts', 'login-address.ts']);

    it('is not repeated in a command: nothing outside config.ts reads config.baseUrl', () => {
        const offenders = readdirSync(__dirname)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !ALLOWED.has(f))
            .filter((f) => /\b(config|existing)\.baseUrl\b|loadConfig\(\)\.baseUrl/.test(readFileSync(join(__dirname, f), 'utf-8')));

        expect(offenders).toEqual([]);
    });
});

// C129: whether the key about to be sent is the file's decides whether an address from the environment may carry it.
describe('the key\'s origin is passed to every place that resolves where it goes', () => {
    const read = (file: string): string => readFileSync(join(__dirname, file), 'utf-8');

    it('resolveBaseUrl gets keyIsFromFile at each command (agent-rules-fetch sends no key)', () => {
        for (const file of ['cli.ts', 'ask.ts', 'verify.ts', 'listener.ts']) {
            const calls = read(file).match(/resolveBaseUrl\([^;]*;/g) ?? [];
            expect(calls.length, file).toBeGreaterThan(0);
            for (const call of calls) expect(call, `${file}: ${call}`).toMatch(/keyIsFromFile\(|, fileKey\)/);
        }
    });

    it('resolveWsUrlDetailed and legacyWsEnvNotice get it at the listener and verify', () => {
        for (const file of ['verify.ts', 'listener.ts']) {
            const text = read(file);
            expect(text, file).toMatch(/resolveWsUrlDetailed\(args, config, \w+, fileKey\)/);
            expect(text, file).toMatch(/legacyWsEnvNotice\(config, process\.env, fileKey \? /);
        }
    });
});

describe.skipIf(process.platform === 'win32')('hwip ask with a config.json that cannot be read', () => {
    let out: string[];
    const fetchFn = vi.fn();
    beforeEach(() => {
        out = [];
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_HOOK_ID', 'hook_1');
        vi.stubEnv('HWIP_BASE_URL', '');
        vi.stubGlobal('fetch', fetchFn);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        fetchFn.mockReset();
    });

    const writeBroken = async () => {
        vi.resetModules();
        const { CONFIG_DIR, CONFIG_FILE } = await import('./config.js');
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_FILE, '{ "baseUrl": "https://stage.example/v1", }');
    };

    it('does not send the environment key to the default API: it answers with the reason', async () => {
        await writeBroken();
        const { handleAsk } = await import('./ask.js');

        const code = await handleAsk({ title: 'next?', timeout: '5' });

        expect(code).toBe(1);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(JSON.parse(out.join(''))).toMatchObject({ answered: false, reason: 'error', error: expect.stringMatching(/config\.json is not valid JSON.*--base-url/) });
    });

    it('goes ahead when --base-url says where', async () => {
        await writeBroken();
        fetchFn.mockRejectedValue(new Error('offline'));
        const { handleAsk } = await import('./ask.js');

        await handleAsk({ title: 'next?', timeout: '5', 'base-url': 'https://stage.example/v1' });

        expect(fetchFn.mock.calls[0]![0]).toMatch(/^https:\/\/stage\.example\/v1\//);
    });
});
