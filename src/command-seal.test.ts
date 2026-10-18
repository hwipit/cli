import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyChangesPath } from './key-changes.js';
import type { CommandSealDeps } from './command-seal.js';

// Real keys and real envelopes, as in ask-seal.test.ts: this machine is the vectors file's `sender`, the phone its
// `recipient`, and `stranger` is another computer of the account — the one a message is sent to.

interface KeyPair { publicKey: string; privateKey: string }
const KEYS = (JSON.parse(readFileSync(new URL('./crypto-labels.vectors.json', import.meta.url), 'utf8')) as {
    keys: { sender: KeyPair; recipient: KeyPair; stranger: KeyPair };
}).keys; // own fixture file
const THIS_MACHINE = KEYS.sender;
const PHONE = KEYS.recipient;
const OTHER_PC = KEYS.stranger;

let TMP: string;
let trustPath: string;
let warnings: string[];
/** Devices the key-change record holds (one entry per device, however often it changed). */
const keyChanges = (): number => {
    try {
        return (JSON.parse(readFileSync(keyChangesPath(trustPath), 'utf8')) as { changes: unknown[] }).changes.length;
    } catch {
        return 0;
    }
};
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'command-seal-'));
    trustPath = join(TMP, 'trusted-devices.json');
    warnings = [];
});
afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

const pinFile = (devices: Record<string, string>): void => {
    const pins = Object.fromEntries(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' }]));
    writeFileSync(trustPath, JSON.stringify({ version: 1, devices: pins }));
};

/** A fresh module graph whose device key is `keys`, as if this host were that device. */
const asDevice = async (keys: KeyPair): Promise<{ crypto: typeof import('./crypto.js'); seal: typeof import('./command-seal.js') }> => {
    const home = mkdtempSync(join(TMP, 'home-'));
    mkdirSync(join(home, '.hwip'), { recursive: true });
    writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(keys));
    process.env.HOME = home;
    vi.resetModules();
    const cryptoMod = await import('./crypto.js');
    await cryptoMod.initDeviceCrypto();
    return { crypto: cryptoMod, seal: await import('./command-seal.js') };
};

const LISTED = [
    { deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey },
    { deviceId: 'dev_other_pc', publicKey: OTHER_PC.publicKey },
    { deviceId: 'dev_phone', publicKey: PHONE.publicKey },
];
const stored = (): Record<string, { publicKey: string }> => JSON.parse(readFileSync(trustPath, 'utf8')).devices;
const COMMAND = { targetDeviceId: 'dev_other_pc', session: 'hwip-api', message: '[from cli@laptop] run the tests' };

const depsFor = (overrides: Partial<CommandSealDeps> = {}): CommandSealDeps => ({
    loadKeys: async () => undefined,
    self: () => ({ deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey }),
    listDevices: async () => LISTED,
    // A server without the route yet: what a test that lists this machine nowhere meets.
    register: async () => 'http 404',
    trustPath,
    warn: (line) => warnings.push(line),
    nextNumber: async () => 1700000000001,
    ...overrides,
});

/** What the target computer reads: its slot opened with its own key. */
const openAsTarget = async (fields: { body: string; senderPublicKey: string; deviceKeyMap: Record<string, string> }, slot = 'dev_other_pc', keys = OTHER_PC) => {
    const { crypto } = await asDevice(keys);
    return crypto.decryptPushBodyForDevice(fields.body, fields.deviceKeyMap[slot], fields.senderPublicKey);
};

describe('sealedCommand', () => {
    const recorder = () => vi.fn(async (_content: unknown, recipients: { deviceId: string }[]) => ({
        isEncrypted: true as const, body: 'x', senderPublicKey: THIS_MACHINE.publicKey,
        deviceKeyMap: Object.fromEntries(recipients.map((r) => [r.deviceId, '{}'])),
    }));

    it('seals for a computer nobody pinned: the target opens the label with its own key, the text is not in the body', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        const prepared = await seal.sealedCommand(COMMAND, depsFor());

        expect(prepared.kind).toBe('sealed');
        if (prepared.kind !== 'sealed') return;
        expect(prepared.fields.body).not.toContain('run the tests');
        expect(prepared.fields.senderPublicKey).toBe(THIS_MACHINE.publicKey);
        expect(Object.keys(prepared.fields.deviceKeyMap).sort()).toEqual(['dev_other_pc', 'dev_phone']);
        const opened = await openAsTarget(prepared.fields);
        expect(opened.body).toBe(COMMAND.message);
        expect(opened.cmd).toEqual({ n: 1700000000001, session: 'hwip-api', device: 'dev_other_pc', from: 'dev_laptop' });
    });

    it('pins the target and every other listed device on the way, and not this machine', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        await seal.sealedCommand(COMMAND, depsFor());

        expect(stored()).toEqual({
            dev_other_pc: { publicKey: OTHER_PC.publicKey, pinnedAt: expect.any(String) },
            dev_phone: { publicKey: PHONE.publicKey, pinnedAt: expect.any(String) },
        });
        expect(warnings).toEqual([]);
        expect(keyChanges()).toBe(0);
    });

    it('lets the phone open the same message from its own slot', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        const prepared = await seal.sealedCommand(COMMAND, depsFor());
        if (prepared.kind !== 'sealed') throw new Error('not sealed');

        const opened = await openAsTarget(prepared.fields, 'dev_phone', PHONE);

        expect(opened.body).toBe(COMMAND.message);
    });

    it('seals for another session on this very computer', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        const prepared = await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_laptop' }, depsFor());

        expect(prepared.kind).toBe('sealed');
        if (prepared.kind !== 'sealed') return;
        const opened = await openAsTarget(prepared.fields, 'dev_laptop', THIS_MACHINE);
        expect(opened.cmd).toEqual({ n: 1700000000001, session: 'hwip-api', device: 'dev_laptop', from: 'dev_laptop' });
    });

    it('seals for the target and every other listed device that has a key — a pin neither adds nor removes a reader', async () => {
        pinFile({ dev_phone: KEYS.stranger.publicKey });
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = recorder();
        const listed = [...LISTED, { deviceId: 'dev_tablet', publicKey: KEYS.stranger.publicKey }, { deviceId: 'dev_old' }];

        await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt, listDevices: async () => listed }));

        expect(sealIt.mock.calls[0]?.[1].map((r) => r.deviceId)).toEqual(['dev_other_pc', 'dev_phone', 'dev_tablet']);
    });

    it('seals for the phone with the key the list holds when it changed, replaces the pin, and says so once', async () => {
        pinFile({ dev_other_pc: OTHER_PC.publicKey, dev_phone: KEYS.stranger.publicKey });
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = recorder();

        const prepared = await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt }));

        expect(prepared.kind).toBe('sealed');
        expect(sealIt.mock.calls[0]?.[1]).toContainEqual({ deviceId: 'dev_phone', publicKey: PHONE.publicKey });
        expect(stored().dev_phone.publicKey).toBe(PHONE.publicKey);
        expect(warnings).toEqual(['trust: dev_phone changed its key — now pinned to the new one']);
        expect(keyChanges()).toBe(1);

        await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt }));
        expect(warnings).toHaveLength(1);
        expect(keyChanges()).toBe(1);
    });

    it('follows a target whose key changed: seals for the new key and replaces the pin', async () => {
        pinFile({ dev_other_pc: PHONE.publicKey });
        const { seal } = await asDevice(THIS_MACHINE);

        const prepared = await seal.sealedCommand(COMMAND, depsFor());
        if (prepared.kind !== 'sealed') throw new Error('not sealed');

        expect((await openAsTarget(prepared.fields)).body).toBe(COMMAND.message);
        expect(stored().dev_other_pc.publicKey).toBe(OTHER_PC.publicKey);
        expect(keyChanges()).toBe(1);
    });

    // The sealer skips a recipient whose key it cannot import: a send with no slot for the target would only be dropped there.
    it('does not send a message that has no slot for the target', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = vi.fn(async () => ({ isEncrypted: true as const, body: 'x', senderPublicKey: THIS_MACHINE.publicKey, deviceKeyMap: { dev_phone: '{}' } }));

        expect(await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt }))).toEqual({ kind: 'refused', cause: 'encrypt' });
    });

    it('does not send to a computer the account does not list with a key', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = vi.fn();

        expect(await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_gone' }, depsFor({ seal: sealIt }))).toEqual({ kind: 'refused', cause: 'target-unlisted' });
        const keyless = LISTED.map((d) => (d.deviceId === 'dev_other_pc' ? { deviceId: d.deviceId } : d));
        expect(await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt, listDevices: async () => keyless }))).toEqual({ kind: 'refused', cause: 'target-unlisted' });
        expect(sealIt).not.toHaveBeenCalled();
    });

    it('does not send when this machine cannot be registered, and says why', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        const unlisted = LISTED.filter((d) => d.deviceId !== 'dev_laptop');
        expect(await seal.sealedCommand(COMMAND, depsFor({ listDevices: async () => unlisted }))).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'http 404' });
        expect(seal.commandRefusalMessage('self-unlisted', 'http 404')).toBe(
            'sealed send: could not register this machine\'s key in the account\'s device list (the server answered HTTP 404); the message was not sent',
        );
    });

    it('puts this machine\'s key on the list once when it is missing, then seals, without reading the list again', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        const register = vi.fn(async () => null);
        const unlisted = LISTED.filter((d) => d.deviceId !== 'dev_laptop');
        const listDevices = vi.fn(async () => unlisted);

        expect((await seal.sealedCommand(COMMAND, depsFor({ listDevices, register }))).kind).toBe('sealed');
        expect(register).toHaveBeenCalledWith({ deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey });
        expect(register).toHaveBeenCalledTimes(1);
        expect(listDevices).toHaveBeenCalledTimes(1);
    });

    it('refuses when the list holds another key for this machine and the API key may not replace it', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        const listDevices = async () => LISTED.map((d) => (d.deviceId === 'dev_laptop' ? { ...d, publicKey: OTHER_PC.publicKey } : d));

        expect(await seal.sealedCommand(COMMAND, depsFor({ listDevices, register: async () => 'http 403' }))).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
    });

    it.each([
        ['the keys do not load', { loadKeys: async () => { throw new Error('no keys'); } }, 'keystore'],
        ['the device list cannot be fetched', { listDevices: async () => { throw new Error('offline'); } }, 'devices'],
        ['the device list is not a list', { listDevices: async () => ({}) as never }, 'devices'],
    ] as const)('does not send when %s', async (_name, override, cause) => {
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = vi.fn();

        expect(await seal.sealedCommand(COMMAND, depsFor({ ...override, seal: sealIt }))).toEqual({ kind: 'refused', cause });
        expect(sealIt).not.toHaveBeenCalled();
    });

    it('sends on, with a warning, when the trust file cannot be read', async () => {
        writeFileSync(trustPath, '{not json');
        const { seal } = await asDevice(THIS_MACHINE);

        expect((await seal.sealedCommand(COMMAND, depsFor())).kind).toBe('sealed');
        expect(warnings).toEqual(['trust: the trust file is unreadable — pins not checked']);
        expect(readFileSync(trustPath, 'utf8')).toBe('{not json');
    });

    it.each([
        ['the counter is locked', { refused: 'lock' }, 'number-locked'],
        ['the counter cannot be used', { refused: 'io' }, 'number-unusable'],
    ] as const)('does not send when %s', async (_name, refusal, cause) => {
        const { seal } = await asDevice(THIS_MACHINE);
        const sealIt = vi.fn();

        expect(await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => refusal, seal: sealIt }))).toEqual({ kind: 'refused', cause });
        expect(sealIt).not.toHaveBeenCalled();
    });

    it('does not send when sealing fails, and says nothing of why', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        const prepared = await seal.sealedCommand(COMMAND, depsFor({ seal: async () => { throw new Error('secret plaintext'); } }));

        expect(prepared).toEqual({ kind: 'refused', cause: 'encrypt' });
    });

    it('takes a fresh number from the shared counter for every message', async () => {
        const { seal } = await asDevice(THIS_MACHINE);
        let n = 40;

        const first = await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => ++n }));
        const second = await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => ++n }));
        if (first.kind !== 'sealed' || second.kind !== 'sealed') throw new Error('not sealed');

        expect((await openAsTarget(first.fields)).cmd?.n).toBe(41);
        expect((await openAsTarget(second.fields)).cmd?.n).toBe(42);
    });

    it('has no plain outcome and no refusal about the account flag, a pin or the trust file', async () => {
        const { seal } = await asDevice(THIS_MACHINE);

        expect(Object.keys(seal.COMMAND_REFUSAL_TEXT).sort()).toEqual([
            'devices', 'encrypt', 'keystore', 'number-locked', 'number-unusable', 'self-unlisted', 'target-unlisted',
        ]);
    });
});
