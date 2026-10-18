import { lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectHash, stateDir } from './gate.js';
import { createdHandedBack, mkdirHandedBack } from './private-files.js';
import { repoRootOf } from './session-diff.js';

/**
 * A per-project on/off switch kept as local state files — one per project and one for every project — in the state
 * directory (`gate.ts`'s, beside `muted-<hash>`). `ask-context` and `file-view` share it, so the rule that matters
 * ("a switch file that cannot be read counts as off") is written once. A switch never reaches the server or the wire.
 * No file means on.
 */

export type SwitchOffBy = 'env' | 'project' | 'global' | 'unreadable';

export type SwitchScope = 'project' | 'global';

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/** The project a command or request belongs to: the repository root, else the directory itself, so a subfolder reads the same switch. */
export const projectDirOf = (cwd: string, repoRoot: (cwd: string) => string | null = repoRootOf): string => repoRoot(cwd) ?? cwd;

/**
 * Whether a state file is there. A file that cannot be told apart from absent (permissions, a broken state
 * directory) counts as there: a switch someone turned off must not turn itself back on.
 */
const stateOf = (path: string): 'present' | 'absent' | 'unreadable' => {
    try {
        lstatSync(path);
        return 'present';
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
    }
};

export interface ProjectSwitch {
    /** Why the feature is off for this project, or `null` when it is on. The env variable turns it off for one run. */
    offBy: (dir: string, env?: NodeJS.ProcessEnv) => SwitchOffBy | null;
    /** Turn it on or off for this project, or for every project. Throws when the state file cannot be written or removed. */
    set: (dir: string, on: boolean, scope: SwitchScope) => void;
}

/** The switch named `<name>` (state files `<name>-off-<project hash>` and `<name>-off-default`), also turned off by `envVar` for one run. */
export const projectSwitch = (name: string, envVar: string): ProjectSwitch => {
    const offFile = (scope: SwitchScope, dir: string): string =>
        join(stateDir(), `${name}-off-${scope === 'global' ? 'default' : projectHash(dir)}`);
    return {
        offBy: (dir, env = process.env) => {
            if (OFF_WORDS.has((env[envVar] ?? '').trim().toLowerCase())) return 'env';
            for (const scope of ['project', 'global'] as const) {
                const state = stateOf(offFile(scope, dir));
                if (state === 'present') return scope;
                if (state === 'unreadable') return 'unreadable';
            }
            return null;
        },
        set: (dir, on, scope) => {
            const file = offFile(scope, dir);
            if (on) {
                try {
                    unlinkSync(file);
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                }
                return;
            }
            mkdirHandedBack(stateDir());
            createdHandedBack(file);
            writeFileSync(file, 'off\n');
        },
    };
};
