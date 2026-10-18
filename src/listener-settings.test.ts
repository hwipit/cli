/**
 * C111/C112 at the listener: the options it starts with and where its key goes, from the flags,
 * the environment and `~/.hwip/config.json`. The daemon cannot be started in a test, so its start-up
 * reads them through `listenerSettings`. Every file is under a temp HOME (src/test-setup.ts).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const settingsFor = async (file: string | null, args: Record<string, string | boolean> = {}, mode = 0o600) => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { CONFIG_DIR, CONFIG_FILE } = await import('./config.js');
    mkdirSync(CONFIG_DIR, { recursive: true });
    rmSync(CONFIG_FILE, { force: true });
    if (file !== null) {
        writeFileSync(CONFIG_FILE, file);
        chmodSync(CONFIG_FILE, mode);
    }
    const { listenerSettings } = await import('./listener.js');
    return listenerSettings(args);
};
const BROKEN = '{ "apiKey": "ak_file", "turnHistory": false, "keepAwake": false, "baseUrl": "https://stage.example/v1", }';

describe.skipIf(process.platform === 'win32')('what the listener starts with', () => {
    it('honours a good config: the opt-outs it holds, the base URL it names', async () => {
        vi.stubEnv('HWIP_API_KEY', '');
        vi.stubEnv('HWIP_BASE_URL', '');
        const settings = await settingsFor('{ "apiKey": "ak_file", "turnHistory": false, "baseUrl": "https://stage.example/v1" }');

        expect(settings).toMatchObject({ apiKey: 'ak_file', baseUrl: 'https://stage.example/v1', features: { turnHistory: false, keepAwake: true }, ignored: null });
    });

    it('turns on only what nothing says no to', async () => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        expect(await settingsFor('{}')).toMatchObject({ features: { turnHistory: true, keepAwake: true } });
        expect(await settingsFor(null, { 'no-turn-history': true })).toMatchObject({ features: { turnHistory: false, keepAwake: true } });
        expect(await settingsFor(null, { 'no-keep-awake': true })).toMatchObject({ features: { turnHistory: true, keepAwake: false } });
        expect(await settingsFor('{ "keepAwake": false }')).toMatchObject({ features: { turnHistory: true, keepAwake: false } });
    });

    // C116/C117: an opt-out written in a shape the code did not expect is still an opt-out.
    it.each(['"false"', '0', 'null', '"off"', '"no"'])('reads "turnHistory" and "keepAwake" of %s in config.json as off', async (value) => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_BASE_URL', '');
        expect(await settingsFor(`{ "turnHistory": ${value}, "keepAwake": ${value} }`)).toMatchObject({ features: { turnHistory: false, keepAwake: false } });
    });

    it.each(['true', '1', 'yes'])('--no-turn-history and --no-keep-awake given as =%s turn both off', async (value) => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        expect(await settingsFor(null, { 'no-turn-history': value, 'no-keep-awake': value })).toMatchObject({ features: { turnHistory: false, keepAwake: false } });
    });

    it('reports a flag typed wrong before a missing key', async () => {
        vi.stubEnv('HWIP_API_KEY', '');
        expect(await settingsFor(null, { 'no-keep-awake': 'sometimes' })).toMatchObject({ exit: 2 });
    });

    it('stops with exit 2 on a flag value that is neither yes nor no', async () => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        expect(await settingsFor(null, { 'no-turn-history': 'maybe' })).toEqual({ exit: 2, message: 'hwip listener: --no-turn-history takes true or false (or nothing, which is true), not "maybe"' });
    });

    // C111: the file's opt-outs are unknown, the key came from the environment: nothing is switched back on.
    it('runs with every option off, and says why, when config.json does not parse', async () => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_BASE_URL', 'https://stage.example/v1');

        const settings = await settingsFor(BROKEN);

        expect(settings).toMatchObject({ apiKey: 'env_key', features: { turnHistory: false, keepAwake: false } });
        expect(settings).toMatchObject({ ignored: expect.stringMatching(/config\.json is not valid JSON/) });
    });

    it('runs with every option off when anyone can write config.json (it is ignored)', async () => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        const settings = await settingsFor('{ "turnHistory": true }', {}, 0o666);

        expect(settings).toMatchObject({ features: { turnHistory: false, keepAwake: false }, ignored: expect.stringMatching(/can be written by anyone/) });
    });

    // C112: the file may hold the base the key belongs to.
    it('stops with exit 1, naming the file, when the key has no known base URL', async () => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_BASE_URL', '');

        expect(await settingsFor(BROKEN)).toMatchObject({ exit: 1, message: expect.stringMatching(/^hwip listener: .*config\.json is not valid JSON.*--base-url/) });
        expect(await settingsFor(BROKEN, { 'base-url': 'https://stage.example/v1' })).toMatchObject({ baseUrl: 'https://stage.example/v1' });
    });

    // The launchd service has no key in its environment: it exits 3 every 30 s, and the log must not send the user to `hwip install`, which refuses here.
    it('says the key is in the file it cannot read, not that none was given', async () => {
        vi.stubEnv('HWIP_API_KEY', '');

        const settings = await settingsFor(BROKEN);

        expect(settings).toMatchObject({ exit: 3, message: expect.stringMatching(/no API key — .*config\.json is not valid JSON.*fixed or moved aside/) });
        expect(await settingsFor(null)).toMatchObject({ exit: 3, message: expect.stringMatching(/API key required\. Run `hwip install`/) });
    });
});

// The daemon cannot be started here, so the two places it hands `features` on are read from the source:
// a start-up that recomputed them, or hard-coded them on, would be the C111 break again.
describe('the listener acts on what listenerSettings says', () => {
    const source = readFileSync(join(__dirname, 'listener.ts'), 'utf-8');

    it('starts the recorder and keep-awake from the settings, and logs why the options are off', () => {
        expect(source).toContain('startTurnRecorder(features, apiKey, baseUrl, deviceDirectory.devices);');
        expect(source).toContain('enabled: features.keepAwake,');
        expect(source).toMatch(/if \(ignored\) \{\n\s+log\(`! \$\{ignored\} — running with the options off/);
        expect(source).toContain('const settings = listenerSettings(args);');
        expect(source).toContain('const { config, apiKey, baseUrl, features, ignored } = settings;');
    });
});
