/**
 * Where the person's own shell finds their agents (F8). A schedule is started by the listener, and the listener run by
 * launchd or systemd has only the PATH its service file baked: tmux's and node's directories and the system ones. An
 * agent installed anywhere else — `~/.local/bin/claude` — is not on it, and the scheduled session's pane dies at once
 * with "command not found". So every `hwip <agent>` typed in a shell writes down the directory its agent was found in,
 * and a schedule launch adds those directories to its PATH.
 *
 * Builtins only: wrapper.ts writes this on the `hwip cc` hot path.
 */

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { stateDir } from './gate.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

/** More than anyone has agents in; bounds what a schedule launch puts on PATH. */
const MAX_DIRS = 16;

export const agentDirsPath = (): string => join(stateDir(), 'agent-dirs.json');

/**
 * Whether the file is the user's own regular file that only they can write: a directory put on PATH by someone else runs
 * their programs as the agent. 'missing' when there is none yet.
 */
const fileState = (path: string): 'ok' | 'missing' | 'refused' => {
    try {
        const info = lstatSync(path);
        const mine = typeof process.getuid !== 'function' || info.uid === process.getuid();
        return info.isFile() && mine && (info.mode & 0o022) === 0 ? 'ok' : 'refused';
    } catch {
        return 'missing';
    }
};

const readDirs = (): string[] => {
    try {
        const path = agentDirsPath();
        if (fileState(path) !== 'ok') return [];
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((dir): dir is string => typeof dir === 'string' && isAbsolute(dir)).slice(0, MAX_DIRS);
    } catch {
        return [];
    }
};

/** Writes down the directory of `binary`, an absolute path the shell resolved. Best-effort: a launch never fails on it. */
export const rememberAgentDir = (binary: string): void => {
    if (!isAbsolute(binary)) return;
    const dir = dirname(binary);
    const path = agentDirsPath();
    // Never written through a link, nor into a file that is not read back: either would be writing for nothing, or elsewhere.
    if (fileState(path) === 'refused') return;
    const dirs = readDirs();
    if (dirs.includes(dir)) return;
    try {
        mkdirHandedBack(stateDir(), 0o700);
        writeFileSync(path, JSON.stringify([...dirs, dir].slice(-MAX_DIRS)), { mode: 0o600 });
        handBackToSudoUser(path);
    } catch {
        // The schedule launch then says the agent is not on PATH, which is the truth.
    }
};

/** `path` with every written-down directory it lacks appended: what the listener has first, so nothing it runs changes. */
export const withAgentDirs = (path: string | undefined): string => {
    const have = (path ?? '').split(delimiter).filter(Boolean);
    return [...have, ...readDirs().filter((dir) => !have.includes(dir))].join(delimiter);
};
