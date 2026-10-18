import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedUpdateNotice, handleCheckUpdate, UPDATE_HINT } from './check-update.js';
import { VERSION } from './config.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-update-'));
    file = join(dir, 'update-check.json');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
});

describe('cachedUpdateNotice', () => {
    it('asks npm when there is no answer yet, and names npm i -g', async () => {
        const latest = vi.fn(async () => '999.0.0');

        const notice = await cachedUpdateNotice({ now: () => 1_000, latest, file, env: {} });

        expect(latest).toHaveBeenCalledOnce();
        expect(notice).toBe(`hwip: v999.0.0 is out (this is v${VERSION}). Update: ${UPDATE_HINT}`);
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ checkedAt: 1_000, latest: '999.0.0' });
    });

    it('asks at most once a day', async () => {
        writeFileSync(file, JSON.stringify({ checkedAt: 1_000, latest: '999.0.0' }));
        const latest = vi.fn(async () => '999.0.1');

        expect(await cachedUpdateNotice({ now: () => 1_000 + DAY - 1, latest, file, env: {} })).toContain('v999.0.0');
        expect(latest).not.toHaveBeenCalled();

        expect(await cachedUpdateNotice({ now: () => 1_000 + DAY, latest, file, env: {} })).toContain('v999.0.1');
        expect(latest).toHaveBeenCalledOnce();
    });

    it('treats a checkedAt in the future as stale', async () => {
        writeFileSync(file, JSON.stringify({ checkedAt: 10 * DAY, latest: VERSION }));
        const latest = vi.fn(async () => '999.0.0');

        expect(await cachedUpdateNotice({ now: () => DAY, latest, file, env: {} })).toContain('v999.0.0');
    });

    it('never asks npm under CI or HWIP_NO_UPDATE_CHECK', async () => {
        const latest = vi.fn(async () => '999.0.0');

        expect(await cachedUpdateNotice({ now: () => 1, latest, file, env: { CI: 'true' } })).toBeUndefined();
        expect(await cachedUpdateNotice({ now: () => 1, latest, file, env: { HWIP_NO_UPDATE_CHECK: '1' } })).toBeUndefined();
        expect(latest).not.toHaveBeenCalled();
    });

    it('keeps the last known version on an offline day, and stays quiet when current', async () => {
        writeFileSync(file, JSON.stringify({ checkedAt: 0, latest: VERSION }));

        expect(await cachedUpdateNotice({ now: () => DAY, latest: async () => null, file, env: {} })).toBeUndefined();
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ checkedAt: DAY, latest: VERSION });
    });
});

describe('hwip check-update', () => {
    // It said `npx @hwip/cli install`, which re-ran setup and left the global install old.
    it('tells an outdated user to npm i -g and restart the listener', async () => {
        vi.stubEnv('HOME', dir);
        vi.stubGlobal('fetch', (async () => ({ ok: true, json: async () => ({ version: '999.0.0' }) })) as unknown as typeof fetch);
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });

        await handleCheckUpdate({});

        expect(logs.join('\n')).toContain(`Update with: ${UPDATE_HINT}`);
        expect(logs.join('\n')).not.toContain('npx @hwip/cli install');
    });
});
