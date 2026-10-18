import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_CHUNK_BYTES, FILE_CHUNK_PREFIX_BYTES, chunkOf, saveStream } from './file-crypto.js';
import { chunked, sealInChunks } from '../tests/helpers/seal.js';

// The chunked sealed-file format (`file-chunk-v1`) against vectors an independent Python
// implementation produced (scripts/gen-file-chunk-vectors.py). The megabyte cases carry
// only hashes, so the test seals them itself the way the format says and first checks
// its own sealing against the vector's hash — what it then feeds the reader is the wire format.

interface Case {
    name: string; key: string; prefix: string; chunk: number;
    plainLength: number; plainSha256: string; sealedLength: number; sealedSha256: string; sealed?: string;
}
const vectors = JSON.parse(readFileSync(new URL('./file-chunk.vectors.json', import.meta.url), 'utf8')) as {
    cases: Case[];
    refused: { key: string; prefix: string; chunk: number; cases: { name: string; sealed: string }[] };
};

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const pattern = (length: number): Buffer => {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) & 0xff;
    return out;
};
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'hwip-file-chunk-')); });
const leftovers = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.part'));
let n = 0;
const nextPath = (): string => join(dir, `out-${n++}.bin`);

describe('a file sealed in chunks', () => {
    it.each(vectors.cases.map((c) => [c.name, c] as const))('opens: %s', async (_name, c) => {
        const key = Buffer.from(c.key, 'hex');
        const prefix = Buffer.from(c.prefix, 'hex');
        const sealed = c.sealed ? Buffer.from(c.sealed, 'hex') : sealInChunks(key, prefix, c.chunk, pattern(c.plainLength));
        expect(sealed.length).toBe(c.sealedLength);
        expect(sha256(sealed)).toBe(c.sealedSha256);

        // However the bytes arrive: one at a time (small cases), across piece ends, all at once.
        const feeds = c.sealedLength <= 4096 ? [1, 7, 17, 33, c.sealedLength] : [65_521, c.chunk + 16, c.sealedLength];
        for (const feed of feeds) {
            const dest = nextPath();
            const saved = await saveStream(chunked(sealed, feed), () => dest, { rawKey: key, iv: prefix, chunk: c.chunk });
            expect(saved).toEqual({ path: dest, bytes: c.plainLength });
            expect(sha256(readFileSync(dest))).toBe(c.plainSha256);
        }
        expect(leftovers()).toEqual([]);
    });

    it.each(vectors.refused.cases.map((c) => [c.name, c.sealed] as const))('is refused and leaves nothing: %s', async (_name, hex) => {
        const { key, prefix, chunk } = vectors.refused;
        const sealed = Buffer.from(hex, 'hex');
        for (const feed of [1, 16, 32, 33, Math.max(1, sealed.length)]) {
            const dest = nextPath();
            await expect(saveStream(chunked(sealed, feed), () => dest, { rawKey: Buffer.from(key, 'hex'), iv: Buffer.from(prefix, 'hex'), chunk }))
                .rejects.toThrow();
            expect(existsSync(dest)).toBe(false);
        }
        expect(leftovers()).toEqual([]);
    });

    it('is refused under another key or another prefix', async () => {
        const c = vectors.cases[3];
        const sealed = Buffer.from(c.sealed ?? '', 'hex');
        const key = Buffer.from(c.key, 'hex');
        const prefix = Buffer.from(c.prefix, 'hex');
        const otherKey = Buffer.from(key).fill(1, 0, 1);
        const otherPrefix = Buffer.from(prefix).fill(1, 0, 1);
        await expect(saveStream(chunked(sealed, 64), nextPath, { rawKey: otherKey, iv: prefix, chunk: c.chunk })).rejects.toThrow();
        await expect(saveStream(chunked(sealed, 64), nextPath, { rawKey: key, iv: otherPrefix, chunk: c.chunk })).rejects.toThrow();
        expect(leftovers()).toEqual([]);
    });

    it('takes a 7-byte prefix and nothing else for its iv', async () => {
        const c = vectors.cases[0];
        const sealed = Buffer.from(c.sealed ?? '', 'hex');
        for (const iv of [Buffer.alloc(12), Buffer.alloc(6), Buffer.alloc(0)]) {
            await expect(saveStream(chunked(sealed, 64), nextPath, { rawKey: Buffer.from(c.key, 'hex'), iv, chunk: c.chunk })).rejects.toThrow(/prefix/);
        }
        expect(leftovers()).toEqual([]);
        expect(FILE_CHUNK_PREFIX_BYTES).toBe(7);
    });
});

describe('the reader of a file sealed in chunks', () => {
    it('takes a chunk that is a whole number of bytes above zero and nothing else', async () => {
        const c = vectors.cases[0];
        for (const chunk of [NaN, 0, -16, 16.5, Infinity]) {
            await expect(saveStream(chunked(Buffer.from(c.sealed ?? '', 'hex'), 64), nextPath, { rawKey: Buffer.from(c.key, 'hex'), iv: Buffer.from(c.prefix, 'hex'), chunk }))
                .rejects.toThrow(/chunk size/);
        }
        expect(leftovers()).toEqual([]);
    });
});

describe('chunkOf — what a sender may say about the chunks', () => {
    it('is absent for a file sealed whole', () => {
        expect(chunkOf(undefined)).toEqual({ ok: true });
    });

    it('is 1 MiB, the one size this version seals in', () => {
        expect(FILE_CHUNK_BYTES).toBe(1_048_576);
        expect(chunkOf(1_048_576)).toEqual({ ok: true, chunk: 1_048_576 });
    });

    it('is nothing else', () => {
        for (const said of [0, 16, 1_048_575, 2_097_152, 1_048_576.5, '1048576', null, true, {}]) {
            expect(chunkOf(said), JSON.stringify(said)).toEqual({ ok: false });
        }
    });
});
