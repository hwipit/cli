/**
 * C111–C113: what hwip does when `~/.hwip/config.json` is there and cannot be used.
 * It holds the opt-outs (`turnHistory: false`, `keepAwake: false`) and where the key goes
 * (`baseUrl`). Read as `{}`, an opt-out is silently lost: the listener started uploading sealed
 * conversations. Every file is under a temp HOME (src/test-setup.ts points HOME at one).
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
    vi.resetModules();
    const config = await import('./config.js');
    mkdirSync(config.CONFIG_DIR, { recursive: true });
    rmSync(config.CONFIG_FILE, { force: true });
    return config;
};
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const BROKEN = '{ "apiKey": "ak_x", "turnHistory": false, "keepAwake": false, "baseUrl": "https://stage.example/v1", }';

describe('the defaults for a config that cannot be used', () => {
    // A new opt-out that is not in the list would be lost the way these two were.
    it('name every boolean option HwipConfig has, all of them off', async () => {
        const { unreadableConfigDefaults } = await import('./config.js');
        const source = readFileSync(join(__dirname, 'config.ts'), 'utf-8');
        const body = source.slice(source.indexOf('export interface HwipConfig'), source.indexOf('\n}', source.indexOf('export interface HwipConfig')));
        const booleans = [...body.matchAll(/^\s+(\w+)\?: boolean;/gm)].map((m) => m[1]).sort();

        expect(booleans.length).toBeGreaterThan(0);
        expect(Object.keys(unreadableConfigDefaults).sort()).toEqual(booleans);
        expect(Object.values(unreadableConfigDefaults).every((v) => v === false)).toBe(true);
    });
});

describe('the options are read in one place', () => {
    // A listener that reads `config.turnHistory` itself is one `=== false` away from "unset means on".
    it('only config.ts and optional-features.ts name them as config properties', () => {
        const offenders = readdirSync(__dirname)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !['config.ts', 'optional-features.ts'].includes(f))
            .filter((f) => /\bconfig\.(turnHistory|keepAwake)\b/.test(readFileSync(join(__dirname, f), 'utf-8')));

        expect(offenders).toEqual([]);
    });
});

describe.skipIf(process.platform === 'win32')('loadConfig on a config.json that cannot be used', () => {
    it('gives the options off, not nothing, when it does not parse', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, BROKEN);

        expect(config.loadConfig()).toEqual(config.unreadableConfigDefaults);
    });

    it('gives the options off when anyone can write it (it is ignored)', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ turnHistory: false }));
        chmodSync(config.CONFIG_FILE, 0o666);

        expect(config.loadConfig()).toEqual(config.unreadableConfigDefaults);
    });

    it('gives nothing extra for a file that is not there, or an empty one', async () => {
        const config = await load();
        expect(config.loadConfig()).toEqual({});
        writeFileSync(config.CONFIG_FILE, ' \n');
        expect(config.loadConfig()).toEqual({});
    });

    it('does not turn them off in a readable file that leaves them out', async () => {
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_x' }));
        expect(config.loadConfig()).toEqual({ apiKey: 'ak_x' });
    });

    it('never writes the off values back: saving is refused', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, BROKEN);

        expect(() => config.saveConfig({ ...config.loadConfig(), apiKey: 'ak_new' })).toThrow(/not saving/);
        expect(readFileSync(config.CONFIG_FILE, 'utf-8')).toBe(BROKEN);
    });
});

describe.skipIf(process.platform === 'win32')('configIgnoredBecause', () => {
    it('says why, for a file that does not parse and for one anyone can write', async () => {
        quiet();
        const config = await load();
        expect(config.configIgnoredBecause()).toBeNull();

        writeFileSync(config.CONFIG_FILE, BROKEN);
        expect(config.configIgnoredBecause()).toMatch(/config\.json is not valid JSON/);

        writeFileSync(config.CONFIG_FILE, '{}');
        chmodSync(config.CONFIG_FILE, 0o666);
        expect(config.configIgnoredBecause()).toMatch(/can be written by anyone/);
        expect(config.configIgnoredBecause()).not.toMatch(/--key/);
    });

    it('is null for a good file and an empty one', async () => {
        const config = await load();
        writeFileSync(config.CONFIG_FILE, '{"apiKey":"ak_x"}');
        expect(config.configIgnoredBecause()).toBeNull();
        writeFileSync(config.CONFIG_FILE, '');
        expect(config.configIgnoredBecause()).toBeNull();
    });
});

describe('the options a listener runs with', () => {
    it('are off for both flags, off for the config, on only when nothing says no', async () => {
        const { optionalFeatures } = await import('./optional-features.js');
        expect(optionalFeatures({}, {})).toEqual({ turnHistory: true, keepAwake: true });
        expect(optionalFeatures({ 'no-turn-history': true }, {})).toEqual({ turnHistory: false, keepAwake: true });
        expect(optionalFeatures({ 'no-keep-awake': true }, {})).toEqual({ turnHistory: true, keepAwake: false });
        expect(optionalFeatures({}, { turnHistory: false, keepAwake: false })).toEqual({ turnHistory: false, keepAwake: false });
    });

    it.skipIf(process.platform === 'win32')('are both off when config.json cannot be used, whatever the key says', async () => {
        quiet();
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        const config = await load();
        writeFileSync(config.CONFIG_FILE, BROKEN);
        const { optionalFeatures } = await import('./optional-features.js');

        expect(optionalFeatures({ key: 'k' }, config.loadConfig())).toEqual({ turnHistory: false, keepAwake: false });
    });
});

describe.skipIf(process.platform === 'win32')('resolveBaseUrl', () => {
    it('takes the flag, then HWIP_BASE_URL, then the file, then the default API', async () => {
        const config = await load();
        const { DEFAULT_API_BASE } = await import('./ws-url.js');
        expect(config.resolveBaseUrl(undefined, {})).toBe(DEFAULT_API_BASE);
        // A bare `--base-url` parses as true, which is no URL.
        expect(config.resolveBaseUrl(true, {})).toBe(DEFAULT_API_BASE);
        expect(config.resolveBaseUrl(undefined, { baseUrl: 'https://file.example/v1' })).toBe('https://file.example/v1');
        vi.stubEnv('HWIP_BASE_URL', 'https://env.example/v1');
        expect(config.resolveBaseUrl(undefined, { baseUrl: 'https://file.example/v1' })).toBe('https://env.example/v1');
        expect(config.resolveBaseUrl('https://flag.example/v1', { baseUrl: 'https://file.example/v1' })).toBe('https://flag.example/v1');
    });

    // The file may hold the base the key belongs to; a key from the environment must not go to the default API instead.
    it('stops, naming the file, when it cannot read the file and nothing else says where the key goes', async () => {
        quiet();
        vi.stubEnv('HWIP_BASE_URL', '');
        const config = await load();
        writeFileSync(config.CONFIG_FILE, BROKEN);

        expect(() => config.resolveBaseUrl(undefined, config.loadConfig())).toThrow(/config\.json is not valid JSON.*--base-url/);
        expect(config.resolveBaseUrl('https://flag.example/v1', config.loadConfig())).toBe('https://flag.example/v1');
        vi.stubEnv('HWIP_BASE_URL', 'https://env.example/v1');
        expect(config.resolveBaseUrl(undefined, config.loadConfig())).toBe('https://env.example/v1');
    });

    it('stops for a baseUrl that is not text: it is no URL, and the caller would crash on it', async () => {
        const config = await load();
        vi.stubEnv('HWIP_BASE_URL', '');
        for (const odd of [true, 123, {}]) {
            expect(() => config.resolveBaseUrl(undefined, { baseUrl: odd as never })).toThrow(/"baseUrl" that is not text.*--base-url/);
        }
        expect(config.resolveBaseUrl('https://flag.example/v1', { baseUrl: true as never })).toBe('https://flag.example/v1');
    });

    // A file that is ignored on purpose (anyone can write it) is not trusted for a base URL either.
    it('uses the default API for a file that is ignored for its mode', async () => {
        quiet();
        vi.stubEnv('HWIP_BASE_URL', '');
        const config = await load();
        const { DEFAULT_API_BASE } = await import('./ws-url.js');
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ baseUrl: 'https://evil.example/v1' }));
        chmodSync(config.CONFIG_FILE, 0o666);

        expect(config.resolveBaseUrl(undefined, config.loadConfig())).toBe(DEFAULT_API_BASE);
        // ...and not an unreadable one either: its mode already says it is not to be believed.
        writeFileSync(config.CONFIG_FILE, BROKEN);
        chmodSync(config.CONFIG_FILE, 0o666);
        expect(config.resolveBaseUrl(undefined, config.loadConfig())).toBe(DEFAULT_API_BASE);
    });
});
