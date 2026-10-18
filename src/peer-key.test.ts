import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { peerKeyOf, type PeerKeyDeps } from './peer-key.js';

const newKey = async (): Promise<string> => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    return Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
};

let dir: string;
let trustPath: string;
let warnings: string[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-key-'));
    trustPath = join(dir, 'trusted-devices.json');
    warnings = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pinFile = (devices: Record<string, string>): void => {
    const pins = Object.fromEntries(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' }]));
    writeFileSync(trustPath, JSON.stringify({ version: 1, devices: pins }));
};
const stored = (): Record<string, { publicKey: string }> => JSON.parse(readFileSync(trustPath, 'utf8')).devices;
const deps = (registered: Record<string, string>, extra: Partial<PeerKeyDeps> = {}): PeerKeyDeps => ({
    registeredKey: async (id) => registered[id] ?? null,
    trustPath,
    warn: (line) => warnings.push(line),
    ...extra,
});

describe('peerKeyOf', () => {
    it('returns the registered key of a device that is pinned with the same key, without a warning', async () => {
        const key = await newKey();
        pinFile({ dev_phone: key });

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
        expect(warnings).toEqual([]);
    });

    it('believes a device nobody pinned before and pins it, with or without other pins', async () => {
        const key = await newKey();
        const other = await newKey();
        pinFile({ dev_other: other });

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });

        expect(stored()).toMatchObject({ dev_other: { publicKey: other }, dev_phone: { publicKey: key } });
        expect(warnings).toEqual([]);
    });

    it('believes the registered key when it is not the pinned one: replaces the pin, says so once', async () => {
        const old = await newKey();
        const fresh = await newKey();
        pinFile({ dev_phone: old });

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: fresh }))).toEqual({ key: fresh });
        expect(stored().dev_phone.publicKey).toBe(fresh);
        expect(warnings).toEqual(['trust: dev_phone changed its key — now pinned to the new one']);

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: fresh }))).toEqual({ key: fresh });
        expect(warnings).toHaveLength(1);
    });

    it('refuses a device the account does not list, even when a pin exists', async () => {
        pinFile({ dev_phone: await newKey() });
        expect(await peerKeyOf('dev_phone', deps({}))).toEqual({ refused: 'unlisted' });
    });

    it('treats a registered key that is not a device key in its one spelling as unlisted, and pins nothing', async () => {
        const key = await newKey();
        for (const odd of ['not-a-key', key.replace(/=+$/, ''), 'A'.repeat(88)]) {
            expect(await peerKeyOf('dev_phone', deps({ dev_phone: odd }))).toEqual({ refused: 'unlisted' });
        }
        expect(() => readFileSync(trustPath)).toThrow();
    });

    it('refuses when the device list cannot be fetched', async () => {
        const failing: PeerKeyDeps = { registeredKey: async () => { throw new Error('devices 503'); }, trustPath };
        expect(await peerKeyOf('dev_phone', failing)).toEqual({ refused: 'devices_unavailable' });
    });

    // A trust file this version cannot read is not the answering device's fault: the list decides, the pins are only a record.
    it.each([
        ['not json', '{ not json'],
        ['a pin with no pinnedAt', JSON.stringify({ version: 1, devices: { dev_phone: { publicKey: 'K' } } })],
        ['an unknown version', JSON.stringify({ version: 2, devices: {} })],
    ])('believes the registered key and writes nothing when the trust file is %s', async (_name, file) => {
        writeFileSync(trustPath, file);
        const key = await newKey();

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
        expect(readFileSync(trustPath, 'utf8')).toBe(file);
        expect(warnings).toEqual(['trust: the trust file is unreadable — pins not checked']);
    });

    it('reads past a sealedOnce an older version wrote and keeps the commands it holds', async () => {
        const key = await newKey();
        writeFileSync(trustPath, JSON.stringify({
            version: 1,
            sealedOnce: 'yes',
            devices: { dev_phone: { publicKey: key, pinnedAt: '2026-10-01T00:00:00.000Z' } },
            commands: { dev_phone: 4 },
        }));

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
        expect(await peerKeyOf('dev_tablet', deps({ dev_tablet: await newKey() }))).toMatchObject({ key: expect.any(String) });
        expect(JSON.parse(readFileSync(trustPath, 'utf8')).commands).toEqual({ dev_phone: 4 });
    });

    it('never pins this computer, whatever the list says of it', async () => {
        const key = await newKey();

        expect(await peerKeyOf('dev_self', deps({ dev_self: key }, { selfId: 'dev_self' }))).toEqual({ key });
        expect(() => readFileSync(trustPath)).toThrow();
    });

    it('treats anything that is not a device id as unlisted without asking the list', async () => {
        let asked = false;
        const spy: PeerKeyDeps = { registeredKey: async () => { asked = true; return 'k'; }, trustPath };
        for (const id of ['', '../etc/passwd', 'dev phone', 'x'.repeat(65)]) {
            expect(await peerKeyOf(id, spy)).toEqual({ refused: 'unlisted' });
        }
        expect(asked).toBe(false);
    });
});
