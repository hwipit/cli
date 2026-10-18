import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensurePrivateDir, handBackToSudoUser } from './private-files.js';

// The listener daemon writes this file (see listener.ts computeListenerDeviceId; `hwip rename`
// reaches the same function, and writes the same value); the other processes in the CLI
// (hwip-hook's agent-session context) only READ it, so both resolve the same id.
const LISTENER_ID_FILE = join(homedir(), '.hwip', 'listener-device-id');

export const hashListenerId = (seed: string): string =>
    `dev_listener_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

/** The id the sticky file holds, or null when it is missing or not an id. */
export const readStickyListenerId = (): string | null => {
    try {
        const saved = readFileSync(LISTENER_ID_FILE, 'utf-8').trim();
        return /^dev_listener_[0-9a-f]{8}$/.test(saved) ? saved : null;
    } catch {
        return null;
    }
};

/**
 * Leave `id` in the sticky file (0600, in the 0700 `~/.hwip`) so a later process that cannot
 * read the machine id — `ioreg` stalled past its timeout — still gets this one. The writer is
 * `computeListenerDeviceId` (the listener, `hwip rename`). A file that already holds `id` is left
 * alone; one that holds another is replaced (an id a stalled start wrote down earlier). The new
 * content goes in by rename, so a hook reading in the middle sees the old id or the new one, never
 * an empty file. Best-effort: the id in memory stands.
 */
export const rememberListenerId = (id: string): void => {
    if (readStickyListenerId() === id) return;
    // Random name, exclusive create: a predictable name is one another process could pre-create as a symlink.
    const tmp = `${LISTENER_ID_FILE}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        ensurePrivateDir(dirname(LISTENER_ID_FILE));
        writeFileSync(tmp, `${id}\n`, { mode: 0o600, flag: 'wx' });
        // After the write: the create mode is cut by the umask, and an older file's mode is not this one's.
        chmodSync(tmp, 0o600);
        handBackToSudoUser(tmp);
        renameSync(tmp, LISTENER_ID_FILE);
    } catch {
        try {
            unlinkSync(tmp);
        } catch { /* never created, or already renamed */ }
        /* not writable: nothing is lost that was not already */
    }
};

/**
 * ioreg by its absolute path: it lives in /usr/sbin, which a PATH from an IDE or a
 * hook environment may lack, and a failed lookup falls back to a hostname hash —
 * the same Mac registered as another device. launchd's own PATH has it; nothing
 * else is promised. Shared by the listener, which registers the id, and the
 * read-only reader here, so both read the same machine id.
 */
const IOREG = '/usr/sbin/ioreg';

/**
 * A stalled ioreg (IOKit wedged) used to hold every hook, `hwip rename` and the
 * listener's start for as long as it hung. A timed-out run throws, which the
 * caller reads as "no machine id" and falls back to the sticky file, then the
 * hostname hash. mcp-server (config.ts IOREG_TIMEOUT_MS) gives up at the same
 * 5 s and falls back the same way. The two run ioreg at different moments, so
 * agreeing on the id still rests on ioreg being fast; this only keeps a wedged
 * one from deciding who waits longest. A listener whose FIRST start (no sticky
 * file yet) stalls keeps the hostname id until it restarts; on macOS that id is
 * not written down, so the restart recovers (C109).
 */
const IOREG_TIMEOUT_MS = 5_000;

/** Platform machine id (macOS IOPlatformUUID / Linux machine-id), or null. */
export const readMachineId = (
    deps: { platform?: NodeJS.Platform; exec?: typeof execFileSync } = {},
): string | null => {
    const platform = deps.platform ?? process.platform;
    const exec = deps.exec ?? execFileSync;
    try {
        if (platform === 'darwin') {
            // stdio: swallow ioreg's stderr so a one-off `hwip rename` / hook
            // never leaks ioreg warnings to the terminal.
            const out = exec(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: IOREG_TIMEOUT_MS,
            });
            const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        }
        if (platform === 'linux') {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                try {
                    const v = readFileSync(p, 'utf-8').trim();
                    if (v) return v;
                } catch { /* try next path */ }
            }
        }
    } catch { /* no machine id readable — fall through */ }
    return null;
};

/**
 * Listener device id, resolved READ-ONLY — MUST equal what `listener.ts`
 * `computeListenerDeviceId()` registers, so pushes tagged with this id land
 * under the listener's device (otherwise a hook/notify reaches the feed but
 * never threads into the agent chat). Hash the platform machine id first, then
 * the sticky file the listener persisted, then a hostname hash — the same order
 * as the writer, but never writing the file here.
 */
let cached: string | undefined;

export const listenerDeviceId = (): string => {
    // The machine id does not change under a running process, and on macOS
    // reading it is an `ioreg` spawn — once per process is enough.
    cached ??= resolveListenerDeviceId();
    return cached;
};

const resolveListenerDeviceId = (): string => {
    const machineId = readMachineId();
    if (machineId) return hashListenerId(machineId);
    const saved = readStickyListenerId();
    if (saved) return saved;
    return hashListenerId(hostname());
};
