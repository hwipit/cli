/**
 * Who this listener hands pane content to, and whether it still answers in
 * the clear.
 *
 * The relay is not trusted with either question. A viewer asks for sealed
 * content by sending a public key, and the relay can swap that key for its own
 * or strip it: the first would have this listener seal the pane for the relay,
 * the second would have it send the pane in the clear. So a key is taken only
 * when
 *
 *   • the account's device list holds it for the device the relay says is
 *     asking, and
 *   • it is pinned for that device: the key this listener saw for it the first
 *     time (trust on first use). A different key later (a reinstalled app) is
 *     pinned in place of the old one, with one line in the log and a record a
 *     person is shown later (`key-changes.ts`); nothing is refused for it.
 *
 * and once this listener pins any device it answers nobody in the clear
 * again. The pin is local and sticky on purpose: the relay can say anything.
 *
 * What this does not stop: a server that registers a brand-new device with its
 * own key is trusted on first use like any new phone. Comparing fingerprints
 * (`hwip trust`) is the check for that.
 *
 * State is one small file, read again whenever it changed, so `hwip trust` can
 * edit it beside a running daemon. Every write holds the lock in `trust-lock.ts`.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'path';
import { publicKeySender, samePublicKey } from './crypto.js';
import { recordKeyChanges, type KeyChange } from './key-changes.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { withTrustLock } from './trust-lock.js';

export type RefusalCode = 'e2ee_required' | 'subscriber_unverified' | 'subscriber_key_in_use';

/** What a requester gets: content sealed for a key, content in the clear, or nothing. */
export type Admission =
    | { kind: 'seal'; publicKey: string }
    | { kind: 'plain' }
    | { kind: 'refuse'; reason: RefusalCode };

export interface SubscriberTrustDeps {
    /** The state file (`~/.hwip/trusted-devices.json`). */
    path: string;
    /** The key the account's device list holds for a device; null when the
     *  device is not listed, has no key, or the list could not be read. */
    registeredKey: (deviceId: string) => Promise<string | null>;
    /** The name the account lists a device under, for the key-change record; undefined when the list does not say. */
    nameOf?: (deviceId: string) => Promise<string | undefined>;
    log: (msg: string) => void;
    now?: () => Date;
}

export interface SubscriberTrust {
    /** Decide how a request for pane content is answered. `publicKey` absent =
     *  the request asked for plaintext. Never rejects. */
    admit: (requester: { deviceId?: string; publicKey?: string }) => Promise<Admission>;
    /** Whether plaintext is refused from here on: this listener pins a device (or its file cannot be read). */
    sealedOnly: () => boolean;
    /** Take sealed command number `n` from `deviceId`: only above the last one
     *  taken from it, and only once it is on disk — a command the relay sends
     *  again, before or after a restart, is refused. False refuses. The
     *  numbers taken from the sender's `publicKey` under any id count too
     *  (`publicKeySender`): the id is the relay's stamp, the key is not. The
     *  key must be a device key. */
    acceptCommand: (deviceId: string, n: number, publicKey: string) => boolean;
}

export interface PinnedDevice {
    publicKey: string;
    pinnedAt: string;
}

export interface TrustState {
    /** deviceId → the key pinned for it. */
    devices: Map<string, PinnedDevice>;
    /** deviceId → the last sealed command number taken from it (M5 D8). Kept
     *  through `hwip trust` and `--reset`: forgetting it would let an old
     *  command be typed again. */
    commands: Map<string, number>;
    /** sender → the largest command number taken from it, where the sender is `publicKeySender` of the key it sealed
     *  with (x coordinate in hex). Beside `commands`, never overwritten by it: the id is the relay's stamp and a
     *  device can change key, but a number taken with a key stays taken, through `--reset` and a key change. A
     *  command is taken only above the larger of both columns. Absent from files written before it, and an older
     *  cli that saves the file drops it — the numbers then count by id and by pin only, as they did before. */
    commandKeys: Map<string, number>;
    /** Top-level fields of the file this version does not know (another writer's, or a later version's), kept as they were on every save. */
    extra?: Record<string, unknown>;
}

/**
 * The key column with the id-column numbers of the pinned devices in `ids` folded in, each under its pinned key. Files
 * from before `commandKeys` hold a number only by id; a pin dropped or changed without this takes the one trace of
 * that key's numbers with it, and an old command comes back under a new id.
 */
export const foldCommandNumbers = (state: TrustState, ids: Iterable<string>): Map<string, number> => {
    const folded = new Map(state.commandKeys);
    for (const id of ids) {
        const pin = state.devices.get(id);
        const sender = pin ? publicKeySender(pin.publicKey) : null;
        const number = state.commands.get(id);
        if (sender !== null && number !== undefined) folded.set(sender, Math.max(folded.get(sender) ?? number, number));
    }
    return folded;
};

/** The file as read: its state, or why it cannot be used. */
export type LoadedTrust = { state: TrustState } | { broken: string };

const STORE_VERSION = 1;

/** The fields this version reads or retired (`sealedOnce`); any other is kept as it is. */
const KNOWN_FIELDS = new Set(['version', 'sealedOnce', 'devices', 'commands', 'commandKeys']);

/** A device id as the app, this cli and the server mint them (`dev_ios_0a1b2c3d`,
 *  `dev_listener_…`, `dev_<nanoid>`).
 *  The one on a request is relay JSON, and it ends up in a log line and in the
 *  `hwip trust <id>` this module tells a person to run: anything else is no id. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Devices one listener pins. A person's phones and tablets are a handful; the
 *  cap is what stops a device list padded with made-up devices from growing
 *  the file one rewrite at a time. */
export const MAX_PINNED_DEVICES = 64;

/** `publicKeySender` as it is written in the file. */
const SENDER = /^[0-9a-f]{64}$/;

const isCommandNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

const parseState = (text: string): TrustState => {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
    if (!('version' in raw) || raw.version !== STORE_VERSION) throw new Error('unknown version');
    if (!('devices' in raw) || typeof raw.devices !== 'object' || raw.devices === null) throw new Error('devices is not an object');
    const devices = new Map<string, PinnedDevice>();
    for (const [deviceId, pin] of Object.entries(raw.devices)) {
        const isPin = typeof pin === 'object' && pin !== null
            && 'publicKey' in pin && typeof pin.publicKey === 'string'
            && 'pinnedAt' in pin && typeof pin.pinnedAt === 'string';
        if (!isPin) throw new Error(`device ${deviceId} is not { publicKey, pinnedAt }`);
        devices.set(deviceId, { publicKey: pin.publicKey, pinnedAt: pin.pinnedAt });
    }
    // Absent from files written before sealed commands.
    const commands = new Map<string, number>();
    if ('commands' in raw) {
        if (typeof raw.commands !== 'object' || raw.commands === null) throw new Error('commands is not an object');
        for (const [deviceId, n] of Object.entries(raw.commands)) {
            if (!isCommandNumber(n)) throw new Error(`command number of ${deviceId} is not a whole number`);
            commands.set(deviceId, n);
        }
    }
    // Optional and only ever a help: an entry that is not a sender and a number is left out, not an error. Every entry
    // is read, however many: a file past the cap (by hand) must not forget the numbers it holds; the cap only stops new ones.
    const commandKeys = new Map<string, number>();
    if ('commandKeys' in raw && typeof raw.commandKeys === 'object' && raw.commandKeys !== null && !Array.isArray(raw.commandKeys)) {
        for (const [sender, n] of Object.entries(raw.commandKeys)) {
            if (SENDER.test(sender) && isCommandNumber(n)) commandKeys.set(sender, n);
        }
    }
    // `sealedOnce` was this file's before every send was sealed: it is read past and not written back.
    const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_FIELDS.has(key)));
    return { devices, commands, commandKeys, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
};

/** Read the state file. A missing file is the empty state; one that will not
 *  read or parse is `broken`, never a guess. */
export const readTrustState = (path: string): LoadedTrust => {
    let text: string;
    try {
        text = readFileSync(path, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: { devices: new Map(), commands: new Map(), commandKeys: new Map() } }; // err.code is how node names a missing file
        return { broken: err instanceof Error ? err.message : String(err) };
    }
    try {
        return { state: parseState(text) };
    } catch (err) {
        return { broken: err instanceof Error ? err.message : String(err) };
    }
};

/** Replace the state file, whole and private. */
export const writeTrustState = (path: string, state: TrustState): void => {
    mkdirHandedBack(dirname(path), 0o700);
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const body = {
        ...state.extra,
        version: STORE_VERSION,
        devices: Object.fromEntries(state.devices),
        ...(state.commands.size > 0 ? { commands: Object.fromEntries(state.commands) } : {}),
        ...(state.commandKeys.size > 0 ? { commandKeys: Object.fromEntries(state.commandKeys) } : {}),
    };
    // Synced before the rename: a crash must leave the old file or the new
    // one, not an empty one that reads as "unusable".
    const fd = openSync(temp, 'wx', 0o600);
    try {
        try {
            writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        handBackToSudoUser(temp);
        renameSync(temp, path);
    } catch (err) {
        // A listener that keeps failing to save would otherwise leave one of these per request.
        rmSync(temp, { force: true });
        throw err;
    }
};

/** What `planPin` finds for a device and key against the pins held. */
export type PinPlan = 'same' | 'new' | 'replace' | 'in-use' | 'cap';

/**
 * How a device's key stands against the pins. `replace` is a device that comes back with another key
 * (a reinstalled app); `in-use` is a key already pinned for another id (one key is one device — the id is
 * the relay's stamp, a second id for a pinned key would have an empty record of the commands taken from
 * it); `cap` is a new device past `MAX_PINNED_DEVICES`.
 */
export const planPin = (state: TrustState, deviceId: string, publicKey: string): PinPlan => {
    const pin = state.devices.get(deviceId);
    if (pin && samePublicKey(pin.publicKey, publicKey)) return 'same';
    const sender = publicKeySender(publicKey);
    for (const [otherId, other] of state.devices) {
        if (otherId !== deviceId && publicKeySender(other.publicKey) === sender) return 'in-use';
    }
    if (pin) return 'replace';
    return state.devices.size >= MAX_PINNED_DEVICES ? 'cap' : 'new';
};

/**
 * The state with `deviceId` pinned to `publicKey` (a new pin, or the old one replaced). The numbers taken with the key a
 * replaced pin held move to the key column first — see `foldCommandNumbers`.
 */
export const withPin = (state: TrustState, deviceId: string, publicKey: string, at: Date): TrustState => ({
    ...state,
    devices: new Map(state.devices).set(deviceId, { publicKey, pinnedAt: at.toISOString() }),
    commandKeys: foldCommandNumbers(state, [deviceId]),
});

export const createSubscriberTrust = (deps: SubscriberTrustDeps): SubscriberTrust => {
    const now = deps.now ?? (() => new Date());
    let cached: { stamp: string; loaded: LoadedTrust } | null = null;
    let brokenLogged = false;
    /** This process has read a pinned device from the file. */
    let sawPins = false;

    /** inode, mtime and size: enough to see an edit without reading the file on
     *  every request. The inode is what catches a rewrite of the same length
     *  within the clock's resolution — every save here is a rename. */
    const stampOf = (): string | null => {
        try {
            const s = statSync(deps.path);
            return `${s.ino}:${s.mtimeMs}:${s.size}`;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // err.code is how node names a missing file
            throw err;
        }
    };

    /** The file as it is now, re-read only when it changed. */
    const read = (): LoadedTrust => {
        let stamp: string | null;
        try {
            stamp = stampOf();
        } catch (err) {
            return { broken: err instanceof Error ? err.message : String(err) };
        }
        if (stamp === null) {
            // Gone after it pinned a device: whoever removed it, this
            // process does not take that as leave to answer in the clear.
            // (`hwip trust --reset` rewrites the file; it does not remove it.)
            return sawPins ? { broken: 'removed while this listener was running' } : readTrustState(deps.path);
        }
        if (cached?.stamp === stamp) return cached.loaded;
        const loaded = readTrustState(deps.path);
        if ('state' in loaded) {
            cached = { stamp, loaded };
            sawPins = loaded.state.devices.size > 0;
        }
        return loaded;
    };

    const load = (): LoadedTrust => {
        const loaded = read();
        if ('state' in loaded) {
            brokenLogged = false;
            return loaded;
        }
        // A file that will not read could have said anything, including
        // "has pinned a device": answering in the clear on that is the downgrade.
        if (!brokenLogged) {
            brokenLogged = true;
            deps.log(`! trust: ${deps.path} is unusable (${loaded.broken}) — refusing every request for pane content until it is fixed or reset with \`hwip trust --reset\``);
        }
        return loaded;
    };

    /**
     * Change the file under its lock, on the file as it is once the lock is held. `change` returns the
     * state to write, or null to write nothing, and the key changes that write makes; its other result goes
     * back to the caller. Throws when the lock cannot be had or the write fails.
     */
    const update = <R>(change: (state: TrustState) => { state: TrustState | null; result: R; keyChanges?: KeyChange[] }): R => {
        const done = withTrustLock(deps.path, () => {
            const loaded = readTrustState(deps.path);
            if ('broken' in loaded) throw new Error(`the trust file is unusable (${loaded.broken})`);
            const out = change(loaded.state);
            if (out.state) {
                writeTrustState(deps.path, out.state);
                sawPins = out.state.devices.size > 0;
                if (!recordKeyChanges(deps.path, out.keyChanges ?? [])) {
                    deps.log('! trust: could not save that key change for later (key-changes.json) — this line is the only notice');
                }
            }
            return out.result;
        });
        if (!done.locked) throw new Error('the trust file is locked by another writer');
        return done.value;
    };

    const refuse = (reason: RefusalCode, why: string): Admission => {
        deps.log(`! trust: refused (${reason}) — ${why}`);
        return { kind: 'refuse', reason };
    };

    const admit: SubscriberTrust['admit'] = async ({ deviceId, publicKey }) => {
        if (publicKey === undefined) {
            const loaded = load();
            const sealedOnly = 'broken' in loaded || loaded.state.devices.size > 0;
            return sealedOnly ? refuse('e2ee_required', 'a plaintext request, and this listener only seals') : { kind: 'plain' };
        }
        // The relay stamps the sending device; without it there is no device
        // whose registered key this one could be checked against.
        if (!deviceId) return refuse('subscriber_unverified', 'the request names no device');
        if (!DEVICE_ID.test(deviceId)) return refuse('subscriber_unverified', 'the request names something that is not a device id');
        let registered: string | null;
        try {
            registered = await deps.registeredKey(deviceId);
        } catch (err) {
            return refuse('subscriber_unverified', `the device list could not be read (${err instanceof Error ? err.message : String(err)})`);
        }
        if (registered === null) return refuse('subscriber_unverified', `${deviceId} has no registered key (or the device list is unavailable)`);
        if (!samePublicKey(registered, publicKey)) return refuse('subscriber_unverified', `the key is not the one registered for ${deviceId}`);

        // Read after the lookup: `hwip trust` may have changed the pin meanwhile.
        const loaded = load();
        if ('broken' in loaded) return refuse('subscriber_unverified', 'the trust file is unusable');
        const plan = planPin(loaded.state, deviceId, publicKey);
        if (plan === 'in-use') {
            return refuse('subscriber_key_in_use', `${deviceId} asks with the key pinned for another id — if it is the same device, compare fingerprints, then \`hwip trust ${deviceId}\``);
        }
        if (plan === 'cap') {
            return refuse('subscriber_unverified', `${MAX_PINNED_DEVICES} devices are pinned already — \`hwip trust --reset\` starts over`);
        }
        if (plan === 'same') return { kind: 'seal', publicKey };
        // Looked up outside the lock, which is held only for file I/O.
        const name = plan === 'replace' ? await deps.nameOf?.(deviceId).catch(() => undefined) : undefined;
        try {
            // Sealing without the record would forget, at the next start, that plaintext is over.
            const settled = update((state) => {
                const again = planPin(state, deviceId, publicKey);
                if (again !== 'new' && again !== 'replace') return { state: null, result: again };
                const at = now();
                return {
                    state: withPin(state, deviceId, publicKey, at),
                    result: again,
                    keyChanges: again === 'replace' ? [{ deviceId, at: at.toISOString(), ...(name ? { name } : {}) }] : [],
                };
            });
            if (settled === 'in-use' || settled === 'cap') return refuse('subscriber_unverified', 'the pins changed while this request was checked');
            // `same`: another writer pinned it first, and that writer logged it.
            if (settled === 'replace') deps.log(`trust: ${deviceId} changed its key — now pinned to the new one`);
            else if (settled === 'new') deps.log(`trust: pinned ${deviceId} on first use`);
        } catch (err) {
            return refuse('subscriber_unverified', `the trust file could not be written (${err instanceof Error ? err.message : String(err)})`);
        }
        return { kind: 'seal', publicKey };
    };

    return {
        admit,
        sealedOnly: () => {
            const loaded = load();
            return 'broken' in loaded || loaded.state.devices.size > 0;
        },
        acceptCommand: (deviceId, n, publicKey) => {
            const sender = publicKeySender(publicKey);
            if (!DEVICE_ID.test(deviceId) || !isCommandNumber(n) || sender === null) {
                deps.log('! trust: a sealed command with no usable sender, key or number — dropped');
                return false;
            }
            const loaded = load();
            if ('broken' in loaded) return false;
            try {
                return update((state) => {
                    const { commands, commandKeys, devices } = state;
                    // The number must clear every number taken under this id, with this key (whatever id it came under), and under
                    // any id pinned to this key (files from before `commandKeys` have no other trace of it).
                    let last = commands.get(deviceId);
                    const raise = (theirs: number | undefined): void => {
                        if (theirs !== undefined) last = Math.max(last ?? theirs, theirs);
                    };
                    raise(commandKeys.get(sender));
                    for (const [otherId, pin] of devices) {
                        if (publicKeySender(pin.publicKey) === sender) raise(commands.get(otherId));
                    }
                    if (last !== undefined && n <= last) {
                        deps.log(`! trust: sealed command ${n} from ${deviceId} is not after ${last} — a replay, dropped`);
                        return { state: null, result: false };
                    }
                    // Nothing is forgotten to make room: a number dropped is a command that can be typed again.
                    if (!commands.has(deviceId) && commands.size >= MAX_PINNED_DEVICES) {
                        deps.log(`! trust: ${MAX_PINNED_DEVICES} senders have numbers already — sealed command from ${deviceId} dropped (\`commands\` in ${deps.path} holds them)`);
                        return { state: null, result: false };
                    }
                    if (!commandKeys.has(sender) && commandKeys.size >= MAX_PINNED_DEVICES) {
                        deps.log(`! trust: ${MAX_PINNED_DEVICES} keys have numbers already — sealed command from ${deviceId} dropped (\`commandKeys\` in ${deps.path} holds them)`);
                        return { state: null, result: false };
                    }
                    return { state: { ...state, commands: new Map(commands).set(deviceId, n), commandKeys: new Map(commandKeys).set(sender, n) }, result: true };
                });
            } catch (err) {
                // Typed without the record, it could be typed again after a restart.
                deps.log(`! trust: sealed command number not written (${err instanceof Error ? err.message : String(err)}) — dropped`);
                return false;
            }
        },
    };
};
