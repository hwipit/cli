import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror of mcp-server's crypto tests — the two crypto.ts files are
// near-identical inline copies (until we extract into a shared package),
// so they share the same test cases, plus the per-device key tests below
// that the MCP version doesn't have.

const CRYPTO_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of CRYPTO_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-crypto-test-'));
    for (const key of CRYPTO_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
    vi.unstubAllGlobals();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of CRYPTO_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    vi.unstubAllGlobals();
});

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

/** A stand-in recipient device with its own keypair. */
const makeDevice = async (): Promise<{ publicKey: string; privateKey: string }> => {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
    const [pub, priv] = await Promise.all([
        crypto.subtle.exportKey('spki', kp.publicKey),
        crypto.subtle.exportKey('pkcs8', kp.privateKey),
    ]);
    return { publicKey: b64(pub), privateKey: b64(priv) };
};

/** Unwrap the way a recipient device does: ECDH(my private, sender public). */
const unwrapAsDevice = async (
    devicePrivateKey: string,
    senderPublicKey: string,
    wrappedEntry: string,
    ciphertext: string | Buffer,
    iv: string,
): Promise<Buffer> => {
    const priv = await crypto.subtle.importKey('pkcs8', unb64(devicePrivateKey), ECDH, false, ['deriveKey']);
    const pub = await crypto.subtle.importKey('spki', unb64(senderPublicKey), ECDH, false, []);
    const sharedKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );

    const { encryptedKey, keyIv } = JSON.parse(wrappedEntry) as { encryptedKey: string; keyIv: string };
    const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(keyIv) }, sharedKey, unb64(encryptedKey));
    const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);

    const bytes = typeof ciphertext === 'string' ? unb64(ciphertext) : ciphertext;
    return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, messageKey, bytes));
};

const fetchCalls = (): { url: string; method: string }[] => {
    const calls = (fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
    return calls.map((args) => ({
        url: String(args[0]),
        method: ((args[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }));
};

describe('initDeviceCrypto — the keys a push is sealed with', () => {
    it('adopts the per-device keypair, the one the stream frames use', async () => {
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');

        const pub = await initDeviceCrypto();

        expect(pub).toBeTruthy();
        expect(getDevicePublicKey()).toBe(pub);
        expect(existsSync(join(TMP, '.hwip', 'device-keys.json'))).toBe(true);
    });

    it('never asks the server anything, and writes no key material to it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        const { initDeviceCrypto } = await import('./crypto.js');

        await initDeviceCrypto();

        // The old code PUT this host's public key to /users/me/keys, which
        // overwrote the account key every other client reads and made pushes
        // undecryptable everywhere.
        expect(fetchCalls()).toEqual([]);
    });

    it('deletes the escrowed account keypair an old build may have left behind', async () => {
        const legacyPath = join(TMP, '.config', 'hwip', 'keys.json');
        mkdirSync(join(TMP, '.config', 'hwip'), { recursive: true });
        writeFileSync(legacyPath, JSON.stringify({ publicKey: 'p', privateKey: 'q' }));
        const { initDeviceCrypto } = await import('./crypto.js');

        await initDeviceCrypto();

        expect(existsSync(legacyPath)).toBe(false);
    });
});

describe('selectRecipients', () => {
    it('drops devices with no public key and keeps every other, whatever its key', async () => {
        const { selectRecipients } = await import('./crypto.js');

        const picked = selectRecipients([
            { deviceId: 'dev_new', publicKey: 'PHONE_PUB' },
            { deviceId: 'dev_other', publicKey: 'OTHER_PUB' },
            { deviceId: 'dev_old' },
        ]);

        expect(picked).toEqual([{ deviceId: 'dev_new', publicKey: 'PHONE_PUB' }, { deviceId: 'dev_other', publicKey: 'OTHER_PUB' }]);
    });
});

describe('encryptPushBodyForDevices', () => {
    it('produces an envelope every recipient device can open', async () => {
        const { initDeviceCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initDeviceCrypto();

        const phone = await makeDevice();
        const laptop = await makeDevice();
        const enc = await encryptPushBodyForDevices(
            { title: 'hi', body: 'hello world', url: 'https://x.test' },
            [{ deviceId: 'dev_phone', publicKey: phone.publicKey }, { deviceId: 'dev_laptop', publicKey: laptop.publicKey }],
        );

        expect(enc.isEncrypted).toBe(true);
        expect(Object.keys(enc.deviceKeyMap)).toEqual(['dev_phone', 'dev_laptop']);
        const { ciphertext, iv } = JSON.parse(enc.body) as { ciphertext: string; iv: string };

        for (const [deviceId, kp] of [['dev_phone', phone], ['dev_laptop', laptop]] as const) {
            const plain = await unwrapAsDevice(kp.privateKey, enc.senderPublicKey, enc.deviceKeyMap[deviceId], ciphertext, iv);
            expect(JSON.parse(plain.toString('utf-8'))).toEqual({ title: 'hi', body: 'hello world', url: 'https://x.test' });
        }
    });

    it('produces different ciphertext on repeated calls', async () => {
        const { initDeviceCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initDeviceCrypto();
        const phone = await makeDevice();
        const to = [{ deviceId: 'dev_phone', publicKey: phone.publicKey }];

        const a = await encryptPushBodyForDevices({ body: 'same' }, to);
        const b = await encryptPushBodyForDevices({ body: 'same' }, to);
        expect(JSON.parse(a.body).ciphertext).not.toBe(JSON.parse(b.body).ciphertext);
    });

    it('throws rather than sending unencrypted when no recipient is usable', async () => {
        const { initDeviceCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initDeviceCrypto();

        await expect(
            encryptPushBodyForDevices({ body: 'x' }, [{ deviceId: 'dev_bad', publicKey: 'not-a-key' }]),
        ).rejects.toThrow(/No recipient device/);
    });

    it('throws when called before initDeviceCrypto', async () => {
        const { encryptPushBodyForDevices } = await import('./crypto.js');
        await expect(encryptPushBodyForDevices({ body: 'x' }, [])).rejects.toThrow(/Crypto not initialized/);
    });
});

describe('encryptFileForDevices', () => {
    it('round-trips the content for a recipient device', async () => {
        const { initDeviceCrypto, encryptFileForDevices, getDevicePublicKey } = await import('./crypto.js');
        await initDeviceCrypto();

        const phone = await makeDevice();
        const enc = await encryptFileForDevices('héllo — 안녕', [{ deviceId: 'dev_phone', publicKey: phone.publicKey }]);

        expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
        expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
        const plain = await unwrapAsDevice(
            phone.privateKey, getDevicePublicKey()!, enc.deviceKeyMap['dev_phone'], enc.ciphertext, enc.iv,
        );
        expect(plain.toString('utf-8')).toBe('héllo — 안녕');
    });
});

// ─── Per-device keys ───

describe('initDeviceCrypto', () => {
    it('generates and persists a device keypair under ~/.hwip', async () => {
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        const pub = await initDeviceCrypto();
        expect(pub).toBeTruthy();
        expect(getDevicePublicKey()).toBe(pub);
        const keysPath = join(TMP, '.hwip', 'device-keys.json');
        expect(existsSync(keysPath)).toBe(true);
        const stored = JSON.parse(readFileSync(keysPath, 'utf-8'));
        expect(stored).toHaveProperty('publicKey');
        expect(stored).toHaveProperty('privateKey');
    });

    it('reuses the stored device keypair on second init', async () => {
        const first = await (await import('./crypto.js')).initDeviceCrypto();
        vi.resetModules();
        const second = await (await import('./crypto.js')).initDeviceCrypto();
        expect(second).toBe(first);
    });

    it('two initialisers racing to create the keypair converge on the one linked into place', async () => {
        const listener = await import('./crypto.js');
        vi.resetModules();
        const mcp = await import('./crypto.js');   // a second module instance stands in for the MCP server
        const [a, b] = await Promise.all([listener.initDeviceCrypto(), mcp.initDeviceCrypto()]);
        expect(a).toBe(b);
        expect(JSON.parse(readFileSync(join(TMP, '.hwip', 'device-keys.json'), 'utf-8')).publicKey).toBe(a);
    });

    it('deduplicates concurrent calls', async () => {
        const { initDeviceCrypto } = await import('./crypto.js');
        const [a, b] = await Promise.all([initDeviceCrypto(), initDeviceCrypto()]);
        expect(a).toBe(b);
    });
});
