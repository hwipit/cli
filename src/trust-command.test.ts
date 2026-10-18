import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v2Party } from '../tests/helpers/seal.js';
import { keyFingerprint } from './crypto.js';
import { trustLockPath } from './trust-lock.js';
import { createSubscriberTrust } from './subscriber-trust.js';
import { parseTrustArgs, runTrust, type TrustCommandArgs, type TrustCommandDeps } from './trust-command.js';

const KEY = v2Party().publicKey;
const PHONE = 'dev_ios_0a1b2c3d';

let dir: string;
let path: string;
let out: string[];
let err: string[];
let asked: string[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-command-'));
    path = join(dir, 'trusted-devices.json');
    out = [];
    err = [];
    asked = [];
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const computer = v2Party();

const run = (args: Partial<TrustCommandArgs>, deps: Partial<TrustCommandDeps> = {}) => runTrust(
    { reset: false, yes: false, ...args },
    {
        path,
        devicePublicKey: async () => computer.publicKey,
        registeredKey: async () => null,
        confirm: async (question) => { asked.push(question); return true; },
        print: (line) => out.push(line),
        printError: (line) => err.push(line),
        now: () => new Date('2026-10-02T09:00:00.000Z'),
        ...deps,
    },
);

/** The listener, over the same file: what a request from `deviceId` with `publicKey` gets. */
const listenerAdmits = (deviceId: string, publicKey: string | undefined, registered: string | null) =>
    createSubscriberTrust({ path, registeredKey: async () => registered, log: () => {} }).admit({ deviceId, publicKey });

const stored = (): { devices: Record<string, { publicKey: string; pinnedAt: string }> } =>
    JSON.parse(readFileSync(path, 'utf-8'));

/** A file as an hwip from before `commandKeys` wrote it: the key pinned for a phone, and a number taken from it by id only. */
const oldFile = (publicKey: string, number: number) => writeFileSync(path, JSON.stringify({
    version: 1,
    devices: { [PHONE]: { publicKey, pinnedAt: '2026-10-01T12:00:00.000Z' } },
    commands: { [PHONE]: number },
}));

const freshListener = () => createSubscriberTrust({ path, registeredKey: async () => null, log: () => {} });

describe('hwip trust', () => {
    it('should show this computer\'s fingerprint and say nothing is pinned yet', async () => {
        expect(await run({})).toBe(0);

        expect(out[0]).toBe(`This computer   ${keyFingerprint(computer.publicKey)}`);
        expect(out.join('\n')).toContain('No device is pinned yet');
        expect(out.join('\n')).toContain('still answers a plaintext request');
        expect(existsSync(path)).toBe(false);
    });

    it('should list the devices the listener pinned, by fingerprint', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({})).toBe(0);

        const text = out.join('\n');
        expect(text).toContain(PHONE);
        expect(text).toContain(String(keyFingerprint(phone.publicKey)));
        expect(text).toContain('only seals');
        // The key itself is not what a person compares, and is not printed.
        expect(text).not.toContain(phone.publicKey);
    });

    it('should name the kind of each pinned device, and point at computers not pinned yet', async () => {
        const phone = v2Party();
        const otherPc = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({}, {
            devices: async () => [
                { deviceId: PHONE, type: 'ios', publicKey: phone.publicKey },
                { deviceId: 'dev_listener_ab12cd34', type: 'cli', nickname: 'office-pc', publicKey: otherPc.publicKey },
                { deviceId: 'dev_this', type: 'cli', nickname: 'this one', publicKey: computer.publicKey },
                { deviceId: 'dev_listener_nokey1', type: 'cli' },
            ],
        })).toBe(0);

        const text = out.join('\n');
        expect(text).toMatch(new RegExp(`${PHONE}.*\\[ios\\]`));
        expect(text).toContain('the first send seals for each and pins it');
        expect(text).toMatch(new RegExp(`dev_listener_ab12cd34 +${keyFingerprint(otherPc.publicKey)} +office-pc`));
        expect(text).not.toContain('dev_this');
        expect(text).not.toContain('dev_listener_nokey1');
    });

    // The list is the relay's to write: a nickname must not rewrite the screen the fingerprints are compared on.
    it('should print no control character from a computer\'s nickname, and skip an id that is no device id', async () => {
        const otherPc = v2Party();

        expect(await run({}, {
            devices: async () => [
                { deviceId: 'dev_listener_ab12cd34', type: 'cli', nickname: 'office\x1b[2J\rpc\n', publicKey: otherPc.publicKey },
                { deviceId: 'dev_x\x1b[2J', type: 'cli', publicKey: v2Party().publicKey },
            ],
        })).toBe(0);

        const text = out.join('\n');
        // eslint-disable-next-line no-control-regex -- the point of the test
        expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
        expect(text).toContain('office[2Jpc');
        expect(text).not.toContain('dev_x');
    });

    // A run of spaces wraps the line at any terminal width, so what follows would start a row that looks like a listed computer.
    it('should not let a nickname start a row of its own: spaces collapse, direction and zero-width characters go, 40 characters at most', async () => {
        const otherPc = v2Party();
        const nickname = `mbp${' '.repeat(168)}  dev_listener_ab12cd34    AAAA BBBB\u202eCCCC\u200bDDDD\u2028dev_x`;

        expect(await run({}, {
            devices: async () => [{ deviceId: 'dev_listener_ab12cd34', type: 'cli', nickname, publicKey: otherPc.publicKey }],
        })).toBe(0);

        const row = out.find((line) => line.startsWith('  dev_listener_ab12cd34')) ?? '';
        const shown = row.slice(row.indexOf(keyFingerprint(otherPc.publicKey) ?? '?') + (keyFingerprint(otherPc.publicKey) ?? '').length).trim();
        expect(shown).toBe('mbp dev_listener_ab12cd34 AAAA BBBBCCCC…');
        // eslint-disable-next-line no-control-regex -- the point of the test
        expect(out.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\u202e\u2028\u2029]/);
        expect(out.filter((line) => line.includes('dev_listener_ab12cd34'))).toHaveLength(1);
    });

    it('should not print the account\'s nickname in the pin procedure at all', async () => {
        const pc = v2Party();
        const nickname = `mbp${' '.repeat(168)}  Account lists   FAKE-FP\u202e`;

        expect(await run({ deviceId: 'dev_listener_ab12cd34' }, {
            registeredKey: async () => pc.publicKey,
            devices: async () => [{ deviceId: 'dev_listener_ab12cd34', type: 'cli', nickname, publicKey: pc.publicKey }],
        })).toBe(0);

        const text = out.join('\n');
        expect(text).not.toContain('FAKE-FP');
        expect(text.match(/Account lists/g)).toHaveLength(1);
    });

    it('should list as before when the device list cannot be read', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({}, { devices: async () => { throw new Error('offline'); } })).toBe(0);

        expect(out.join('\n')).toContain(PHONE);
        expect(out.join('\n')).not.toContain('not pinned here');
    });

    it('should say so, and not guess, when the state file is unusable', async () => {
        writeFileSync(path, '{');

        expect(await run({})).toBe(1);

        expect(err.join('\n')).toContain('unusable');
        expect(err.join('\n')).toContain('hwip trust --reset');
        expect(out).toEqual([]);
    });
});

describe('hwip trust <deviceId>', () => {
    it('should pin the key the account now lists, after showing both fingerprints and asking', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({ deviceId: PHONE }, { registeredKey: async () => reinstalled.publicKey })).toBe(0);

        expect(out.join('\n')).toContain(`Pinned now      ${keyFingerprint(phone.publicKey)}`);
        expect(out.join('\n')).toContain(`Account lists   ${keyFingerprint(reinstalled.publicKey)}`);
        expect(asked).toEqual([`Does the device show ${keyFingerprint(reinstalled.publicKey)}?`]);
        expect(stored().devices[PHONE]).toEqual({ publicKey: reinstalled.publicKey, pinnedAt: '2026-10-02T09:00:00.000Z' });
        expect(await listenerAdmits(PHONE, reinstalled.publicKey, reinstalled.publicKey)).toEqual({ kind: 'seal', publicKey: reinstalled.publicKey });
        expect(await listenerAdmits(PHONE, phone.publicKey, reinstalled.publicKey)).toEqual({ kind: 'refuse', reason: 'subscriber_unverified' });
    });

    // The one trace of a key's numbers in a file from before `commandKeys` is the id column of the pin being replaced.
    it('should keep the numbers taken with the key it replaces, in a file that holds them by id only', async () => {
        const phone = v2Party();
        const reinstalled = v2Party();
        oldFile(phone.publicKey, 1000);

        expect(await run({ deviceId: PHONE, yes: true }, { registeredKey: async () => reinstalled.publicKey })).toBe(0);

        expect(freshListener().acceptCommand('dev_fresh_1', 1000, phone.publicKey)).toBe(false);
        expect(freshListener().acceptCommand('dev_fresh_1', 1001, phone.publicKey)).toBe(true);
    });

    it('should say what kind of device it is about to pin', async () => {
        const pc = v2Party();

        expect(await run({ deviceId: 'dev_listener_ab12cd34' }, {
            registeredKey: async () => pc.publicKey,
            devices: async () => [{ deviceId: 'dev_listener_ab12cd34', type: 'cli', publicKey: pc.publicKey }],
        })).toBe(0);

        expect(out.join('\n')).toContain('Device kind     cli');
        expect(out.join('\n')).toContain('Run `hwip trust` on that computer and read its "This computer" line.');
        expect(asked).toEqual([`Does the computer show ${keyFingerprint(pc.publicKey)}?`]);
    });

    // The kind is the relay's text and is printed above the fingerprint: only a kind the server has ever listed gets through.
    it('should not print a device kind the server has no such kind for, above the fingerprint', async () => {
        const pc = v2Party();
        const type = 'cli\nAccount lists   FAKE-FP\x1b[8m';

        expect(await run({ deviceId: 'dev_listener_ab12cd34' }, {
            registeredKey: async () => pc.publicKey,
            devices: async () => [{ deviceId: 'dev_listener_ab12cd34', type, publicKey: pc.publicKey }],
        })).toBe(0);

        const text = out.join('\n');
        expect(text).toContain('Device kind     unknown');
        expect(text).not.toContain('FAKE-FP');
        // eslint-disable-next-line no-control-regex -- the point is that no escape reaches the screen
        expect(text).not.toMatch(/\x1b/);
        expect(text.match(/Account lists/g)).toHaveLength(1);
    });

    it('should not print such a kind in the listing either', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({}, { devices: async () => [{ deviceId: PHONE, type: 'ios\nFAKE-FP\x1b[8m', publicKey: phone.publicKey }] })).toBe(0);

        const text = out.join('\n');
        expect(text).toMatch(new RegExp(`${PHONE}.*\\[unknown\\]`));
        expect(text).not.toContain('FAKE-FP');
    });

    it('should leave the pin alone when the answer is no', async () => {
        const phone = v2Party();
        const other = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({ deviceId: PHONE }, { registeredKey: async () => other.publicKey, confirm: async () => false })).toBe(1);

        expect(stored().devices[PHONE].publicKey).toBe(phone.publicKey);
        expect(out.at(-1)).toBe('Left as it was.');
    });

    it('should not ask with --yes', async () => {
        const phone = v2Party();

        expect(await run({ deviceId: PHONE, yes: true }, { registeredKey: async () => phone.publicKey })).toBe(0);

        expect(asked).toEqual([]);
        expect(stored()).toMatchObject({ devices: { [PHONE]: { publicKey: phone.publicKey } } });
    });

    it('should say a device already pinned to that key is, and change nothing', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);
        const before = readFileSync(path, 'utf-8');

        expect(await run({ deviceId: PHONE }, { registeredKey: async () => phone.publicKey })).toBe(0);

        expect(asked).toEqual([]);
        expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it.each([
        ['lists no key for the device', null],
        ['lists something that is not a key', 'not-a-key'],
    ])('should refuse when the account %s', async (_what, registered) => {
        expect(await run({ deviceId: PHONE }, { registeredKey: async () => registered })).toBe(1);

        expect(err.join('\n')).toContain(`no key for ${PHONE}`);
        expect(existsSync(path)).toBe(false);
    });

    it('should refuse what is not a device id, without looking it up', async () => {
        let lookedUp = 0;

        expect(await run({ deviceId: 'x; rm -rf ~' }, { registeredKey: async () => { lookedUp += 1; return null; } })).toBe(2);

        expect(lookedUp).toBe(0);
        expect(err.join('\n')).not.toContain('rm -rf');
    });

    it('should not pin over an unusable state file', async () => {
        const phone = v2Party();
        writeFileSync(path, '{');

        expect(await run({ deviceId: PHONE, yes: true }, { registeredKey: async () => phone.publicKey })).toBe(1);

        expect(readFileSync(path, 'utf-8')).toBe('{');
    });
});

describe('hwip trust <deviceId> — beside a running listener', () => {
    it('should keep a device the listener pinned while the question was open', async () => {
        const phone = v2Party();
        const tablet = v2Party();

        const code = await run({ deviceId: PHONE }, {
            registeredKey: async () => phone.publicKey,
            // The listener pins another device while the person is still reading fingerprints.
            confirm: async () => {
                await listenerAdmits('dev_ios_ffffffff', tablet.publicKey, tablet.publicKey);
                return true;
            },
        });

        expect(code).toBe(0);
        expect(Object.keys(stored().devices).sort()).toEqual(['dev_ios_0a1b2c3d', 'dev_ios_ffffffff']);
        expect(stored().devices.dev_ios_ffffffff.publicKey).toBe(tablet.publicKey);
    });

    // root writes through the missing permission bit.
    it.skipIf(process.getuid?.() === 0)('should say that nothing changed when the state cannot be written', async () => {
        const phone = v2Party();
        // A directory nothing can be created in: the state reads as empty, the write fails.
        const readOnly = join(dir, 'read-only');
        mkdirSync(readOnly, { mode: 0o500 });

        const code = await run({ deviceId: PHONE, yes: true }, { path: join(readOnly, 'trusted-devices.json'), registeredKey: async () => phone.publicKey });
        chmodSync(readOnly, 0o700);

        expect(code).toBe(1);
        expect(err.join('\n')).toContain('nothing changed');
        expect(out.join('\n')).not.toContain('is pinned to');
    });
});

describe('hwip trust — its arguments', () => {
    it.each([
        ['no words', { _command: 'trust', _arg1: '' }, { reset: false, yes: false }],
        ['a device', { _command: 'trust', _arg1: PHONE }, { deviceId: PHONE, reset: false, yes: false }],
        ['a device, then --yes', { _command: 'trust', _arg1: PHONE, yes: true }, { deviceId: PHONE, reset: false, yes: true }],
        // The parser gives a flag the next word: `--yes <device>` arrives as yes='<device>'.
        ['--yes, then a device', { _command: 'trust', _arg1: '', yes: PHONE }, { deviceId: PHONE, reset: false, yes: true }],
        ['--reset', { _command: 'trust', _arg1: '', reset: true }, { reset: true, yes: false }],
        ['--reset --yes', { _command: 'trust', _arg1: '', reset: true, yes: true }, { reset: true, yes: true }],
    ])('should read %s', (_what, args, expected) => {
        expect(parseTrustArgs(args)).toEqual(expected);
    });

    it.each([
        ['--reset with a device before it', { _command: 'trust', _arg1: PHONE, reset: true }],
        ['--reset with a word after it', { _command: 'trust', _arg1: '', reset: PHONE }],
        ['--reset --yes with a device', { _command: 'trust', _arg1: '', reset: true, yes: PHONE }],
        ['two devices', { _command: 'trust', _arg1: PHONE, yes: 'dev_ios_ffffffff' }],
    ])('should refuse %s rather than do something else', (_what, args) => {
        expect(parseTrustArgs(args)).toHaveProperty('error');
    });
});

describe('hwip trust — while another process writes the file', () => {
    it('should change nothing, say so and fail, for a pin and for --reset', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);
        const before = readFileSync(path, 'utf-8');
        writeFileSync(trustLockPath(path), '1 1\n');

        expect(await run({ deviceId: PHONE, yes: true }, { registeredKey: async () => v2Party().publicKey })).toBe(1);
        expect(await run({ reset: true, yes: true })).toBe(1);

        expect(readFileSync(path, 'utf-8')).toBe(before);
        expect(err.join('\n')).toContain('is being written by another process');
    }, 10_000);
});

describe('hwip trust --reset', () => {
    it('should forget every pin and let the listener answer in plaintext again', async () => {
        const phone = v2Party();
        const listener = createSubscriberTrust({ path, registeredKey: async () => phone.publicKey, log: () => {} });
        await listener.admit({ deviceId: PHONE, publicKey: phone.publicKey });
        expect(await listener.admit({})).toEqual({ kind: 'refuse', reason: 'e2ee_required' });

        expect(await run({ reset: true })).toBe(0);

        expect(asked).toHaveLength(1);
        expect(stored()).toEqual({ version: 1, devices: {} });
        // The listener that was running the whole time takes it as a fresh start, not as a vanished file.
        expect(await listener.admit({})).toEqual({ kind: 'plain' });
    });

    // Forgetting the numbers would let an old sealed command be typed again.
    it('should keep the sealed command numbers', async () => {
        const listener = createSubscriberTrust({ path, registeredKey: async () => null, log: () => {} });
        listener.acceptCommand(PHONE, 1000, KEY);

        expect(await run({ reset: true, yes: true })).toBe(0);

        expect(listener.acceptCommand(PHONE, 1000, KEY)).toBe(false);
    });

    it('should keep the key of every sealed command number, for an id the file does not know', async () => {
        const listener = createSubscriberTrust({ path, registeredKey: async () => null, log: () => {} });
        listener.acceptCommand(PHONE, 1000, KEY);

        expect(await run({ reset: true, yes: true })).toBe(0);

        expect(createSubscriberTrust({ path, registeredKey: async () => null, log: () => {} }).acceptCommand('dev_fresh_1', 1000, KEY)).toBe(false);
    });

    it('should keep the numbers of every pinned key, in a file that holds them by id only', async () => {
        const phone = v2Party();
        oldFile(phone.publicKey, 1000);

        expect(await run({ reset: true, yes: true })).toBe(0);

        expect(freshListener().acceptCommand('dev_fresh_1', 1000, phone.publicKey)).toBe(false);
    });

    it('should repair an unusable state file', async () => {
        writeFileSync(path, '{');

        expect(await run({ reset: true, yes: true })).toBe(0);

        expect(stored()).toEqual({ version: 1, devices: {} });
    });

    it('should change nothing when the answer is no', async () => {
        const phone = v2Party();
        await listenerAdmits(PHONE, phone.publicKey, phone.publicKey);

        expect(await run({ reset: true }, { confirm: async () => false })).toBe(1);

        expect(Object.keys(stored().devices)).toEqual([PHONE]);
    });
});
