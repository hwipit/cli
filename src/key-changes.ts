/**
 * Devices whose key changed since this computer pinned them, kept until a person has been shown it.
 *
 * Whoever replaces a pin — `hwip notify`, `hwip ask`, `hwip agent send`, the listener, the MCP server — writes the
 * change here, under the trust file's lock (`trust-lock.ts`). Their own output often reaches nobody (a hook's
 * `2>/dev/null`, the daemon log, an MCP server's stderr), and once the pin holds the new key no one sees the change
 * again. So it waits beside the pins until a surface a person reads takes it: a cli command at a terminal, the
 * plugin's SessionStart and /hwip-mode, an MCP tool result.
 *
 * THE CONTRACT (cli and mcp-server write and read it, the plugin reads it — changing it is a cross-repo change):
 *
 *   path  key-changes.json beside trusted-devices.json (~/.hwip/key-changes.json), 0600
 *   body  {"v":1,"changes":[{"deviceId":"<device id>","at":"<ISO 8601 UTC>","name":"<nickname, optional>"}]}
 *         one entry per device, updated in place; at most 64, the oldest dropped
 *   take  under the same lock as the writers (trusted-devices.lock), rename to key-changes.json.<pid>.taken, read,
 *         delete: a writer cannot put back what was taken, and of two readers only the one whose rename wins shows
 *         the changes. A record that does not parse, or another `v`, reads as none.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { DEVICE_ID } from './subscriber-trust.js';
import { withTrustLock } from './trust-lock.js';

export interface KeyChange {
    deviceId: string;
    /** When the pin was replaced, ISO 8601 UTC. */
    at: string;
    /** The device's nickname as the account lists it. */
    name?: string;
}

export const MAX_KEY_CHANGES = 64;
const NAME_MAX = 80;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const keyChangesPath = (trustPath: string): string => join(dirname(trustPath), 'key-changes.json');

/** The relay writes nicknames: no control, direction or zero-width characters, one space per run, 80 characters at most. */
const cleanName = (name: unknown): string | undefined => {
    if (typeof name !== 'string') return undefined;
    const plain = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(plain);
    if (chars.length === 0) return undefined;
    return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join('') : plain;
};

const entryOf = (raw: unknown): KeyChange | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const { deviceId, at, name } = raw as Record<string, unknown>;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId) || typeof at !== 'string' || !ISO_UTC.test(at)) return null;
    const clean = cleanName(name);
    return clean === undefined ? { deviceId, at } : { deviceId, at, name: clean };
};

const readChanges = (path: string): KeyChange[] => {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return [];
    }
    const { v, changes } = (raw ?? {}) as { v?: unknown; changes?: unknown };
    if (v !== 1 || !Array.isArray(changes)) return [];
    return changes.map(entryOf).filter((c): c is KeyChange => c !== null).slice(-MAX_KEY_CHANGES);
};

/**
 * Add `changes` to the record. Call it inside the `withTrustLock` section that replaced the pins: that lock is what
 * keeps two writers from dropping each other's entry, and a taker from seeing an entry twice. Throws nothing: false
 * means the record could not be written, and the caller says so — nothing else will.
 */
export const recordKeyChanges = (trustPath: string, changes: KeyChange[]): boolean => {
    if (changes.length === 0) return true;
    const path = keyChangesPath(trustPath);
    const list = readChanges(path);
    for (const change of changes) {
        const entry = entryOf(change);
        if (!entry) continue;
        const at = list.findIndex((c) => c.deviceId === entry.deviceId);
        if (at >= 0) list[at] = entry;
        else list.push(entry);
    }
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        mkdirHandedBack(dirname(path), 0o700);
        writeFileSync(temp, `${JSON.stringify({ v: 1, changes: list.slice(-MAX_KEY_CHANGES) })}\n`, { mode: 0o600, flag: 'wx' });
        handBackToSudoUser(temp);
        renameSync(temp, path);
        return true;
    } catch {
        try { rmSync(temp, { force: true }); } catch { /* the folder is not there either */ }
        return false;
    }
};

const takeRecord = (path: string): KeyChange[] => {
    const taken = `${path}.${process.pid}.taken`;
    try {
        renameSync(path, taken);
    } catch {
        return [];
    }
    try {
        return readChanges(taken);
    } finally {
        rmSync(taken, { force: true });
    }
};

/** The changes nobody has been shown yet, and the record gone. A lock that cannot be had leaves the record for the next surface. */
export const takeKeyChanges = (trustPath: string, opts: { waitMs?: number } = {}): KeyChange[] => {
    const path = keyChangesPath(trustPath);
    // Most commands find nothing: no lock for them.
    if (!existsSync(path)) return [];
    const done = withTrustLock(trustPath, () => takeRecord(path), opts);
    return done.locked ? done.value : [];
};

/** One line for a person; the caller adds its prefix. */
export const describeKeyChange = (change: KeyChange): string =>
    `${change.name ?? change.deviceId} changed its encryption key — the new key is trusted. Not expecting that (app reinstalled?) Check it: hwip trust`;

/**
 * Show the recorded changes on stderr and clear them — only when stderr is a terminal. A hook runs `hwip notify …
 * 2>/dev/null`; taking the record there would lose it unseen, so it is left for the plugin to show.
 */
export const showKeyChanges = (trustPath: string, stderr: { isTTY?: boolean; write: (text: string) => unknown }): void => {
    if (stderr.isTTY !== true) return;
    for (const change of takeKeyChanges(trustPath)) stderr.write(`hwip: ${describeKeyChange(change)}\n`);
};
