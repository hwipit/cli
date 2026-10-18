/**
 * `hwip agent send` (F2): the message goes to the target listener inside a push-v1 envelope, so the
 * server relays it and reads nothing of what is typed into the other session.
 *
 * Every message is sealed, as every `hwip ask` question is (ask-seal.ts): when that cannot be done it is refused, never sent
 * in the clear. No phone app is needed — the target is a computer.
 *
 * The receiving listener takes a command only from a device whose key it can check, and the server stamps a send made with
 * an API key `api_<keyId>`, which names no machine. So the sealed label carries `from`, this machine's device id; the listener
 * admits it by the key the account lists for that id and the one it pinned.
 *
 * Who reads the message is the account's device list: the target's slot is the listener's own, and every other listed device
 * that has a key (a phone's bubble opens) gets one. Each device on the list is pinned on the way (`trust-pins.ts`), the target
 * included, so no `hwip trust` comes first; a key that changed replaces its pin with one warning.
 *
 * Nothing here logs or returns a decrypt or encrypt error's message.
 */

import { encryptPushBodyForDevices, samePublicKey, selectRecipients, type DeviceRecipient, type PushBodyInput } from './crypto.js';
import { type AskSealDeps, type SealedFields } from './ask-seal.js';
import { nextCommandNumber, type CommandSeqRefusal } from './command-seq.js';
import { observeDevices } from './trust-pins.js';
import { ensureSelfListed, unregisteredText, type RegisterWhy } from './self-register.js';

export type CommandSealDeps = Pick<AskSealDeps, 'loadKeys' | 'self' | 'listDevices' | 'register' | 'trustPath' | 'warn'> & {
    /** The next command number from the counter every sender on this machine shares. */
    nextNumber?: () => Promise<number | { refused: CommandSeqRefusal }>;
    seal?: (content: PushBodyInput, recipients: DeviceRecipient[]) => Promise<SealedFields & { isEncrypted: true }>;
};

export type CommandRefusal =
    | 'keystore'
    | 'devices'
    | 'self-unlisted'
    | 'target-unlisted'
    | 'number-locked'
    | 'number-unusable'
    | 'encrypt';

export const COMMAND_REFUSAL_TEXT: Record<CommandRefusal, string> = {
    'keystore': 'this machine\'s encryption keys did not load; the message was not sent',
    'devices': 'the device list could not be fetched; the message was not sent',
    'self-unlisted': unregisteredText('message'),
    'target-unlisted': 'the target computer is not in the account\'s device list with a key (run `hwip listener` on it once); the message was not sent',
    'number-locked': 'another hwip process holds ~/.hwip/command-seq.lock; try again in a moment (the message was not sent)',
    'number-unusable': 'the command counter ~/.hwip/command-seq cannot be read or written; the message was not sent',
    'encrypt': 'sealing the message failed; the message was not sent',
};

export const commandRefusalMessage = (cause: CommandRefusal, why?: RegisterWhy): string =>
    `sealed send: ${cause === 'self-unlisted' ? unregisteredText('message', why) : COMMAND_REFUSAL_TEXT[cause]}`;

/** What `POST /pushes/send` gets for an `agent.command`: the sealed fields and no text at all. */
export type AgentCommandPayload = { targetDeviceId: string; agentSessionName: string; isEncrypted: true } & SealedFields;

export type PreparedCommand =
    | { kind: 'sealed'; fields: SealedFields }
    | { kind: 'refused'; cause: CommandRefusal; why?: RegisterWhy };

/**
 * Seal `message` for `session` on `targetDeviceId`.
 * The caller sends `sealed` with the returned fields (body, key, slots) and tells the user of `refused` without sending.
 */
export const sealedCommand = async (
    command: { targetDeviceId: string; session: string; message: string },
    deps: CommandSealDeps,
): Promise<PreparedCommand> => {
    try {
        await deps.loadKeys();
    } catch {
        return { kind: 'refused', cause: 'keystore' };
    }
    const self = deps.self();
    if (!self) return { kind: 'refused', cause: 'keystore' };

    let devices: { deviceId: string; publicKey?: string }[];
    try {
        devices = await deps.listDevices();
        if (!Array.isArray(devices)) throw new Error('not a list');
    } catch {
        return { kind: 'refused', cause: 'devices' };
    }
    // The listener admits this machine by the key the list holds for it: one missing or under another key is put there first.
    const listing = await ensureSelfListed(devices, self, deps.register);
    if (!listing.ok) return { kind: 'refused', cause: 'self-unlisted', why: listing.why };
    devices = listing.devices;

    observeDevices(deps.trustPath, devices, { selfId: self.deviceId, warn: deps.warn ?? (() => undefined) });

    // The target's slot is the listener's own; this computer's key is its own. Everything else the list holds with a key reads too.
    const targetKey = command.targetDeviceId === self.deviceId ? self.publicKey : devices.find((d) => d.deviceId === command.targetDeviceId)?.publicKey;
    if (!targetKey || !samePublicKey(targetKey, targetKey)) return { kind: 'refused', cause: 'target-unlisted' };
    const readers = selectRecipients(devices).filter((d) => d.deviceId !== self.deviceId && d.deviceId !== command.targetDeviceId);
    const recipients: DeviceRecipient[] = [{ deviceId: command.targetDeviceId, publicKey: targetKey }, ...readers];

    const n = await (deps.nextNumber ?? (() => nextCommandNumber()))();
    if (typeof n !== 'number') return { kind: 'refused', cause: n.refused === 'lock' ? 'number-locked' : 'number-unusable' };

    try {
        const sealed = await (deps.seal ?? encryptPushBodyForDevices)(
            { body: command.message, cmd: { n, session: command.session, device: command.targetDeviceId, from: self.deviceId } },
            recipients,
        );
        // A recipient whose key would not import is skipped by the sealer: the send must not go without the target's slot.
        if (!sealed.deviceKeyMap[command.targetDeviceId]) return { kind: 'refused', cause: 'encrypt' };
        return {
            kind: 'sealed',
            fields: { body: sealed.body, senderPublicKey: sealed.senderPublicKey, deviceKeyMap: sealed.deviceKeyMap },
        };
    } catch {
        return { kind: 'refused', cause: 'encrypt' };
    }
};
