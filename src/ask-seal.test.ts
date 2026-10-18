import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyChangesPath } from './key-changes.js';
import type { AskSealDeps, SealedFields } from './ask-seal.js';
import type { PushBodyInput } from './crypto.js';

// Real keys and real envelopes: this machine is the vectors file's `sender`, the phone its
// `recipient`, and `stranger` is some other device. The phone's side is written out here with
// WebCrypto so the asker is checked against the wire format and not against its own idea of it.

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
interface KeyPair { publicKey: string; privateKey: string }
const KEYS = (JSON.parse(readFileSync(new URL('./crypto-labels.vectors.json', import.meta.url), 'utf8')) as {
    keys: { sender: KeyPair; recipient: KeyPair; stranger: KeyPair };
}).keys; // own fixture file
const ASKER = KEYS.sender;
const PHONE = KEYS.recipient;
const STRANGER = KEYS.stranger;

const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');

/** What a device with `from`'s key seals for the given `to` public keys (deviceId → key). */
const sealAs = async (from: KeyPair, content: PushBodyInput, to: Record<string, string>): Promise<SealedFields> => {
    const privateKey = await crypto.subtle.importKey('pkcs8', unb64(from.privateKey), ECDH, false, ['deriveKey']);
    const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, new TextEncoder().encode(JSON.stringify(content)));
    const raw = await crypto.subtle.exportKey('raw', messageKey);
    const deviceKeyMap: Record<string, string> = {};
    for (const [deviceId, publicKey] of Object.entries(to)) {
        const shared = await crypto.subtle.deriveKey(
            { name: 'ECDH', public: await crypto.subtle.importKey('spki', unb64(publicKey), ECDH, false, []) },
            privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
        );
        const keyIv = crypto.getRandomValues(new Uint8Array(12));
        deviceKeyMap[deviceId] = JSON.stringify({ encryptedKey: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, raw)), keyIv: b64(keyIv) });
    }
    return { body: JSON.stringify({ ciphertext: b64(ciphertext), iv: b64(iv) }), senderPublicKey: from.publicKey, deviceKeyMap };
};

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
    TMP = mkdtempSync(join(tmpdir(), 'ask-seal-'));
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
const asDevice = async (keys: KeyPair): Promise<{ crypto: typeof import('./crypto.js'); seal: typeof import('./ask-seal.js') }> => {
    const home = mkdtempSync(join(TMP, 'home-'));
    mkdirSync(join(home, '.hwip'), { recursive: true });
    writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(keys));
    process.env.HOME = home;
    vi.resetModules();
    const cryptoMod = await import('./crypto.js');
    await cryptoMod.initDeviceCrypto();
    return { crypto: cryptoMod, seal: await import('./ask-seal.js') };
};

const stored = (): Record<string, { publicKey: string }> => JSON.parse(readFileSync(trustPath, 'utf8')).devices;

// `type` is what `GET /devices` says of the kind of client: the question needs a phone app among them.
const LISTED = [
    { deviceId: 'dev_laptop', publicKey: ASKER.publicKey, type: 'cli' },
    { deviceId: 'dev_phone', publicKey: PHONE.publicKey, type: 'ios' },
];
const ACTIONS = [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }];
const QUESTION = { title: 'Deploy to production?', body: 'All checks are green.', actions: ACTIONS };

const depsFor = (overrides: Partial<AskSealDeps> = {}): AskSealDeps => ({
    loadKeys: async () => undefined,
    self: () => ({ deviceId: 'dev_laptop', publicKey: ASKER.publicKey }),
    listDevices: async () => LISTED,
    // A server without the route yet: what a test that lists this machine nowhere meets.
    register: async () => 'http 404',
    trustPath,
    warn: (line) => warnings.push(line),
    newAskId: () => 'q7Zk2mV0wXb9Yc3dEfGhIg',
    ...overrides,
});

describe('prepareAsk', () => {
    it.each([
        ['a label over 100 characters', [{ id: 'go', label: 'y'.repeat(101) }]],
        ['an id over 64 characters', [{ id: 'x'.repeat(65), label: 'Go' }]],
        ['eleven choices', Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }))],
    ])('says a question with %s is too large', async (_name, actions) => {
        const { seal } = await asDevice(ASKER);
        // The real seal: the code this relies on is crypto.ts's.
        expect(await seal.prepareAsk({ ...QUESTION, actions }, depsFor())).toEqual({ kind: 'refused', cause: 'too-large' });
    });

    it('still calls any other sealing failure a failure', async () => {
        const { seal } = await asDevice(ASKER);
        const broken = depsFor({ seal: async () => { throw new Error('boom'); } });
        expect(await seal.prepareAsk(QUESTION, broken)).toEqual({ kind: 'refused', cause: 'encrypt' });
    });

    it('seals the question for the other devices; the phone opens it and finds the wording and the ask label', async () => {
        const asker = await asDevice(ASKER);
        const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());

        expect(prepared.kind).toBe('sealed');
        if (prepared.kind !== 'sealed') return;
        expect(prepared.askId).toBe('q7Zk2mV0wXb9Yc3dEfGhIg');
        expect(prepared.offered).toEqual(['approve', 'deny']);
        expect(Object.keys(prepared.fields.deviceKeyMap)).toEqual(['dev_phone']);
        expect(JSON.stringify(prepared.fields)).not.toContain('Deploy');
        expect(JSON.stringify(prepared.fields)).not.toContain('Approve');

        const phone = await asDevice(PHONE);
        const opened = await phone.crypto.decryptPushBodyForDevice(prepared.fields.body, prepared.fields.deviceKeyMap.dev_phone!, prepared.fields.senderPublicKey);
        expect(opened).toMatchObject({
            title: 'Deploy to production?',
            body: 'All checks are green.',
            ask: { id: 'q7Zk2mV0wXb9Yc3dEfGhIg', device: 'dev_laptop', actions: ACTIONS },
        });
    });

    describe('with a context attachment', () => {
        const SUMMARY = {
            diff: 'ok' as const, files: 1, added: 2, removed: 1,
            listed: [{ path: 'src/a.ts', status: 'M' as const, added: 2, removed: 1 }],
            moreFiles: 0, screenLines: 3, masked: 0, cut: { diff: false, screen: false },
        };
        const META = { iv: 'AAECAwQFBgcICQoL', name: 'ask-context.json', type: 'application/vnd.hwip.ask-context+json', size: 321 };
        const FILE = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: META.iv, deviceKeyMap: { dev_phone: 'wrapped' } };
        const openAsPhone = async (fields: SealedFields) => {
            const phone = await asDevice(PHONE);
            return phone.crypto.decryptPushBodyForDevice(fields.body, fields.deviceKeyMap.dev_phone!, fields.senderPublicKey);
        };

        it.each([
            ['the keys do not load', { loadKeys: async () => { throw new Error('locked'); } }],
            ['no app is signed in', { listDevices: async () => [LISTED[0]!] }],
            ['there is nobody to seal for', { listDevices: async () => [LISTED[0]!, { deviceId: 'dev_phone', type: 'ios' }] }],
        ])('gathers nothing when %s', async (_name, overrides) => {
            const { seal } = await asDevice(ASKER);
            const attach = vi.fn(async () => ({ context: SUMMARY, meta: META, file: FILE }));
            const prepared = await seal.prepareAsk(QUESTION, depsFor({ ...overrides, attach }));
            expect(prepared.kind).toBe('refused');
            expect(attach).not.toHaveBeenCalled();
        });

        it('seals the summary and the name of the original into the body, for the same devices, and hands the attachment on', async () => {
            const asker = await asDevice(ASKER);
            const attach = vi.fn(async () => ({ context: SUMMARY, meta: META, file: FILE }));
            const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach }));

            if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
            expect(attach).toHaveBeenCalledWith([{ deviceId: 'dev_phone', publicKey: PHONE.publicKey }]);
            expect(prepared.files).toEqual([FILE]);
            const opened = await openAsPhone(prepared.fields);
            expect(opened).toMatchObject({ title: 'Deploy to production?', ask: { id: 'q7Zk2mV0wXb9Yc3dEfGhIg' }, files: [META], context: SUMMARY });
        });

        it('names the attachment and no summary when there was no context', async () => {
            const asker = await asDevice(ASKER);
            const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach: async () => ({ meta: { ...META, size: 0 }, file: FILE }) }));

            if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
            expect(prepared.files).toEqual([FILE]);
            const opened = await openAsPhone(prepared.fields);
            expect(opened.files).toEqual([{ ...META, size: 0 }]);
            expect(opened.context).toBeUndefined();
        });

        it('sends the question without the attachment when attaching fails', async () => {
            const asker = await asDevice(ASKER);
            const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach: async () => { throw new Error('upload 503'); } }));

            if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
            expect(prepared.files).toBeUndefined();
            const opened = await openAsPhone(prepared.fields);
            expect(opened.title).toBe('Deploy to production?');
            expect(opened.files).toBeUndefined();
            expect(opened.context).toBeUndefined();
        });

        it('leaves the attachment out too when the summary alone was not enough', async () => {
            const asker = await asDevice(ASKER);
            const attach = async () => ({ context: SUMMARY, meta: META, file: FILE });
            const bare = await asker.seal.prepareAsk({ ...QUESTION, body: 'x'.repeat(35_000) }, depsFor());
            if (bare.kind !== 'sealed') throw new Error('expected a sealed question');
            // A body that fits on its own, with less room left than the attachment's name takes.
            const room = 48 * 1024 - Buffer.byteLength(bare.fields.body);
            const longer = 'x'.repeat(35_000 + Math.floor(room * 3 / 4) - 8);

            const prepared = await asker.seal.prepareAsk({ ...QUESTION, body: longer }, depsFor({ attach }));

            if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
            expect(Buffer.byteLength(prepared.fields.body)).toBeLessThanOrEqual(48 * 1024);
            expect(prepared.files).toBeUndefined();
            const opened = await openAsPhone(prepared.fields);
            expect(opened.body).toBe(longer);
            expect(opened.files).toBeUndefined();
        });

        it('leaves the summary out when it would push the envelope over what the server takes for a question', async () => {
            const asker = await asDevice(ASKER);
            const attach = async () => ({ context: SUMMARY, meta: META, file: FILE });
            // Base64 of the plaintext: the summary is what tips this body over 48 KiB.
            const summaryBytes = Buffer.byteLength(JSON.stringify(SUMMARY));
            const fits = await asker.seal.prepareAsk({ ...QUESTION, body: 'x'.repeat(35_000) }, depsFor({ attach }));
            if (fits.kind !== 'sealed') throw new Error('expected a sealed question');
            const room = 48 * 1024 - Buffer.byteLength(fits.fields.body);
            expect(room).toBeGreaterThan(0);
            const longer = 'x'.repeat(35_000 + Math.floor(room * 3 / 4) + 3);
            expect(summaryBytes).toBeGreaterThan(3);

            const prepared = await asker.seal.prepareAsk({ ...QUESTION, body: longer }, depsFor({ attach }));

            if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
            expect(Buffer.byteLength(prepared.fields.body)).toBeLessThanOrEqual(48 * 1024);
            expect(prepared.files).toEqual([FILE]);
            const opened = await openAsPhone(prepared.fields);
            expect(opened.body).toBe(longer);
            expect(opened.files).toEqual([META]);
            expect(opened.context).toBeUndefined();
        });
    });

    it('makes a fresh 128-bit id for every question', async () => {
        const { seal } = await asDevice(ASKER);
        const deps = depsFor({ newAskId: undefined });
        const first = await seal.prepareAsk(QUESTION, deps);
        const second = await seal.prepareAsk(QUESTION, deps);
        if (first.kind !== 'sealed' || second.kind !== 'sealed') throw new Error('expected sealed questions');
        expect(first.askId).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(first.askId).not.toBe(second.askId);
    });

    it.each([
        ['keys do not load', { loadKeys: async () => { throw new Error('keychain locked'); } }, 'keystore'],
        ['this machine has no key', { self: () => null }, 'keystore'],
        ['the device list cannot be fetched', { listDevices: async () => { throw new Error('devices 503'); } }, 'devices'],
        ['the device list is not a list', { listDevices: async () => ({}) as never }, 'devices'],
        ['no app is signed in', { listDevices: async () => [LISTED[0]!] }, 'no-app'],
        ['only a computer is signed in', { listDevices: async () => [LISTED[0]!, { deviceId: 'dev_other_pc', publicKey: STRANGER.publicKey, type: 'cli' }] }, 'no-app'],
        ['the only app has no key', { listDevices: async () => [LISTED[0]!, { deviceId: 'dev_phone', type: 'ios' }] }, 'no-recipients'],
        ['sealing throws', { seal: async () => { throw new Error('boom'); } }, 'encrypt'],
    ] as const)('refuses, and never falls back to plaintext, when %s', async (_name, override, cause) => {
        const { seal } = await asDevice(ASKER);
        expect(await seal.prepareAsk(QUESTION, depsFor(override))).toEqual({ kind: 'refused', cause });
    });

    // C150: a failure from the configuration keeps its own words instead of the generic device-list line.
    it('says a configuration failure as it is, not as a device-list failure', async () => {
        const { seal } = await asDevice(ASKER);
        const broken = new TypeError('a header could not be sent — check the API key for stray characters');
        expect(await seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => { throw broken; } }))).toEqual({
            kind: 'refused',
            cause: 'devices',
            detail: 'a header could not be sent — check the API key for stray characters',
        });
        expect(seal.refusalMessage('devices', undefined, 'a header could not be sent — check the API key for stray characters')).toBe(
            'a header could not be sent — check the API key for stray characters');
    });

    it('does not register this machine when the list holds it under its key', async () => {
        const { seal } = await asDevice(ASKER);
        const register = vi.fn(async () => null);

        expect((await seal.prepareAsk(QUESTION, depsFor({ register }))).kind).toBe('sealed');
        expect(register).not.toHaveBeenCalled();
    });

    it.each([
        ['missing from the list', [LISTED[1]!]],
        ['listed under another key', [{ deviceId: 'dev_laptop', publicKey: STRANGER.publicKey, type: 'cli' }, LISTED[1]!]],
    ])('puts this machine\'s key on the list once when it is %s, then seals, without reading the list again', async (_name, devices) => {
        const { seal } = await asDevice(ASKER);
        const register = vi.fn(async () => null);
        const listDevices = vi.fn(async () => devices);

        expect((await seal.prepareAsk(QUESTION, depsFor({ listDevices, register }))).kind).toBe('sealed');
        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith({ deviceId: 'dev_laptop', publicKey: ASKER.publicKey });
        expect(listDevices).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['the server has no such route yet', 'http 404'],
        ['the server cannot be reached', 'network'],
        ['the server does not answer', 'timeout'],
        ['the API key may not write it', 'http 403'],
    ] as const)('refuses, sending nothing, when this machine cannot be registered: %s', async (_name, why) => {
        const { seal } = await asDevice(ASKER);
        const sealIt = vi.fn();

        const prepared = await seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => [LISTED[1]!], register: async () => why, seal: sealIt }));

        expect(prepared).toEqual({ kind: 'refused', cause: 'self-unlisted', why });
        expect(sealIt).not.toHaveBeenCalled();
    });

    // Only a push:read key may replace a listed key: the old one stays, and the app would seal the answer for it.
    it('refuses, saying so, when the list holds another key for this machine and the API key may not replace it', async () => {
        const { seal } = await asDevice(ASKER);
        const listDevices = async () => [{ deviceId: 'dev_laptop', publicKey: STRANGER.publicKey, type: 'cli' }, LISTED[1]!];

        const prepared = await seal.prepareAsk(QUESTION, depsFor({ listDevices, register: async () => 'http 403' }));

        expect(prepared).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
        expect(seal.refusalMessage('self-unlisted', 'replace-forbidden')).toBe(
            'sealed ask: could not register this machine\'s key in the account\'s device list (the account lists another key for it, and only an API key with push:read may replace it); the question was not sent',
        );
    });

    it('seals for every other listed device that has a key, pins them, and not this machine', async () => {
        const asker = await asDevice(ASKER);
        const devices = [...LISTED, { deviceId: 'dev_other', publicKey: STRANGER.publicKey, type: 'cli' }, { deviceId: 'dev_old', type: 'ios' }];

        const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => devices }));

        if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
        expect(Object.keys(prepared.fields.deviceKeyMap).sort()).toEqual(['dev_other', 'dev_phone']);
        expect(Object.keys(stored()).sort()).toEqual(['dev_other', 'dev_phone']);
        expect(warnings).toEqual([]);
        expect(keyChanges()).toBe(0);
    });

    it('does not take a reader away for a pin: a device pinned with another key still reads, and the pin follows the list', async () => {
        const asker = await asDevice(ASKER);
        pinFile({ dev_phone: STRANGER.publicKey });

        const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());

        if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
        expect(Object.keys(prepared.fields.deviceKeyMap)).toEqual(['dev_phone']);
        expect(stored().dev_phone.publicKey).toBe(PHONE.publicKey);
        expect(warnings).toEqual(['trust: dev_phone changed its key — now pinned to the new one']);
        expect(keyChanges()).toBe(1);

        await asker.seal.prepareAsk(QUESTION, depsFor());
        expect(warnings).toHaveLength(1);
        expect(keyChanges()).toBe(1);
    });

    it('asks, with a warning, when the trust file cannot be read, and leaves it alone', async () => {
        const { seal } = await asDevice(ASKER);
        writeFileSync(trustPath, '{ not json');

        expect((await seal.prepareAsk(QUESTION, depsFor())).kind).toBe('sealed');
        expect(warnings).toEqual(['trust: the trust file is unreadable — pins not checked']);
        expect(readFileSync(trustPath, 'utf8')).toBe('{ not json');
    });
});

describe('openAnswer', () => {
    const ASK_ID = 'q7Zk2mV0wXb9Yc3dEfGhIg';
    const OFFERED = ['approve', 'deny'];
    const toAsker = { dev_laptop: ASKER.publicKey };

    const open = async (response: unknown, overrides: Partial<AskSealDeps> = {}, offered: string[] | undefined = OFFERED) => {
        const { seal } = await asDevice(ASKER);
        return seal.openAnswer(response as never, ASK_ID, offered, depsFor(overrides));
    };
    const answerFrom = async (content: PushBodyInput, from: KeyPair = PHONE, to: Record<string, string> = toAsker) =>
        ({ sealed: await sealAs(from, content, to), respondedDeviceId: 'dev_phone' });

    it('reads a chosen action from a phone nobody pinned, and pins it', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
        expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
        expect(stored().dev_phone.publicKey).toBe(PHONE.publicKey);
        expect(keyChanges()).toBe(0);
    });

    it('reads a chosen action from a phone pinned with the same key, and from one pinned while others are', async () => {
        pinFile({ dev_phone: PHONE.publicKey });
        expect(await open(await answerFrom({ answer: { ask: ASK_ID, actionId: 'deny' } }))).toEqual({ ok: true, actionId: 'deny' });

        pinFile({ dev_tablet: STRANGER.publicKey });
        expect(await open(await answerFrom({ answer: { ask: ASK_ID, actionId: 'deny' } }))).toEqual({ ok: true, actionId: 'deny' });
        expect(warnings).toEqual([]);
    });

    it('reads the answer of a phone whose key changed, replaces the pin and records it once', async () => {
        pinFile({ dev_phone: STRANGER.publicKey });
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });

        expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
        expect(stored().dev_phone.publicKey).toBe(PHONE.publicKey);
        expect(warnings).toEqual(['trust: dev_phone changed its key — now pinned to the new one']);
        expect(keyChanges()).toBe(1);

        expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
        expect(keyChanges()).toBe(1);
    });

    it('reads typed text with the exit flag', async () => {
        const response = await answerFrom({ body: 'ship it', answer: { ask: ASK_ID, exit: true } });
        expect(await open(response)).toEqual({ ok: true, value: 'ship it', exit: true });
    });

    it('answer files: reads the sealed file list with the text, and the key that sealed it', async () => {
        const meta = { iv: 'ZmlsZS1pdg==', name: 'shot.png', type: 'image/png', size: 3 };
        const response = await answerFrom({ body: 'see this', answer: { ask: ASK_ID }, files: [meta] });
        expect(await open(response, {}, undefined)).toEqual({ ok: true, value: 'see this', files: [meta], senderPublicKey: expect.any(String) });
    });

    it('answer files: takes files with no text as an answer', async () => {
        const meta = { iv: 'ZmlsZS1pdg==', name: 'log.txt', type: 'text/plain', size: 3 };
        const response = await answerFrom({ answer: { ask: ASK_ID }, files: [meta] });
        expect(await open(response, {}, undefined)).toEqual({ ok: true, files: [meta], senderPublicKey: expect.any(String) });
    });

    it('reads typed text alone', async () => {
        const response = await answerFrom({ body: 'run the tests', answer: { ask: ASK_ID } });
        expect(await open(response, {}, undefined)).toEqual({ ok: true, value: 'run the tests' });
    });

    it('ignores plaintext fields in the response: only the seal is read', async () => {
        const response = { ...(await answerFrom({ answer: { ask: ASK_ID, actionId: 'deny' } })), actionId: 'approve', value: 'injected' };
        expect(await open(response)).toEqual({ ok: true, actionId: 'deny' });
    });

    it('refuses a response with no seal, however plain its answer looks', async () => {
        expect(await open({ actionId: 'approve', respondedDeviceId: 'dev_phone' })).toEqual({ ok: false, cause: 'not-sealed' });
        expect(await open(undefined)).toEqual({ ok: false, cause: 'not-sealed' });
        expect(await open({ sealed: { body: 1 }, respondedDeviceId: 'dev_phone' })).toEqual({ ok: false, cause: 'not-sealed' });
    });

    it('refuses an answer that names another question', async () => {
        const response = await answerFrom({ answer: { ask: 'someone-elses-question', actionId: 'approve' } });
        expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
    });

    it('refuses a body with no answer label — the text alone is not an answer', async () => {
        const response = await answerFrom({ body: 'approve' });
        expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
    });

    it.each([
        ['an ask label', { ask: { id: ASK_ID, device: 'dev_laptop' } }],
        ['a cmd label', { cmd: { n: 1, session: 's', device: 'dev_laptop' } }],
    ])('refuses an answer that also carries %s', async (_name, extra) => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' }, ...extra });
        expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
    });

    it('refuses the question played back as the answer, whoever it claims to come from', async () => {
        const asker = await asDevice(ASKER);
        const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());
        if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
        for (const [from, cause] of [['dev_laptop', 'no-slot'], ['dev_phone', 'sender-mismatch']] as const) {
            const outcome = await asker.seal.openAnswer({ sealed: prepared.fields, respondedDeviceId: from }, ASK_ID, OFFERED, depsFor());
            expect(outcome).toEqual({ ok: false, cause });
        }
    });

    it('refuses a question envelope that does carry this machine\'s slot, played back as the answer', async () => {
        // Listing this machine under its own key lets it pass the sender check; the labels must still stop it.
        const replay = await sealAs(ASKER, { title: 't', body: 'approve', ask: { id: ASK_ID, device: 'dev_laptop' } }, toAsker);
        const { seal } = await asDevice(ASKER);
        const outcome = await seal.openAnswer({ sealed: replay, respondedDeviceId: 'dev_laptop' }, ASK_ID, OFFERED, depsFor());
        expect(outcome).toEqual({ ok: false, cause: 'wrong-labels' });
    });

    it('refuses an envelope sealed with a key other than the answering device\'s', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } }, STRANGER);
        expect(await open(response)).toEqual({ ok: false, cause: 'sender-mismatch' });
    });

    it('refuses a device the account does not list', async () => {
        const response = { ...(await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } })), respondedDeviceId: 'dev_ghost' };
        expect(await open(response)).toEqual({ ok: false, cause: 'peer-unlisted' });
    });

    it('looks the answering device up in the account\'s list even when it names this machine', async () => {
        // This machine's own key never stands in for a listed one.
        const own = await sealAs(ASKER, { answer: { ask: ASK_ID, actionId: 'approve' } }, toAsker);
        const { seal } = await asDevice(ASKER);
        const outcome = await seal.openAnswer({ sealed: own, respondedDeviceId: 'dev_laptop' }, ASK_ID, OFFERED,
            depsFor({ listDevices: async () => [LISTED[1]!] }));
        expect(outcome).toEqual({ ok: false, cause: 'peer-unlisted' });
    });

    it('refuses an envelope with no slot for this machine', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } }, PHONE, { dev_tablet: STRANGER.publicKey });
        expect(await open(response)).toEqual({ ok: false, cause: 'no-slot' });
    });

    it('refuses a tampered ciphertext without saying anything about it', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
        const envelope = JSON.parse(response.sealed.body) as { ciphertext: string; iv: string };
        const bytes = unb64(envelope.ciphertext);
        bytes[0] = bytes[0]! ^ 1;
        response.sealed.body = JSON.stringify({ ...envelope, ciphertext: b64(bytes) });
        expect(await open(response)).toEqual({ ok: false, cause: 'unreadable' });
    });

    it('refuses an authenticated body that is not JSON, without its text', async () => {
        const { seal } = await asDevice(ASKER);
        // sealAs JSON-encodes; build the odd plaintext by sealing a string literal through a raw content value.
        const odd = await sealAs(PHONE, 'SECRET-NOT-AN-OBJECT' as unknown as PushBodyInput, toAsker);
        const outcome = await seal.openAnswer({ sealed: odd, respondedDeviceId: 'dev_phone' } as never, ASK_ID, OFFERED, depsFor());
        expect(outcome).toEqual({ ok: false, cause: 'unreadable' });
        expect(JSON.stringify(outcome)).not.toContain('SECRET');
    });

    it('refuses a choice that was not offered', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'rm-rf' } });
        expect(await open(response)).toEqual({ ok: false, cause: 'unknown-action' });
        expect(await open(response, {}, undefined)).toEqual({ ok: false, cause: 'unknown-action' });
    });

    it('refuses an answer with neither a choice nor text', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID } });
        expect(await open(response)).toEqual({ ok: false, cause: 'empty-answer' });
    });

    it('reports the device list failing as peer-unusable', async () => {
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
        expect(await open(response, { listDevices: async () => { throw new Error('devices 503'); } })).toEqual({ ok: false, cause: 'peer-unusable' });
    });

    it('opens the answer, with a warning, when the trust file cannot be read', async () => {
        writeFileSync(trustPath, '{ not json');
        const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });

        expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
        expect(warnings).toEqual(['trust: the trust file is unreadable — pins not checked']);
    });
});
