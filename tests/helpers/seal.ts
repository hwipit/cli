import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes, webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Test-only sender: seals bytes exactly the way `libs/crypto` `encryptFile`
 * and the cli's `encryptFileForDevices` do it, on WebCrypto, so a receiver
 * under test is checked against the real wire format rather than its own
 * idea of it. Lives outside `src/` so it is never built into `dist/`.
 */

const subtle = webcrypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b).toString('base64');

export interface Sealed {
    ciphertext: Buffer;
    iv: string;
    /** JSON `{ encryptedKey, keyIv }` — one `deviceKeyMap` slot. */
    entry: string;
    senderPublicKey: string;
}

/**
 * A file sealed in chunks (`file-chunk-v1`), written from the format's words
 * and not from the reader under test: piece i under nonce
 * prefix(7) ‖ i (u32, big-endian) ‖ last (1 or 0), each piece ciphertext ‖ tag.
 */
export const sealInChunks = (key: Buffer, prefix: Buffer, chunk: number, plain: Buffer): Buffer => {
    const pieces: Buffer[] = [];
    const count = Math.ceil(plain.length / chunk);
    for (let i = 0; i < count; i++) {
        const nonce = Buffer.alloc(12);
        prefix.copy(nonce);
        nonce.writeUInt32BE(i, 7);
        nonce[11] = i === count - 1 ? 1 : 0;
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        pieces.push(cipher.update(plain.subarray(i * chunk, (i + 1) * chunk)), cipher.final(), cipher.getAuthTag());
    }
    return Buffer.concat(pieces);
};

/** With `chunk`, the file is sealed in chunks and `iv` is its 7-byte prefix. */
export const sealForReceiver = async (plaintext: Buffer, receiverPublicKeyB64: string, chunk?: number): Promise<Sealed> => {
    const sender = await subtle.generateKey(ECDH, true, ['deriveKey']);
    const receiverPub = await subtle.importKey('spki', Buffer.from(receiverPublicKeyB64, 'base64'), ECDH, true, []);
    const fileKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(chunk === undefined ? 12 : 7));
    const ciphertext = chunk === undefined
        ? Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, plaintext))
        : sealInChunks(Buffer.from(await subtle.exportKey('raw', fileKey)), Buffer.from(iv), chunk, plaintext);
    const shared = await subtle.deriveKey({ name: 'ECDH', public: receiverPub }, sender.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const keyIv = webcrypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, await subtle.exportKey('raw', fileKey));
    return {
        ciphertext,
        iv: b64(iv),
        entry: JSON.stringify({ encryptedKey: b64(wrapped), keyIv: b64(keyIv) }),
        senderPublicKey: b64(await subtle.exportKey('spki', sender.publicKey)),
    };
};

/** A fresh ECDH public key that is not the receiver's — "some other device". */
export const otherDevicePublicKey = async (): Promise<string> => {
    const pair = await subtle.generateKey(ECDH, true, ['deriveKey']);
    return b64(await subtle.exportKey('spki', pair.publicKey));
};

export const chunked = (buf: Buffer, size: number): Readable => {
    const parts: Buffer[] = [];
    for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
    return Readable.from(parts);
};

// ─── Envelope v2 ───

/** The wire fields of a v2 envelope (cli crypto.ts `SealedV2`). */
export interface SealedV2Wire {
    v: 2;
    salt: string;
    iv: string;
    ciphertext: string;
    senderPublicKey: string;
}

export const isSealedV2Wire = (value: unknown): value is SealedV2Wire =>
    typeof value === 'object' && value !== null
    && 'v' in value && value.v === 2
    && 'salt' in value && typeof value.salt === 'string'
    && 'iv' in value && typeof value.iv === 'string'
    && 'ciphertext' in value && typeof value.ciphertext === 'string'
    && 'senderPublicKey' in value && typeof value.senderPublicKey === 'string';

/** DER header of a P-256 SPKI whose key is an uncompressed point; the 65-byte point follows it. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

const pointOf = (spkiBase64: string): Buffer => Buffer.from(spkiBase64, 'base64').subarray(P256_SPKI_PREFIX.length);

export interface V2Party {
    /** Base64 SPKI, as a device registers it. */
    publicKey: string;
    seal: (purpose: string, plaintext: string, recipientPublicKey: string, context?: string) => SealedV2Wire;
    open: (purpose: string, envelope: SealedV2Wire, context?: string) => string;
    /** Seals a push body the way the app's `Envelope.seal` (and the cli's
     *  `encryptPushBodyForDevices`) does, from this device to one recipient:
     *  the push `body` and that recipient's `deviceKeyMap` slot. */
    sealPush: (content: object, recipientPublicKey: string) => { body: string; entry: string };
    /** Seals file bytes the way the app's `Envelope.sealFile` does, for one recipient: the
     *  bytes to upload (ciphertext ‖ tag), their IV and that recipient's `deviceKeyMap` slot. */
    sealFile: (bytes: Buffer, recipientPublicKey: string) => { bytes: Buffer; iv: string; entry: string };
}

/**
 * A peer device speaking envelope v2 — the phone, in a listener test. Built on
 * node's classic crypto calls and the format's description rather than on
 * WebCrypto or `crypto.ts`, so a test that passes proves the two agree on the
 * wire format and not that one implementation agrees with itself.
 */
export const v2Party = (): V2Party => {
    const ecdh = createECDH('prime256v1');
    const ownPoint = ecdh.generateKeys();
    const messageKey = (peerPoint: Buffer, salt: Buffer, purpose: string): Buffer =>
        Buffer.from(hkdfSync('sha256', ecdh.computeSecret(peerPoint), salt, `hwip/e2e/v2/${purpose}`, 32));
    const aad = (purpose: string, sender: Buffer, recipient: Buffer, context: string): Buffer =>
        Buffer.concat([Buffer.from(`hwip/e2e/v2\n${purpose}\n`, 'utf-8'), sender, recipient, Buffer.from(context, 'utf-8')]);
    const publicKey = Buffer.concat([P256_SPKI_PREFIX, ownPoint]).toString('base64');
    /** AES-256-GCM as WebCrypto does it: the tag after the ciphertext. */
    const gcm = (key: Buffer, plaintext: Buffer): { sealed: Buffer; iv: Buffer } => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        return { sealed: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), iv };
    };
    return {
        publicKey,
        seal: (purpose, plaintext, recipientPublicKey, context = '') => {
            const peer = pointOf(recipientPublicKey);
            const salt = randomBytes(32);
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', messageKey(peer, salt, purpose), iv);
            cipher.setAAD(aad(purpose, ownPoint, peer, context));
            const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
            return {
                v: 2,
                salt: salt.toString('base64'),
                iv: iv.toString('base64'),
                ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
                senderPublicKey: publicKey,
            };
        },
        sealFile: (bytes, recipientPublicKey) => {
            const fileKey = randomBytes(32);
            const file = gcm(fileKey, bytes);
            const wrap = gcm(ecdh.computeSecret(pointOf(recipientPublicKey)), fileKey);
            return {
                bytes: file.sealed,
                iv: file.iv.toString('base64'),
                entry: JSON.stringify({ encryptedKey: wrap.sealed.toString('base64'), keyIv: wrap.iv.toString('base64') }),
            };
        },
        sealPush: (content, recipientPublicKey) => {
            const messageKey = randomBytes(32);
            const message = gcm(messageKey, Buffer.from(JSON.stringify(content), 'utf-8'));
            // WebCrypto's ECDH → AES-GCM derivation keys the cipher with the raw x-coordinate.
            const wrap = gcm(ecdh.computeSecret(pointOf(recipientPublicKey)), messageKey);
            return {
                body: JSON.stringify({ ciphertext: message.sealed.toString('base64'), iv: message.iv.toString('base64') }),
                entry: JSON.stringify({ encryptedKey: wrap.sealed.toString('base64'), keyIv: wrap.iv.toString('base64') }),
            };
        },
        open: (purpose, envelope, context = '') => {
            const peer = pointOf(envelope.senderPublicKey);
            const sealed = Buffer.from(envelope.ciphertext, 'base64');
            const decipher = createDecipheriv(
                'aes-256-gcm',
                messageKey(peer, Buffer.from(envelope.salt, 'base64'), purpose),
                Buffer.from(envelope.iv, 'base64'),
            );
            decipher.setAAD(aad(purpose, peer, ownPoint, context));
            decipher.setAuthTag(sealed.subarray(sealed.length - 16));
            return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf-8');
        },
    };
};

const P256_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;

/**
 * The other key with the same x coordinate: the public key (x, p − y). It makes the same ECDH secret as `publicKey`
 * does, so anything sealed for or by one opens with the other; a relay can compute it without any secret key.
 */
export const mirroredPublicKey = (publicKey: string): string => {
    const der = Buffer.from(publicKey, 'base64');
    const yAt = der.length - 32;
    const y = BigInt(`0x${der.subarray(yAt).toString('hex')}`);
    const mirrored = Buffer.from(der);
    mirrored.write((P256_PRIME - y).toString(16).padStart(64, '0'), yAt, 'hex');
    return mirrored.toString('base64');
};
