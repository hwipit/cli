import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { downloadAttachments, downloadSealedEach, saveFileFromS3, type SaveFileDeps } from './listener.js';
import { getDevicePublicKey, initDeviceCrypto } from './crypto.js';
import { sealForReceiver } from '../tests/helpers/seal.js';

// The real save path, S3 replaced by a recording fetch. What is pinned:
// the API key goes to the hwip API and never to the presigned URL, each
// key-material shape takes the branch it should, and an encrypted file
// sealed the way the MCP seals it lands decrypted under Downloads/Hwip.

const ME = 'dev_listener_me';
const API = 'https://api.example/v1';
const CHUNK = 1_048_576;
const PRESIGNED = 'https://bucket.s3.ap-northeast-2.amazonaws.com/obj?X-Amz-Signature=abc';

interface Call { url: string; headers: Record<string, string>; redirect?: RequestRedirect }

const harness = (bodyBytes: Buffer | null, opts: { metaStatus?: number; binStatus?: number; downloadUrl?: string; api?: string; binHeaders?: Record<string, string> } = {}) => {
    const calls: Call[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'hwip-save-'));
    const api = opts.api ?? API;
    const fetchFn: typeof fetch = async (input, init) => {
        const url = String(input);
        const headers = { ...(init?.headers as Record<string, string> | undefined) }; // fixture: the saver passes a plain object
        calls.push({ url, headers, redirect: init?.redirect });
        if (url.startsWith(api)) {
            return new Response(JSON.stringify({ data: { downloadUrl: opts.downloadUrl ?? PRESIGNED } }), { status: opts.metaStatus ?? 200 });
        }
        return new Response(bodyBytes, { status: opts.binStatus ?? 200, headers: opts.binHeaders });
    };
    const deps: SaveFileDeps = { ctx: { apiKey: 'zk_secret', baseUrl: api }, fetchFn, deviceId: () => ME, downloadsDir: () => dir };
    return { calls, dir, deps };
};

let receiverPublicKey: string;
beforeAll(async () => {
    await initDeviceCrypto();
    receiverPublicKey = getDevicePublicKey() ?? '';
});

describe('saveFileFromS3', () => {
    it('plaintext: metadata with the API key, bytes from the presigned URL with no headers, file lands', async () => {
        const h = harness(Buffer.from('hello'));
        const path = await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk/1', fileName: 'hi.txt' }, h.deps);
        expect(path).toBe(join(h.dir, 'hi.txt'));
        expect(readFileSync(path ?? '').toString()).toBe('hello');
        expect(h.calls.map((c) => c.url)).toEqual([`${API}/files/fk%2F1`, PRESIGNED]);
        expect(h.calls[0].headers['X-API-Key']).toBe('zk_secret');
        expect(h.calls[1].headers).toEqual({});
    });

    it('encrypted for this device: opens the deviceKeyMap slot and writes the plaintext', async () => {
        const secret = Buffer.from('top secret recording bytes '.repeat(50));
        const sealed = await sealForReceiver(secret, receiverPublicKey);
        const h = harness(sealed.ciphertext);
        const path = await saveFileFromS3(
            { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
            { fileKey: 'fk', fileName: 'rec.mov', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry, dev_other: '{}' } },
            h.deps,
        );
        expect(path).toBe(join(h.dir, 'rec.mov'));
        expect(readFileSync(path ?? '').equals(secret)).toBe(true);
    });

    // M5: a sealed file is padded (Padmé) before sealing, and the size given
    // with it (from the sealed body) is what it is cut back to.
    it('cuts a padded sealed file back to the size it was given', async () => {
        const secret = Buffer.from('real bytes');
        const sealed = await sealForReceiver(Buffer.concat([secret, Buffer.alloc(6)]), receiverPublicKey);
        const h = harness(sealed.ciphertext);
        const path = await saveFileFromS3(
            { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
            { fileKey: 'fk', fileName: 'notes.txt', fileSize: 16, iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } },
            h.deps,
            secret.length,
        );
        expect(readFileSync(path ?? '').equals(secret)).toBe(true);
    });

    // A file sealed in chunks (`file-chunk-v1`): the sealed body says so, the iv
    // is the 7-byte prefix, and the padding is cut back the same way.
    it('opens a file sealed in chunks, piece by piece, and cuts its padding back', async () => {
        const secret = Buffer.alloc(2 * CHUNK + 4321, 0);
        for (let i = 0; i < secret.length; i++) secret[i] = (i * 31 + 7) & 0xff;
        const sealed = await sealForReceiver(Buffer.concat([secret, Buffer.alloc(100)]), receiverPublicKey, CHUNK);
        expect(Buffer.from(sealed.iv, 'base64')).toHaveLength(7);
        const h = harness(sealed.ciphertext);
        const path = await saveFileFromS3(
            { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
            { fileKey: 'fk', fileName: 'clip.mov', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } },
            h.deps,
            secret.length,
            CHUNK,
        );
        expect(path).toBe(join(h.dir, 'clip.mov'));
        expect(readFileSync(path ?? '').equals(secret)).toBe(true);
    });

    it('refuses a chunk size this build does not open, before any fetch', async () => {
        const sealed = await sealForReceiver(Buffer.from('real bytes'), receiverPublicKey, 16);
        const h = harness(sealed.ciphertext);
        for (const chunk of [16, 2 * CHUNK, 0]) {
            await expect(saveFileFromS3(
                { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
                { fileKey: 'fk', fileName: 'clip.mov', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } },
                h.deps,
                undefined,
                chunk,
            )).rejects.toThrow(/chunks of a size/);
        }
        expect(h.calls).toEqual([]);
    });

    it('does not open a file sealed in chunks as one sealed whole, or the other way round, and leaves nothing', async () => {
        const inChunks = await sealForReceiver(Buffer.from('real bytes'), receiverPublicKey, CHUNK);
        const whole = await sealForReceiver(Buffer.from('real bytes'), receiverPublicKey);
        for (const [sealed, chunk] of [[inChunks, undefined], [whole, CHUNK]] as const) {
            const h = harness(sealed.ciphertext);
            await expect(saveFileFromS3(
                { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
                { fileKey: 'fk', fileName: 'clip.mov', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } },
                h.deps,
                undefined,
                chunk,
            )).rejects.toThrow();
            expect(readdirSync(h.dir)).toEqual([]);
        }
    });

    // The record's size is the server's word: it never cuts an authenticated file short.
    it.each([0, 3, -1])('keeps a sealed file whole when only the record gives a size (%d)', async (recorded) => {
        const secret = Buffer.from('real bytes');
        const sealed = await sealForReceiver(secret, receiverPublicKey);
        const h = harness(sealed.ciphertext);
        const path = await saveFileFromS3(
            { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
            { fileKey: 'fk', fileName: 'notes.txt', fileSize: recorded, iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } },
            h.deps,
        );
        expect(readFileSync(path ?? '').equals(secret)).toBe(true);
    });

    it('encrypted for other devices only: null, and nothing is fetched', async () => {
        const h = harness(Buffer.from('x'));
        const path = await saveFileFromS3(
            { pushId: 'p', senderPublicKey: 'pk' },
            { fileKey: 'fk', fileName: 'a.bin', iv: 'aXY=', deviceKeyMap: { dev_other: '{}' } },
            h.deps,
        );
        expect(path).toBeNull();
        expect(h.calls).toEqual([]);
        expect(existsSync(join(h.dir, 'a.bin'))).toBe(false);
    });

    it('legacy account-key wrap (encryptedKey, no deviceKeyMap) is refused with a clear reason', async () => {
        const h = harness(Buffer.from('x'));
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin', iv: 'aXY=', encryptedKey: 'k' }, h.deps))
            .rejects.toThrow(/legacy account-key/);
        expect(h.calls).toEqual([]);
    });

    it('a slot for us but no senderPublicKey on the push, or no iv on the file, is refused before any fetch', async () => {
        const h = harness(Buffer.from('x'));
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a', iv: 'aXY=', deviceKeyMap: { [ME]: '{}' } }, h.deps))
            .rejects.toThrow(/senderPublicKey/);
        await expect(saveFileFromS3({ pushId: 'p', senderPublicKey: 'pk' }, { fileKey: 'fk', fileName: 'a', deviceKeyMap: { [ME]: '{}' } }, h.deps))
            .rejects.toThrow(/no iv/);
        expect(h.calls).toEqual([]);
    });

    it('no fileKey, no attachment context, or a body-less download each throw', async () => {
        const h = harness(null);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileName: 'a' }, h.deps)).rejects.toThrow(/no fileKey/);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a' }, { ...h.deps, ctx: null })).rejects.toThrow(/context/);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a' }, h.deps)).rejects.toThrow(/no body/);
    });

    it('a rejected metadata call or download status surfaces as an error, nothing on disk', async () => {
        const meta = harness(Buffer.from('x'), { metaStatus: 403 });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin' }, meta.deps)).rejects.toThrow(/metadata 403/);
        const bin = harness(Buffer.from('x'), { binStatus: 500 });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin' }, bin.deps)).rejects.toThrow(/download 500/);
        expect(existsSync(join(bin.dir, 'a.bin'))).toBe(false);
    });

    it('a sender-chosen name cannot leave the downloads dir', async () => {
        const h = harness(Buffer.from('x'));
        const path = await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: '../../escape.txt' }, h.deps);
        expect(path).toBe(join(h.dir, 'escape.txt'));
    });
});

// A relay that rewrites the metadata answer picks where this machine sends a
// GET: only an S3 address is fetched, and a redirect is not followed.
describe('the download address the API names', () => {
    it.each([
        ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
        ['a loopback service, with a remote API', 'http://127.0.0.1:8080/admin'],
        ['a LAN host', 'https://192.168.0.10/x'],
        ['a lookalike host', 'https://amazonaws.com.evil.example/x'],
        ['S3 over plain http', 'http://bucket.s3.ap-northeast-2.amazonaws.com/x'],
        ['not a URL', 'nope'],
    ])('refuses %s, and fetches nothing from it', async (_, downloadUrl) => {
        const h = harness(Buffer.from('x'), { downloadUrl });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin' }, h.deps)).rejects.toThrow(/refused downloadUrl/);
        expect(h.calls).toHaveLength(1);
        expect(existsSync(join(h.dir, 'a.bin'))).toBe(false);
    });

    it('takes a loopback address when the API is loopback too (the local server)', async () => {
        const h = harness(Buffer.from('local'), { api: 'http://localhost:3100', downloadUrl: 'http://localhost:4566/bucket/obj' });
        const path = await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'l.txt' }, h.deps);
        expect(readFileSync(path ?? '').toString()).toBe('local');
    });

    it('does not follow a redirect from the download address', async () => {
        const h = harness(Buffer.from('x'));
        await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'r.txt' }, h.deps);
        expect(h.calls[1]).toMatchObject({ url: PRESIGNED, redirect: 'error' });
    });

    it('refuses a saved file that says it is over the size limit, and writes nothing', async () => {
        const h = harness(Buffer.from('x'), { binHeaders: { 'content-length': String(2 * 1024 ** 3) } });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'big.bin' }, h.deps)).rejects.toThrow(/over the .*-byte limit/);
        expect(existsSync(join(h.dir, 'big.bin'))).toBe(false);
    });

    // A command's attachments are opened whole in memory, so they are sealed whole.
    it('refuses a command attachment sealed in chunks, and types nothing for that command', async () => {
        const sealed = await sealForReceiver(Buffer.from('real bytes'), receiverPublicKey, CHUNK);
        const fetchFn: typeof fetch = async (input) => (String(input).startsWith(API)
            ? new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }))
            : new Response(sealed.ciphertext));
        const file = { fileKey: 'fk', fileName: 'file', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } };
        await expect(downloadAttachments('cmd-chunked', [file], { apiKey: 'k', baseUrl: API }, {
            deviceId: ME, senderPublicKey: sealed.senderPublicKey,
            files: [{ iv: sealed.iv, name: 'clip.mov', type: 'video/quicktime', size: 10, chunk: CHUNK }],
        }, { fetchFn })).rejects.toThrow(/sealed in chunks/);
    });

    it('skips a command attachment whose address is not S3', async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            calls.push(String(input));
            return String(input).startsWith(API)
                ? new Response(JSON.stringify({ data: { downloadUrl: 'http://169.254.169.254/' } }))
                : new Response('secret');
        };
        const paths = await downloadAttachments('ssrf', [{ fileKey: 'fk', fileName: 'a.txt' }], { apiKey: 'k', baseUrl: API }, undefined, { fetchFn });
        expect(paths).toEqual([]);
        expect(calls).toEqual([`${API}/files/fk`]);
    });

    // C143 sealed half: the same sealed file twice in one command is stored and named once.
    it('names the same sealed file once when one command attaches it twice', async () => {
        const sealed = await sealForReceiver(Buffer.from('same bytes'), receiverPublicKey);
        const fetchFn: typeof fetch = async (input) => (String(input).startsWith(API)
            ? new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }))
            : new Response(sealed.ciphertext));
        const file = { fileKey: 'fk', fileName: 'a.txt', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry } };
        const paths = await downloadAttachments('dup-sealed', [file, file], { apiKey: 'k', baseUrl: API }, {
            deviceId: ME, senderPublicKey: sealed.senderPublicKey,
        }, { fetchFn });
        expect(paths).toHaveLength(1);
    });

    // C143: the same file attached twice in one command is stored and named once, not twice.
    it('names the same file once when one command attaches it twice', async () => {
        const bytes = 'same bytes';
        const fetchFn: typeof fetch = async (input) => String(input).startsWith(API)
            ? new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }))
            : new Response(bytes);
        const files = [
            { fileKey: 'fk', fileName: 'a.txt' },
            { fileKey: 'fk', fileName: 'a.txt' },
        ];
        const paths = await downloadAttachments('dup', files, { apiKey: 'k', baseUrl: API }, undefined, { fetchFn });
        expect(paths).toHaveLength(1);
        expect(new Set(paths).size).toBe(paths.length);
    });

    // C143: two different files that share a name are both kept — the second gets a suffix, not dropped.
    it('keeps two different files that share a name, the second under a suffixed name', async () => {
        const fetchFn: typeof fetch = async (input) => {
            const url = String(input);
            if (url.startsWith(API)) return new Response(JSON.stringify({ data: { downloadUrl: `${PRESIGNED}&k=${url.endsWith('fk2') ? 2 : 1}` } }));
            return new Response(url.endsWith('k=2') ? 'second bytes' : 'first bytes');
        };
        const files = [
            { fileKey: 'fk1', fileName: 'image.png' },
            { fileKey: 'fk2', fileName: 'image.png' },
        ];
        const paths = await downloadAttachments('same-name', files, { apiKey: 'k', baseUrl: API }, undefined, { fetchFn });
        expect(paths.map((p) => basename(p))).toEqual(['image.png', 'image-1.png']);
        expect(paths.map((p) => readFileSync(p, 'utf-8'))).toEqual(['first bytes', 'second bytes']);
    });

    it('skips a command attachment that says it is over the size limit, without reading it', async () => {
        const fetchFn: typeof fetch = async (input) => String(input).startsWith(API)
            ? new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }))
            : new Response('x', { headers: { 'content-length': String(2 * 1024 ** 3) } });
        const paths = await downloadAttachments('big', [{ fileKey: 'fk', fileName: 'a.txt' }], { apiKey: 'k', baseUrl: API }, undefined, { fetchFn });
        expect(paths).toEqual([]);
    });
});

// C24: neither the metadata call nor the bytes had a deadline, so one stalled
// request held the command carrying the file forever — never typed.
describe('attachment downloads that stall', () => {
    /** A fetch that never answers `stallUrl` until its signal aborts. */
    const stallingFetch = (stall: (url: string) => boolean): typeof fetch => async (input, init) => {
        const url = String(input);
        if (stall(url)) {
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) return; // unbounded: the bug — the test times out
                signal.addEventListener('abort', () => reject(signal.reason));
            });
        }
        if (url.startsWith(API)) return new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }));
        return new Response('bytes');
    };
    const ctx = { apiKey: 'zk_secret', baseUrl: API };
    const file = { fileKey: 'fk/1', fileName: 'a.txt' };

    it('a command attachment whose metadata call stalls is skipped, not waited on forever', async () => {
        const paths = await downloadAttachments('c24-meta', [file], ctx, undefined, {
            fetchFn: stallingFetch((url) => url.startsWith(API)), timeoutMs: 50,
        });
        expect(paths).toEqual([]);
    });

    it('a command attachment whose bytes stall is skipped', async () => {
        const paths = await downloadAttachments('c24-bin', [file], ctx, undefined, {
            fetchFn: stallingFetch((url) => url === PRESIGNED), timeoutMs: 50,
        });
        expect(paths).toEqual([]);
    });

    it('a saved file whose download never answers fails instead of hanging', async () => {
        const h = harness(Buffer.from('x'));
        const deps: SaveFileDeps = { ...h.deps, fetchFn: stallingFetch((url) => url === PRESIGNED), idleTimeoutMs: 50 };
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk/1', fileName: 'hi.txt' }, deps)).rejects.toThrow(/no response in 50 ms/);
    });
});

describe('downloadSealedEach — answer files', () => {
    const ctx = { apiKey: 'k', baseUrl: API };

    it('saves the files that open and names the one that did not, keeping the rest', async () => {
        const good = await sealForReceiver(Buffer.from('hello\0\0'), receiverPublicKey);
        const bad = await sealForReceiver(Buffer.from('nope'), receiverPublicKey);
        const fetchFn: typeof fetch = async (input) => {
            const url = String(input);
            if (url.startsWith(API)) return new Response(JSON.stringify({ data: { downloadUrl: `${PRESIGNED}&k=${url.endsWith('bad') ? 'bad' : 'good'}` } }));
            return url.endsWith('bad') ? new Response('gone', { status: 403 }) : new Response(good.ciphertext);
        };
        const files = [
            { fileKey: 'good', fileName: 'file', iv: good.iv, deviceKeyMap: { [ME]: good.entry } },
            { fileKey: 'bad', fileName: 'file', iv: bad.iv, deviceKeyMap: { [ME]: bad.entry } },
        ];

        const saved = await downloadSealedEach('evt-answer-partial', files, ctx, {
            deviceId: ME, senderPublicKey: good.senderPublicKey,
            files: [{ iv: good.iv, name: 'note.txt', type: 'text/plain', size: 5 }, { iv: bad.iv, name: 'shot.png', type: 'image/png', size: 4 }],
        }, { fetchFn });

        expect(saved.paths.map((p) => basename(p))).toEqual(['note.txt']);
        expect(readFileSync(saved.paths[0]!, 'utf8')).toBe('hello');
        expect(saved.missing).toEqual(['shot.png: download 403']);
    });

    it('names a file sealed in chunks, and a second copy of the same file, instead of dropping them', async () => {
        const once = await sealForReceiver(Buffer.from('same'), receiverPublicKey);
        const chunked = await sealForReceiver(Buffer.from('big'), receiverPublicKey, CHUNK);
        const fetchFn: typeof fetch = async (input) => {
            const url = String(input);
            if (url.startsWith(API)) return new Response(JSON.stringify({ data: { downloadUrl: `${PRESIGNED}&k=${url.split('/').pop()}` } }));
            return new Response(url.endsWith('big') ? chunked.ciphertext : once.ciphertext);
        };
        const same = { fileKey: 'same', fileName: 'file', iv: once.iv, deviceKeyMap: { [ME]: once.entry } };
        const big = { fileKey: 'big', fileName: 'file', iv: chunked.iv, deviceKeyMap: { [ME]: chunked.entry } };

        const saved = await downloadSealedEach('evt-answer-dup', [same, same, big], ctx, {
            deviceId: ME, senderPublicKey: once.senderPublicKey,
            files: [
                { iv: once.iv, name: 'a.txt', type: 'text/plain', size: 4 },
                { iv: once.iv, name: 'a.txt', type: 'text/plain', size: 4 },
                { iv: chunked.iv, name: 'clip.mov', type: 'video/quicktime', size: 3, chunk: CHUNK },
            ],
        }, { fetchFn });

        expect(saved.paths.map((p) => basename(p))).toEqual(['a.txt']);
        expect(saved.missing).toEqual(['a.txt: the same file was attached twice', expect.stringMatching(/^clip\.mov: .*sealed in chunks/)]);
    });
});
