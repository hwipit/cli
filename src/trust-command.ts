/**
 * `hwip trust` — the person's side of subscriber-trust.ts. Advanced: nothing needs it to work.
 *
 * Every device the account lists is pinned the first time hwip sees it (a send, or the listener), and a key that
 * changed replaces its pin with one warning. Whether a new key is the phone after a reinstall or a server putting
 * its own in the device list is not something hwip can tell; a person can, by reading a fingerprint off the phone's
 * screen. This command shows the fingerprints and takes that decision.
 *
 *   hwip trust             this computer's fingerprint, and the pinned devices
 *   hwip trust <deviceId>  pin the key the account now registers for a device
 *   hwip trust --reset     forget every pin; the listener then answers a plaintext screen request again
 */

import { keyFingerprint } from './crypto.js';
import type { DeviceInfo } from './device-directory.js';
import { foldCommandNumbers, readTrustState, writeTrustState, type LoadedTrust, type TrustState, DEVICE_ID } from './subscriber-trust.js';
import { withTrustLock } from './trust-lock.js';

export interface TrustCommandDeps {
    /** The listener's state file (`~/.hwip/trusted-devices.json`). */
    path: string;
    /** This machine's device public key (load-or-create). */
    devicePublicKey: () => Promise<string>;
    /** The key the account's device list holds for a device; null when it lists none. */
    registeredKey: (deviceId: string) => Promise<string | null>;
    /** The account's device list with each device's kind; empty (or absent) when it cannot be read. */
    devices?: () => Promise<DeviceInfo[]>;
    /** Ask a yes/no question; false when there is nobody to ask. */
    confirm: (question: string) => Promise<boolean>;
    print: (line: string) => void;
    printError: (line: string) => void;
    now?: () => Date;
}

export interface TrustCommandArgs {
    deviceId?: string;
    reset: boolean;
    /** Skip the question (`--yes`): the caller has compared the fingerprints already. */
    yes: boolean;
}

/** A flag's value when it was given one; a bare `--flag` or an empty string is none. */
export const flagText = (value: string | boolean | undefined): string | undefined =>
    (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * `hwip trust`'s arguments from the cli's parsed flags, or why they make no
 * command. The parser hands a flag the next word as its value, so
 * `--yes <deviceId>` arrives as `yes: '<deviceId>'` with no positional: that
 * word is the device. `--reset` takes no device at all — with one it would
 * read as "reset this device" and do something much larger.
 */
export const parseTrustArgs = (args: Record<string, string | boolean>): TrustCommandArgs | { error: string } => {
    const positional = flagText(args._arg1);
    const afterYes = flagText(args.yes);
    const reset = args.reset !== undefined && args.reset !== false;
    const yes = args.yes !== undefined && args.yes !== false;
    if (positional && afterYes) return { error: 'hwip trust: one device at a time' };
    const deviceId = positional ?? afterYes;
    if (reset && (deviceId || flagText(args.reset))) {
        return { error: 'hwip trust: --reset forgets every device and takes none — use `hwip trust <deviceId>` to re-pin one' };
    }
    return { ...(deviceId ? { deviceId } : {}), reset, yes };
};

const fingerprintOf = (publicKey: string): string => keyFingerprint(publicKey) ?? '(not a device key)';

const NICKNAME_MAX = 40;

/**
 * A nickname as the screen shows it. The account lists it, so the relay writes it: it may carry control characters that
 * rewrite the terminal, direction or zero-width characters that move or hide text, and a run of spaces that wraps the line so
 * a made-up row (an id and a fingerprint) starts the next one. So: those characters go, whitespace runs become one space,
 * and it is cut at 40 characters.
 */
const nicknameOf = (text: string): string => {
    const plain = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(plain);
    return chars.length > NICKNAME_MAX ? `${chars.slice(0, NICKNAME_MAX - 1).join('')}…` : plain;
};

/** The kinds the server lists a device as (`DeviceType` in the server's device types). */
const DEVICE_KINDS = new Set(['android', 'ios', 'macos', 'chrome', 'firefox', 'safari', 'chrome_extension', 'firefox_extension', 'cli', 'hook']);

/** The kind the account lists, if it is one of those: a relay's text never reaches the screen, least of all above the fingerprint. */
const kindOf = (type: string | undefined): string | undefined => (type === undefined ? undefined : DEVICE_KINDS.has(type) ? type : 'unknown');

/** A device's kind as the account lists it, for the line it is on. */
const kindTag = (listed: Map<string, DeviceInfo>, deviceId: string): string => {
    const kind = kindOf(listed.get(deviceId)?.type);
    return kind ? `  [${kind}]` : '';
};

const showState = async (state: TrustState, deps: TrustCommandDeps): Promise<number> => {
    const own = await deps.devicePublicKey();
    deps.print(`This computer   ${fingerprintOf(own)}`);
    deps.print('');
    const listed = new Map((await deps.devices?.().catch((): DeviceInfo[] => []) ?? []).map((d) => [d.deviceId, d]));
    if (state.devices.size === 0) {
        deps.print('No device is pinned yet: each one is pinned the first time hwip sees it in the account\'s device list.');
    } else {
        deps.print('Pinned devices — the listener seals a screen only for these keys:');
        for (const [deviceId, pin] of state.devices) {
            deps.print(`  ${deviceId.padEnd(24)} ${fingerprintOf(pin.publicKey)}   since ${pin.pinnedAt.slice(0, 10)}${kindTag(listed, deviceId)}`);
        }
    }
    // A computer is pinned the first time a send seals for it; this is the chance to compare its fingerprint before that.
    const unpinned = [...listed.values()].filter((d) => d.type === 'cli' && DEVICE_ID.test(d.deviceId) && d.publicKey !== undefined && !state.devices.has(d.deviceId) && d.publicKey !== own);
    if (unpinned.length > 0) {
        deps.print('');
        deps.print('Computers on the account not pinned here yet — the first send seals for each and pins it; to compare a fingerprint before that, run `hwip trust <deviceId>`:');
        for (const d of unpinned) deps.print(`  ${d.deviceId.padEnd(24)} ${fingerprintOf(d.publicKey ?? '')}   ${nicknameOf(d.nickname ?? '')}`.trimEnd());
    }
    deps.print('');
    deps.print(state.devices.size > 0
        ? 'This listener only seals: a request for a screen in plaintext is refused.'
        : 'No device is pinned: this listener still answers a plaintext request.');
    deps.print('Each fingerprint has to read the same in the app, on that device\'s page.');
    return 0;
};

const trustDevice = async (deviceId: string, state: TrustState, args: TrustCommandArgs, deps: TrustCommandDeps): Promise<number> => {
    if (!DEVICE_ID.test(deviceId)) {
        deps.printError('hwip trust: that is not a device id (see `hwip trust` for the pinned ones)');
        return 2;
    }
    const registered = await deps.registeredKey(deviceId);
    if (registered === null || keyFingerprint(registered) === null) {
        deps.printError(`hwip trust: the account lists no key for ${deviceId} (or its device list could not be read)`);
        return 1;
    }
    const pin = state.devices.get(deviceId);
    if (pin?.publicKey === registered) {
        deps.print(`${deviceId} is already pinned to ${fingerprintOf(registered)}.`);
        return 0;
    }
    const kind = kindOf((await deps.devices?.().catch((): DeviceInfo[] => []) ?? []).find((d) => d.deviceId === deviceId)?.type);
    if (kind) deps.print(`Device kind     ${kind}`);
    deps.print(`Pinned now      ${pin ? fingerprintOf(pin.publicKey) : '(nothing)'}`);
    deps.print(`Account lists   ${fingerprintOf(registered)}`);
    // Another computer shows its own fingerprint as `This computer` in its `hwip trust`; the app shows a device's on its page.
    deps.print(kind === 'cli'
        ? 'Run `hwip trust` on that computer and read its "This computer" line.'
        : 'Open the app on that device and read its own fingerprint (its page under Devices).');
    const agreed = args.yes || await deps.confirm(`Does the ${kind === 'cli' ? 'computer' : 'device'} show ${fingerprintOf(registered)}?`);
    if (!agreed) {
        deps.print('Left as it was.');
        return 1;
    }
    // Read again, under the lock: the lookup and the question took time, and a running
    // listener may have pinned another device meanwhile. Writing the state
    // from before would quietly unpin it.
    const at = (deps.now?.() ?? new Date()).toISOString();
    const done = rewrite(deps, (latest) => {
        if ('broken' in latest) return { refused: unusable(latest.broken, deps) };
        const devices = new Map(latest.state.devices);
        devices.set(deviceId, { publicKey: registered, pinnedAt: at });
        // The key being replaced keeps the numbers taken with it: they are written beside the key before the pin goes.
        return { state: { ...latest.state, devices, commandKeys: foldCommandNumbers(latest.state, [deviceId]) } };
    });
    if (done !== 0) return done;
    deps.print(`${deviceId} is pinned to ${fingerprintOf(registered)}.`);
    return 0;
};

/**
 * Rewrite the state file under its lock, from the file as it is once the lock is held. `make` returns the state to
 * write, or the exit code of a refusal it has already printed. 0 is done; anything else says why nothing changed.
 */
const rewrite = (deps: TrustCommandDeps, make: (latest: LoadedTrust) => { state: TrustState } | { refused: number }): number => {
    try {
        const done = withTrustLock(deps.path, () => {
            const made = make(readTrustState(deps.path));
            if ('refused' in made) return made.refused;
            writeTrustState(deps.path, made.state);
            return 0;
        });
        if (done.locked) return done.value;
        deps.printError(`hwip trust: ${deps.path} is being written by another process — nothing changed, try again.`);
        return 1;
    } catch (err) {
        deps.printError(`hwip trust: could not write ${deps.path} (${err instanceof Error ? err.message : String(err)}) — nothing changed.`);
        return 1;
    }
};

const unusable = (why: string, deps: TrustCommandDeps): number => {
    deps.printError(`hwip trust: ${deps.path} is unusable (${why}).`);
    deps.printError('The listener refuses every screen until it is fixed; `hwip trust --reset` starts over.');
    return 1;
};

const reset = async (args: TrustCommandArgs, deps: TrustCommandDeps): Promise<number> => {
    const agreed = args.yes || await deps.confirm(
        'Forget every pinned device? Each is pinned again the next time hwip sees it in the account\'s device list; until then this listener answers a request for a screen in plaintext.',
    );
    if (!agreed) {
        deps.print('Left as it was.');
        return 1;
    }
    // Rewritten, not removed: a running listener treats a state file that
    // vanished as a reason to refuse, and an empty one as a fresh start. The
    // sealed command numbers stay, with the keys they were taken with: without them an old command could be typed
    // again (a file too broken to read has none to keep).
    const done = rewrite(deps, (before) => {
        const commands = 'state' in before ? before.state.commands : new Map<string, number>();
        // A file from before `commandKeys` holds the numbers by id only, and the pins that tell which key each id had are
        // going: they are written beside their keys first.
        const commandKeys = 'state' in before ? foldCommandNumbers(before.state, before.state.devices.keys()) : new Map<string, number>();
        return { state: { devices: new Map(), commands, commandKeys, ...('state' in before && before.state.extra ? { extra: before.state.extra } : {}) } };
    });
    if (done !== 0) return done;
    deps.print('Reset. Each device is pinned again the next time hwip sees it.');
    return 0;
};

/** Run `hwip trust`; the return value is the exit code. */
export const runTrust = async (args: TrustCommandArgs, deps: TrustCommandDeps): Promise<number> => {
    // A reset is the way out of an unusable file, so it does not read it.
    if (args.reset) return reset(args, deps);
    const loaded = readTrustState(deps.path);
    if ('broken' in loaded) return unusable(loaded.broken, deps);
    return args.deviceId ? trustDevice(args.deviceId, loaded.state, args, deps) : showState(loaded.state, deps);
};
