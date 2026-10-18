/**
 * Pinning the account's devices as a sender sees them.
 *
 * `hwip notify`, `hwip ask`, `hwip agent send`, the listener's recorders and the MCP server all read `GET /devices`
 * before they seal. Every device that lists a key is pinned the first time it is seen, and a pin whose device now
 * lists another key is replaced — with one warning, because a key that changed is also what a relay swapping the
 * list looks like, and a record (`key-changes.ts`) a person is shown later, since the warning often reaches nobody. Nothing here decides who is sealed for: the list does, the pins are what the listener holds a
 * request against (`subscriber-trust.ts`) and what a person compares with `hwip trust`.
 */

import { DEVICE_ID, planPin, readTrustState, withPin, writeTrustState, type TrustState } from './subscriber-trust.js';
import { recordKeyChanges } from './key-changes.js';
import { withTrustLock } from './trust-lock.js';

export interface ObservedDevice {
    deviceId: string;
    publicKey?: string;
    /** The name the account lists it under, for the key-change record. */
    nickname?: string;
}

export interface ObserveOptions {
    /** This computer's own device id: it never pins itself. */
    selfId?: string;
    now?: () => Date;
    /** One line for a person; the caller adds its own prefix. */
    warn: (line: string) => void;
}

export interface Observed {
    /** Devices pinned for the first time. */
    pinned: string[];
    /** Devices whose pin was replaced by the key they list now — or would have been, when the status is not `ok`. */
    replaced: string[];
    /** Devices not pinned: their key is pinned for another id, or the cap is reached. */
    skipped: string[];
    /**
     * `unreadable`: the trust file cannot be read, nothing was checked or written. `unlocked`: another process held
     * the file, or it could not be written; nothing was written. A send goes on in both cases.
     */
    status: 'ok' | 'unreadable' | 'unlocked';
}

interface Changes {
    state: TrustState;
    pinned: string[];
    replaced: string[];
    skipped: string[];
}

const apply = (from: TrustState, devices: ObservedDevice[], selfId: string | undefined, at: Date): Changes => {
    const changes: Changes = { state: from, pinned: [], replaced: [], skipped: [] };
    for (const { deviceId, publicKey } of devices) {
        if (!publicKey || deviceId === selfId || !DEVICE_ID.test(deviceId)) continue;
        const plan = planPin(changes.state, deviceId, publicKey);
        if (plan === 'same') continue;
        if (plan === 'in-use' || plan === 'cap') {
            changes.skipped.push(deviceId);
            continue;
        }
        changes.state = withPin(changes.state, deviceId, publicKey, at);
        (plan === 'new' ? changes.pinned : changes.replaced).push(deviceId);
    }
    return changes;
};

const unchanged = (c: Changes): boolean => c.pinned.length === 0 && c.replaced.length === 0;

export const observeDevices = (path: string, devices: ObservedDevice[], opts: ObserveOptions): Observed => {
    const now = opts.now ?? (() => new Date());
    const quick = readTrustState(path);
    if ('broken' in quick) {
        opts.warn('trust: the trust file is unreadable — pins not checked');
        return { pinned: [], replaced: [], skipped: [], status: 'unreadable' };
    }
    const first = apply(quick.state, devices, opts.selfId, now());
    // The usual send changes nothing: no lock, no write.
    if (unchanged(first)) return { pinned: [], replaced: [], skipped: first.skipped, status: 'ok' };

    // Not written: the send goes on with the key the list holds, and a changed key is still said here, since no record will.
    const notWritten = (status: 'unreadable' | 'unlocked'): Observed => {
        for (const deviceId of first.replaced) opts.warn(`trust: ${deviceId} changed its key — could not record the new pin`);
        return { pinned: [], replaced: first.replaced, skipped: [], status };
    };
    let recorded = true;
    try {
        // Read again under the lock: the listener or another send may have pinned meanwhile.
        const done = withTrustLock(path, () => {
            const latest = readTrustState(path);
            if ('broken' in latest) return null;
            const at = now();
            const changes = apply(latest.state, devices, opts.selfId, at);
            if (unchanged(changes)) return changes;
            writeTrustState(path, changes.state);
            // In the same section as the pin: a process that sees the new key as `same` next has nothing left to say it.
            const names = new Map(devices.map((d) => [d.deviceId, d.nickname]));
            recorded = recordKeyChanges(path, changes.replaced.map((deviceId) => ({ deviceId, at: at.toISOString(), name: names.get(deviceId) })));
            return changes;
        });
        if (!done.locked || done.value === null) return notWritten(done.locked ? 'unreadable' : 'unlocked');
        for (const deviceId of done.value.replaced) opts.warn(`trust: ${deviceId} changed its key — now pinned to the new one`);
        if (!recorded) opts.warn('trust: could not save that key change for later (key-changes.json) — this line is the only notice');
        const { pinned, replaced, skipped } = done.value;
        return { pinned, replaced, skipped, status: 'ok' };
    } catch {
        // A full disk, a folder that is not ours: the send does not depend on the pin.
        return notWritten('unlocked');
    }
};
