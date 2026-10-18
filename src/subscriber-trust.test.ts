import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mirroredPublicKey, v2Party } from '../tests/helpers/seal.js';
import { createSubscriberTrust, MAX_PINNED_DEVICES, planPin, withPin, type SubscriberTrustDeps } from './subscriber-trust.js';
import { takeKeyChanges } from './key-changes.js';
import { trustLockPath } from './trust-lock.js';

let dir: string;
let path: string;
let logs: string[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'subscriber-trust-'));
    path = join(dir, 'trusted-devices.json');
    logs = [];
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const KEY = v2Party().publicKey;
const PHONE = 'dev_ios_0a1b2c3d';

/** A trust store over `path` whose device list is `registered` (deviceId → key). */
const trustWith = (registered: Record<string, string>, overrides: Partial<SubscriberTrustDeps> = {}) =>
    createSubscriberTrust({
        path,
        registeredKey: async (deviceId) => registered[deviceId] ?? null,
        log: (msg) => logs.push(msg),
        now: () => new Date('2026-10-01T12:00:00.000Z'),
        ...overrides,
    });

const stored = (): { version: number; devices: Record<string, { publicKey: string; pinnedAt: string }> } =>
    JSON.parse(readFileSync(path, 'utf-8'));

describe('subscriber trust — a request with a key', () => {
    it('should seal for a key the account registered for that device, and pin it', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'seal', publicKey: phone.publicKey });

        expect(stored()).toEqual({
            version: 1,
            devices: { [PHONE]: { publicKey: phone.publicKey, pinnedAt: '2026-10-01T12:00:00.000Z' } },
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    // The relay stamps the sender id. A key already pinned for one device, asked with under another id the account's
    // list also holds, would give the replay check an empty column of its own.
    it('should refuse a key that is pinned for another device, and pin nothing for the new id', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey, dev_fresh_1: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trust.admit({ deviceId: 'dev_fresh_1', publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_key_in_use' });

        expect(Object.keys(stored().devices)).toEqual([PHONE]);
        expect(logs.join('\n')).toContain(`hwip trust dev_fresh_1`);
    });

    it('should still seal for the device the key is pinned for', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey, dev_fresh_1: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'seal', publicKey: phone.publicKey });
    });

    it('should refuse a key that is not the one registered for the device', async () => {
        const phone = v2Party();
        const relay = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE, publicKey: relay.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });

        expect(existsSync(path)).toBe(false);
        expect(trust.sealedOnly()).toBe(false);
    });

    it('should refuse a device the account does not list', async () => {
        const phone = v2Party();
        const trust = trustWith({});

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
    });

    it('should refuse a request that names no device', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(await trust.admit({ publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
    });

    it.each([
        ['control characters', 'dev_ios_0a1b2c3d\n\u001b[2J'],
        ['a shell command', 'x; rm -rf ~'],
        ['more than 64 characters', 'd'.repeat(65)],
    ])('should refuse a device id holding %s, without looking it up or logging it', async (_what, deviceId) => {
        const phone = v2Party();
        const lookedUp: string[] = [];
        const trust = trustWith({}, { registeredKey: async (id) => { lookedUp.push(id); return phone.publicKey; } });

        expect(await trust.admit({ deviceId, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });

        expect(lookedUp).toEqual([]);
        expect(logs.join('\n')).not.toContain(deviceId);
        expect(existsSync(path)).toBe(false);
    });

    it('should pin no more devices than the cap', async () => {
        const keys = new Map<string, string>();
        const keyOf = (deviceId: string): string => {
            if (!keys.has(deviceId)) keys.set(deviceId, v2Party().publicKey);
            return keys.get(deviceId) ?? '';
        };
        const trust = trustWith({}, { registeredKey: async (deviceId) => keyOf(deviceId) });
        for (let i = 0; i < MAX_PINNED_DEVICES; i++) {
            const deviceId = `dev_ios_${String(i).padStart(8, '0')}`;
            expect(await trust.admit({ deviceId, publicKey: keyOf(deviceId) })).toMatchObject({ kind: 'seal' });
        }

        expect(await trust.admit({ deviceId: 'dev_ios_ffffffff', publicKey: keyOf('dev_ios_ffffffff') })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
        expect(Object.keys(stored().devices)).toHaveLength(MAX_PINNED_DEVICES);
        // A pinned one still gets in.
        expect(await trust.admit({ deviceId: 'dev_ios_00000000', publicKey: keyOf('dev_ios_00000000') })).toMatchObject({ kind: 'seal' });
    });

    it('should refuse when the device list cannot be read', async () => {
        const phone = v2Party();
        const trust = trustWith({}, { registeredKey: async () => { throw new Error('devices 503'); } });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
        expect(logs.join('\n')).toContain('devices 503');
    });

    // A phone that was reinstalled comes back with another key. Nothing is refused for it: the key the account
    // lists is pinned in place of the old one, with a line in the log, once.
    it('should pin the new key of a pinned device, say so once, and seal for it', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });
        logs.length = 0;

        const trust = trustWith({ [PHONE]: reinstalled.publicKey }, { now: () => new Date('2026-10-02T00:00:00.000Z') });

        expect(await trust.admit({ deviceId: PHONE, publicKey: reinstalled.publicKey })).toEqual({ kind: 'seal', publicKey: reinstalled.publicKey });
        expect(await trust.admit({ deviceId: PHONE, publicKey: reinstalled.publicKey })).toEqual({ kind: 'seal', publicKey: reinstalled.publicKey });

        expect(stored().devices[PHONE]).toEqual({ publicKey: reinstalled.publicKey, pinnedAt: '2026-10-02T00:00:00.000Z' });
        expect(logs.filter((line) => line.includes('changed its key'))).toEqual([`trust: ${PHONE} changed its key — now pinned to the new one`]);
        // The daemon log is no place a person reads: the change waits beside the pins for one who does.
        expect(takeKeyChanges(path)).toEqual([{ deviceId: PHONE, at: '2026-10-02T00:00:00.000Z' }]);
    });

    it('should record the name the account lists the device under', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });
        const asked: string[] = [];

        const trust = trustWith({ [PHONE]: reinstalled.publicKey }, {
            now: () => new Date('2026-10-02T00:00:00.000Z'),
            nameOf: async (deviceId) => { asked.push(deviceId); return 'iPhone'; },
        });
        await trust.admit({ deviceId: PHONE, publicKey: reinstalled.publicKey });

        expect(takeKeyChanges(path)).toEqual([{ deviceId: PHONE, at: '2026-10-02T00:00:00.000Z', name: 'iPhone' }]);
        expect(asked).toEqual([PHONE]);
    });

    it('should record the change without a name when the list cannot say one', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        const trust = trustWith({ [PHONE]: reinstalled.publicKey }, {
            now: () => new Date('2026-10-02T00:00:00.000Z'),
            nameOf: async () => { throw new Error('devices 503'); },
        });

        expect(await trust.admit({ deviceId: PHONE, publicKey: reinstalled.publicKey })).toEqual({ kind: 'seal', publicKey: reinstalled.publicKey });
        expect(takeKeyChanges(path)).toEqual([{ deviceId: PHONE, at: '2026-10-02T00:00:00.000Z' }]);
    });

    it('should log it when the pin is replaced but the change cannot be saved for later', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });
        mkdirSync(join(dir, 'key-changes.json', 'in-the-way'), { recursive: true });

        expect(await trustWith({ [PHONE]: reinstalled.publicKey }).admit({ deviceId: PHONE, publicKey: reinstalled.publicKey }))
            .toEqual({ kind: 'seal', publicKey: reinstalled.publicKey });
        expect(logs).toContain('! trust: could not save that key change for later (key-changes.json) — this line is the only notice');
    });

    it('should record nothing for a device pinned on first use', async () => {
        const phone = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(takeKeyChanges(path)).toEqual([]);
    });

    it('should still refuse a key the account does not list for the pinned device', async () => {
        const phone = v2Party();
        const relay = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: relay.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
        expect(stored().devices[PHONE].publicKey).toBe(phone.publicKey);
    });

    it('should not take a new key for a device when it is the key pinned for another id', async () => {
        const phone = v2Party();
        const tablet = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey, dev_ios_ffffffff: tablet.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });
        await trust.admit({ deviceId: 'dev_ios_ffffffff', publicKey: tablet.publicKey });

        const moved = trustWith({ [PHONE]: tablet.publicKey, dev_ios_ffffffff: tablet.publicKey });

        expect(await moved.admit({ deviceId: PHONE, publicKey: tablet.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_key_in_use' });
        expect(stored().devices[PHONE].publicKey).toBe(phone.publicKey);
    });

    it('should keep sealing for the pinned key after a restart', async () => {
        const phone = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        const restarted = trustWith({ [PHONE]: phone.publicKey });

        expect(await restarted.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'seal', publicKey: phone.publicKey });
    });

    it('should pin a second device without touching the first', async () => {
        const phone = v2Party();
        const tablet = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey, dev_ios_ffffffff: tablet.publicKey });

        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });
        await trust.admit({ deviceId: 'dev_ios_ffffffff', publicKey: tablet.publicKey });

        expect(Object.keys(stored().devices).sort()).toEqual(['dev_ios_0a1b2c3d', 'dev_ios_ffffffff']);
        expect(stored().devices[PHONE].publicKey).toBe(phone.publicKey);
    });

    it('should take a pin changed in the file while it runs', async () => {
        // What `hwip trust <device>` does beside a running daemon.
        const phone = v2Party();
        const replaced = v2Party();
        const registered: Record<string, string> = { [PHONE]: phone.publicKey };
        const trust = trustWith(registered);
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        const state = stored();
        state.devices[PHONE] = { publicKey: replaced.publicKey, pinnedAt: '2026-10-02T00:00:00.000Z' };
        writeFileSync(path, JSON.stringify(state));
        utimesSync(path, new Date(), new Date(Date.now() + 5_000));
        registered[PHONE] = replaced.publicKey;

        expect(await trust.admit({ deviceId: PHONE, publicKey: replaced.publicKey })).toEqual({ kind: 'seal', publicKey: replaced.publicKey });
        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toMatchObject({ kind: 'refuse' });
    });

    it('should refuse rather than seal when the pin cannot be written', async () => {
        const phone = v2Party();
        // The state file's directory is a file: nothing can be created under it.
        writeFileSync(join(dir, 'blocker'), '');
        const trust = createSubscriberTrust({
            path: join(dir, 'blocker', 'trusted-devices.json'),
            registeredKey: async () => phone.publicKey,
            log: (msg) => logs.push(msg),
        });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
    });
});

describe('subscriber trust — a request without a key', () => {
    it('should answer in the clear while this listener has never sealed', async () => {
        const trust = trustWith({});

        expect(await trust.admit({ deviceId: PHONE })).toEqual({ kind: 'plain' });
        expect(trust.sealedOnly()).toBe(false);
        expect(existsSync(path)).toBe(false);
    });

    it('should refuse once this listener has sealed for anyone', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE })).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
        expect(await trust.admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
        expect(trust.sealedOnly()).toBe(true);
    });

    it('should refuse when the state file is removed under a listener that only sealed', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        rmSync(path);

        expect(trust.sealedOnly()).toBe(true);
        expect(await trust.admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
    });

    it('should still refuse after a restart', async () => {
        const phone = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trustWith({}).admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
    });
});

describe('subscriber trust — writing the state file', () => {
    it('should leave no temp file behind when the state cannot be written', async () => {
        const phone = v2Party();
        // The state path is a directory: the write lands, the rename onto it cannot.
        mkdirSync(path);
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });

        expect(readdirSync(dir)).toEqual(['trusted-devices.json']);
    });

    it('should refuse rather than seal when another writer holds the lock, and pin nothing', async () => {
        const phone = v2Party();
        writeFileSync(trustLockPath(path), '1 1\n');
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });

        expect(existsSync(path)).toBe(false);
    }, 10_000);

    it('should leave no lock behind after a pin', async () => {
        const phone = v2Party();
        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(existsSync(trustLockPath(path))).toBe(false);
    });

    it('should keep a top-level field this version does not know, and never write sealedOnce back', async () => {
        const phone = v2Party();
        writeFileSync(path, JSON.stringify({ version: 1, sealedOnce: true, devices: {}, futureField: { a: 1 } }));

        await trustWith({ [PHONE]: phone.publicKey }).admit({ deviceId: PHONE, publicKey: phone.publicKey });

        const file: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf-8'));
        expect(file.futureField).toEqual({ a: 1 });
        expect(file).not.toHaveProperty('sealedOnce');
        expect(file.devices).toMatchObject({ [PHONE]: { publicKey: phone.publicKey } });
    });

    // A file from before `commandKeys` holds a number only by id: replacing the pin moves it under the old key.
    it('should keep the numbers taken with a key when its pin is replaced, in a file that holds them by id only', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        writeFileSync(path, JSON.stringify({
            version: 1,
            devices: { [PHONE]: { publicKey: phone.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } },
            commands: { [PHONE]: 1000 },
        }));

        await trustWith({ [PHONE]: reinstalled.publicKey }).admit({ deviceId: PHONE, publicKey: reinstalled.publicKey });

        const later = trustWith({ dev_ios_ffffffff: phone.publicKey });
        expect(later.acceptCommand('dev_ios_ffffffff', 1000, phone.publicKey)).toBe(false);
        expect(later.acceptCommand('dev_ios_ffffffff', 1001, phone.publicKey)).toBe(true);
    });

    it('should drop a sealed command, and keep the numbers, while another writer holds the lock', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });
        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);
        const before = readFileSync(path, 'utf-8');
        writeFileSync(trustLockPath(path), '1 1\n');

        expect(trust.acceptCommand(PHONE, 1001, phone.publicKey)).toBe(false);

        expect(readFileSync(path, 'utf-8')).toBe(before);
    }, 10_000);

    it('should keep the command numbers another writer saved between its read and its write', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });
        // A second process takes a command number after this listener last read the file.
        const state = stored() as { devices: object; commands?: Record<string, number> };
        writeFileSync(path, JSON.stringify({ ...state, commands: { [PHONE]: 9 } }));

        const other = v2Party();
        await trustWith({ dev_ios_ffffffff: other.publicKey }).admit({ deviceId: 'dev_ios_ffffffff', publicKey: other.publicKey });

        expect((stored() as { commands?: Record<string, number> }).commands).toEqual({ [PHONE]: 9 });
    });
});

describe('subscriber trust — an unusable state file', () => {
    it.each([
        ['is not JSON', '{'],
        ['is another version', JSON.stringify({ version: 2, devices: {} })],
        ['holds a malformed pin', JSON.stringify({ version: 1, devices: { [PHONE]: { publicKey: 1 } } })],
    ])('should refuse everything when the file %s', async (_what, body) => {
        const phone = v2Party();
        writeFileSync(path, body);
        const trust = trustWith({ [PHONE]: phone.publicKey });

        expect(trust.sealedOnly()).toBe(true);
        expect(await trust.admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
        expect(await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey })).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
        // The file is left as it was: a reset is a person's decision.
        expect(readFileSync(path, 'utf-8')).toBe(body);
        expect(logs.filter((line) => line.includes('hwip trust --reset'))).toHaveLength(1);
    });

    // root reads through the missing permission bits.
    it.skipIf(process.getuid?.() === 0)('should refuse everything when the file cannot be read', async () => {
        writeFileSync(path, JSON.stringify({ version: 1, devices: {} }));
        chmodSync(path, 0o000);
        const trust = trustWith({});

        expect(await trust.admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });
        chmodSync(path, 0o600);
    });

    it('should work again once the file is repaired', async () => {
        writeFileSync(path, '{');
        const trust = trustWith({});
        expect(trust.sealedOnly()).toBe(true);

        writeFileSync(path, JSON.stringify({ version: 1, devices: {} }));

        expect(await trust.admit({})).toEqual({ kind: 'plain' });
    });
});

// A sealed REST command carries a number that only grows per sender (M5 D8):
// the listener keeps the last one taken, in the same file, so a command the
// relay sends again — before or after a restart — is not typed twice.
describe('subscriber trust — sealed command numbers', () => {
    it('should take a larger number and refuse the same or a smaller one', () => {
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, KEY)).toBe(true);
        expect(trust.acceptCommand(PHONE, 1000, KEY)).toBe(false);
        expect(trust.acceptCommand(PHONE, 999, KEY)).toBe(false);
        expect(trust.acceptCommand(PHONE, 1001, KEY)).toBe(true);
    });

    it('should keep the numbers of each sender apart', () => {
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, KEY)).toBe(true);
        expect(trust.acceptCommand('dev_ios_99999999', 10, v2Party().publicKey)).toBe(true);
    });

    it('should refuse a number taken before the listener restarted', () => {
        expect(trustWith({}).acceptCommand(PHONE, 1000, KEY)).toBe(true);

        expect(trustWith({}).acceptCommand(PHONE, 1000, KEY)).toBe(false);
    });

    it.each([
        ['not an integer', 1.5],
        ['negative', -1],
        ['not finite', Number.POSITIVE_INFINITY],
    ])('should refuse a number that is %s', (_, n) => {
        expect(trustWith({}).acceptCommand(PHONE, n, KEY)).toBe(false);
    });

    it('should refuse a sender that is not a device id', () => {
        expect(trustWith({}).acceptCommand('../etc', 1, KEY)).toBe(false);
    });

    it('should refuse every command while the file is unusable', () => {
        writeFileSync(path, '{');

        expect(trustWith({}).acceptCommand(PHONE, 1, KEY)).toBe(false);
    });

    // root writes through the missing permission bits.
    it.skipIf(process.getuid?.() === 0)('should refuse a command whose number could not be written', () => {
        const locked = join(dir, 'locked');
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        const trust = trustWith({}, { path: join(locked, 'trusted-devices.json') });

        expect(trust.acceptCommand(PHONE, 1, KEY)).toBe(false);
        chmodSync(locked, 0o700);
    });

    it('should keep the pins and the sealed-only state when it writes a number', async () => {
        const phone = v2Party();
        const trust = trustWith({ [PHONE]: phone.publicKey });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        trust.acceptCommand(PHONE, 1000, KEY);

        expect(stored()).toMatchObject({ devices: { [PHONE]: { publicKey: phone.publicKey } }, commands: { [PHONE]: 1000 } });
    });
});

// A person can pin the same key under two ids (`hwip trust <id>` is their decision); the numbers are then shared
// between them, or a command taken under one id could be typed again under the other.
describe('subscriber trust — command numbers of one key', () => {
    const pinnedTwice = (key: string) => {
        const pin = { publicKey: key, pinnedAt: '2026-10-01T00:00:00.000Z' };
        writeFileSync(path, JSON.stringify({ version: 1, devices: { [PHONE]: pin, dev_fresh_1: pin } }));
    };

    it('should refuse a number taken under another id pinned to the same key', () => {
        const phone = v2Party();
        pinnedTwice(phone.publicKey);
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);
        expect(trust.acceptCommand('dev_fresh_1', 1000, phone.publicKey)).toBe(false);
        expect(trust.acceptCommand('dev_fresh_1', 1001, phone.publicKey)).toBe(true);
        expect(trust.acceptCommand(PHONE, 1001, phone.publicKey)).toBe(false);
    });

    it('should not mix the numbers of different keys', () => {
        const phone = v2Party();
        const tablet = v2Party();
        const pin = (publicKey: string) => ({ publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' });
        writeFileSync(path, JSON.stringify({ version: 1, devices: { [PHONE]: pin(phone.publicKey), dev_ios_99999999: pin(tablet.publicKey) } }));
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);
        expect(trust.acceptCommand('dev_ios_99999999', 10, tablet.publicKey)).toBe(true);
    });
});

// `hwip trust --reset` empties the pins and keeps the numbers. The largest number taken with each sealing key is written
// beside them (`commandKeys`, by the x coordinate of the key), so that those numbers still count under an id the file has
// never seen, after a key change, and for the key's mirror image (a relay makes it without any secret).
describe('subscriber trust — command numbers by key', () => {
    const sender = (publicKey: string): string => Buffer.from(publicKey, 'base64').subarray(-64, -32).toString('hex');
    const withFile = (extra: Record<string, unknown>) => {
        writeFileSync(path, JSON.stringify({ version: 1, devices: {}, ...extra }));
    };
    const keyFile = (): Record<string, number> => JSON.parse(readFileSync(path, 'utf-8')).commandKeys ?? {};

    it('should write the largest number beside the key, apart from the id', () => {
        const phone = v2Party();
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);
        expect(trust.acceptCommand(PHONE, 1001, phone.publicKey)).toBe(true);

        const file = JSON.parse(readFileSync(path, 'utf-8'));
        expect(file).toMatchObject({ version: 1, commands: { [PHONE]: 1001 }, commandKeys: { [sender(phone.publicKey)]: 1001 } });
    });

    it('should refuse a number of a key under a new id after the pins were forgotten', () => {
        const phone = v2Party();
        withFile({ commands: { [PHONE]: 1000 }, commandKeys: { [sender(phone.publicKey)]: 1000 } });
        const trust = trustWith({});

        expect(trust.acceptCommand('dev_fresh_1', 1000, phone.publicKey)).toBe(false);
        expect(trust.acceptCommand('dev_fresh_1', 999, phone.publicKey)).toBe(false);
        expect(trust.acceptCommand('dev_fresh_1', 1001, phone.publicKey)).toBe(true);
    });

    // The branch that reads the id column of every device pinned to the key: a file from before `commandKeys` has no key column.
    it('should refuse a number taken under another id pinned to the same key, where the file has no key column', () => {
        const phone = v2Party();
        const pinned = (publicKey: string) => ({ publicKey, pinnedAt: '2026-10-01T12:00:00.000Z' });
        withFile({ devices: { [PHONE]: pinned(phone.publicKey), dev_new: pinned(phone.publicKey) }, commands: { [PHONE]: 1000 } });
        const trust = trustWith({});

        expect(trust.acceptCommand('dev_new', 1000, phone.publicKey)).toBe(false);
        expect(trust.acceptCommand('dev_new', 1001, phone.publicKey)).toBe(true);
    });

    it('should refuse a number of a key under the key\'s mirror image', () => {
        const phone = v2Party();
        const trust = trustWith({});
        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);

        expect(trust.acceptCommand('dev_fresh_1', 1000, mirroredPublicKey(phone.publicKey))).toBe(false);
        expect(trust.acceptCommand('dev_fresh_1', 1001, mirroredPublicKey(phone.publicKey))).toBe(true);
    });

    it('should still refuse the old key\'s numbers after the same id took numbers with another key', () => {
        const old = v2Party();
        const rotated = v2Party();
        const trust = trustWith({});
        expect(trust.acceptCommand(PHONE, 1000, old.publicKey)).toBe(true);
        expect(trust.acceptCommand(PHONE, 2000, rotated.publicKey)).toBe(true);

        expect(trust.acceptCommand('dev_fresh_2', 1000, old.publicKey)).toBe(false);
        expect(Object.keys(keyFile()).sort()).toEqual([sender(old.publicKey), sender(rotated.publicKey)].sort());
    });

    it('should still refuse the phone\'s numbers after a key of the relay\'s took a number under the phone\'s id', () => {
        const phone = v2Party();
        const relay = v2Party();
        const trust = trustWith({});
        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(true);
        expect(trust.acceptCommand(PHONE, 1001, relay.publicKey)).toBe(true);

        expect(trust.acceptCommand('dev_fresh_1', 1000, phone.publicKey)).toBe(false);
    });

    it('should not hold another key to those numbers', () => {
        const phone = v2Party();
        const tablet = v2Party();
        withFile({ commands: { [PHONE]: 1000 }, commandKeys: { [sender(phone.publicKey)]: 1000 } });

        expect(trustWith({}).acceptCommand('dev_ios_99999999', 10, tablet.publicKey)).toBe(true);
    });

    it('should behave as before for a file with numbers and no keys', () => {
        const phone = v2Party();
        withFile({ commands: { [PHONE]: 1000 } });
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, phone.publicKey)).toBe(false);
        expect(trust.acceptCommand('dev_fresh_1', 5, phone.publicKey)).toBe(true);
    });

    it.each([
        ['not an object', 'x'],
        ['an array', [1000]],
        ['null', null],
        ['numbers that are not whole', { [sender(KEY)]: 1.5 }],
        ['senders that are not a key\'s x coordinate', { [PHONE]: 1000, ABCDEF: 1000 }],
    ])('should ignore commandKeys that are %s, and still use the numbers', (_, commandKeys) => {
        withFile({ commands: { [PHONE]: 1000 }, commandKeys });
        const trust = trustWith({});

        expect(trust.acceptCommand(PHONE, 1000, KEY)).toBe(false);
        expect(trust.acceptCommand(PHONE, 1001, KEY)).toBe(true);
    });

    it('should refuse a sender that is not a device key', () => {
        expect(trustWith({}).acceptCommand(PHONE, 1, 'not-a-key')).toBe(false);
    });

    it('should read every key in a file past the cap, and take a new key only if there is room', () => {
        const commandKeys: Record<string, number> = {};
        const parties = Array.from({ length: MAX_PINNED_DEVICES + 6 }, () => v2Party());
        for (const party of parties) commandKeys[sender(party.publicKey)] = 500;
        withFile({ commandKeys });
        const trust = trustWith({});
        const last = parties[parties.length - 1];

        expect(trust.acceptCommand(PHONE, 500, last.publicKey)).toBe(false);
        expect(trust.acceptCommand(PHONE, 501, last.publicKey)).toBe(true);
        expect(trust.acceptCommand(PHONE, 600, v2Party().publicKey)).toBe(false);
        expect(logs.join('\n')).toContain(`${MAX_PINNED_DEVICES} keys have numbers already`);
        expect(Object.keys(keyFile()).length).toBe(MAX_PINNED_DEVICES + 6);
    });

    it('should keep the keys when a save adds a pin', async () => {
        const phone = v2Party();
        withFile({ commands: { [PHONE]: 1000 }, commandKeys: { [sender(phone.publicKey)]: 1000 } });
        const other = v2Party();
        const trust = trustWith({ dev_ios_99999999: other.publicKey });

        await trust.admit({ deviceId: 'dev_ios_99999999', publicKey: other.publicKey });

        expect(keyFile()).toEqual({ [sender(phone.publicKey)]: 1000 });
    });

    it('should refuse the mirror image of a key pinned for another device', async () => {
        const phone = v2Party();
        const mirror = mirroredPublicKey(phone.publicKey);
        const trust = trustWith({ [PHONE]: phone.publicKey, dev_fresh_1: mirror });
        await trust.admit({ deviceId: PHONE, publicKey: phone.publicKey });

        expect(await trust.admit({ deviceId: 'dev_fresh_1', publicKey: mirror })).toEqual({ kind: 'refuse', reason: 'subscriber_key_in_use' });
        expect(Object.keys(stored().devices)).toEqual([PHONE]);
    });
});

describe('planPin and withPin', () => {
    const [ka, kb, kc, knew] = [v2Party().publicKey, v2Party().publicKey, v2Party().publicKey, v2Party().publicKey];
    const state = (devices: Record<string, string>) => ({
        devices: new Map(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' }])),
        commands: new Map<string, number>(),
        commandKeys: new Map<string, number>(),
        extra: {},
    });

    it('should tell a new device, the same key, a changed key, a key held by another id, and a full list apart', () => {
        const pinned = state({ dev_a: ka, dev_b: kb });

        expect(planPin(pinned, 'dev_c', kc)).toBe('new');
        expect(planPin(pinned, 'dev_a', ka)).toBe('same');
        expect(planPin(pinned, 'dev_a', kc)).toBe('replace');
        expect(planPin(pinned, 'dev_c', kb)).toBe('in-use');

        const full = state(Object.fromEntries(Array.from({ length: MAX_PINNED_DEVICES }, (_, i) => [`dev_${i}`, v2Party().publicKey])));
        expect(planPin(full, 'dev_new', knew)).toBe('cap');
        expect(planPin(full, 'dev_0', knew)).toBe('replace');
    });

    it('should return a state with the pin and leave the one it was given alone', () => {
        const pinned = state({ dev_a: ka });

        const next = withPin(pinned, 'dev_a', kb, new Date('2026-10-02T00:00:00.000Z'));

        expect(next.devices.get('dev_a')).toEqual({ publicKey: kb, pinnedAt: '2026-10-02T00:00:00.000Z' });
        expect(pinned.devices.get('dev_a')?.publicKey).toBe(ka);
    });
});
