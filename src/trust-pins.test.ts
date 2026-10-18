import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { publicKeySender } from './crypto.js';
import { MAX_PINNED_DEVICES } from './subscriber-trust.js';
import { keyChangesPath, takeKeyChanges } from './key-changes.js';
import { trustLockPath } from './trust-lock.js';
import { observeDevices } from './trust-pins.js';

let dir: string;
let path: string;
let warnings: string[];

const NOW = new Date('2026-10-12T09:00:00.000Z');
const observe = (devices: { deviceId: string; publicKey?: string; nickname?: string }[], selfId?: string) =>
    observeDevices(path, devices, { selfId, now: () => NOW, warn: (line) => warnings.push(line) });
const stored = (): { devices: Record<string, { publicKey: string; pinnedAt: string }>; [field: string]: unknown } =>
    JSON.parse(readFileSync(path, 'utf-8'));

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-pins-'));
    path = join(dir, 'trusted-devices.json');
    warnings = [];
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('observeDevices', () => {
    it('should pin every device that lists a key, the first time it is seen', () => {
        const phone = v2Party();
        const tablet = v2Party();

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }, { deviceId: 'dev_android_1', publicKey: tablet.publicKey }]);

        expect(seen).toEqual({ pinned: ['dev_ios_1', 'dev_android_1'], replaced: [], skipped: [], status: 'ok' });
        expect(stored().devices).toEqual({
            dev_ios_1: { publicKey: phone.publicKey, pinnedAt: NOW.toISOString() },
            dev_android_1: { publicKey: tablet.publicKey, pinnedAt: NOW.toISOString() },
        });
        expect(warnings).toEqual([]);
        expect(existsSync(trustLockPath(path))).toBe(false);
    });

    it('should leave the file alone when nothing changed, without taking the lock', () => {
        const phone = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);
        const before = readFileSync(path, 'utf-8');
        writeFileSync(trustLockPath(path), '1 1\n');

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: [], skipped: [], status: 'ok' });
        expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('should skip a device with no key, this computer, and an id that is not a device id', () => {
        const self = v2Party();
        const other = v2Party();

        const seen = observe(
            [{ deviceId: 'dev_old' }, { deviceId: 'dev_self', publicKey: self.publicKey }, { deviceId: 'no spaces allowed', publicKey: other.publicKey }],
            'dev_self',
        );

        expect(seen).toEqual({ pinned: [], replaced: [], skipped: [], status: 'ok' });
        expect(existsSync(path)).toBe(false);
    });

    it('should replace the pin of a device whose key changed, and say so once', () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: ['dev_ios_1'], skipped: [], status: 'ok' });
        expect(stored().devices.dev_ios_1.publicKey).toBe(reinstalled.publicKey);
        expect(warnings).toEqual(['trust: dev_ios_1 changed its key — now pinned to the new one']);
        expect(observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]).replaced).toEqual([]);
        expect(warnings).toHaveLength(1);
    });

    it('should record a replaced pin for a person to see, with the name the list gives', () => {
        const phone = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);
        expect(existsSync(keyChangesPath(path))).toBe(false);

        observe([{ deviceId: 'dev_ios_1', publicKey: v2Party().publicKey, nickname: 'iPhone' }]);

        expect(takeKeyChanges(path)).toEqual([{ deviceId: 'dev_ios_1', at: NOW.toISOString(), name: 'iPhone' }]);
    });

    // The pin is shared: a second process that finds the new key already pinned sees `same`, and the record is all that is left.
    it('should keep the record when another process then sees the new key as the pinned one', () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);
        observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        expect(takeKeyChanges(path).map((c) => c.deviceId)).toEqual(['dev_ios_1']);
    });

    it('should not pin a key that is already pinned for another id', () => {
        const phone = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);

        const seen = observe([{ deviceId: 'dev_ios_2', publicKey: phone.publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: [], skipped: ['dev_ios_2'], status: 'ok' });
        expect(Object.keys(stored().devices)).toEqual(['dev_ios_1']);
    });

    it('should not pin two ids with one key in the same list', () => {
        const phone = v2Party();

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }, { deviceId: 'dev_ios_2', publicKey: phone.publicKey }]);

        expect(seen).toMatchObject({ pinned: ['dev_ios_1'], skipped: ['dev_ios_2'] });
    });

    it('should pin no more than the cap, and skip the rest', () => {
        const devices = Array.from({ length: MAX_PINNED_DEVICES + 2 }, (_, i) => ({ deviceId: `dev_${i}`, publicKey: v2Party().publicKey }));

        const seen = observe(devices);

        expect(seen.pinned).toHaveLength(MAX_PINNED_DEVICES);
        expect(seen.skipped).toEqual(['dev_64', 'dev_65']);
        expect(Object.keys(stored().devices)).toHaveLength(MAX_PINNED_DEVICES);
    });

    it('should keep commands, command keys and fields it does not know', () => {
        const phone = v2Party();
        const tablet = v2Party();
        writeFileSync(path, JSON.stringify({
            version: 1,
            devices: { dev_ios_1: { publicKey: phone.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } },
            commands: { dev_ios_1: 7 },
            commandKeys: { [publicKeySender(tablet.publicKey) as string]: 9 },
            futureField: true,
        }));

        observe([{ deviceId: 'dev_android_1', publicKey: tablet.publicKey }]);

        expect(stored()).toMatchObject({ commands: { dev_ios_1: 7 }, commandKeys: { [publicKeySender(tablet.publicKey) as string]: 9 }, futureField: true });
    });

    it('should not write, and say the pins were not checked, when the trust file cannot be read', () => {
        writeFileSync(path, '{ not json');

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: v2Party().publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: [], skipped: [], status: 'unreadable' });
        expect(readFileSync(path, 'utf-8')).toBe('{ not json');
        expect(warnings).toEqual(['trust: the trust file is unreadable — pins not checked']);
    });

    it('should write nothing, but still say a key changed, when another writer holds the lock', () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);
        const before = readFileSync(path, 'utf-8');
        writeFileSync(trustLockPath(path), '1 1\n');

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: ['dev_ios_1'], skipped: [], status: 'unlocked' });
        expect(readFileSync(path, 'utf-8')).toBe(before);
        expect(warnings).toEqual(['trust: dev_ios_1 changed its key — could not record the new pin']);
        expect(existsSync(keyChangesPath(path))).toBe(false);
    }, 10_000);

    // The pin holds the new key now: the next send sees `same`, so this line is all that is left of the change.
    it('should say so when the pin is replaced but the change cannot be saved for later', () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        observe([{ deviceId: 'dev_ios_1', publicKey: phone.publicKey }]);
        mkdirSync(join(keyChangesPath(path), 'in-the-way'), { recursive: true });

        const seen = observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        expect(seen).toEqual({ pinned: [], replaced: ['dev_ios_1'], skipped: [], status: 'ok' });
        expect(stored().devices.dev_ios_1.publicKey).toBe(reinstalled.publicKey);
        expect(warnings).toEqual([
            'trust: dev_ios_1 changed its key — now pinned to the new one',
            'trust: could not save that key change for later (key-changes.json) — this line is the only notice',
        ]);
    });

    it('should take the numbers a replaced key had, in a file that holds them by id only', () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        writeFileSync(path, JSON.stringify({
            version: 1,
            devices: { dev_ios_1: { publicKey: phone.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } },
            commands: { dev_ios_1: 1000 },
        }));

        observe([{ deviceId: 'dev_ios_1', publicKey: reinstalled.publicKey }]);

        expect(Object.values(stored().commandKeys as Record<string, number>)).toEqual([1000]);
    });
});
