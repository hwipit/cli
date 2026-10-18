/**
 * C100: a call that carries the API key must not follow a redirect. undici drops
 * `authorization` and `cookie` across origins but sends every other header on, so
 * the `X-API-Key` of a keyed request reached whatever host the answer's Location
 * named (and an https answer could point it at plain http).
 *
 * Two real servers on 127.0.0.1: `front` answers every request with a 307 to
 * `target`, which records the headers it gets. Nothing leaves the machine.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiFetch, fitsInHeader } from './api.js';
import { liveDeps, requestApproval } from './ask.js';
import type { AskSealDeps } from './ask-seal.js';
import { HwipHook } from './hwip-hook.js';
import { registerOverApi } from './self-register.js';

const KEY = 'ak_SECRET_KEY_FOR_REDIRECT_TEST';

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; url: string }> =>
    new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    });

let front: { server: http.Server; url: string };
let target: { server: http.Server; url: string };
let seen: http.IncomingHttpHeaders[] = [];
let frontHits: string[] = [];

beforeAll(async () => {
    target = await listen((req, res) => {
        seen.push(req.headers);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [], pagination: { hasMore: false } }));
    });
    front = await listen((req, res) => {
        frontHits.push(`${req.method} ${req.url}`);
        res.statusCode = 307;
        res.setHeader('Location', `${target.url}/elsewhere`);
        res.end();
    });
});
afterAll(() => {
    front.server.close();
    target.server.close();
});

/** A real P-256 SPKI: the seal checks that this machine's key is one. */
const newKey = async (): Promise<string> => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return Buffer.from(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))).toString('base64');
};

/** A question that seals without the keystore or the device list, so its trigger and polls are all the API sees. */
const sealsHere = async (): Promise<AskSealDeps> => {
    const self = { deviceId: 'dev_listener_0000aaaa', publicKey: await newKey() };
    const phone = { deviceId: 'dev_phone', type: 'ios', publicKey: await newKey() };
    return {
        loadKeys: async () => undefined,
        self: () => self,
        listDevices: async () => [{ ...self, type: 'cli' }, phone],
        register: async () => null,
        trustPath: join(mkdtempSync(join(tmpdir(), 'hwip-redirect-')), 'trusted-devices.json'),
        seal: async () => ({ isEncrypted: true, body: 'sealed', senderPublicKey: self.publicKey, deviceKeyMap: { dev_phone: 'wrapped' } }),
    };
};

const keyReachedTarget = (): boolean => seen.some((headers) => JSON.stringify(headers).includes(KEY));

describe('a keyed call does not follow a redirect', () => {
    it('HwipHook (notify, list, …)', async () => {
        seen = [];
        const hook = new HwipHook({ apiKey: KEY, baseUrl: front.url, timeout: 3_000 });

        await expect(hook.list()).rejects.toThrow(/redirect/i);

        expect(seen).toEqual([]);
        expect(keyReachedTarget()).toBe(false);
    });

    it('apiFetch (the listener\'s own calls to the API)', async () => {
        seen = [];

        await expect(apiFetch(fetch, `${front.url}/x`, KEY, 3_000)).rejects.toThrow();

        expect(seen).toEqual([]);
    });

    // C106: apiFetch's callers (the listener, the device directory, the turn recorder) log what it throws.
    it('apiFetch says what happened too — a redirect, and which host — instead of "fetch failed"', async () => {
        const err = await apiFetch(fetch, `${front.url}/x?apiKey=${KEY}`, KEY, 3_000).then(() => null, (e: unknown) => e as Error);

        const host = new URL(front.url).host;
        expect(err).toBeInstanceOf(TypeError);
        expect(err?.message).toBe(`${host} answered with a redirect, and hwip does not follow one with your API key — check the base URL (${host})`);
        expect(err?.message).not.toContain(KEY);
        // The original is kept for whoever wants the detail.
        expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    });

    // `fetch` quotes a header value it cannot send, and that value is the key: a caller that logs what this throws would log it.
    it.each([
        ['a line break', 'ak_live_abc\nSECRETTAIL'],
        ['a bell', 'ak_live_abc\u0007SECRETTAIL'],
    ])('apiFetch says a key with %s in it could not be sent, and quotes none of it', async (_, key) => {
        seen = [];
        const err = await apiFetch(fetch, `${front.url}/x`, key, 3_000).then(() => null, (e: unknown) => e);

        expect(seen).toEqual([]);
        expect(err).toBeInstanceOf(TypeError);
        expect(err).toMatchObject({ message: 'a header could not be sent — check the API key for stray characters' });
    });

    // C152: the same for an address with a password in it, which `fetch` quotes whole. No cause either: its words are the address.
    it('apiFetch says an address with a user name and password in it cannot be used, and keeps none of it', async () => {
        frontHits = [];
        const err = await apiFetch(fetch, `${front.url.replace('://', '://alice:s3"cr et@')}/x`, KEY, 3_000).then(() => null, (e: unknown) => e);

        expect(frontHits).toEqual([]);
        expect(err).toBeInstanceOf(TypeError);
        const said = err instanceof Error ? err : new Error('nothing thrown');
        expect(said.message).toMatch(/^the base URL has a user name or password in it/);
        expect(said.message).not.toMatch(/alice|s3|cr et/);
        expect(said.cause).toBeUndefined();
    });

    // A password with a `#` in it makes the address one that does not parse, and `fetch` quotes that one whole as well.
    it('apiFetch says an address that is not one cannot be used, and keeps none of it', async () => {
        const err = await apiFetch(fetch, 'https://alice:pa#ss@127.0.0.1/x', KEY, 3_000).then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(TypeError);
        const said = err instanceof Error ? err : new Error('nothing thrown');
        expect(said.message).toMatch(/^the base URL is not a valid address/);
        expect(said.message).not.toMatch(/alice|pa#ss|127\.0\.0\.1/);
        expect(said.cause).toBeUndefined();
    });

    it('apiFetch leaves every other failure as fetch threw it', async () => {
        const dropped = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

        await expect(apiFetch(async () => { throw dropped; }, 'https://api.example.com/x', KEY, 3_000)).rejects.toBe(dropped);
    });

    it('the PUT that registers this computer\'s key', async () => {
        seen = [];
        frontHits = [];

        expect(await registerOverApi({ apiKey: KEY, baseUrl: front.url })({ deviceId: 'dev_listener_0000aaaa', publicKey: await newKey() })).toBe('network');

        expect(frontHits).toEqual(['PUT /devices/dev_listener_0000aaaa/public-key']);
        expect(seen).toEqual([]);
    });

    it('the device list a question or a message is sealed from', async () => {
        seen = [];

        await expect(liveDeps({ apiKey: KEY, baseUrl: front.url }).seal.listDevices()).rejects.toThrow('redirect');

        expect(seen).toEqual([]);
    });

    it('hwip ask (trigger and poll)', async () => {
        seen = [];

        const outcome = await requestApproval(
            { apiKey: KEY, baseUrl: front.url, hookId: 'hook_x', title: 't', body: 'b', actions: [], timeoutSeconds: 1 },
            { fetchFn: fetch, now: () => Date.now(), sleep: async () => undefined, seal: await sealsHere() },
        );

        expect(outcome.answered).toBe(false);
        expect(seen).toEqual([]);
    });

    // A refused redirect is a TypeError like a dropped connection, which ask retries; the server got the request, so a retry is a second push.
    it('hwip ask does not send the question a second time because of it', async () => {
        frontHits = [];

        await requestApproval(
            { apiKey: KEY, baseUrl: front.url, hookId: 'hook_x', title: 't', body: 'b', actions: [], timeoutSeconds: 60 },
            { fetchFn: fetch, now: () => Date.now(), sleep: async () => undefined, seal: await sealsHere() },
        );

        expect(frontHits.filter((hit) => hit.startsWith('POST'))).toHaveLength(1);
    });

    it('says what happened: a redirect, and which host answered with it', async () => {
        const hook = new HwipHook({ apiKey: KEY, baseUrl: front.url, timeout: 3_000 });

        const err = await hook.list().then(() => null, (e: unknown) => e as Error);

        expect(err?.message).toBe(`${new URL(front.url).host} answered with a redirect, and hwip does not follow one with your API key — check the base URL (${new URL(front.url).host})`);
        expect(err?.message).not.toContain(KEY);
    });
});

// C150: configuration failures are said before anything is tried — no fetch, no secret in a cause.
describe('apiFetch says a broken configuration before trying anything', () => {
    const spyFetch = (calls: string[]): typeof fetch =>
        (async (input: unknown) => { calls.push(String(input)); throw new Error('must not be called'); }) as unknown as typeof fetch;

    it('a key that cannot travel in a header never reaches fetch, and names none of itself', async () => {
        const calls: string[] = [];
        const err = await apiFetch(spyFetch(calls), `${front.url}/x`, 'ak_live_abc\nSECRETTAIL', 3_000).then(() => null, (e: unknown) => e as Error);
        expect(calls).toEqual([]);
        expect(err).toBeInstanceOf(TypeError);
        expect(err?.message).toBe('a header could not be sent — check the API key for stray characters');
        expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
        expect(JSON.stringify(err?.message)).not.toContain('SECRET');
        expect(fitsInHeader('ak_live_abc\nSECRETTAIL')).toBe(false);
        expect(fitsInHeader(KEY)).toBe(true);
    });

    // fetch trims white space at either end of a header value and sends Latin-1, so a key saved with a
    // trailing newline (or one with a Latin-1 character) still works — the same rule as mcp-server's.
    it('a key with a trailing newline or a Latin-1 character still fits in a header', () => {
        expect(fitsInHeader(`${KEY}\n`)).toBe(true);
        expect(fitsInHeader(`${KEY}\r\n`)).toBe(true);
        expect(fitsInHeader(` ${KEY}\t`)).toBe(true);
        expect(fitsInHeader(`${KEY}\u00e9`)).toBe(true);
        expect(fitsInHeader(`${KEY}\u0100`)).toBe(false);
        expect(fitsInHeader(`${KEY}\u0000`)).toBe(false);
        expect(() => new Headers({ 'X-API-Key': `${KEY}\r\n` })).not.toThrow();
    });

    it('an address with a user name and password in it never reaches fetch', async () => {
        const calls: string[] = [];
        const err = await apiFetch(spyFetch(calls), `${front.url.replace('://', '://alice:s3cret@')}/x`, KEY, 3_000).then(() => null, (e: unknown) => e as Error);
        expect(calls).toEqual([]);
        expect(err).toBeInstanceOf(TypeError);
        expect(err?.message).toMatch(/user name or password/);
        expect(err?.message).not.toContain('s3cret');
    });

    it('an address that is not one never reaches fetch', async () => {
        const calls: string[] = [];
        const err = await apiFetch(spyFetch(calls), 'not a url at all', KEY, 3_000).then(() => null, (e: unknown) => e as Error);
        expect(calls).toEqual([]);
        expect(err).toBeInstanceOf(TypeError);
        expect(err?.message).toMatch(/not a valid address/);
    });
});
