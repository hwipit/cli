/**
 * `hwip ask` (F1): the question goes to the phone inside a push-v1 envelope and the
 * answer comes back in one, so the server relays both and reads neither.
 *
 * Every question is sealed. When that cannot be done — no keys, no device list, no phone app signed in,
 * no device with a key — it is refused, never sent in the clear. Who reads it is the account's device list;
 * each device on it is pinned on the way (`trust-pins.ts`), and a key that changed replaces its pin with one warning.
 *
 * What the server still sees of a sealed question: each choice's `id`, the timeout, the session routing fields and which device answered,
 * and that it has one attachment of a fixed name, type and size (`ask-context-attach.ts`) — or none, when that attachment could not be stored or would take the envelope over the server's limit.
 * Not the title, the body, the wording of the choices, the answer, or whether the attachment holds anything.
 *
 * Nothing here logs or returns a decrypt error's message: the plaintext of an
 * authenticated envelope can end up in one, and a refusal says only which step failed.
 */

import { randomBytes } from 'node:crypto';
import {
    ASK_CHOICES_CODE,
    decryptPushBodyForDevice,
    encryptPushBodyForDevices,
    isAppDevice,
    samePublicKey,
    selectRecipients,
    type DeviceRecipient,
    type PushBodyInput,
    type SealedAskContext,
    type SealedFileMeta,
} from './crypto.js';
import { peerKeyOf } from './peer-key.js';
import { observeDevices } from './trust-pins.js';
import { ensureSelfListed, unregisteredText, type Register, type RegisterWhy } from './self-register.js';
import { isConfigFailure } from './http-failure.js';

export interface AskQuestion {
    title: string;
    body?: string;
    actions?: { id: string; label: string }[];
}

/** A sealed envelope as the trigger and the respond route carry it. */
export interface SealedFields {
    body: string;
    senderPublicKey: string;
    deviceKeyMap: Record<string, string>;
}

/** What `GET /devices` says of a device that the seal needs: `type` is the kind of client (`ios`, `android`, `cli`, …). */
type DeviceEntry = { deviceId: string; publicKey?: string; type?: string };

/** One sealed attachment as the trigger carries it: everything in it but the wrapped keys is in the server's view. */
export interface AskWireFile {
    fileKey: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
}

/** What a sealed question carries of its session (F3, `ask-context-attach.ts`). */
export interface AskAttachment {
    /** The summary for the sealed body; left out when there is no context (the attachment is there all the same). */
    context?: SealedAskContext;
    /** How the sealed body names the attachment. */
    meta: SealedFileMeta;
    file: AskWireFile;
}

/** The longest envelope the server takes as a sealed question's `body` (hwip `server/src/lib/push-input.ts` MAX_ASK_BODY_BYTES). */
const ASK_BODY_MAX_BYTES = 48 * 1024;

export interface AskSealDeps {
    /** Load this machine's device keys; throws when they cannot be had. */
    loadKeys: () => Promise<void>;
    /** This machine as a device of the account, once its keys are loaded. */
    self: () => { deviceId: string; publicKey: string } | null;
    /** `GET /devices`; throws when the list cannot be fetched. */
    listDevices: () => Promise<DeviceEntry[]>;
    /** Put this machine's key on the account's device list when the list lacks it (`self-register.ts`). */
    register: Register;
    /** The listener's state file, where devices are pinned. */
    trustPath: string;
    /** One line for a person: a pin replaced because the device lists another key, this machine's key not registered, or — from `ask.ts` — a question that went up unconfirmed or stays on record. The caller adds its prefix. */
    warn?: (line: string) => void;
    seal?: (content: PushBodyInput, recipients: DeviceRecipient[]) => Promise<SealedFields & { isEncrypted: true }>;
    open?: typeof decryptPushBodyForDevice;
    /** A fresh 128-bit id, URL-safe. */
    newAskId?: () => string;
    /**
     * Uploads the context attachment sealed for `recipients`. Called only for a question that is being sealed,
     * once who may read it is known; when it throws, the question goes out without an attachment.
     */
    attach?: (recipients: DeviceRecipient[]) => Promise<AskAttachment>;
}

export type AskRefusal =
    | 'keystore'
    | 'devices'
    | 'no-app'
    | 'self-unlisted'
    | 'no-recipients'
    | 'too-large'
    | 'encrypt'
    | 'not-sealed'
    | 'peer-unlisted'
    | 'peer-unusable'
    | 'sender-mismatch'
    | 'no-slot'
    | 'unreadable'
    | 'wrong-labels'
    | 'unknown-action'
    | 'empty-answer';

const REFUSAL_TEXT: Record<AskRefusal, string> = {
    'keystore': 'this machine\'s encryption keys did not load; the question was not sent',
    'devices': 'the device list could not be fetched; the question was not sent',
    'no-app': 'no app is signed in to this account: sign in to the Hwip app on an iPhone or Android phone, then send again; the question was not sent',
    'self-unlisted': unregisteredText('question'),
    'no-recipients': 'no device has a key to seal the question for; the question was not sent',
    'too-large': 'a choice id is over 64 characters, a choice label over 100, or there are more than 10 choices; shorten them (the question was not sent)',
    'encrypt': 'sealing the question failed; the question was not sent',
    'not-sealed': 'the answer to a sealed question was not sealed; ignored',
    'peer-unlisted': 'the answer came from a device the account does not list; ignored',
    'peer-unusable': 'the answering device could not be checked (device list); ignored',
    'sender-mismatch': 'the answer was sealed with a key other than the answering device\'s; ignored',
    'no-slot': 'the answer was not sealed for this machine; ignored',
    'unreadable': 'the answer could not be opened; ignored',
    'wrong-labels': 'the answer does not belong to this question; ignored',
    'unknown-action': 'the answer names a choice that was not offered; ignored',
    'empty-answer': 'the answer holds no choice and no text; ignored',
};

export const refusalMessage = (cause: AskRefusal, why?: RegisterWhy, detail?: string): string =>
    detail ?? `sealed ask: ${cause === 'self-unlisted' ? unregisteredText('question', why) : REFUSAL_TEXT[cause]}`;

export type PreparedAsk =
    | { kind: 'sealed'; askId: string; fields: SealedFields; offered: string[] | undefined; files?: AskWireFile[] }
    | { kind: 'refused'; cause: AskRefusal; why?: RegisterWhy; detail?: string };

export type OpenedAnswer =
    /** `files` comes with the key that sealed them, which opens each file's slot (answer-files.ts). */
    | { ok: true; actionId?: string; value?: string; exit?: true; files?: SealedFileMeta[]; senderPublicKey?: string }
    | { ok: false; cause: AskRefusal };

const defaultAskId = (): string => randomBytes(16).toString('base64url');

export const prepareAsk = async (question: AskQuestion, deps: AskSealDeps): Promise<PreparedAsk> => {
    try {
        await deps.loadKeys();
    } catch {
        return { kind: 'refused', cause: 'keystore' };
    }
    const self = deps.self();
    if (!self) return { kind: 'refused', cause: 'keystore' };

    let devices: DeviceEntry[];
    try {
        devices = await deps.listDevices();
        if (!Array.isArray(devices)) throw new Error('not a list');
    } catch (err) {
        // A failure from the configuration (bad key, bad base URL) is said as it is: retrying the
        // question or checking the devices would not fix it, and the generic "device list" line hides it.
        if (isConfigFailure(err)) return { kind: 'refused', cause: 'devices', detail: err instanceof Error ? err.message : String(err) };
        return { kind: 'refused', cause: 'devices' };
    }
    // A question nobody can answer on a phone is not sent.
    if (!devices.some(isAppDevice)) return { kind: 'refused', cause: 'no-app' };
    // The phone seals its answer for the computer named in the question, by the key the same list holds for it: one
    // missing or under another key is put there first.
    const listing = await ensureSelfListed(devices, self, deps.register);
    if (!listing.ok) return { kind: 'refused', cause: 'self-unlisted', why: listing.why };
    devices = listing.devices;

    // Every device that lists a key is pinned and reads the question; a pin never takes a reader away.
    observeDevices(deps.trustPath, devices, { selfId: self.deviceId, warn: deps.warn ?? (() => undefined) });
    const recipients = selectRecipients(devices).filter((d) => d.deviceId !== self.deviceId);
    if (recipients.length === 0) return { kind: 'refused', cause: 'no-recipients' };

    // The context never stops a question: an approval gate that cannot attach still has to ask (the live `attach` says why on stderr).
    const attachment = deps.attach ? await deps.attach(recipients).catch(() => null) : null;

    const askId = (deps.newAskId ?? defaultAskId)();
    const actions = question.actions;
    const sealWith = (context: SealedAskContext | undefined, attached = attachment) => (deps.seal ?? encryptPushBodyForDevices)(
        {
            title: question.title,
            body: question.body,
            ask: { id: askId, device: self.deviceId, ...(actions ? { actions } : {}) },
            ...(attached ? { files: [attached.meta] } : {}),
            ...(context ? { context } : {}),
        },
        recipients,
    );
    try {
        let sealed = await sealWith(attachment?.context);
        // The server refuses a longer envelope whole: the summary goes before the question does, then the attachment's name.
        let attached = attachment;
        const over = () => attached !== null && Buffer.byteLength(sealed.body) > ASK_BODY_MAX_BYTES;
        if (over() && attached?.context) sealed = await sealWith(undefined);
        if (over()) {
            attached = null;
            sealed = await sealWith(undefined, null);
        }
        return {
            kind: 'sealed',
            askId,
            fields: { body: sealed.body, senderPublicKey: sealed.senderPublicKey, deviceKeyMap: sealed.deviceKeyMap },
            offered: actions?.map((a) => a.id),
            ...(attached ? { files: [attached.file] } : {}),
        };
    } catch (err) {
        // Only crypto.ts `assertAskWithinLimits` carries this code, for the choices alone; a test seals an over-limit choice for real.
        if (err instanceof Error && (err as { code?: unknown }).code === ASK_CHOICES_CODE) return { kind: 'refused', cause: 'too-large' };
        return { kind: 'refused', cause: 'encrypt' };
    }
};

const PEER_REFUSALS = {
    unlisted: 'peer-unlisted',
    devices_unavailable: 'peer-unusable',
} as const;

/**
 * Open the answer the phone sealed. It counts only when every step holds:
 * the answering device's key is believed (`peerKeyOf`: the account's device list, never
 * this machine's own key), the envelope was
 * sealed with exactly that key, it opens with this machine's slot, and it is
 * an `answer` for this question's id — and not a question or command label,
 * which would be the question envelope this machine sent, played back.
 */
export const openAnswer = async (
    response: { sealed?: unknown; respondedDeviceId?: unknown } | undefined,
    askId: string,
    offered: string[] | undefined,
    deps: AskSealDeps,
): Promise<OpenedAnswer> => {
    const sealed = response?.sealed;
    const from = response?.respondedDeviceId;
    if (!isSealedFields(sealed) || typeof from !== 'string') return { ok: false, cause: 'not-sealed' };

    const peer = await peerKeyOf(from, {
        registeredKey: async (id) => (await deps.listDevices()).find((d) => d.deviceId === id)?.publicKey ?? null,
        trustPath: deps.trustPath,
        selfId: deps.self()?.deviceId,
        warn: deps.warn,
    });
    if ('refused' in peer) return { ok: false, cause: PEER_REFUSALS[peer.refused] };
    if (!samePublicKey(peer.key, sealed.senderPublicKey)) return { ok: false, cause: 'sender-mismatch' };

    const self = deps.self();
    const slot = self ? sealed.deviceKeyMap[self.deviceId] : undefined;
    if (typeof slot !== 'string') return { ok: false, cause: 'no-slot' };

    let opened: Awaited<ReturnType<typeof decryptPushBodyForDevice>>;
    try {
        opened = await (deps.open ?? decryptPushBodyForDevice)(sealed.body, slot, sealed.senderPublicKey);
    } catch {
        return { ok: false, cause: 'unreadable' };
    }
    if (!opened.answer || opened.answer.ask !== askId || opened.ask || opened.cmd) return { ok: false, cause: 'wrong-labels' };

    const { actionId, exit } = opened.answer;
    if (actionId !== undefined && (offered === undefined || !offered.includes(actionId))) return { ok: false, cause: 'unknown-action' };
    // What the seal says each attached file is; the bytes come with the response's wire `files` (answer-files.ts).
    const files = opened.files?.length ? opened.files : undefined;
    if (actionId === undefined && !opened.body && exit !== true && !files) return { ok: false, cause: 'empty-answer' };
    return {
        ok: true,
        ...(actionId === undefined ? {} : { actionId }),
        ...(opened.body ? { value: opened.body } : {}),
        ...(exit === true ? { exit } : {}),
        ...(files ? { files, senderPublicKey: sealed.senderPublicKey } : {}),
    };
};

const isSealedFields = (value: unknown): value is SealedFields =>
    typeof value === 'object' && value !== null
    && 'body' in value && typeof value.body === 'string'
    && 'senderPublicKey' in value && typeof value.senderPublicKey === 'string'
    && 'deviceKeyMap' in value && typeof value.deviceKeyMap === 'object' && value.deviceKeyMap !== null;
