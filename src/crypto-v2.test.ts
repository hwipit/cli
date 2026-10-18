import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirroredPublicKey, v2Party } from '../tests/helpers/seal.js';

// Envelope v2 against a peer that implements the format independently
// (tests/helpers/seal.ts): what this file proves is the wire format, not that
// crypto.ts can read its own output.

const originalHome = process.env.HOME;
let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'crypto-v2-test-'));
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    process.env.HOME = originalHome;
});

/** crypto.ts with this host's device keypair loaded. */
const loadDevice = async () => {
    const crypto = await import('./crypto.js');
    const publicKey = await crypto.initDeviceCrypto();
    return { ...crypto, publicKey };
};

const PANE = '\u001b[1mhello\u001b[0m 한글 🔐';

describe('envelope v2', () => {
    it('should open what an independent peer sealed for this device', async () => {
        const device = await loadDevice();
        const phone = v2Party();

        const envelope = phone.seal('stream.input', PANE, device.publicKey, 'hwip-app');

        expect(await device.openV2('stream.input', envelope, phone.publicKey, 'hwip-app')).toBe(PANE);
    });

    it('should seal what an independent peer can open', async () => {
        const device = await loadDevice();
        const phone = v2Party();

        const envelope = await device.sealV2('stream.frame', PANE, phone.publicKey, 'hwip-app');

        expect(envelope.v).toBe(2);
        expect(envelope.senderPublicKey).toBe(device.publicKey);
        expect(Buffer.from(envelope.salt, 'base64')).toHaveLength(32);
        expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12);
        expect(phone.open('stream.frame', envelope, 'hwip-app')).toBe(PANE);
    });

    it('should use a fresh salt and iv for every message', async () => {
        const device = await loadDevice();
        const phone = v2Party();

        const first = await device.sealV2('stream.frame', PANE, phone.publicKey);
        const second = await device.sealV2('stream.frame', PANE, phone.publicKey);

        expect(second.salt).not.toBe(first.salt);
        expect(second.iv).not.toBe(first.iv);
        expect(second.ciphertext).not.toBe(first.ciphertext);
    });

    it('should refuse an envelope sealed for another purpose', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const envelope = phone.seal('stream.frame', PANE, device.publicKey, 'hwip-app');

        await expect(device.openV2('stream.input', envelope, phone.publicKey, 'hwip-app')).rejects.toThrow();
    });

    it('should refuse its own frame handed back as input from the peer', async () => {
        // The reflection a relay can try: the ECDH secret is the same in both
        // directions, so a frame this device sealed for the phone, relabelled as
        // sent by the phone, derives the same secret here.
        const device = await loadDevice();
        const phone = v2Party();
        const frame = await device.sealV2('stream.input', PANE, phone.publicKey, 'hwip-app');

        const reflected = { ...frame, senderPublicKey: phone.publicKey };

        await expect(device.openV2('stream.input', reflected, phone.publicKey, 'hwip-app')).rejects.toThrow();
    });

    it('should refuse an envelope whose sender key was swapped', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const relay = v2Party();
        const envelope = phone.seal('stream.input', PANE, device.publicKey);

        // Even a caller that believes the swapped key: the seal covers the sender.
        await expect(device.openV2('stream.input', { ...envelope, senderPublicKey: relay.publicKey }, relay.publicKey)).rejects.toThrow();
    });

    it('should refuse an envelope opened under another context', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const envelope = phone.seal('stream.input', PANE, device.publicKey, 'hwip-app');

        await expect(device.openV2('stream.input', envelope, phone.publicKey, 'hwip-other')).rejects.toThrow();
    });

    it('should not be openable by a device it was not sealed for', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const stranger = v2Party();

        const envelope = await device.sealV2('stream.frame', PANE, phone.publicKey);

        expect(() => stranger.open('stream.frame', envelope)).toThrow();
    });

    it('should refuse an envelope sealed for another device', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const other = v2Party();
        const envelope = phone.seal('stream.input', PANE, other.publicKey);

        await expect(device.openV2('stream.input', envelope, phone.publicKey)).rejects.toThrow();
    });

    it('should refuse an envelope from another key than the expected sender', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const other = v2Party();
        const envelope = other.seal('stream.input', PANE, device.publicKey);

        await expect(device.openV2('stream.input', envelope, phone.publicKey)).rejects.toThrow('expected key');
        expect(await device.openV2('stream.input', envelope, other.publicKey)).toBe(PANE);
    });

    it('should refuse the v1 ephemeral envelope', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const key = device.getDevicePublicKey();
        if (!key) throw new Error('no device key');
        // The five fields the envelope before v2 carried.
        const sealed = phone.sealPush({ body: PANE }, key);
        const v1 = { ...JSON.parse(sealed.body), ...JSON.parse(sealed.entry), senderPublicKey: phone.publicKey };

        expect(device.isSealedV2(v1)).toBe(false);
        // @ts-expect-error — a v1 envelope is not a SealedV2; the runtime check is what is under test.
        await expect(device.openV2('stream.frame', v1, phone.publicKey)).rejects.toThrow('not a v2 envelope');
    });

    it.each([
        ['a short salt', { salt: Buffer.alloc(16).toString('base64') }],
        ['a long iv', { iv: Buffer.alloc(16).toString('base64') }],
        ['a truncated ciphertext', { ciphertext: Buffer.alloc(8).toString('base64') }],
    ])('should refuse an envelope with %s', async (_what, change) => {
        const device = await loadDevice();
        const phone = v2Party();
        const envelope = phone.seal('stream.input', PANE, device.publicKey);

        await expect(device.openV2('stream.input', { ...envelope, ...change }, phone.publicKey)).rejects.toThrow();
    });

    it.each([
        ['another version', { v: 3, salt: 'a', iv: 'b', ciphertext: 'c', senderPublicKey: 'd' }],
        ['a missing field', { v: 2, salt: 'a', iv: 'b', ciphertext: 'c' }],
        ['a non-string field', { v: 2, salt: 1, iv: 'b', ciphertext: 'c', senderPublicKey: 'd' }],
        ['an array', [2]],
        ['null', null],
    ])('should not take %s for a v2 envelope', async (_what, value) => {
        const device = await loadDevice();

        expect(device.isSealedV2(value)).toBe(false);
    });
});

describe('envelope v2 — sealed by the iOS app', () => {
    // crypto-v2.vectors.json: one message from the app's Envelope.sealV2
    // (CryptoKit) for a synthetic listener key, so the phone → listener
    // direction is pinned to bytes the app actually produced.
    const vector = JSON.parse(readFileSync(new URL('./crypto-v2.vectors.json', import.meta.url), 'utf8')) as {
        deviceKeys: { publicKey: string; privateKey: string };
        purpose: 'stream.input';
        context: string;
        plaintext: string;
        envelope: { v: 2; salt: string; iv: string; ciphertext: string; senderPublicKey: string };
    };

    const loadVectorDevice = async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'device-keys.json'), JSON.stringify(vector.deviceKeys));
        const device = await loadDevice();
        expect(device.publicKey).toBe(vector.deviceKeys.publicKey);
        return device;
    };

    it('should open it', async () => {
        const device = await loadVectorDevice();

        expect(await device.openV2(vector.purpose, vector.envelope, vector.envelope.senderPublicKey, vector.context)).toBe(vector.plaintext);
    });

    it('should refuse it under another purpose or context', async () => {
        const device = await loadVectorDevice();

        await expect(device.openV2('stream.frame', vector.envelope, vector.envelope.senderPublicKey, vector.context)).rejects.toThrow();
        await expect(device.openV2(vector.purpose, vector.envelope, vector.envelope.senderPublicKey, 'hwip-other')).rejects.toThrow();
    });
});

describe('envelope v2 — a file view request sealed by the iOS app', () => {
    // crypto-file-view.vectors.json: the `tree.request` the app's FileView seals, under the `session.diff`
    // label the diff requests use. The file view shares that label, so the sealed `kind` is what tells
    // its requests from a diff's: this pins that the listener opens what the app really produces and
    // reads the fields `serveDiff` checks (no `base`, no `cursor` on a first page).
    const vector = JSON.parse(readFileSync(new URL('./crypto-file-view.vectors.json', import.meta.url), 'utf8')) as {
        deviceKeys: { publicKey: string; privateKey: string };
        purpose: 'session.diff';
        context: string;
        plaintext: string;
        envelope: { v: 2; salt: string; iv: string; ciphertext: string; senderPublicKey: string };
    };

    const loadVectorDevice = async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'device-keys.json'), JSON.stringify(vector.deviceKeys));
        return loadDevice();
    };

    it('should open it as the request the listener expects', async () => {
        const device = await loadVectorDevice();

        const opened = await device.openV2(vector.purpose, vector.envelope, vector.envelope.senderPublicKey, vector.context);

        expect(opened).toBe(vector.plaintext);
        expect(JSON.parse(opened)).toEqual({ v: 1, kind: 'tree.request', requestId: 'fv-vector-1', path: 'src' });
    });

    it('should refuse it under the stream label or another session', async () => {
        const device = await loadVectorDevice();

        await expect(device.openV2('stream.input', vector.envelope, vector.envelope.senderPublicKey, vector.context)).rejects.toThrow();
        await expect(device.openV2(vector.purpose, vector.envelope, vector.envelope.senderPublicKey, 'hwip-other')).rejects.toThrow();
    });
});

describe('keyFingerprint', () => {
    it('should be the first 16 bytes of SHA-256 over the key\'s point, in groups of four hex digits', async () => {
        const device = await loadDevice();
        const { createHash } = await import('node:crypto');
        const phone = v2Party();
        // Worked by hand from the format: the point is the last 65 bytes of the SPKI.
        const point = Buffer.from(phone.publicKey, 'base64').subarray(26);
        const hex = createHash('sha256').update(point).digest('hex');

        const fingerprint = device.keyFingerprint(phone.publicKey);

        expect(fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
        expect(fingerprint?.replace(/ /g, '')).toBe(hex.slice(0, 32));
    });

    it('should match the fingerprint the app shows for the same key', async () => {
        const device = await loadDevice();
        const vector = JSON.parse(readFileSync(new URL('./crypto-v2.vectors.json', import.meta.url), 'utf8')) as {
            deviceKeys: { publicKey: string };
            fingerprint: string;
        };

        expect(device.keyFingerprint(vector.deviceKeys.publicKey)).toBe(vector.fingerprint);
    });

    it('should have none for what is not a device key', async () => {
        const device = await loadDevice();

        expect(device.keyFingerprint('not-a-key')).toBeNull();
        expect(device.keyFingerprint('')).toBeNull();
    });
});

describe('samePublicKey', () => {
    it('should tell the same key from another', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const other = v2Party();

        expect(device.samePublicKey(phone.publicKey, phone.publicKey)).toBe(true);
        expect(device.samePublicKey(device.publicKey, device.publicKey)).toBe(true);
        expect(device.samePublicKey(phone.publicKey, other.publicKey)).toBe(false);
    });

    it.each([
        ['empty strings', ''],
        ['the same text that is no key', 'not-a-key'],
        ['a key cut short', 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'],
    ])('should not take %s for a key, even against itself', async (_what, value) => {
        const device = await loadDevice();

        expect(device.samePublicKey(value, value)).toBe(false);
        expect(device.publicKeyPoint(value)).toBeNull();
    });

    it('should refuse another spelling of the same key', async () => {
        // One key, four strings: the SPKI every client writes, the same SPKI
        // with a compressed point, with a hybrid point (which Node imports as
        // the same key), and the first without its Base64 padding. Only the
        // first is a device key — the app cannot read the others, so taking
        // them here would make the two disagree on who a peer is.
        const device = await loadDevice();
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
        const point = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
        const compressed = Buffer.concat([
            Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'),
            Buffer.from([point[64] % 2 === 0 ? 0x02 : 0x03]),
            point.subarray(1, 33),
        ]).toString('base64');
        const hybrid = Buffer.concat([
            Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
            Buffer.from([point[64] % 2 === 0 ? 0x06 : 0x07]),
            point.subarray(1),
        ]).toString('base64');
        const unpadded = spki.replace(/=+$/, '');

        expect(device.publicKeyPoint(spki)).toEqual(point);
        expect(unpadded).not.toBe(spki);
        for (const other of [compressed, hybrid, unpadded]) {
            expect(device.publicKeyPoint(other)).toBeNull();
            expect(device.samePublicKey(other, other)).toBe(false);
            expect(device.samePublicKey(spki, other)).toBe(false);
            await expect(device.sealV2('stream.frame', PANE, other)).rejects.toThrow('not a device public key');
        }
    });
});

describe('publicKeySender', () => {
    it('should name a key and its mirror image the same sender, and another key another one', async () => {
        const device = await loadDevice();
        const phone = v2Party();
        const mirror = mirroredPublicKey(phone.publicKey);

        expect(mirror).not.toBe(phone.publicKey);
        expect(device.samePublicKey(phone.publicKey, mirror)).toBe(false);
        expect(device.publicKeySender(mirror)).toBe(device.publicKeySender(phone.publicKey));
        expect(device.publicKeySender(v2Party().publicKey)).not.toBe(device.publicKeySender(phone.publicKey));
        expect(device.publicKeySender(phone.publicKey)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should give no sender for a string that is not a device key', async () => {
        const device = await loadDevice();

        expect(device.publicKeySender('not-a-key')).toBeNull();
        expect(device.publicKeySender('')).toBeNull();
    });
});
