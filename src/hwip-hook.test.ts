import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeKeyChanges } from './key-changes.js';

// HwipHook.notify branches by payload size:
//   - body ≤ 512 bytes → POST /pushes/send with the full body inline
//   - body > 512 bytes → request upload URL, PUT to S3, then send the push
//                        with a 200-char preview body + a file attachment
//
// Crypto module has module-scope state (initPromise + cachedKeyPair) so we
// dynamic-import everything inside each test, after vi.resetModules(), to
// guarantee a fresh graph. The errors module also has to come from the
// same fresh graph for instanceof checks to succeed.

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
let lastCalls: Array<{ url: string; init: RequestInit | undefined }>;
/** `PUT /devices/{self}/public-key` calls, answered apart from the sequence: this computer is on no test's list. */
let registered: Array<{ url: string; init: RequestInit | undefined }>;
let registerStatus: number;

const sequenceResponses = (responses: Array<{ ok: boolean; status?: number; json?: unknown }>) => {
    let i = 0;
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
        if (String(url).endsWith('/public-key')) {
            registered.push({ url: String(url), init: init as RequestInit | undefined });
            return { ok: registerStatus < 300, status: registerStatus, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        }
        lastCalls.push({ url: String(url), init: init as RequestInit | undefined });
        const r = responses[Math.min(i++, responses.length - 1)];
        return {
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 500),
            json: async () => r.json,
        } as unknown as Response;
    });
};

/** A real P-256 SPKI: an unusable key makes sealing fail, and the send would fail before the thing under test. */
const newKey = async (): Promise<string> => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return Buffer.from(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))).toString('base64');
};
const device = async (deviceId: string, type: string) => ({ deviceId, type, publicKey: await newKey() });
const list = (...devices: unknown[]) => ({ ok: true, json: { data: devices } });
/** The answer of `GET /devices` for an account with one signed-in phone: what every send reads first. */
const phoneList = async () => list(await device('dev_phone', 'ios'));

const loadHookModule = async () => {
    vi.resetModules();
    const mod = await import('./hwip-hook.js');
    const errors = await import('./errors.js');
    return { HwipHook: mod.HwipHook, ...errors };
};

// This computer's keys and trust file live under HOME: every test gets its own.
let TMP: string;

beforeEach(() => {
    lastCalls = [];
    registered = [];
    registerStatus = 200;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TMP = mkdtempSync(join(tmpdir(), 'sdk-hook-'));
    vi.stubEnv('HOME', TMP);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
});

describe('HwipHook.notify — short body (inline)', () => {
    it('reads the device list, then sends a single sealed POST /pushes/send', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { pushId: 'push_short_01' } } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.notify({ title: 'Build done', body: 'all green' });
        expect(result.pushId).toBe('push_short_01');
        const pushCall = lastCalls.find((c) => c.url.endsWith('/pushes/send'));
        expect(pushCall).toBeDefined();
        const sent = JSON.parse(pushCall!.init!.body as string);
        // Sealed: the server sees neither the title nor the text.
        expect(sent.isEncrypted).toBe(true);
        expect(sent.title).toBeUndefined();
        expect(sent.body).not.toContain('all green');
    });

    it('throws if server returns no pushId', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: {} } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'oops' })).rejects.toThrow(/no pushId/);
    });
});

describe('HwipHook.notify — this computer\'s own key', () => {
    /** This computer as the fresh module graph sees it: its id and the key it made under this test's HOME. */
    const ownDevice = async () => {
        const crypto = await import('./crypto.js');
        await crypto.initDeviceCrypto();
        const { listenerDeviceId } = await import('./listener-device-id.js');
        return { deviceId: listenerDeviceId(), publicKey: crypto.getDevicePublicKey()!, type: 'cli' };
    };

    it('puts this computer\'s key on the list once when the list lacks it, and reads the list once', async () => {
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_reg' } } }]);
        const { HwipHook } = await loadHookModule();
        const own = await ownDevice();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        expect((await hook.notify({ title: 'T', body: 'b' })).pushId).toBe('push_reg');

        expect(registered).toHaveLength(1);
        expect(registered[0]!.url).toBe(`https://api.example.com/v1/devices/${own.deviceId}/public-key`);
        expect(registered[0]!.init?.method).toBe('PUT');
        expect(JSON.parse(registered[0]!.init!.body as string).publicKey).toBe(own.publicKey);
        expect(lastCalls.filter((c) => c.url.endsWith('/devices'))).toHaveLength(1);
    });

    it('registers nothing when the list holds this computer under its key', async () => {
        const { HwipHook } = await loadHookModule();
        const own = await ownDevice();
        sequenceResponses([list(await device('dev_phone', 'ios'), own), { ok: true, json: { data: { pushId: 'push_listed' } } }]);
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'T', body: 'b' });

        expect(registered).toEqual([]);
    });

    // A push does not need the key on the list: the app reads it either way.
    it('still sends, with one line, when the key cannot be registered', async () => {
        registerStatus = 404;
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_unreg' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        expect((await hook.notify({ title: 'T', body: 'b' })).pushId).toBe('push_unreg');

        const lines = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
        expect(lines).toEqual(["hwip: could not register this computer's key (the server answered HTTP 404) — the app cannot verify who sent this push"]);
    });

    it('says the API key may not replace the listed key, keeps it, and sends', async () => {
        registerStatus = 403;
        const { HwipHook } = await loadHookModule();
        const own = await ownDevice();
        sequenceResponses([list(await device('dev_phone', 'ios'), { ...own, publicKey: await newKey() }), { ok: true, json: { data: { pushId: 'push_403' } } }]);
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        expect((await hook.notify({ title: 'T', body: 'b' })).pushId).toBe('push_403');

        expect(registered).toHaveLength(1);
        expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0]))).toContain(
            "hwip: could not register this computer's key (the account lists another key for it, and only an API key with push:read may replace it) — the app cannot verify who sent this push",
        );
    });
});

describe('HwipHook.notify — agent session key', () => {
    it('files the push under HWIP_AGENT_SESSION_NAME instead of the tmux session', async () => {
        // A pi subagent's notify runs in the parent's tmux session, so #S would
        // file it under the parent. The extension hands down the subagent's own
        // wire name; it must win (and tmux is never asked).
        vi.stubEnv('TMUX', '/private/tmp/tmux-501/default,1,0');
        vi.stubEnv('HWIP_AGENT_SESSION_NAME', 'hwip-hwip.48');
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { pushId: 'push_sub_01' } } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await hook.notify({ title: 'pi asks: hwip · review-01', body: 'waiting' });
        const sent = JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
        expect(sent.agentSessionName).toBe('hwip-hwip.48');
        expect(typeof sent.agentDeviceId).toBe('string');
    });
});

describe('HwipHook.notify — long body (file upload path)', () => {
    it('requests upload URL, PUTs to S3, then sends a push with preview + file metadata', async () => {
        const longBody = 'x'.repeat(1000);
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: true, status: 200, json: {} },
            { ok: true, json: { data: { pushId: 'push_long_01' } } },
        ]);

        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.notify({ title: 'big report', body: longBody });

        expect(result.pushId).toBe('push_long_01');
        expect(result.fileKey).toBe('fk1');
        expect(result.autoFile).toBe(true);

        const upload = lastCalls.find((c) => c.url.endsWith('/files/upload-request'));
        const s3 = lastCalls.find((c) => c.url.startsWith('https://s3.example.com/'));
        const push = lastCalls.find((c) => c.url.endsWith('/pushes/send'));
        expect(upload).toBeDefined();
        expect(s3).toBeDefined();
        expect(push).toBeDefined();
        expect(s3!.init!.method).toBe('PUT');
        // The attachment is ciphertext: nothing of the report reaches S3.
        expect(Buffer.from(s3!.init!.body as Buffer).includes('xxxxxxxx')).toBe(false);
        const pushBody = JSON.parse(push!.init!.body as string);
        expect(pushBody.isEncrypted).toBe(true);
        expect(pushBody.files).toHaveLength(1);
        expect(pushBody.files[0].fileKey).toBe('fk1');
        expect(Object.keys(pushBody.files[0].deviceKeyMap)).toEqual(['dev_phone']);
    });

    // The address is signed for the type given at upload-request, written the server's way: S3 answers 403 to any other header.
    it('PUTs the ciphertext under the type the upload address was requested for', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: true, status: 200, json: {} },
            { ok: true, json: { data: { pushId: 'push_long_01' } } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'big report', body: 'x'.repeat(1000) });

        const upload = lastCalls.find((c) => c.url.endsWith('/files/upload-request'));
        expect(JSON.parse(upload!.init!.body as string).fileType).toBe('application/octet-stream');
        const s3 = lastCalls.find((c) => c.url.startsWith('https://s3.example.com/'));
        expect(new Headers(s3!.init!.headers).get('content-type')).toBe('application/octet-stream');
    });

    // Mirror of hwip server `uploadContentType` (lib/s3.ts) and mcp-server `uploadContentType` (mime.ts).
    it.each([
        ['image/png', 'image/png'],
        ['application/octet-stream', 'application/octet-stream'],
        ['application/json', 'application/json'],
        ['text/plain', 'text/plain; charset=utf-8'],
        ['text/markdown', 'text/markdown; charset=utf-8'],
        ['text/plain; charset=utf-16', 'text/plain; charset=utf-16'],
        ['text/plain; Charset=UTF-8', 'text/plain; Charset=UTF-8; charset=utf-8'],
    ])('writes the type %j as the header %j, for a string body and for bytes', async (type, header) => {
        const { HwipHook } = await loadHookModule();
        const { uploadContentType } = await import('./hwip-hook.js');
        expect(uploadContentType(type)).toBe(header);
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        for (const content of ['hello', Buffer.from('hello')]) {
            lastCalls = [];
            sequenceResponses([{ ok: true, status: 200, json: {} }]);
            await hook.uploadToS3('https://s3.example.com/put/abc', content, type);
            expect(new Headers(lastCalls[0]!.init!.headers).get('content-type')).toBe(header);
        }
    });

    it('propagates S3 upload failures', async () => {
        const longBody = 'x'.repeat(1000);
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: false, status: 503, json: { error: 'unavailable' } },
        ]);

        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'big', body: longBody }))
            .rejects.toThrow(/S3 upload failed/);
    });
});

describe('HwipHook.request — error mapping', () => {
    it('401 → AuthenticationError', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: false, status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'bad key', status: 401 } } },
        ]);
        const { HwipHook, AuthenticationError } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('403 + QUOTA_EXCEEDED → QuotaExceededError', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: false, status: 403, json: { error: { code: 'QUOTA_EXCEEDED', message: 'over limit', status: 403 } } },
        ]);
        const { HwipHook, QuotaExceededError } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('other 4xx → generic HwipError carrying code + status', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: false, status: 400, json: { error: { code: 'BAD_REQUEST', message: 'bad', status: 400 } } },
        ]);
        const { HwipHook, HwipError } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        try {
            await hook.notify({ title: 'x' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(HwipError);
            expect((err as InstanceType<typeof HwipError>).code).toBe('BAD_REQUEST');
            expect((err as InstanceType<typeof HwipError>).status).toBe(400);
        }
    });
});

describe('HwipHook constructor', () => {
    it('rejects empty apiKey', async () => {
        const { HwipHook } = await loadHookModule();
        expect(() => new HwipHook({ apiKey: '' })).toThrow(/apiKey is required/);
    });

    it('strips trailing slash from baseUrl', async () => {
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1/' });
        expect((hook as unknown as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v1');
    });
});

describe('HwipHook.list', () => {
    it('passes through limit + type to /pushes', async () => {
        // No crypto step for list — only one fetch expected
        sequenceResponses([
            { ok: true, json: { data: [{ pushId: 'p1', type: 'hook', createdAt: '2026-01-01T00:00:00Z' }], pagination: { hasMore: false } } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.list({ limit: 10, type: 'hook' });
        expect(result.pushes).toHaveLength(1);
        expect(result.hasMore).toBe(false);
        const listCall = lastCalls.find((c) => c.url.includes('/pushes?'));
        expect(listCall?.url).toContain('limit=10');
        expect(listCall?.url).toContain('type=hook');
    });
});

describe('HwipHook.dismiss', () => {
    it('encodes the push id and POSTs to /pushes/<id>/dismiss', async () => {
        sequenceResponses([
            { ok: true, json: { data: { dismissed: true } } },
        ]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.dismiss('push_01:weird/id');
        expect(result.dismissed).toBe(true);
        const dismissCall = lastCalls.find((c) => c.url.includes('/dismiss'));
        expect(dismissCall?.url).toContain('push_01%3Aweird%2Fid');
    });
});

describe('HwipHook.renameAgentSession', () => {
    it('PATCHes the agent-session alias endpoint with the alias body', async () => {
        sequenceResponses([{ ok: true, json: { data: { deviceId: 'dev_listener_abc' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        const res = await hook.renameAgentSession('dev_listener_abc', 'hwip-proj', 'Prod deploy');

        expect(res.deviceId).toBe('dev_listener_abc');
        const call = lastCalls.find((c) => c.url.includes('/agent-sessions/'));
        expect(call?.url).toBe('https://api.example.com/v1/devices/dev_listener_abc/agent-sessions/hwip-proj');
        expect(call?.init?.method).toBe('PATCH');
        expect(JSON.parse(call!.init!.body as string)).toEqual({ alias: 'Prod deploy' });
    });
});

// The listener drops an encrypted agent.command; an agentDeviceId would file
// the push under a chat that is not the target's.
describe('HwipHook.sendAgentCommand', () => {
    it('POSTs a plaintext agent.command with only the target and body', async () => {
        sequenceResponses([{ ok: true, json: { data: { pushId: 'push_1' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        const res = await hook.sendAgentCommand({ targetDeviceId: 'dev_linux', agentSessionName: 'hwip-api', body: '[from cli@mbp] hi' });

        expect(res.pushId).toBe('push_1');
        expect(lastCalls).toHaveLength(1);
        expect(lastCalls[0].url).toBe('https://api.example.com/v1/pushes/send');
        expect(JSON.parse(String(lastCalls[0].init?.body))).toEqual({
            type: 'agent.command',
            targetDeviceId: 'dev_linux',
            agentSessionName: 'hwip-api',
            body: '[from cli@mbp] hi',
        });
    });

    it('POSTs a sealed agent.command as the envelope alone: no text, no agentDeviceId', async () => {
        sequenceResponses([{ ok: true, json: { data: { pushId: 'push_2' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        await hook.sendAgentCommand({
            targetDeviceId: 'dev_linux',
            agentSessionName: 'hwip-api',
            isEncrypted: true,
            body: 'CIPHERTEXT',
            senderPublicKey: 'SENDER',
            deviceKeyMap: { dev_linux: 'SLOT' },
        });

        expect(JSON.parse(String(lastCalls[0].init?.body))).toEqual({
            type: 'agent.command',
            targetDeviceId: 'dev_linux',
            agentSessionName: 'hwip-api',
            isEncrypted: true,
            body: 'CIPHERTEXT',
            senderPublicKey: 'SENDER',
            deviceKeyMap: { dev_linux: 'SLOT' },
        });
    });

    it('fails loudly when the server answers without a pushId', async () => {
        sequenceResponses([{ ok: true, json: { data: {} } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        await expect(hook.sendAgentCommand({ targetDeviceId: 'd', agentSessionName: 's', body: 'b' })).rejects.toThrow('no pushId');
    });
});

describe('HwipHook.listDevices', () => {
    it('GETs the device list', async () => {
        sequenceResponses([{ ok: true, json: { data: [{ deviceId: 'dev_linux', agentSessions: [{ name: 'hwip-api' }] }] } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        const devices = await hook.listDevices();

        expect(devices.map((d) => d.deviceId)).toEqual(['dev_linux']);
        expect(lastCalls[0].url).toBe('https://api.example.com/v1/devices');
        expect(lastCalls[0].init?.method).toBe('GET');
    });

    // "No devices" would surface as an unknown target and hide the real failure.
    it('fails loudly when the response has no list', async () => {
        sequenceResponses([{ ok: true, json: {} }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        await expect(hook.listDevices()).rejects.toThrow('no device list');
    });
});

// Every push is sealed. A push this computer cannot seal is not sent — never sent in the clear, and a server
// that refuses a sealed push is an error to show, not a reason to send it again.
describe('HwipHook.notify — sealed sends', () => {
    const trustFile = () => join(TMP, '.hwip', 'trusted-devices.json');
    const pins = (): Record<string, { publicKey: string }> => JSON.parse(readFileSync(trustFile(), 'utf-8')).devices;
    const writeTrust = (devices: Record<string, string>): void => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        const body = Object.fromEntries(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-11T00:00:00.000Z' }]));
        writeFileSync(trustFile(), JSON.stringify({ version: 1, devices: body }));
    };
    const sends = () => lastCalls.filter((c) => c.url.endsWith('/pushes/send') || c.url.endsWith('/files/upload-request'));
    const sentPush = () => JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
    const newHook = async () => {
        const { HwipHook, ...errors } = await loadHookModule();
        return { hook: new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' }), ...errors };
    };

    it('does not resend in the clear when the server refuses a sealed send', async () => {
        sequenceResponses([
            await phoneList(),
            { ok: false, status: 403, json: { error: { code: 'FORBIDDEN', message: 'no', status: 403 } } },
        ]);
        const { hook, HwipError } = await newHook();

        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(HwipError);
        expect(lastCalls.filter((c) => c.url.endsWith('/pushes/send'))).toHaveLength(1);
    });

    it('wraps the message key per device and strips the plaintext title and url', async () => {
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_enc_01' } } }]);
        const { hook } = await newHook();

        await hook.notify({ title: 'Deploy done', body: 'prod is live', url: 'https://secret.example.com/build/42' });

        const sent = sentPush();
        expect(sent.isEncrypted).toBe(true);
        expect(sent.senderPublicKey).toBeTruthy();
        expect(Object.keys(sent.deviceKeyMap)).toEqual(['dev_phone']);
        expect(JSON.parse(sent.deviceKeyMap.dev_phone)).toEqual({ encryptedKey: expect.any(String), keyIv: expect.any(String) });
        // The url is sealed inside the ciphertext; a plaintext copy at the top level would hand the server the
        // one thing isEncrypted promises it cannot see — and on a link push the url IS the payload.
        expect(sent.title).toBeUndefined();
        expect(sent.url).toBeUndefined();
        expect(sent.body).not.toContain('secret.example.com');
    });

    it('seals for every device that lists a key, not only the phone, and for none that lists none', async () => {
        sequenceResponses([
            list(await device('dev_phone', 'ios'), await device('dev_listener_1', 'cli'), { deviceId: 'dev_old', type: 'android' }),
            { ok: true, json: { data: { pushId: 'push_all' } } },
        ]);
        const { hook } = await newHook();

        await hook.notify({ title: 't', body: 'b' });

        expect(Object.keys(sentPush().deviceKeyMap).sort()).toEqual(['dev_listener_1', 'dev_phone']);
    });

    it('needs no pin to seal: a phone seen for the first time is sealed for and pinned', async () => {
        const phone = await device('dev_phone', 'ios');
        sequenceResponses([list(phone), { ok: true, json: { data: { pushId: 'push_first' } } }]);
        const { hook } = await newHook();

        const result = await hook.notify({ title: 't' });

        expect(result).toEqual({ pushId: 'push_first' });
        expect(Object.keys(sentPush().deviceKeyMap)).toEqual(['dev_phone']);
        expect(pins()).toEqual({ dev_phone: { publicKey: phone.publicKey, pinnedAt: expect.any(String) } });
        expect(console.error).not.toHaveBeenCalled();
    });

    it('pins every listed device with a key but not this computer', async () => {
        const { listenerDeviceId } = await import('./listener-device-id.js');
        sequenceResponses([
            list(await device('dev_phone', 'ios'), await device(listenerDeviceId(), 'cli'), await device('dev_pc_2', 'cli')),
            { ok: true, json: { data: { pushId: 'push_pins' } } },
        ]);
        const { hook } = await newHook();

        await hook.notify({ title: 't' });

        expect(Object.keys(pins()).sort()).toEqual(['dev_pc_2', 'dev_phone']);
        // Itself is still read by itself: a push is for every device that can open it.
        expect(Object.keys(sentPush().deviceKeyMap)).toContain(listenerDeviceId());
    });

    it('seals for the new key of a pinned device, replaces the pin, warns once and records the change', async () => {
        const before = await newKey();
        writeTrust({ dev_phone: before });
        const reinstalled = await device('dev_phone', 'ios');
        sequenceResponses([
            list(reinstalled), { ok: true, json: { data: { pushId: 'push_changed' } } },
            list(reinstalled), { ok: true, json: { data: { pushId: 'push_after' } } },
        ]);
        const { hook } = await newHook();

        expect(await hook.notify({ title: 't' })).toEqual({ pushId: 'push_changed' });
        expect(await hook.notify({ title: 't' })).toEqual({ pushId: 'push_after' });

        expect(pins().dev_phone.publicKey).toBe(reinstalled.publicKey);
        expect(takeKeyChanges(trustFile()).map((c) => c.deviceId)).toEqual(['dev_phone']);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith('hwip: trust: dev_phone changed its key — now pinned to the new one');
    });

    it('records a changed key for a long body sent as a file too', async () => {
        writeTrust({ dev_phone: await newKey() });
        sequenceResponses([
            await phoneList(),
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: true, status: 200, json: {} },
            { ok: true, json: { data: { pushId: 'push_file_changed' } } },
        ]);
        const { hook } = await newHook();

        expect(await hook.notify({ title: 't', body: 'x'.repeat(1000) })).toEqual({ pushId: 'push_file_changed', fileKey: 'fk1', autoFile: true });
        expect(takeKeyChanges(trustFile()).map((c) => c.deviceId)).toEqual(['dev_phone']);
    });

    it('does not filter the recipients by pin: a device added since is sealed for, and pinned', async () => {
        const phone = await device('dev_phone', 'ios');
        writeTrust({ dev_phone: phone.publicKey });
        sequenceResponses([list(phone, await device('dev_tablet', 'android')), { ok: true, json: { data: { pushId: 'push_new_device' } } }]);
        const { hook } = await newHook();

        await hook.notify({ title: 't' });

        expect(Object.keys(sentPush().deviceKeyMap).sort()).toEqual(['dev_phone', 'dev_tablet']);
        expect(Object.keys(pins()).sort()).toEqual(['dev_phone', 'dev_tablet']);
    });

    // ── What stops a push: nothing is sent, nothing is uploaded ──
    it.each([
        ['only computers are listed', async () => list(await device('dev_listener_1', 'cli'), await device('dev_mac', 'macos'))],
        ['the list is empty', async () => list()],
    ])('fails with NO_APP_DEVICE and sends nothing when %s', async (_, response) => {
        sequenceResponses([await response()]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'Secret', body: 'classified' })).rejects.toMatchObject({
            code: 'NO_APP_DEVICE',
            message: expect.stringContaining('sign in to the Hwip app on an iPhone or Android phone'),
        });
        await expect(hook.notify({ title: 'Secret', body: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'NO_APP_DEVICE' });
        expect(sends()).toEqual([]);
    });

    it('fails with E2E_REQUIRED and sends nothing when the server refuses the device list', async () => {
        sequenceResponses([{ ok: false, status: 404, json: { error: { code: 'NOT_FOUND', message: 'no', status: 404 } } }]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'Secret', body: 'classified' })).rejects.toMatchObject({
            code: 'E2E_REQUIRED',
            message: 'the device list could not be fetched; the push was not sent',
        });
        expect(sends()).toEqual([]);
    });

    it.each([[503], [429]])('fails as the server\'s own error, kept for the record, when the device list answers %i', async (status) => {
        sequenceResponses([{ ok: false, status, json: { error: { code: 'DOWN', message: 'down', status } } }]);
        const { hook, HwipError } = await newHook();

        const err = await hook.notify({ title: 'x' }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(HwipError);
        expect(err).toMatchObject({ code: 'DOWN', status });
        expect(sends()).toEqual([]);
    });

    it('fails as a used-up quota when the device list answers with one', async () => {
        sequenceResponses([{ ok: false, status: 403, json: { error: { code: 'QUOTA_EXCEEDED', message: 'over', status: 403 } } }]);
        const { hook, QuotaExceededError } = await newHook();

        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('fails as a network error, not as a sealing failure, when the server cannot be reached', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'x' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    });

    it('fails as a rejected key when the device list answers 401', async () => {
        sequenceResponses([{ ok: false, status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'bad key', status: 401 } } }]);
        const { hook, AuthenticationError } = await newHook();

        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('fails with E2E_REQUIRED and sends nothing when the answer has no device list', async () => {
        sequenceResponses([{ ok: true, json: { data: null } }]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'x' })).rejects.toMatchObject({ code: 'E2E_REQUIRED' });
        expect(sends()).toEqual([]);
    });

    it('fails with E2E_REQUIRED and sends nothing when no device lists a key', async () => {
        sequenceResponses([list({ deviceId: 'dev_phone', type: 'ios' })]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'Secret', body: 'classified' })).rejects.toMatchObject({
            code: 'E2E_REQUIRED',
            message: 'no device has a key to encrypt for; the push was not sent',
        });
        expect(sends()).toEqual([]);
    });

    it('fails with E2E_REQUIRED and sends nothing when sealing fails', async () => {
        sequenceResponses([list({ deviceId: 'dev_phone', type: 'ios', publicKey: 'not-a-key' })]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 'Secret', body: 'classified' })).rejects.toMatchObject({ code: 'E2E_REQUIRED' });
        await expect(hook.notify({ title: 'Secret', body: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'E2E_REQUIRED' });
        expect(sends()).toEqual([]);
    });

    it("fails with E2E_REQUIRED and asks the server nothing when this computer's keys do not load, and tries again next send", async () => {
        // A HOME whose keystore is a directory: the keys cannot be read or created there.
        const home = mkdtempSync(join(tmpdir(), 'hwip-nokeys-'));
        mkdirSync(join(home, '.hwip', 'device-keys.json'), { recursive: true });
        vi.stubEnv('HOME', home);
        try {
            sequenceResponses([await phoneList()]);
            const { hook } = await newHook();

            await expect(hook.notify({ title: 't', body: 'b' })).rejects.toMatchObject({ code: 'E2E_REQUIRED', message: "this computer's keys did not load; the push was not sent" });
            await expect(hook.notify({ title: 't', body: 'b' })).rejects.toMatchObject({ code: 'E2E_REQUIRED' });
            expect(lastCalls).toEqual([]);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it('never asks whether the account encrypts', async () => {
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_noflag' } } }]);
        const { hook } = await newHook();

        await hook.notify({ title: 't' });

        expect(lastCalls.map((c) => c.url)).toEqual(['https://api.example.com/v1/devices', 'https://api.example.com/v1/pushes/send']);
    });

    // ── The trust file does not decide whether a push goes ──
    it('sends on, sealed, and says the pins were not checked when the trust file cannot be read', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(trustFile(), '{ not json');
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_unreadable' } } }]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 't' })).resolves.toEqual({ pushId: 'push_unreadable' });

        expect(sentPush().isEncrypted).toBe(true);
        expect(readFileSync(trustFile(), 'utf-8')).toBe('{ not json');
        expect(console.error).toHaveBeenCalledWith('hwip: trust: the trust file is unreadable — pins not checked');
    });

    it('sends on, sealed, when another process holds the trust file lock, and writes no pin', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'trusted-devices.lock'), '1 1\n');
        sequenceResponses([await phoneList(), { ok: true, json: { data: { pushId: 'push_locked' } } }]);
        const { hook } = await newHook();

        await expect(hook.notify({ title: 't' })).resolves.toEqual({ pushId: 'push_locked' });

        expect(sentPush().isEncrypted).toBe(true);
        expect(() => readFileSync(trustFile())).toThrow();
    }, 10_000);
});

describe('HwipHook.notify — to a channel', () => {
    // m7.md §3 E2E: a channel push is fanned out without the sender's device keys, so a
    // sealed one could not be opened. Whatever the account's setting, it goes in the clear —
    // and it must not even ask: any E2E opt-in or device lookup would be a second request.
    it('is one plain POST, with no encryption lookups and no sealed fields', async () => {
        sequenceResponses([{ ok: true, json: { data: { pushId: 'push_ch_1' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        const result = await hook.notify({ title: 'v1', body: 'shipped', url: 'https://x.test', type: 'hook', channelId: 'ch_1' });

        expect(result).toEqual({ pushId: 'push_ch_1' });
        expect(lastCalls).toHaveLength(1);
        expect(lastCalls[0]!.url).toBe('https://api.example.com/v1/pushes/send');
        const sent = JSON.parse(lastCalls[0]!.init!.body as string);
        expect(sent).toEqual({ title: 'v1', body: 'shipped', url: 'https://x.test', type: 'hook', channelId: 'ch_1' });
    });

    it('sends a long body inline, not as a file', async () => {
        sequenceResponses([{ ok: true, json: { data: { pushId: 'push_ch_2' } } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const body = 'x'.repeat(2000);

        await hook.notify({ title: 'long', body, channelId: 'ch_1' });

        expect(lastCalls).toHaveLength(1);
        expect(JSON.parse(lastCalls[0]!.init!.body as string).body).toBe(body);
    });

    it('lists channels without the record fields a terminal should not show', async () => {
        sequenceResponses([{ ok: true, json: { data: [{ channelId: 'ch_1', name: 'A', ownerId: 'u', isPublic: true, subscriberCount: 2, webhookSecret: 'whsec_x' }] } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        const channels = await hook.listChannels();

        expect(lastCalls[0]!.url).toBe('https://api.example.com/v1/channels');
        expect(channels).toEqual([{ channelId: 'ch_1', name: 'A', ownerId: 'u', isPublic: true, subscriberCount: 2 }]);
    });

    it('treats an answer with no list as a failure, not as no channels', async () => {
        sequenceResponses([{ ok: true, json: { data: null } }]);
        const { HwipHook } = await loadHookModule();
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await expect(hook.listChannels()).rejects.toThrow('no channel list');
    });
});
