import { createDecipheriv, randomBytes } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdirHandedBack } from './private-files.js';

/**
 * Streaming decrypt of a file the web / MCP side produced with
 * `libs/crypto` `encryptFile` (WebCrypto AES-256-GCM, 12-byte IV). That
 * API is one-shot; a 1 GiB attachment would sit in memory here, so this
 * is the same wire format on `node:crypto`'s incremental cipher:
 * WebCrypto appends the 16-byte GCM tag to the ciphertext, and the stream
 * holds back the last 16 bytes of whatever it is fed as that tag.
 *
 * The key is the raw per-file AES key, already unwrapped from the
 * attachment's `deviceKeyMap` slot (see `unwrapDeviceKey` in crypto.ts).
 */

export const GCM_TAG_BYTES = 16;
export const GCM_IV_BYTES = 12;

export const createFileDecryptStream = (rawKey: Buffer, iv: Buffer): Transform => {
    if (rawKey.length !== 32) throw new Error(`file key must be 32 bytes, got ${rawKey.length}`);
    if (iv.length !== GCM_IV_BYTES) throw new Error(`file iv must be ${GCM_IV_BYTES} bytes, got ${iv.length}`);
    const decipher = createDecipheriv('aes-256-gcm', rawKey, iv);
    let tail: Buffer = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _enc, done) {
            const joined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
            if (joined.length <= GCM_TAG_BYTES) {
                tail = joined;
                done();
                return;
            }
            const body = joined.subarray(0, joined.length - GCM_TAG_BYTES);
            tail = Buffer.from(joined.subarray(joined.length - GCM_TAG_BYTES));
            done(null, decipher.update(body));
        },
        flush(done) {
            if (tail.length < GCM_TAG_BYTES) {
                done(new Error('ciphertext shorter than the GCM tag'));
                return;
            }
            try {
                decipher.setAuthTag(tail);
                done(null, decipher.final());   // throws on a bad tag: tampered, truncated, wrong key
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
};

/**
 * A file sealed in chunks (`file-chunk-v1`), the format a phone seals a file
 * in that is too large to hold in memory. The padded plaintext is cut into
 * `FILE_CHUNK_BYTES` pieces — the last one shorter or equal, never empty —
 * and each is sealed alone with AES-256-GCM under the file key, no AAD:
 *
 *   nonce = prefix[7] ‖ piece index (u32 big-endian) ‖ 0x01 on the last piece, else 0x00
 *   file  = every `ciphertext ‖ tag[16]`, in order
 *
 * The index in the nonce refuses a piece moved or repeated; the last-piece
 * flag refuses a file cut at a piece's end, and bytes added after it. The
 * prefix travels where a whole-sealed file's IV does (`iv`), and the sealed
 * message says `chunk` next to it — see `chunkOf`. Vectors:
 * `file-chunk.vectors.json` (scripts/gen-file-chunk-vectors.py).
 */
export const FILE_CHUNK_BYTES = 1_048_576;
export const FILE_CHUNK_PREFIX_BYTES = 7;
/** What a listener tells senders it opens (`capabilities` on its device record). */
export const FILE_CHUNK_CAPABILITY = 'file-chunk-v1';
/** Feeds the reader keeps apart before it joins them. */
const MAX_HELD_FEEDS = 1024;

/**
 * The `chunk` a sender wrote beside a file's `iv`: absent for a file sealed
 * whole, `FILE_CHUNK_BYTES` for one sealed in chunks. Any other value is a
 * format this build does not open — `ok: false`, and the file is left alone.
 */
export const chunkOf = (said: unknown): { ok: true; chunk?: number } | { ok: false } => {
    if (said === undefined) return { ok: true };
    return said === FILE_CHUNK_BYTES ? { ok: true, chunk: FILE_CHUNK_BYTES } : { ok: false };
};

/**
 * Streaming decrypt of a file sealed in chunks. A piece is opened only once
 * a byte past it has arrived, because whether it is the last one is in its
 * nonce: what is left when the stream ends is the last piece, and it has to
 * open as one. Pieces already opened have reached the `.part` file by then;
 * `saveStream` removes it on any failure, so nothing a later piece disowns
 * is ever linked into place.
 */
export const createChunkedFileDecryptStream = (rawKey: Buffer, prefix: Buffer, chunk: number = FILE_CHUNK_BYTES): Transform => {
    if (rawKey.length !== 32) throw new Error(`file key must be 32 bytes, got ${rawKey.length}`);
    if (prefix.length !== FILE_CHUNK_PREFIX_BYTES) throw new Error(`chunked file prefix must be ${FILE_CHUNK_PREFIX_BYTES} bytes, got ${prefix.length}`);
    if (!Number.isSafeInteger(chunk) || chunk <= 0) throw new Error(`chunk size must be a whole number of bytes above zero, got ${chunk}`);
    const sealedPiece = chunk + GCM_TAG_BYTES;
    // What has arrived and is not opened yet, joined only once it holds a whole
    // piece: joining at every feed would copy up to a chunk each time.
    let held: Buffer[] = [];
    let heldBytes = 0;
    let index = 0;
    const open = (piece: Buffer, last: boolean): Buffer => {
        const nonce = Buffer.alloc(GCM_IV_BYTES);
        prefix.copy(nonce);
        nonce.writeUInt32BE(index++, FILE_CHUNK_PREFIX_BYTES);
        nonce[GCM_IV_BYTES - 1] = last ? 1 : 0;
        const decipher = createDecipheriv('aes-256-gcm', rawKey, nonce);
        decipher.setAuthTag(piece.subarray(piece.length - GCM_TAG_BYTES));
        const plain = decipher.update(piece.subarray(0, piece.length - GCM_TAG_BYTES));
        decipher.final();   // checks the tag; GCM has no bytes left to give here
        return plain;
    };
    return new Transform({
        transform(fed: Buffer, _enc, done) {
            held.push(fed);
            heldBytes += fed.length;
            // A peer that sends a byte at a time does not get to pile up a million buffers.
            if (held.length > MAX_HELD_FEEDS) held = [Buffer.concat(held)];
            if (heldBytes <= sealedPiece) { done(); return; }
            try {
                let rest = Buffer.concat(held);
                while (rest.length > sealedPiece) {
                    this.push(open(rest.subarray(0, sealedPiece), false));
                    rest = rest.subarray(sealedPiece);
                }
                held = [rest];
                heldBytes = rest.length;
                done();
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        },
        flush(done) {
            if (heldBytes <= GCM_TAG_BYTES) {
                done(new Error('chunked file ends without a last piece'));
                return;
            }
            try {
                done(null, open(Buffer.concat(held), true));   // throws on a piece that is not the last: cut short, or more was sealed after it
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
};

/**
 * Abort `controller` when `source` goes quiet for `idleMs`. A stalled S3
 * connection would otherwise park a download — and its part file — for
 * the life of the daemon with nothing in the log. Bytes still flowing,
 * however slowly, never trip it: a 1 GiB file on a bad link is not a stall.
 * More than `maxBytes` fails the stream: a body that never ends is not a
 * stall either, and would fill the disk.
 */
export const withIdleTimeout = (source: Readable, idleMs: number, controller: AbortController, maxBytes = Infinity): Readable => {
    let timer: NodeJS.Timeout | null = null;
    let seen = 0;
    const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(`no bytes for ${idleMs} ms`)), idleMs);
        timer.unref();
    };
    const guard = new Transform({
        transform(chunk: Buffer, _enc, done) {
            arm();
            seen += chunk.length;
            if (seen <= maxBytes) return done(null, chunk);
            if (timer) clearTimeout(timer);
            done(new Error(`download passed the ${maxBytes}-byte limit`));
        },
        flush(done) { if (timer) clearTimeout(timer); done(); },
    });
    arm();
    // `pipeline`, not `pipe`: a failure downstream (bad tag, disk, name cap)
    // must destroy the source too, or the response body sits open until the
    // idle timer fires. Errors surface through the returned stream.
    void pipeline(source, guard).catch(() => undefined);
    return guard;
};

/**
 * The most bytes one download may carry: the largest file any tier may send
 * (1 GiB, `fileMaxBytes`), plus the Padmé padding (at most about 12%) and
 * the GCM tag a sealed file adds. The record's `fileSize` is the relay's
 * word, so it cannot be the limit; without one, a URL that streams forever
 * fills the disk.
 */
export const DOWNLOAD_MAX_BYTES = 1.25 * 1024 ** 3;

export interface SavedFile {
    path: string;
    bytes: number;
}

/** How many `nextDest()` candidates `saveStream` tries before giving up. */
const MAX_LINK_ATTEMPTS = 100;

const isErrno = (err: unknown, code: string): boolean =>
    typeof err === 'object' && err !== null && 'code' in err && err.code === code;

/**
 * Stream `source` to the path `nextDest()` names, optionally decrypting
 * on the way — a file sealed whole, or with `chunk` one sealed in chunks
 * (`iv` is then its 7-byte prefix). The bytes go to a private `.part` file first (a per-call
 * random name, so two saves of the same file cannot touch each other's
 * temp) and are fsynced before being linked into place — a reader never
 * sees a half file, and an authentication failure (which GCM only reports
 * at the very end) leaves nothing behind. `link` refuses an existing dest
 * where `rename` would replace it; on that collision `nextDest()` is asked
 * again, so a name taken between the caller's check and here costs a
 * ` (n)` suffix, never the download. Resolves with the path written and
 * the plaintext byte count.
 */
export const saveStream = async (
    source: Readable,
    nextDest: () => string,
    decrypt?: { rawKey: Buffer; iv: Buffer; chunk?: number },
): Promise<SavedFile> => {
    const first = nextDest();
    const dir = dirname(first);
    mkdirHandedBack(dir);
    const part = join(dir, `.hwip-${randomBytes(6).toString('hex')}.part`);
    let bytes = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _enc, done) { bytes += chunk.length; done(null, chunk); },
    });
    try {
        // Before the part file exists: a key or an iv the format refuses throws here.
        const opened = !decrypt ? null : decrypt.chunk === undefined
            ? createFileDecryptStream(decrypt.rawKey, decrypt.iv)
            : createChunkedFileDecryptStream(decrypt.rawKey, decrypt.iv, decrypt.chunk);
        const sink = createWriteStream(part, { flags: 'wx' });
        if (opened) await pipeline(source, opened, counter, sink);
        else await pipeline(source, counter, sink);
        const fh = await open(part, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
        let dest = first;
        for (let attempt = 1; ; attempt++) {
            try {
                await link(part, dest);
                break;
            } catch (err) {
                if (!isErrno(err, 'EEXIST') || attempt >= MAX_LINK_ATTEMPTS) throw err;
                dest = nextDest();
            }
        }
        // The file is in place; a temp that will not go is not a failed save.
        await unlink(part).catch(() => undefined);
        return { path: dest, bytes };
    } catch (err) {
        rmSync(part, { force: true });
        throw err;
    }
};
