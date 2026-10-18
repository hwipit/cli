import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// crypto-swift-answer.vectors.json is one sealed answer the iOS app built with
// its own CryptoKit seal (the app's EnvelopeLabelTests.writesTheCliAnswerVector,
// synthetic asker key). The cli has to open it with the same label values, so
// the two implementations agree on the answer the phone sends, not just on the
// question the cli sends (F1).
interface SwiftAnswerVector {
    deviceKeys: { publicKey: string; privateKey: string };
    deviceId: string;
    senderPublicKey: string;
    body: string;
    entry: string;
    expected: { body: string; answer: { ask: string; actionId: string; exit: true } };
}

const readVector = (): SwiftAnswerVector =>
    JSON.parse(readFileSync(new URL('./crypto-swift-answer.vectors.json', import.meta.url), 'utf8')) as SwiftAnswerVector; // own fixture file

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-swift-answer-'));
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/** A fresh module graph whose device key is `keys`, as if this host were that device. */
const asDevice = async (keys: SwiftAnswerVector['deviceKeys']): Promise<typeof import('./crypto.js')> => {
    mkdirSync(join(TMP, '.hwip'), { recursive: true });
    writeFileSync(join(TMP, '.hwip', 'device-keys.json'), JSON.stringify(keys));
    process.env.HOME = TMP;
    vi.resetModules();
    const mod = await import('./crypto.js');
    await mod.initDeviceCrypto();
    return mod;
};

describe('an answer the iOS app sealed', () => {
    it('opens with its answer label, text and exit flag intact', async () => {
        const vector = readVector();
        const device = await asDevice(vector.deviceKeys);
        const opened = await device.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey);
        expect(opened.body).toBe(vector.expected.body);
        expect(opened.answer).toEqual(vector.expected.answer);
        expect(opened.ask).toBeUndefined();
    });

    it('does not open under another device key', async () => {
        const vector = readVector();
        const other = await asDevice((await import('./crypto-labels.vectors.json', { with: { type: 'json' } })).default.keys.stranger);
        await expect(other.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey)).rejects.toThrow();
    });

    it('does not open when the sender key is not the one that sealed it', async () => {
        const vector = readVector();
        const device = await asDevice(vector.deviceKeys);
        await expect(device.decryptPushBodyForDevice(vector.body, vector.entry, vector.deviceKeys.publicKey)).rejects.toThrow();
    });
});
