import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutboxChunk } from './turn-recorder.js';

// The recorder's real I/O against fakes: a loopback HTTP server that answers
// like the sessions-turns route (hwip server/SERVER-API.md), and the real push-v1
// envelope on a throwaway device key. Nothing here touches the account API.

const CHUNK: OutboxChunk = {
    seq: 178_900_000_001,
    firstAt: '2026-10-02T00:00:01.000Z',
    lastAt: '2026-10-02T00:00:09.000Z',
    sealed: { body: '{"ciphertext":"AAAA","iv":"BBBB"}', deviceKeyMap: { dev_phone: '{"encryptedKey":"k","keyIv":"i"}' }, senderPublicKey: 'pub' },
};

interface Seen { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }

let server: Server;
let seen: Seen[];
let answer: (res: ServerResponse, n: number) => void;
let base: string;

beforeEach(async () => {
    seen = [];
    answer = (res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"data":{}}'); };
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            answer(res, seen.length);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
});

const reply = (res: ServerResponse, status: number, error?: { code: string; details?: object }, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(error ? { error: { ...error, message: 'm', status } } : { data: {} }));
};

describe('createChunkUploader', () => {
    const uploader = async (extra: { perMinute?: number; now?: () => number } = {}) => {
        const { createChunkUploader } = await import('./turn-recorder-wire.js');
        return createChunkUploader({ baseUrl: base, apiKey: 'ak_test', ...extra });
    };

    it('posts the stored chunk to the session\'s turns route with the account key', async () => {
        const upload = await uploader();
        expect(await upload('dev_listener_x:hwip-app', CHUNK)).toEqual({ kind: 'ok' });

        expect(seen).toHaveLength(1);
        expect(seen[0]!.method).toBe('POST');
        expect(seen[0]!.url).toBe('/v1/sessions/dev_listener_x%3Ahwip-app/turns');
        expect(seen[0]!.headers['x-api-key']).toBe('ak_test');
        expect(JSON.parse(seen[0]!.body)).toEqual({ seq: CHUNK.seq, firstAt: CHUNK.firstAt, lastAt: CHUNK.lastAt, sealed: CHUNK.sealed });
    });

    it('separate runs: names the chunk\'s run in the body', async () => {
        const upload = await uploader();
        await upload('dev_listener_x:hwip-app', { ...CHUNK, runId: '1790000000' });

        expect(JSON.parse(seen[0]!.body)).toEqual({ seq: CHUNK.seq, firstAt: CHUNK.firstAt, lastAt: CHUNK.lastAt, runId: '1790000000', sealed: CHUNK.sealed });
    });

    it('sends the same bytes every time, and takes a repeat (200) as stored', async () => {
        answer = (res, n) => reply(res, n === 1 ? 201 : 200);
        const upload = await uploader();
        await upload('k:s', CHUNK);
        await upload('k:s', CHUNK);
        expect(seen[0]!.body).toBe(seen[1]!.body);
    });

    it.each([
        [500, undefined, 'retry'],
        [503, undefined, 'retry'],
        [408, undefined, 'retry'],
        [403, { code: 'FORBIDDEN' }, 'pause'],
        [401, { code: 'UNAUTHORIZED' }, 'pause'],
        [404, { code: 'NOT_FOUND' }, 'pause'],
        // These two will never succeed with these bytes: waiting would block the session for good.
        [400, { code: 'VALIDATION_ERROR' }, 'drop'],
        [409, { code: 'TURN_CONFLICT' }, 'drop'],
    ])('HTTP %i → %s', async (status, error, kind) => {
        answer = (res) => reply(res, status, error);
        const outcome = await (await uploader())('k:s', CHUNK);
        expect(outcome.kind).toBe(kind);
        expect('why' in outcome ? outcome.why : '').toContain(`HTTP ${status}`);
    });

    it('looks again soon after a 403: the key may only just have been registered', async () => {
        answer = (res) => reply(res, 403, { code: 'FORBIDDEN' });
        const before = Date.now();
        const outcome = await (await uploader())('k:s', CHUNK);
        expect(outcome.kind).toBe('pause');
        const until = (outcome as { untilMs?: number }).untilMs!;
        expect(until - before).toBeGreaterThanOrEqual(4 * 60_000);
        expect(until - before).toBeLessThan(6 * 60_000);
    });

    it('marks a 409 as a conflict, and a 403 as one to give up on after five', async () => {
        answer = (res) => reply(res, 409, { code: 'TURN_CONFLICT' });
        expect(await (await uploader())('k:s', CHUNK)).toMatchObject({ kind: 'drop', conflict: true });
        answer = (res) => reply(res, 400, { code: 'VALIDATION_ERROR' });
        expect(await (await uploader())('k:s', CHUNK)).not.toHaveProperty('conflict');
        answer = (res) => reply(res, 403, { code: 'FORBIDDEN' });
        expect(await (await uploader())('k:s', CHUNK)).toMatchObject({ kind: 'pause', giveUpAfter: 5 });
    });

    it('waits what Retry-After says on a per-minute limit', async () => {
        answer = (res) => reply(res, 429, { code: 'RATE_LIMIT_EXCEEDED', details: { retryAfter: 7 } }, { 'retry-after': '7' });
        expect(await (await uploader())('k:s', CHUNK)).toMatchObject({ kind: 'retry', afterMs: 7000 });
    });

    it('leaves the session alone until the day\'s cap resets', async () => {
        const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString();
        answer = (res) => reply(res, 429, { code: 'TURN_DAILY_LIMIT', details: { resource: 'chunks', limit: 2000, resetAt } });
        expect(await (await uploader())('k:s', CHUNK)).toEqual({ kind: 'pause', why: 'HTTP 429 TURN_DAILY_LIMIT', untilMs: Date.parse(resetAt) });
    });

    // C150: a broken configuration fails the same way on every try — pause, don't retry with backoff.
    it('a configuration failure pauses the session instead of retrying with backoff', async () => {
        const { createChunkUploader } = await import('./turn-recorder-wire.js');
        const upload = createChunkUploader({ baseUrl: 'https://alice:s3cret@example.test/v1', apiKey: 'k' });
        const outcome = await upload('k:s', CHUNK);
        expect(outcome).toMatchObject({ kind: 'pause', why: expect.stringMatching(/user name or password/) });
        expect(JSON.stringify(outcome)).not.toContain('s3cret');
    });

    it('a network failure is a retry', async () => {
        const { createChunkUploader } = await import('./turn-recorder-wire.js');
        const upload = createChunkUploader({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' });
        expect((await upload('k:s', CHUNK)).kind).toBe('retry');
    });

    // C110: a refused redirect is a TypeError like a dropped connection, but the base URL does it on every try.
    it('a redirect it refuses to follow pauses the session instead of retrying with backoff', async () => {
        answer = (res) => { res.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }); res.end(); };

        const outcome = await (await uploader())('k:s', CHUNK);

        expect(outcome).toMatchObject({ kind: 'pause', why: expect.stringMatching(/answered with a redirect, and hwip does not follow one with your API key/) });
        // Nothing to give up after: the chunk stays queued, and the pause is the recorder's usual one.
        expect(outcome).not.toHaveProperty('giveUpAfter');
        expect(seen).toHaveLength(1);
        expect(JSON.stringify(outcome)).not.toContain('ak_test');
    });

    it('keeps to its own share of the per-minute budget', async () => {
        let at = 1_000_000;
        const upload = await uploader({ perMinute: 2, now: () => at });
        await upload('k:s', CHUNK);
        await upload('k:s', CHUNK);
        const third = await upload('k:s', CHUNK);
        expect(third).toMatchObject({ kind: 'retry' });
        expect(seen).toHaveLength(2);
        at += 61_000;
        expect(await upload('k:s', CHUNK)).toEqual({ kind: 'ok' });
    });
});

describe('the sealed chunk', () => {
    let home: string;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'recorder-crypto-'));
        for (const k of ['HOME', 'XDG_CONFIG_HOME']) { saved[k] = process.env[k]; delete process.env[k]; }
        process.env.HOME = home;
        vi.resetModules();
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        rmSync(home, { recursive: true, force: true });
    });

    const phone = async (): Promise<{ publicKey: string }> => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
        return { publicKey: Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64') };
    };

    it('opens, on this machine, as {sessionKey, seq, events} — and holds no plaintext', async () => {
        const { sealChunk } = await import('./turn-recorder-wire.js');
        const { initDeviceCrypto, decryptPushBodyForDevice } = await import('./crypto.js');
        const self = await initDeviceCrypto();
        const other = await phone();
        const plaintext = JSON.stringify({ sessionKey: 'dev_x:hwip-a', seq: 5, events: [{ kind: 'prompt', text: 'the password is hunter2' }] });

        const sealed = await sealChunk(plaintext, [{ deviceId: 'dev_self', publicKey: self }, { deviceId: 'dev_phone', publicKey: other.publicKey }]);

        expect(Object.keys(sealed.deviceKeyMap).sort()).toEqual(['dev_phone', 'dev_self']);
        expect(sealed.senderPublicKey).toBe(self);
        expect(JSON.stringify(sealed)).not.toContain('hunter2');
        const opened = await decryptPushBodyForDevice(sealed.body, sealed.deviceKeyMap.dev_self!, sealed.senderPublicKey);
        expect(JSON.parse(opened.body!)).toEqual(JSON.parse(plaintext));
    });

    describe('accountRecipients', () => {
        const setup = async (listed: () => Promise<{ deviceId: string; publicKey?: string }[]>) => {
            const { accountRecipients } = await import('./turn-recorder-wire.js');
            const { initDeviceCrypto } = await import('./crypto.js');
            const self = await initDeviceCrypto();
            const trustFile = join(home, 'trusted-devices.json');
            const logged: string[] = [];
            return { self, trustFile, logged, recipients: accountRecipients({ trustFile, deviceId: 'dev_self', devices: listed, log: (m) => logged.push(m) }) };
        };
        const pinsOf = (trustFile: string): string[] => Object.keys(JSON.parse(readFileSync(trustFile, 'utf8')).devices);

        it('lists this machine and every device that lists a key, pinned or not, and pins them on the way', async () => {
            const [a, b] = [await phone(), await phone()];
            const { self, trustFile, recipients } = await setup(async () => [
                { deviceId: 'dev_self', publicKey: 'ignored-self-key' },
                { deviceId: 'dev_phone', publicKey: a.publicKey },
                { deviceId: 'dev_old' },
                { deviceId: 'dev_tablet', publicKey: b.publicKey },
            ]);

            const chosen = await recipients();

            expect(chosen.map((r) => r.deviceId).sort()).toEqual(['dev_phone', 'dev_self', 'dev_tablet']);
            expect(chosen.find((r) => r.deviceId === 'dev_self')!.publicKey).toBe(self);
            expect(pinsOf(trustFile).sort()).toEqual(['dev_phone', 'dev_tablet']);
        });

        it('is nobody when the account lists no device but this machine', async () => {
            const { self, recipients } = await setup(async () => []);
            expect(await recipients()).toEqual([]);
            expect(self).toBeTruthy();
        });

        it('seals for the key the list gives now, when a device changed its key', async () => {
            const [old, fresh] = [await phone(), await phone()];
            const { trustFile, logged, recipients } = await setup(async () => [{ deviceId: 'dev_phone', publicKey: fresh.publicKey }]);
            writeFileSync(trustFile, JSON.stringify({ version: 1, devices: { dev_phone: { publicKey: old.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } } }));

            expect((await recipients()).find((r) => r.deviceId === 'dev_phone')!.publicKey).toBe(fresh.publicKey);
            expect(JSON.parse(readFileSync(trustFile, 'utf8')).devices.dev_phone.publicKey).toBe(fresh.publicKey);
            expect(logged.join('\n')).toContain('dev_phone changed its key');
        });

        it('is nobody, with one log line, when the device list cannot be had — the old pins do not stand in', async () => {
            const old = await phone();
            const { trustFile, logged, recipients } = await setup(async () => { throw new Error('devices 503'); });
            writeFileSync(trustFile, JSON.stringify({ version: 1, devices: { dev_phone: { publicKey: old.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } } }));

            expect(await recipients()).toEqual([]);
            expect(logged).toHaveLength(1);
            expect(logged[0]).toContain('devices 503');
        });

        it('still seals for the list when the trust file cannot be read, and says the pins were not checked', async () => {
            const a = await phone();
            const { trustFile, logged, recipients } = await setup(async () => [{ deviceId: 'dev_phone', publicKey: a.publicKey }]);
            writeFileSync(trustFile, '{ not json');

            expect((await recipients()).map((r) => r.deviceId).sort()).toEqual(['dev_phone', 'dev_self']);
            expect(readFileSync(trustFile, 'utf8')).toBe('{ not json');
            expect(logged.join('\n')).toContain('unreadable');
        });

        it('keeps this machine and the newest pins within the slot limit', async () => {
            const { RECORDER_MAX_RECIPIENTS } = await import('./turn-recorder.js');
            const keys = await Promise.all(Array.from({ length: RECORDER_MAX_RECIPIENTS + 5 }, () => phone()));
            const listed = keys.map((k, i) => ({ deviceId: `dev_${i}`, publicKey: k.publicKey }));
            // Listed oldest-pin first, so only the pin dates put the newest ones in.
            const { trustFile, recipients } = await setup(async () => [...listed].reverse());
            // dev_0 and dev_1 are the newest pins; the rest are older, so they are the ones cut.
            const pins = Object.fromEntries(listed.map((d, i) => [d.deviceId, { publicKey: d.publicKey, pinnedAt: new Date(Date.UTC(2026, 9, 1) + (i < 2 ? 1e9 - i * 1000 : -i * 1000)).toISOString() }]));
            writeFileSync(trustFile, JSON.stringify({ version: 1, devices: pins }));

            const chosen = await recipients();

            expect(chosen).toHaveLength(RECORDER_MAX_RECIPIENTS);
            expect(chosen[0]!.deviceId).toBe('dev_self');
            expect(chosen.slice(1, 3).map((r) => r.deviceId)).toEqual(['dev_0', 'dev_1']);
            expect(chosen.map((r) => r.deviceId)).not.toContain(`dev_${RECORDER_MAX_RECIPIENTS + 4}`);
        });
    });
});

describe('createLatestSeqReader', () => {
    const reader = async () => {
        const { createLatestSeqReader } = await import('./turn-recorder-wire.js');
        return createLatestSeqReader({ baseUrl: base, apiKey: 'ak_test' });
    };

    it('asks for the newest chunk of the session and returns its seq', async () => {
        answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ seq: 178_900_000_007 }], pagination: { hasMore: true } })); };
        expect(await (await reader())('dev_l:hwip-app')).toBe(178_900_000_007);
        expect(seen[0]!.method).toBe('GET');
        expect(seen[0]!.url).toBe('/v1/sessions/dev_l%3Ahwip-app/turns?limit=1');
        expect(seen[0]!.headers['x-api-key']).toBe('ak_test');
    });

    it.each([
        ['an empty session', 200, { data: [] }],
        ['a server error', 500, { error: { code: 'INTERNAL' } }],
        ['a seq that is not a number', 200, { data: [{ seq: 'x' }] }],
    ])('is null for %s', async (_name, status, body) => {
        answer = (res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        expect(await (await reader())('k:s')).toBeNull();
    });

    it('is null when the server cannot be reached', async () => {
        const { createLatestSeqReader } = await import('./turn-recorder-wire.js');
        expect(await createLatestSeqReader({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' })('k:s')).toBeNull();
    });
});
