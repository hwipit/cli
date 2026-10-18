/**
 * Which key to believe for a device that signs something with its own key.
 *
 * An envelope that opens only shows its sender held *a* key (push v1 carries
 * the sender's public key unsigned), so the reader must say whose key it
 * expects. This answers that for one device id: the key the account's device
 * list registers for it. The device is pinned on the way (`observeDevices`) — a first
 * sight pins it, a key that changed replaces the pin with one warning and a record
 * (`key-changes.ts`). The pin is a record for a person (`hwip trust`) and for the
 * listener; it does not decide here, the list does.
 */

import { samePublicKey } from './crypto.js';
import { DEVICE_ID } from './subscriber-trust.js';
import { observeDevices } from './trust-pins.js';

export type PeerKeyRefusal =
    /** Not a device id, or not in the account's device list. */
    | 'unlisted'
    /** The device list could not be fetched. */
    | 'devices_unavailable';

export type PeerKey = { key: string } | { refused: PeerKeyRefusal };

export interface PeerKeyDeps {
    /** The key the account's device list registers for `deviceId`: null when none is listed, a rejection when the list cannot be had. */
    registeredKey: (deviceId: string) => Promise<string | null>;
    /** The listener's state file (`~/.hwip/trusted-devices.json`). */
    trustPath: string;
    /** This computer's own id: it never pins itself. */
    selfId?: string;
    /** One line for a person, as `observeDevices` words it. */
    warn?: (line: string) => void;
}

export const peerKeyOf = async (deviceId: string, deps: PeerKeyDeps): Promise<PeerKey> => {
    if (!DEVICE_ID.test(deviceId)) return { refused: 'unlisted' };

    let registered: string | null;
    try {
        registered = await deps.registeredKey(deviceId);
    } catch {
        return { refused: 'devices_unavailable' };
    }
    // A listed key that is no device key in the one spelling is as good as none.
    if (!registered || !samePublicKey(registered, registered)) return { refused: 'unlisted' };

    observeDevices(deps.trustPath, [{ deviceId, publicKey: registered }], { selfId: deps.selfId, warn: deps.warn ?? (() => undefined) });
    return { key: registered };
};
