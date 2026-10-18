/**
 * Per-device encryption for the Hook SDK — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @hwip/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API via node:crypto webcrypto, imported rather
 * than read off the `crypto` global.
 *
 * How it works (ADR-0007):
 *
 *   This host holds its own ECDH keypair in ~/.hwip/device-keys.json. The
 *   private half is generated here and never leaves — the server only ever
 *   sees public keys. A push is encrypted once with a random AES key, and
 *   that key is wrapped separately for each of the user's registered devices
 *   using ECDH(this host, that device). Same keypair the stream frames below
 *   already used; push and file bodies now share it.
 *
 * What it does not give you:
 *   • Forward secrecy — the ECDH secret for a given (sender, device) pair is
 *     static, so a compromise of either private key retroactively opens every
 *     push wrapped for that pair.
 *   • Authenticity beyond the key pairing — nothing signs `senderPublicKey`.
 *
 * Superseded scheme: a single account-wide keypair whose private half the
 * backend escrowed so it could sync to new devices. Key escrow was removed
 * server-side and `GET /users/me/keys` has returned a public
 * key only ever since. This client used to react by generating a fresh
 * account keypair and PUTting it back — which overwrote the account public
 * key and encrypted to a key no device held. Both that upload path and the
 * account keypair are gone.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, unlinkSync, linkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

// The Web Crypto implementation comes from `node:crypto`, not the `crypto`
// global.
const crypto = webcrypto as unknown as Crypto;

// ─── Base64 helpers ───

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fromBase64 = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ─── ECDH key management ───

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

interface ExportedKeyPair {
  publicKey: string;   // Base64-encoded SPKI
  privateKey: string;  // Base64-encoded PKCS8
}

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const exportKeyPair = async (keyPair: CryptoKeyPair): Promise<ExportedKeyPair> => {
  const [publicRaw, privateRaw] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return { publicKey: toBase64(publicRaw), privateKey: toBase64(privateRaw) };
};

const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('spki', fromBase64(base64), ECDH_PARAMS, true, []);

const importPrivateKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('pkcs8', fromBase64(base64), ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const importKeyPair = async (exported: ExportedKeyPair): Promise<CryptoKeyPair> => {
  const [publicKey, privateKey] = await Promise.all([
    importPublicKey(exported.publicKey),
    importPrivateKey(exported.privateKey),
  ]);
  return { publicKey, privateKey };
};

const deriveAesKey = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

// ─── Superseded account keystore ───
//
// Held the escrowed account keypair. Nothing reads it any more; it is deleted
// on sight so a private key the server no longer issues stops sitting on disk.

const LEGACY_KEYS_PATH = join(homedir(), '.config', 'hwip', 'keys.json');

const deleteLegacyKeys = (): void => {
  try { unlinkSync(LEGACY_KEYS_PATH); } catch { /* not present — fine */ }
};

// uploadServerKeys is gone. It wrote this host's public key to
// /users/me/keys, overwriting the account key every other client reads — and
// it fired on exactly the path escrow removal made unreachable. Nothing here
// writes key material to the server any more.

/** One target device, as returned by `GET /devices`. */
export interface DeviceRecipient {
  deviceId: string;
  /** Base64 SPKI of that device's per-device public key. */
  publicKey: string;
}

/** deviceId → JSON `{ encryptedKey, keyIv }`, the wire shape the clients parse. */
export type DeviceKeyMap = Record<string, string>;

/**
 * Keep only devices this host can encrypt for: a device without a public key
 * has never run a build that registers one, and wrapping for it produces a push
 * it cannot open.
 */
export const selectRecipients = (
  devices: { deviceId: string; publicKey?: string }[],
): DeviceRecipient[] =>
  devices
    .filter((d): d is DeviceRecipient => !!d.publicKey)
    .map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));

/** A device a person reads pushes on: the iOS or Android app. A push or question nobody can read on a phone is not sent. */
export const isAppDevice = (d: { type?: string }): boolean => d.type === 'ios' || d.type === 'android';

/**
 * Wrap one raw AES key for every recipient device.
 *
 * The payload is encrypted once and only the wrapped key repeats, so an
 * attachment costs one S3 object regardless of device count. A recipient
 * whose public key will not import is dropped rather than failing the send —
 * one broken device record must not silence every push.
 */
const wrapForDevices = async (
  rawKey: ArrayBuffer,
  senderPrivateKey: CryptoKey,
  recipients: DeviceRecipient[],
): Promise<DeviceKeyMap> => {
  const entries = await Promise.all(
    recipients.map(async ({ deviceId, publicKey }) => {
      try {
        const sharedKey = await deriveAesKey(senderPrivateKey, await importPublicKey(publicKey));
        const keyIv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawKey);
        return [
          deviceId,
          JSON.stringify({ encryptedKey: toBase64(wrapped), keyIv: toBase64(keyIv.buffer as ArrayBuffer) }),
        ] as const;
      } catch (err) {
        console.error(`[Crypto] Skipping device ${deviceId} — unusable public key:`, err);
        return null;
      }
    }),
  );

  const keyMap: DeviceKeyMap = {};
  for (const entry of entries) {
    if (entry) keyMap[entry[0]] = entry[1];
  }
  if (Object.keys(keyMap).length === 0) throw new Error('No recipient device accepted the wrapped key');
  return keyMap;
};

/**
 * Encrypt a push body for the given recipient devices.
 *
 * Returns the wire fields the API expects: `body` carries the ciphertext and
 * IV, `deviceKeyMap` the per-device wrapped keys, `senderPublicKey` the half
 * recipients need to derive the same secret back.
 */
export const encryptPushBodyForDevices = async (
  input: PushBodyInput,
  recipients: DeviceRecipient[],
): Promise<{
  body: string;
  deviceKeyMap: DeviceKeyMap;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!deviceKeyPair || !deviceExportedPublicKey) throw new Error('Crypto not initialized');
  assertAskWithinLimits(input.ask);

  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(
      JSON.stringify({
        title: input.title,
        body: input.body,
        url: input.url,
        cmd: input.cmd,
        ask: input.ask,
        answer: input.answer,
        files: input.files,
        keys: input.keys,
        ifPrompt: input.ifPrompt,
        context: input.context,
      }),
    ),
  );
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);

  return {
    body: JSON.stringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) }),
    deviceKeyMap: await wrapForDevices(rawMessageKey, deviceKeyPair.privateKey, recipients),
    senderPublicKey: deviceExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for the given recipient devices.
 */
export const encryptFileForDevices = async (
  content: string | Buffer,
  recipients: DeviceRecipient[],
): Promise<{ ciphertext: Buffer; iv: string; deviceKeyMap: DeviceKeyMap }> => {
  if (!deviceKeyPair) throw new Error('Crypto not initialized');

  // Binary content must be encrypted byte for byte — running a Buffer through
  // TextEncoder would UTF-8 mangle every non-ASCII byte. Today's only caller
  // passes markdown, so this is a guard against the first binary sender rather
  // than a live fix (the MCP twin took that bug in production).
  const buffer =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);

  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    deviceKeyMap: await wrapForDevices(rawFileKey, deviceKeyPair.privateKey, recipients),
  };
};

// ─── Per-device keypair (stream E2EE + push/file bodies) ───
//
// One keypair per host: generated here, private key never leaves
// ~/.hwip/device-keys.json, never uploaded. It matches the web app's
// per-device `'device'` slot, so anything encrypted here is decryptable only
// by the devices whose public keys it was wrapped for.
//
// Stream frames, push bodies and file bodies all use it. It replaced the escrowed
// account-wide keypair entirely — the file header explains why that one is
// gone.

const DEVICE_KEYS_DIR = join(homedir(), '.hwip');
const DEVICE_KEYS_PATH = join(DEVICE_KEYS_DIR, 'device-keys.json');

let deviceKeyPair: CryptoKeyPair | null = null;
let deviceExportedPublicKey: string | null = null;
let deviceInitPromise: Promise<string> | null = null;

const loadStoredDeviceKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(DEVICE_KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

/**
 * Create the keypair file, exclusively. The MCP server creates the same file
 * (one Machine Device keypair per host, ADR-0007), and two processes each
 * writing their own pair would leave one of them holding a key that is not on
 * disk — and not the one registered. Returns what is on disk afterwards: ours,
 * or the pair that won the race.
 */
const storeDeviceKeys = (exported: ExportedKeyPair): ExportedKeyPair => {
  mkdirHandedBack(DEVICE_KEYS_DIR, 0o700);
  // Written whole to a private temp name, then linked into place: `link` is
  // atomic and fails if the name exists, so the file under the real name is
  // never half-written, and a process that loses the race reads a complete one.
  const temp = `${DEVICE_KEYS_PATH}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(exported, null, 2), { mode: 0o600, flag: 'wx' });
  // `link` below makes a second name for this same file, so its owner is the key's owner (root through sudo: the user).
  handBackToSudoUser(temp);
  try {
    linkSync(temp, DEVICE_KEYS_PATH);
    return exported;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const winner = loadStoredDeviceKeys();
    if (!winner?.publicKey || !winner.privateKey) throw new Error(`${DEVICE_KEYS_PATH} exists but holds no keypair`);
    return winner;
  } finally {
    try { unlinkSync(temp); } catch { /* already gone — fine */ }
  }
};

/**
 * Load-or-create the per-device keypair. Local-only — no server round-trip,
 * no upload. Safe to call concurrently (dedupes to one init). Returns the
 * exported public key (Base64 SPKI).
 */
export const initDeviceCrypto = (): Promise<string> => {
  if (deviceInitPromise) return deviceInitPromise;
  deviceInitPromise = (async () => {
    deleteLegacyKeys();
    const stored = loadStoredDeviceKeys();
    if (stored) {
      deviceKeyPair = await importKeyPair(stored);
      deviceExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    const onDisk = storeDeviceKeys(exported);
    deviceKeyPair = onDisk === exported ? keyPair : await importKeyPair(onDisk);
    deviceExportedPublicKey = onDisk.publicKey;
    return onDisk.publicKey;
  })().catch((err) => {
    deviceInitPromise = null;
    throw err;
  });
  return deviceInitPromise;
};

export const getDevicePublicKey = (): string | null => deviceExportedPublicKey;

/**
 * Raw ECDH secret between this device and `peerPublicKeyRaw` (Base64
 * SPKI) — the 32-byte x-coordinate WebCrypto's `deriveBits` yields for
 * P-256. Input to the local-transfer MAC key (lan-auth.ts `deriveLanKey`);
 * never used as a key by itself. Requires initDeviceCrypto().
 */
export const deriveLanSharedSecret = async (peerPublicKeyRaw: string): Promise<Buffer> => {
  if (!deviceKeyPair) throw new Error('Device crypto not initialized');
  const peer = await importPublicKey(peerPublicKeyRaw);
  return Buffer.from(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, deviceKeyPair.privateKey, 256));
};

/**
 * Open this device's slot in a `deviceKeyMap` (the JSON `{ encryptedKey,
 * keyIv }` `wrapForDevices` writes) and return the raw AES key inside —
 * the per-file key for an attachment, or the message key for a push body.
 * The ECDH secret is derived from this device's private half and the
 * sender's `senderPublicKey`; anything but that pairing fails the GCM tag
 * and rejects. Requires initDeviceCrypto().
 */
const unwrapDeviceKeyRaw = async (entryJson: string, senderPublicKeyRaw: string): Promise<ArrayBuffer> => {
  if (!deviceKeyPair) throw new Error('Device crypto not initialized');
  const entry = JSON.parse(entryJson) as { encryptedKey?: unknown; keyIv?: unknown };
  if (typeof entry.encryptedKey !== 'string' || typeof entry.keyIv !== 'string') {
    throw new Error('deviceKeyMap entry is not { encryptedKey, keyIv }');
  }
  const sharedKey = await deriveAesKey(deviceKeyPair.privateKey, await importPublicKey(senderPublicKeyRaw));
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(entry.keyIv)) },
    sharedKey,
    fromBase64(entry.encryptedKey),
  );
};

export const unwrapDeviceKey = async (entryJson: string, senderPublicKeyRaw: string): Promise<Buffer> =>
  Buffer.from(await unwrapDeviceKeyRaw(entryJson, senderPublicKeyRaw));

/**
 * The label a sealed REST command carries inside its body (M5 D8): which
 * session on which machine it is for, and a number that only grows per
 * sender. A sealed body without one is not a command. `from` is the id of the
 * computer that sent it, when it names itself.
 */
export interface SealedCommandLabel {
  n: number;
  session: string;
  device: string;
  from?: string;
}

/** One button of a sealed question: `id` and `style` also reach the server in the clear, `label` never does. */
export interface SealedAskAction {
  id: string;
  label: string;
  style?: string;
}

/**
 * The label a sealed question carries inside its body: the asker's own random
 * `id` (the answer must echo it, so a relay cannot pass an old question's answer
 * off as a new one's), the Machine Device that asks, and the wording the server
 * must not read.
 */
export interface SealedAskLabel {
  id: string;
  device: string;
  actions?: SealedAskAction[];
  placeholder?: string;
}

/**
 * The summary a sealed question may carry in its body under `context` (F3): what the asking session has changed
 * and how much of its screen the original holds. It is a new key of the same plaintext JSON — the envelope and
 * the schema are unchanged, and a reader that does not know the key drops it with the rest of the keys it does
 * not read. The original (the masked diff and screen) is never in the body: it is the question's sealed attachment.
 */
export interface SealedAskContext {
  diff: 'ok' | 'no_repo' | 'failed';
  files: number;
  added: number;
  removed: number;
  listed: { path: string; status: 'M' | 'A' | 'D' | '?'; added: number; removed: number; binary?: true }[];
  moreFiles: number;
  screenLines: number;
  masked: number;
  cut: { diff: boolean; screen: boolean };
}

/** The label a sealed answer carries: which question it answers and what was chosen. */
export interface SealedAnswerLabel {
  ask: string;
  actionId?: string;
  exit?: true;
}

/** What `encryptPushBodyForDevices` seals. Keys left out are left out of the plaintext JSON. */
export interface PushBodyInput {
  title?: string;
  body?: string;
  url?: string;
  cmd?: SealedCommandLabel;
  ask?: SealedAskLabel;
  answer?: SealedAnswerLabel;
  files?: SealedFileMeta[];
  /**
   * Named keys (the blocked prompt's answer) inside a sealed command. Read
   * back only when every entry is a string; the listener allowlists the names.
   */
  keys?: string[];
  /** The blocked prompt id the keys answer, inside a sealed command. */
  ifPrompt?: string;
  context?: SealedAskContext;
}

/**
 * One sealed attachment as the sealed body names it (M5): its IV — fresh per
 * file, so an attachment from another message does not match — and what it
 * really is. The list binds the attachments to the message, in order.
 * `chunk` is there for a file sealed in chunks (`file-chunk-v1`): the plain
 * bytes in each piece, and `iv` is then the 7-byte prefix of the piece nonces.
 */
export interface SealedFileMeta {
  iv: string;
  name: string;
  type: string;
  size: number;
  chunk?: number;
}

const MAX_ASK_ACTIONS = 10;
const MAX_ACTION_ID_CHARS = 64;
const MAX_ACTION_LABEL_CHARS = 100;
const MAX_ASK_ID_CHARS = 128;
/** Most files the summary lists, and the longest path it shows (bytes): the summary rides in a size-capped body. */
const MAX_CONTEXT_LISTED = 20;
const MAX_CONTEXT_PATH_BYTES = 128;
/** A device id as the account issues it (`subscriber-trust` DEVICE_ID, kept here so crypto stays free of that import). */
const ASK_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The reader drops a whole label that is over its limits, so a question sealed
 * past them would arrive as one with no `ask` label. Refuse at the seal instead.
 */
const assertAskWithinLimits = (ask: SealedAskLabel | undefined): void => {
  if (!ask) return;
  if (ask.id.length === 0 || ask.id.length > MAX_ASK_ID_CHARS) throw new Error(`ask id must be 1 to ${MAX_ASK_ID_CHARS} characters`);
  if (!ASK_DEVICE_ID.test(ask.device)) throw new Error('ask device id is not a device id');
  const actions = ask.actions ?? [];
  // The choices are the caller's to shorten: `ASK_CHOICES_CODE` lets `prepareAsk` say so (a property, not a class,
  // so it survives a module registry reset).
  const choices = (message: string) => Object.assign(new Error(message), { code: ASK_CHOICES_CODE });
  if (actions.length > MAX_ASK_ACTIONS) throw choices(`a question takes at most ${MAX_ASK_ACTIONS} choices`);
  if (actions.some((a) => a.id.length > MAX_ACTION_ID_CHARS)) throw choices(`a choice id is over ${MAX_ACTION_ID_CHARS} characters`);
  if (actions.some((a) => a.label.length > MAX_ACTION_LABEL_CHARS)) throw choices(`a choice label is over ${MAX_ACTION_LABEL_CHARS} characters`);
};

/** The `code` of the errors above that a shorter choice list fixes. */
export const ASK_CHOICES_CODE = 'ask-choices-over-limits';

/** Named keys inside a sealed command: non-empty strings only, like the socket path's
 * `isKeyList` — the listener allowlists the names. */
const sealedKeys = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((item): item is string => typeof item === 'string')) return undefined;
  return [...value];
};

const fileMetas = (value: unknown): SealedFileMeta[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const metas: SealedFileMeta[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    if (!('iv' in item) || !('name' in item) || !('type' in item) || !('size' in item)) return undefined;
    const { iv, name, type, size } = item;
    if (typeof iv !== 'string' || typeof name !== 'string' || typeof type !== 'string' || typeof size !== 'number') return undefined;
    const chunk = 'chunk' in item ? item.chunk : undefined;
    if (chunk !== undefined && typeof chunk !== 'number') return undefined;
    metas.push(chunk === undefined ? { iv, name, type, size } : { iv, name, type, size, chunk });
  }
  return metas;
};

const commandLabel = (value: unknown): SealedCommandLabel | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('n' in value) || !('session' in value) || !('device' in value)) return undefined;
  const { n, session, device } = value;
  if (typeof n !== 'number' || typeof session !== 'string' || typeof device !== 'string') return undefined;
  if (!('from' in value) || value.from === undefined) return { n, session, device };
  if (typeof value.from !== 'string') return undefined;
  return { n, session, device, from: value.from };
};

const askActions = (value: unknown): SealedAskAction[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_ASK_ACTIONS) return undefined;
  const actions: SealedAskAction[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('label' in item)) return undefined;
    const { id, label } = item;
    if (typeof id !== 'string' || id.length > MAX_ACTION_ID_CHARS) return undefined;
    if (typeof label !== 'string' || label.length > MAX_ACTION_LABEL_CHARS) return undefined;
    if (!('style' in item) || item.style === undefined) {
      actions.push({ id, label });
      continue;
    }
    if (typeof item.style !== 'string') return undefined;
    actions.push({ id, label, style: item.style });
  }
  return actions;
};

const askLabel = (value: unknown): SealedAskLabel | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('id' in value) || !('device' in value)) return undefined;
  const { id, device } = value;
  if (typeof id !== 'string' || typeof device !== 'string') return undefined;
  if (id === '' || id.length > MAX_ASK_ID_CHARS || !ASK_DEVICE_ID.test(device)) return undefined;
  const label: SealedAskLabel = { id, device };
  if ('actions' in value && value.actions !== undefined) {
    const actions = askActions(value.actions);
    if (!actions) return undefined;
    label.actions = actions;
  }
  if ('placeholder' in value && value.placeholder !== undefined) {
    if (typeof value.placeholder !== 'string') return undefined;
    label.placeholder = value.placeholder;
  }
  return label;
};

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const contextFile = (value: unknown): SealedAskContext['listed'][number] | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { path, status, added, removed } = value as Record<string, unknown>;
  const binary = (value as Record<string, unknown>).binary;
  if (typeof path !== 'string' || path === '' || Buffer.byteLength(path) > MAX_CONTEXT_PATH_BYTES) return undefined;
  if (status !== 'M' && status !== 'A' && status !== 'D' && status !== '?') return undefined;
  const a = count(added);
  const r = count(removed);
  if (a === undefined || r === undefined) return undefined;
  if (binary === undefined) return { path, status, added: a, removed: r };
  return binary === true ? { path, status, added: a, removed: r, binary } : undefined;
};

/** The `context` summary of a sealed question, or `undefined` when it is absent or not well formed (the question still opens without it). */
const askContext = (value: unknown): SealedAskContext | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.diff !== 'ok' && v.diff !== 'no_repo' && v.diff !== 'failed') return undefined;
  const files = count(v.files);
  const added = count(v.added);
  const removed = count(v.removed);
  const moreFiles = count(v.moreFiles);
  const screenLines = count(v.screenLines);
  const masked = count(v.masked);
  if (files === undefined || added === undefined || removed === undefined) return undefined;
  if (moreFiles === undefined || screenLines === undefined || masked === undefined) return undefined;
  if (!Array.isArray(v.listed) || v.listed.length > MAX_CONTEXT_LISTED) return undefined;
  const listed: SealedAskContext['listed'] = [];
  for (const item of v.listed) {
    const file = contextFile(item);
    if (!file) return undefined;
    listed.push(file);
  }
  const cut = v.cut as Record<string, unknown> | null | undefined;
  if (typeof cut !== 'object' || cut === null || typeof cut.diff !== 'boolean' || typeof cut.screen !== 'boolean') return undefined;
  return { diff: v.diff, files, added, removed, listed, moreFiles, screenLines, masked, cut: { diff: cut.diff, screen: cut.screen } };
};

const answerLabel = (value: unknown): SealedAnswerLabel | undefined => {
  if (typeof value !== 'object' || value === null || !('ask' in value)) return undefined;
  if (typeof value.ask !== 'string' || value.ask === '' || value.ask.length > MAX_ASK_ID_CHARS) return undefined;
  const label: SealedAnswerLabel = { ask: value.ask };
  if ('actionId' in value && value.actionId !== undefined) {
    if (typeof value.actionId !== 'string') return undefined;
    label.actionId = value.actionId;
  }
  if ('exit' in value && value.exit !== undefined) {
    if (value.exit !== true) return undefined;
    label.exit = true;
  }
  return label;
};

/**
 * Decrypt a push body sealed by `encryptPushBodyForDevices` (any client's
 * twin of it) for this device: `body` is the JSON `{ ciphertext, iv }`
 * envelope, the message key comes out of this device's `deviceKeyMap` slot.
 * Returns the `{ title, body, url }` the sender put in, the `cmd` label of a
 * sealed command, the `ask` / `answer` label of a sealed question / answer and
 * the `files` list, the sealed `keys` / `ifPrompt` of a blocked-prompt answer,
 * and the `context` summary — each only when well formed. `context` is read from any body;
 * whether it belongs there (a question) is the caller's to decide.
 */
export const decryptPushBodyForDevice = async (
  body: string,
  entryJson: string,
  senderPublicKeyRaw: string,
): Promise<{
  title?: string;
  body?: string;
  url?: string;
  cmd?: SealedCommandLabel;
  ask?: SealedAskLabel;
  answer?: SealedAnswerLabel;
  files?: SealedFileMeta[];
  keys?: string[];
  ifPrompt?: string;
  /** A schedule request inside a sealed command (F8); its fields are the listener's to check. */
  schedule?: Record<string, unknown>;
  context?: SealedAskContext;
}> => {
  const envelope = JSON.parse(body) as { ciphertext?: unknown; iv?: unknown };
  if (typeof envelope.ciphertext !== 'string' || typeof envelope.iv !== 'string') {
    throw new Error('push body is not a { ciphertext, iv } envelope');
  }
  const rawKey = await unwrapDeviceKeyRaw(entryJson, senderPublicKeyRaw);
  const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(envelope.iv)) },
    messageKey,
    fromBase64(envelope.ciphertext),
  );
  // A SyntaxError from JSON.parse quotes the start of the text it could not read, and this text
  // is authenticated plaintext: the message must not carry it. Same for the TypeError of `null`.
  let parsed: { title?: unknown; body?: unknown; url?: unknown; cmd?: unknown; ask?: unknown; answer?: unknown; files?: unknown; keys?: unknown; ifPrompt?: unknown; schedule?: unknown; context?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as typeof parsed;
  } catch {
    throw new Error('sealed body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('sealed body is not a JSON object');
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const plainObject = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  return { title: str(parsed.title), body: str(parsed.body), url: str(parsed.url), cmd: commandLabel(parsed.cmd), ask: askLabel(parsed.ask), answer: answerLabel(parsed.answer), files: fileMetas(parsed.files), keys: sealedKeys(parsed.keys), ifPrompt: str(parsed.ifPrompt), schedule: plainObject(parsed.schedule), context: askContext(parsed.context) };
};

// ─── Envelope v2 (live path) ───
//
// One message sealed for one peer device, for one purpose:
//
//   key = HKDF-SHA256(ikm = ECDH x-coordinate, salt = 32 random bytes,
//                     info = "hwip/e2e/v2/" + purpose)
//   aad = "hwip/e2e/v2\n" + purpose + "\n" ‖ sender point ‖ recipient point ‖ context
//   ciphertext = AES-256-GCM(key, iv = 12 random bytes, aad)
//
// The purpose is in the key and the AAD, so a frame cannot be opened as input
// (or as anything else this pair seals). Both public keys are in the AAD in
// send → receive order, as X9.63 points: the same ECDH secret serves both
// directions, and the order is what stops a relay handing a message back to
// the side that sealed it under the peer's name. `context` is whatever the
// caller pins the message to (a session name) — it has to match on open.
//
// The live envelope before it (v1, removed in M5) used the raw ECDH secret as
// the AES key with no AAD, and an app still tells it apart to say "update hwip".

export type SealPurpose =
  | 'stream.frame'
  | 'stream.input'
  | 'stream.alive'
  | 'stream.started'
  | 'screen.snapshot'
  | 'screen.history'
  | 'session.diff'
  | 'schedule.list'
  | 'turn.batch';

export interface SealedV2 {
  v: 2;
  /** Base64, 32 bytes — the HKDF salt, fresh per message. */
  salt: string;
  /** Base64, 12 bytes. */
  iv: string;
  /** Base64 ciphertext ‖ 16-byte tag. */
  ciphertext: string;
  /** Base64 SPKI of the sealing device. Covered by the seal (AAD). */
  senderPublicKey: string;
}

const V2_LABEL = 'hwip/e2e/v2';
const V2_SALT_BYTES = 32;
const V2_IV_BYTES = 12;

/** Every field of a v2 envelope is relay JSON: check the shape before any of
 *  it reaches WebCrypto, so a malformed one is a refusal and not a throw from
 *  inside a Base64 decode. */
export const isSealedV2 = (value: unknown): value is SealedV2 =>
  typeof value === 'object' && value !== null
  && 'v' in value && value.v === 2
  && 'salt' in value && typeof value.salt === 'string'
  && 'iv' in value && typeof value.iv === 'string'
  && 'ciphertext' in value && typeof value.ciphertext === 'string'
  && 'senderPublicKey' in value && typeof value.senderPublicKey === 'string';

/** DER header of a P-256 SPKI whose key is an uncompressed point; the 65-byte
 *  X9.63 point follows it. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const P256_POINT_BYTES = 65;

/**
 * The X9.63 point of a device public key, or null when the string is not
 * spelled as one. Only the spelling is checked: whether the 65 bytes are a
 * point on the curve is left to the key import that follows, which is where
 * `sealV2` and `openV2` reject one that is not.
 *
 * A device key has exactly one spelling here: standard padded Base64 of the
 * 91-byte SPKI with an uncompressed point — what WebCrypto's
 * `exportKey('spki')` and the app's CryptoKit `derRepresentation` both write.
 * The same key spelled another way (a compressed point, unpadded Base64) is
 * refused rather than normalised. With one spelling, two keys are the same
 * exactly when their strings are, here and in the app, which cannot read the
 * compressed form at all.
 */
export const publicKeyPoint = (spkiBase64: string): Buffer | null => {
  const der = Buffer.from(spkiBase64, 'base64');
  const isDeviceKey = der.length === P256_SPKI_PREFIX.length + P256_POINT_BYTES
    && der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)
    // 0x04 = uncompressed. Node also imports the hybrid forms (0x06, 0x07) of
    // the same point, which the app does not.
    && der[P256_SPKI_PREFIX.length] === 0x04
    && der.toString('base64') === spkiBase64;
  return isDeviceKey ? der.subarray(P256_SPKI_PREFIX.length) : null;
};

/**
 * Who a sealed message is from, as far as a replay check can tell: the x
 * coordinate of the sender's point, in hex (null for a string that is not a
 * device key). A sealed push opens from the ECDH x coordinate alone — the
 * secret is the same for a point and its mirror (x, p − y) — so a relay can
 * hand the same box to the listener under the mirrored key without the
 * phone's secret. The string of that key is another one, the sender is not.
 * Pins and fingerprints still compare the whole key; only the question "have
 * I taken this number from this sender" asks for x.
 */
export const publicKeySender = (spkiBase64: string): string | null => {
  const point = publicKeyPoint(spkiBase64);
  return point ? point.subarray(1, 33).toString('hex') : null;
};

/** Whether two strings are the same device public key. A string that is not
 *  in the one spelling `publicKeyPoint` takes equals nothing, itself included. */
export const samePublicKey = (a: string, b: string): boolean => a === b && publicKeyPoint(a) !== null;

/**
 * A device public key as something two people can compare: the first 16 bytes
 * of SHA-256 over its X9.63 point, as eight groups of four hex digits. The app
 * prints the same string for the same key (`Envelope.fingerprint`), which is
 * the point — `hwip trust` on this side, the device screen on that one. null
 * for a string that is not a device key.
 */
export const keyFingerprint = (spkiBase64: string): string | null => {
  const point = publicKeyPoint(spkiBase64);
  if (!point) return null;
  const digest = createHash('sha256').update(point).digest('hex').slice(0, 32);
  return Array.from({ length: 8 }, (_, group) => digest.slice(group * 4, group * 4 + 4)).join(' ');
};

interface V2Peer {
  point: Uint8Array;
  /** The ECDH secret as an HKDF base key. */
  secret: CryptoKey;
}

// A listener seals for whoever watches its panes: a few phones at most. The
// cap only stops a relay cycling made-up sender keys from growing this forever.
const V2_PEER_CACHE_MAX = 8;
const v2Peers = new Map<string, V2Peer>();
let devicePoint: Uint8Array | null = null;

const v2PeerFor = async (spkiBase64: string, privateKey: CryptoKey): Promise<V2Peer> => {
  const cached = v2Peers.get(spkiBase64);
  if (cached) return cached;
  const point = publicKeyPoint(spkiBase64);
  if (!point) throw new Error('not a device public key');
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(spkiBase64) }, privateKey, 256);
  const peer: V2Peer = { point, secret: await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']) };
  const oldest = v2Peers.keys().next();
  if (v2Peers.size >= V2_PEER_CACHE_MAX && !oldest.done) v2Peers.delete(oldest.value);
  v2Peers.set(spkiBase64, peer);
  return peer;
};

const v2MessageKey = (secret: CryptoKey, salt: Uint8Array<ArrayBuffer>, purpose: SealPurpose): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`${V2_LABEL}/${purpose}`) },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

const v2Aad = (purpose: SealPurpose, sender: Uint8Array, recipient: Uint8Array, context: string): Uint8Array<ArrayBuffer> => {
  const head = new TextEncoder().encode(`${V2_LABEL}\n${purpose}\n`);
  const tail = new TextEncoder().encode(context);
  const aad = new Uint8Array(head.length + sender.length + recipient.length + tail.length);
  aad.set(head);
  aad.set(sender, head.length);
  aad.set(recipient, head.length + sender.length);
  aad.set(tail, head.length + sender.length + recipient.length);
  return aad;
};

const v2Self = (): { privateKey: CryptoKey; publicKey: string; point: Uint8Array } => {
  if (!deviceKeyPair || !deviceExportedPublicKey) throw new Error('Device crypto not initialized');
  devicePoint ??= publicKeyPoint(deviceExportedPublicKey);
  if (!devicePoint) throw new Error('this device\'s stored public key is not a device public key');
  return { privateKey: deviceKeyPair.privateKey, publicKey: deviceExportedPublicKey, point: devicePoint };
};

/**
 * Seal `plaintext` for one recipient device, for one purpose. Requires
 * initDeviceCrypto().
 */
export const sealV2 = async (
  purpose: SealPurpose,
  plaintext: string,
  recipientPublicKey: string,
  context = '',
): Promise<SealedV2> => {
  const self = v2Self();
  const peer = await v2PeerFor(recipientPublicKey, self.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(V2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(V2_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: v2Aad(purpose, self.point, peer.point, context) },
    await v2MessageKey(peer.secret, salt, purpose),
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 2,
    salt: toBase64(salt.buffer),
    iv: toBase64(iv.buffer),
    ciphertext: toBase64(ciphertext),
    senderPublicKey: self.publicKey,
  };
};

/**
 * Open a v2 envelope addressed to this device.
 *
 * Rejects rather than returning null, like every open here: a throw means the
 * envelope was sealed by another key than `expectedSender`, for another
 * device, purpose or context, was tampered with, or is not a v2 envelope.
 *
 * `expectedSender` is not optional: opening alone proves only that the sender
 * holds the private half of `senderPublicKey`, and anyone can mint a keypair.
 * Every caller knows who it is talking to; naming that key here is what turns
 * "it opened" into "the peer sent it". Requires initDeviceCrypto().
 */
export const openV2 = async (
  purpose: SealPurpose,
  envelope: SealedV2,
  expectedSender: string,
  context = '',
): Promise<string> => {
  if (!isSealedV2(envelope)) throw new Error('not a v2 envelope');
  if (!samePublicKey(envelope.senderPublicKey, expectedSender)) {
    throw new Error('envelope not sealed by the expected key');
  }
  const salt = new Uint8Array(fromBase64(envelope.salt));
  const iv = new Uint8Array(fromBase64(envelope.iv));
  if (salt.length !== V2_SALT_BYTES || iv.length !== V2_IV_BYTES) throw new Error('v2 envelope salt or iv has the wrong length');
  const self = v2Self();
  const peer = await v2PeerFor(envelope.senderPublicKey, self.privateKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: v2Aad(purpose, peer.point, self.point, context) },
    await v2MessageKey(peer.secret, salt, purpose),
    fromBase64(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
};
