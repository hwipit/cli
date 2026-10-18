import { describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import { ensureSelfListed, registerOverApi, registerWhyText, unregisteredText, type RegisterWhy } from './self-register.js';

/** A real P-256 SPKI: \`samePublicKey\` reads the key, not the text. */
const newKey = async (): Promise<string> => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return Buffer.from(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))).toString('base64');
};

const SELF_ID = 'dev_listener_0a1b2c3d';

describe('ensureSelfListed', () => {
    it('leaves a list that holds this computer under its key as it is, and registers nothing', async () => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };
        const devices = [{ ...self, type: 'cli' }, { deviceId: 'dev_phone', type: 'ios' }];
        const register = vi.fn(async () => null);

        expect(await ensureSelfListed(devices, self, register)).toEqual({ ok: true, devices });
        expect(register).not.toHaveBeenCalled();
    });

    it('registers a computer missing from the list once, and adds it as the server made it', async () => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };
        const phone = { deviceId: 'dev_phone', type: 'ios' };
        const register = vi.fn(async () => null);

        expect(await ensureSelfListed([phone], self, register)).toEqual({ ok: true, devices: [phone, { ...self, type: 'cli' }] });
        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith(self);
    });

    it('registers a computer listed under another key, and keeps the rest of its entry', async () => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };
        const stale = { deviceId: SELF_ID, publicKey: await newKey(), type: 'cli', nickname: 'desk' };
        const register = vi.fn(async () => null);

        expect(await ensureSelfListed([stale], self, register)).toEqual({ ok: true, devices: [{ ...stale, publicKey: self.publicKey }] });
        expect(register).toHaveBeenCalledTimes(1);
    });

    it.each(['http 404', 'http 400', 'http 401', 'network', 'timeout'] as const)('says why when registering fails: %s', async (why) => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };

        expect(await ensureSelfListed([], self, async () => why)).toEqual({ ok: false, why });
    });

    // The server lets only a push:read key replace a listed key; an empty slot any of the three scopes may fill.
    it('names a 403 on replacing a listed key apart from a 403 on a missing one', async () => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };
        const stale = { deviceId: SELF_ID, publicKey: await newKey() };

        expect(await ensureSelfListed([stale], self, async () => 'http 403')).toEqual({ ok: false, why: 'replace-forbidden' });
        expect(await ensureSelfListed([], self, async () => 'http 403')).toEqual({ ok: false, why: 'http 403' });
    });
});

describe('registerOverApi', () => {
    const account = { apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' };
    const answering = (status: number) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(status === 201 ? '{"data":{}}' : null, { status }));

    it('PUTs this computer\'s key and the listener\'s name under its id, with the API key, never following a redirect', async () => {
        const fetchFn = answering(201);
        const publicKey = await newKey();

        expect(await registerOverApi(account, fetchFn)({ deviceId: SELF_ID, publicKey })).toBeNull();

        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0]!;
        expect(url).toBe(`https://api.example.com/v1/devices/${SELF_ID}/public-key`);
        expect(init?.method).toBe('PUT');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toMatchObject({ 'X-API-Key': 'ak_test', 'Content-Type': 'application/json' });
        expect(JSON.parse(init?.body as string)).toEqual({ publicKey, nickname: hostname() || 'listener' });
    });

    it.each([[200, null], [404, 'http 404'], [403, 'http 403'], [400, 'http 400'], [500, 'http 500']] as const)('reads %i as %s', async (status, why) => {
        expect(await registerOverApi(account, answering(status))({ deviceId: SELF_ID, publicKey: await newKey() })).toBe(why);
    });

    it('reads a connection that failed as network, and a deadline that passed as timeout', async () => {
        const self = { deviceId: SELF_ID, publicKey: await newKey() };
        const dropped = async () => { throw new TypeError('fetch failed'); };
        const late = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };

        expect(await registerOverApi(account, dropped)(self)).toBe('network');
        expect(await registerOverApi(account, late)(self)).toBe('timeout');
    });
});

describe('what a person reads', () => {
    it.each([
        ['http 404', 'the server answered HTTP 404'],
        ['network', 'could not reach the server'],
        ['timeout', 'the server did not answer in time'],
        ['replace-forbidden', 'the account lists another key for it, and only an API key with push:read may replace it'],
    ] as const)('%s', (why: RegisterWhy, text) => {
        expect(registerWhyText(why)).toBe(text);
    });

    it('names what was not sent, and no listener', () => {
        expect(unregisteredText('question', 'network')).toBe('could not register this machine\'s key in the account\'s device list (could not reach the server); the question was not sent');
        expect(unregisteredText('message')).not.toMatch(/listener/);
    });
});
