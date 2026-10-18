import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeKeyChange, keyChangesPath, MAX_KEY_CHANGES, recordKeyChanges, showKeyChanges, takeKeyChanges } from './key-changes.js';
import { trustLockPath } from './trust-lock.js';

let dir: string;
let trustPath: string;

const AT = '2026-10-13T09:00:00.000Z';
const stored = (): unknown => JSON.parse(readFileSync(keyChangesPath(trustPath), 'utf-8'));

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'key-changes-'));
    trustPath = join(dir, 'trusted-devices.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('key-changes.json', () => {
    it('lives beside the trust file', () => {
        expect(keyChangesPath(trustPath)).toBe(join(dir, 'key-changes.json'));
    });

    // The contract cli, mcp-server and the plugin read (plugin tests/fixtures/key-changes.json holds the same line).
    it('writes the contract line, private', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);

        expect(readFileSync(keyChangesPath(trustPath), 'utf-8')).toBe('{"v":1,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z","name":"iPhone"}]}\n');
        expect(statSync(keyChangesPath(trustPath)).mode & 0o777).toBe(0o600);
    });

    it('keeps one line per device, updated in place', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }, { deviceId: 'dev_android_1', at: AT }]);
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: '2026-10-13T10:00:00.000Z', name: 'iPhone' }]);

        expect(stored()).toEqual({ v: 1, changes: [
            { deviceId: 'dev_ios_1', at: '2026-10-13T10:00:00.000Z', name: 'iPhone' },
            { deviceId: 'dev_android_1', at: AT },
        ] });
    });

    it('keeps the newest 64, dropping the oldest', () => {
        const many = Array.from({ length: MAX_KEY_CHANGES + 2 }, (_, i) => ({ deviceId: `dev_${i}`, at: AT }));
        recordKeyChanges(trustPath, many);

        const changes = (stored() as { changes: { deviceId: string }[] }).changes;
        expect(changes).toHaveLength(MAX_KEY_CHANGES);
        expect(changes[0].deviceId).toBe('dev_2');
    });

    it('starts over from a record it cannot read', () => {
        writeFileSync(keyChangesPath(trustPath), '{ not json');

        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);

        expect(stored()).toEqual({ v: 1, changes: [{ deviceId: 'dev_ios_1', at: AT }] });
    });

    it('stores a name without control characters, cut short', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: `\u001b[2Jphone\u202e ${'x'.repeat(200)}` }]);

        const name = (stored() as { changes: { name: string }[] }).changes[0].name;
        expect(name).not.toMatch(/[\u0000-\u001f\u202e]/u);
        expect(Array.from(name).length).toBeLessThanOrEqual(80);
        expect(name.startsWith('[2Jphone x')).toBe(true);
    });

    it('throws nothing when the folder cannot hold the record, and says it was not written', () => {
        const blocked = join(dir, 'file-not-folder');
        writeFileSync(blocked, '');
        expect(recordKeyChanges(join(blocked, 'trusted-devices.json'), [{ deviceId: 'dev_ios_1', at: AT }])).toBe(false);
        expect(recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }])).toBe(true);
    });
});

describe('takeKeyChanges', () => {
    it('returns the changes once and removes the record', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);

        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(readdirSync(dir)).toEqual([]);
    });

    // A writer holds the lock from reading the record to renaming its new one over it: what is taken then would come back.
    it('takes nothing while a writer holds the lock, and leaves the record', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);
        writeFileSync(trustLockPath(trustPath), `${process.pid} ${Date.now()}\n`);

        expect(takeKeyChanges(trustPath, { waitMs: 50 })).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(true);

        rmSync(trustLockPath(trustPath));
        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_1', at: AT }]);
        expect(existsSync(trustLockPath(trustPath))).toBe(false);
    });

    it('takes no lock, and makes no folder, when there is no record', () => {
        const absent = join(dir, 'never-made', 'trusted-devices.json');

        expect(takeKeyChanges(absent)).toEqual([]);
        expect(existsSync(join(dir, 'never-made'))).toBe(false);
    });

    it('gives a change to one of two takers only', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);

        const both = [takeKeyChanges(trustPath), takeKeyChanges(trustPath)];

        expect(both.flat()).toHaveLength(1);
    });

    it('reads an unknown version or a broken record as none, and removes it', () => {
        writeFileSync(keyChangesPath(trustPath), '{"v":2,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z"}]}');
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);

        writeFileSync(keyChangesPath(trustPath), 'garbage');
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);
    });

    it('drops entries that are not a device id with an ISO time', () => {
        writeFileSync(keyChangesPath(trustPath), JSON.stringify({ v: 1, changes: [
            { deviceId: 'no spaces allowed', at: AT },
            { deviceId: 'dev_ios_1', at: '$(touch pwned)' },
            { deviceId: 'dev_ios_2', at: AT, name: 7 },
        ] }));

        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_2', at: AT }]);
    });
});

describe('showKeyChanges', () => {
    it('prints one line per change at a terminal, and takes them', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }, { deviceId: 'dev_android_1', at: AT }]);
        const lines: string[] = [];

        showKeyChanges(trustPath, { isTTY: true, write: (s) => { lines.push(s); } });

        expect(lines).toEqual([
            `hwip: ${describeKeyChange({ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' })}\n`,
            `hwip: ${describeKeyChange({ deviceId: 'dev_android_1', at: AT })}\n`,
        ]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);
    });

    // A hook runs `hwip notify … 2>/dev/null`: taking the record there would lose it unseen.
    it('neither reads nor removes the record when stderr is not a terminal', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);
        const lines: string[] = [];

        showKeyChanges(trustPath, { isTTY: false, write: (s) => { lines.push(s); } });
        showKeyChanges(trustPath, { write: (s) => { lines.push(s); } });

        expect(lines).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(true);
    });

    it('names the device and where to check it', () => {
        expect(describeKeyChange({ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }))
            .toBe('iPhone changed its encryption key — the new key is trusted. Not expecting that (app reinstalled?) Check it: hwip trust');
        expect(describeKeyChange({ deviceId: 'dev_ios_1', at: AT })).toMatch(/^dev_ios_1 changed its encryption key/);
    });
});
