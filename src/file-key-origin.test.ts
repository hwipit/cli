/**
 * C129 (the cli half of mcp-server M29): the key in `~/.hwip/config.json` belongs to the addresses the file says
 * (`baseUrl`, else the default API). An address from the environment (`HWIP_BASE_URL`, the legacy `HWIP_WS_URL`)
 * is not where it was issued for, so the file's key does not follow it. A key given by flag or `HWIP_API_KEY`
 * goes with the environment as before, and so does the same origin; a flag is the user's word on that command.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_BASE, DEFAULT_WS_URL, envWsAllowed, legacyWsEnvNotice, originOf, resolveWsUrlDetailed } from './ws-url.js';

beforeEach(() => {
    vi.stubEnv('HWIP_API_KEY', '');
    vi.stubEnv('HWIP_BASE_URL', '');
    vi.stubEnv('HWIP_WS_URL', '');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const load = async () => {
    vi.resetModules();
    return import('./config.js');
};

describe('originOf', () => {
    it('is scheme, host and port, and nothing else', () => {
        expect(originOf('https://user:pw@api.example.com:8443/v1?x=1#f')).toBe('https://api.example.com:8443');
        expect(originOf('https://API.example.com/v1')).toBe('https://api.example.com');
    });

    it('is null for what has no origin', () => {
        expect(originOf('not a url')).toBeNull();
        expect(originOf('data:text/plain,a')).toBeNull();
        expect(originOf('')).toBeNull();
    });
});

// C152: `fetch` refuses such an address every time, quoting it whole. Stopped where it is read, by where it came from.
describe('resolveBaseUrl with a user name or password in the address', () => {
    const ADDRESS = 'https://alice:pa"ss wd@self-hosted.example/v1';
    const refusal = (run: () => string): string => {
        try {
            return `no refusal: ${run()}`;
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
    };

    it('stops at the flag, the environment and the file alike, naming which and nothing of the address', async () => {
        const { resolveBaseUrl } = await load();
        const fromFlag = refusal(() => resolveBaseUrl(ADDRESS, {}));
        const fromFile = refusal(() => resolveBaseUrl(undefined, { baseUrl: ADDRESS }));
        vi.stubEnv('HWIP_BASE_URL', ADDRESS);
        const fromEnv = refusal(() => resolveBaseUrl(undefined, {}));

        expect(fromFlag).toMatch(/^--base-url has a user name or password in it/);
        expect(fromEnv).toMatch(/^HWIP_BASE_URL has a user name or password in it/);
        expect(fromFile).toMatch(/^"baseUrl" in .*config\.json has a user name or password in it/);
        for (const said of [fromFlag, fromEnv, fromFile]) expect(said).not.toMatch(/alice|pa"ss|ss wd|self-hosted/);
    });

    it('stops at a user name alone, and lets through an address with neither', async () => {
        const { resolveBaseUrl } = await load();

        expect(refusal(() => resolveBaseUrl('https://alice@self-hosted.example/v1', {}))).toMatch(/^--base-url has a user name or password in it/);
        expect(resolveBaseUrl('https://self-hosted.example/v1', {})).toBe('https://self-hosted.example/v1');
        // Not an address at all: left for the call that uses it to say so (`ERR_INVALID_URL`).
        expect(resolveBaseUrl('not a url', {})).toBe('not a url');
    });
});

describe('resolveBaseUrl with the config file\'s key', () => {
    it('does not send it to an HWIP_BASE_URL on another origin', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');
        expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file' }, true))
            .toThrow(/HWIP_BASE_URL points at https:\/\/evil\.example, but the API key in .*config\.json belongs to https:\/\/api\.hwip\.app, so it is not sent there — set HWIP_API_KEY as well, pass --base-url, or unset HWIP_BASE_URL/);
    });

    it('holds the file\'s own baseUrl as the key\'s home', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', DEFAULT_API_BASE);
        expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl: 'https://self-hosted.example/v1' }, true))
            .toThrow(/belongs to https:\/\/self-hosted\.example/);
    });

    it('is not fooled by lookalikes of the origin: port, scheme, subdomain, userinfo, an address in the path', async () => {
        const { resolveBaseUrl } = await load();
        const config = { apiKey: 'ak_file', baseUrl: 'https://api.example.com/v1' };
        for (const env of [
            'https://api.example.com:8443/v1', 'http://api.example.com/v1', 'https://api.example.com.evil.example/v1',
            'https://api.example.com@evil.example/v1', 'https://evil.example/https://api.example.com/v1',
        ]) {
            vi.stubEnv('HWIP_BASE_URL', env);
            expect(() => resolveBaseUrl(undefined, config, true), env).toThrow(/is not sent there/);
        }
    });

    it('names the origin only: no userinfo, path, query or key', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://user:pw@evil.example/v1?token=t0k');
        let message = '';
        try { resolveBaseUrl(undefined, { apiKey: 'ak_file_secret' }, true); } catch (err) { message = (err as Error).message; }
        expect(message).toContain('https://evil.example');
        for (const secret of ['user', 'pw', 't0k', 'ak_file_secret', '/v1']) expect(message).not.toContain(secret);
    });

    it('stops for an address that is not a URL, and for two with no origin', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'not a url');
        expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file' }, true)).toThrow(/points at something that is not a URL/);
        vi.stubEnv('HWIP_BASE_URL', 'data:text/plain,b');
        expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl: 'data:text/plain,a' }, true)).toThrow(/is not sent there/);
    });

    it('stops when the file\'s baseUrl is not text: where the key belongs is unknown', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://api.hwip.app/v1');
        expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl: true as never }, true)).toThrow(/"baseUrl" that is not text/);
    });

    it('follows the environment on the same origin, whatever the path', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://api.example.com/v2');
        expect(resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl: 'https://api.example.com/v1' }, true)).toBe('https://api.example.com/v2');
    });

    it('takes a file without a baseUrl, or an empty one, for the default API', async () => {
        const { resolveBaseUrl } = await load();
        for (const baseUrl of [undefined, '']) {
            vi.stubEnv('HWIP_BASE_URL', 'https://api.hwip.app/d1');
            expect(resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl }, true)).toBe('https://api.hwip.app/d1');
            vi.stubEnv('HWIP_BASE_URL', 'https://staging.example/v1');
            expect(() => resolveBaseUrl(undefined, { apiKey: 'ak_file', baseUrl }, true)).toThrow(/belongs to https:\/\/api\.hwip\.app/);
        }
    });

    it('follows --base-url anywhere: it is the user\'s word on this command', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');
        expect(resolveBaseUrl('https://staging.example/v1', { apiKey: 'ak_file' }, true)).toBe('https://staging.example/v1');
    });

    it('follows the environment anywhere when the key was not the file\'s', async () => {
        const { resolveBaseUrl } = await load();
        vi.stubEnv('HWIP_BASE_URL', 'https://staging.example/v1');
        expect(resolveBaseUrl(undefined, { apiKey: 'ak_file' }, false)).toBe('https://staging.example/v1');
        expect(resolveBaseUrl(undefined, {})).toBe('https://staging.example/v1');
    });
});

describe('keyIsFromFile', () => {
    it('is true only when no flag and no HWIP_API_KEY gave the key', async () => {
        const { keyIsFromFile } = await load();
        expect(keyIsFromFile(undefined, { apiKey: 'ak_file' })).toBe(true);
        expect(keyIsFromFile(true, { apiKey: 'ak_file' })).toBe(true); // a bare flag is no key
        expect(keyIsFromFile('', { apiKey: 'ak_file' })).toBe(true);
        expect(keyIsFromFile('ak_flag', { apiKey: 'ak_file' })).toBe(false);
        expect(keyIsFromFile(undefined, {})).toBe(false);
        vi.stubEnv('HWIP_API_KEY', 'ak_env');
        expect(keyIsFromFile(undefined, { apiKey: 'ak_file' })).toBe(false);
    });

    it('does not take an unexpanded ${HWIP_API_KEY} placeholder for a key', async () => {
        const { keyIsFromFile } = await load();
        vi.stubEnv('HWIP_API_KEY', '${HWIP_API_KEY}');
        expect(keyIsFromFile(undefined, { apiKey: 'ak_file' })).toBe(true);
    });
});

describe('the environment\'s HWIP_WS_URL with the config file\'s key', () => {
    it('is used only on the default socket\'s origin, with the default API', () => {
        expect(envWsAllowed('wss://ws.hwip.app/other', DEFAULT_API_BASE, true)).toBe(true);
        expect(envWsAllowed('wss://evil.example/ws', DEFAULT_API_BASE, true)).toBe(false);
        expect(envWsAllowed('wss://ws.hwip.app', 'https://self-hosted.example/v1', true)).toBe(false);
        expect(envWsAllowed('not a url', DEFAULT_API_BASE, true)).toBe(false);
    });

    it('is used anywhere when the key was not the file\'s', () => {
        expect(envWsAllowed('wss://evil.example/ws', DEFAULT_API_BASE, false)).toBe(true);
    });

    it('is skipped by resolveWsUrlDetailed: the default socket answers, or none for another API', () => {
        vi.stubEnv('HWIP_WS_URL', 'wss://evil.example/ws');
        expect(resolveWsUrlDetailed({}, {}, DEFAULT_API_BASE, true)).toEqual({ url: DEFAULT_WS_URL, source: 'default' });
        expect(resolveWsUrlDetailed({}, {}, 'https://self-hosted.example/v1', true)).toBeNull();
        expect(resolveWsUrlDetailed({}, {}, DEFAULT_API_BASE, false)).toEqual({ url: 'wss://evil.example/ws', source: 'env-deprecated' });
    });

    it('leaves the file\'s wsUrl and --ws-url first, as before', () => {
        vi.stubEnv('HWIP_WS_URL', 'wss://evil.example/ws');
        expect(resolveWsUrlDetailed({}, { wsUrl: 'wss://file.example' }, DEFAULT_API_BASE, true)).toEqual({ url: 'wss://file.example', source: 'config' });
        expect(resolveWsUrlDetailed({ 'ws-url': 'wss://flag.example' }, {}, DEFAULT_API_BASE, true)).toEqual({ url: 'wss://flag.example', source: 'flag' });
    });

    it('says it is skipped, and says nothing when the file wins or the export is allowed', () => {
        const env = { HWIP_WS_URL: 'wss://evil.example/ws' };
        const skipped = legacyWsEnvNotice({}, env, { baseUrl: DEFAULT_API_BASE });
        expect(skipped).toMatch(/HWIP_WS_URL is not used: the API key in ~\/\.hwip\/config\.json is not sent to an address from the environment/);
        expect(skipped).not.toContain('evil.example');
        expect(legacyWsEnvNotice({ wsUrl: 'wss://file.example' }, env, { baseUrl: DEFAULT_API_BASE })).toMatch(/config\.json wins now/);
        expect(legacyWsEnvNotice({}, { HWIP_WS_URL: 'wss://ws.hwip.app' }, { baseUrl: DEFAULT_API_BASE })).toMatch(/deprecated/);
        expect(legacyWsEnvNotice({}, env)).toMatch(/deprecated/);
    });
});

describe.skipIf(process.platform === 'win32')('at the commands: the file\'s key and an HWIP_BASE_URL on another origin', () => {
    const writeFile = async (content: Record<string, unknown>) => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { CONFIG_DIR, CONFIG_FILE } = await import('./config.js');
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_FILE, JSON.stringify(content));
        chmodSync(CONFIG_FILE, 0o600);
    };

    it('the listener does not start with it, and says why', async () => {
        await writeFile({ apiKey: 'ak_file' });
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');
        const { listenerSettings } = await import('./listener.js');
        const settings = listenerSettings({});
        expect(settings).toMatchObject({ exit: 1, message: expect.stringMatching(/^hwip listener: HWIP_BASE_URL points at https:\/\/evil\.example/) });
    });

    it('the listener goes ahead when the key came with the address, or by flag', async () => {
        await writeFile({ apiKey: 'ak_file' });
        vi.stubEnv('HWIP_BASE_URL', 'https://staging.example/v1');
        const { listenerSettings } = await import('./listener.js');
        vi.stubEnv('HWIP_API_KEY', 'ak_env');
        expect(listenerSettings({})).toMatchObject({ apiKey: 'ak_env', baseUrl: 'https://staging.example/v1' });
        vi.stubEnv('HWIP_API_KEY', '');
        expect(listenerSettings({ key: 'ak_flag' })).toMatchObject({ apiKey: 'ak_flag', baseUrl: 'https://staging.example/v1' });
        expect(listenerSettings({ 'base-url': 'https://flag.example/v1' })).toMatchObject({ apiKey: 'ak_file', baseUrl: 'https://flag.example/v1' });
    });

    it('hwip ask sends nothing and answers with the reason', async () => {
        await writeFile({ apiKey: 'ak_file' });
        vi.stubEnv('HWIP_HOOK_ID', 'hook_1');
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');
        const fetchFn = vi.fn();
        vi.stubGlobal('fetch', fetchFn);
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
        const { handleAsk } = await import('./ask.js');
        expect(await handleAsk({ title: 'next?', timeout: '5' })).toBe(1);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(JSON.parse(out.join(''))).toMatchObject({ answered: false, reason: 'error', error: expect.stringMatching(/HWIP_BASE_URL points at https:\/\/evil\.example/) });
    });

    it('install does not check, or save, the saved key against it', async () => {
        await writeFile({ apiKey: 'ak_file' });
        vi.stubEnv('HWIP_BASE_URL', 'https://evil.example/v1');
        const { collectCredentials } = await import('./installer.js');
        const { loadConfig } = await import('./config.js');
        await expect(collectCredentials({}, { hook: 'none' }, true, loadConfig())).rejects.toThrow(/HWIP_BASE_URL points at https:\/\/evil\.example/);
    });

    // C150: an address with a user name or password in it never reaches config.json.
    it('install refuses a --base-url with a user name or password in it before saving', async () => {
        await writeFile({ apiKey: 'ak_file' });
        const { collectCredentials } = await import('./installer.js');
        const { loadConfig } = await import('./config.js');
        await expect(collectCredentials({}, { 'base-url': 'https://alice:s3cret@flag.example/v1' }, true, loadConfig()))
            .rejects.toThrow(/user name or password/);
    });

    it('install goes ahead for a key given with it, a --base-url, or the same origin', async () => {
        await writeFile({ apiKey: 'ak_file' });
        const { collectCredentials } = await import('./installer.js');
        const { loadConfig } = await import('./config.js');
        const existing = loadConfig();
        vi.stubEnv('HWIP_BASE_URL', 'https://staging.example/v1');
        expect(await collectCredentials({}, { key: 'ak_flag' }, true, existing)).toMatchObject({ apiKey: 'ak_flag', baseUrl: 'https://staging.example/v1' });
        expect(await collectCredentials({}, { 'base-url': 'https://flag.example/v1' }, true, existing)).toMatchObject({ apiKey: 'ak_file', baseUrl: 'https://flag.example/v1' });
        vi.stubEnv('HWIP_API_KEY', 'ak_env');
        expect(await collectCredentials({}, {}, true, existing)).toMatchObject({ apiKey: 'ak_env', baseUrl: 'https://staging.example/v1' });
        vi.stubEnv('HWIP_API_KEY', '');
        vi.stubEnv('HWIP_BASE_URL', 'https://api.hwip.app/d1');
        expect(await collectCredentials({}, {}, true, existing)).toMatchObject({ apiKey: 'ak_file', baseUrl: 'https://api.hwip.app/d1' });
    });
});
