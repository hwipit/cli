/**
 * t89: the state folder is made 0700 in one place (ensurePrivateDir) and every
 * state file is 0600 — even under a permissive umask (022) and when the gate
 * path is the first writer (the folder and file did not exist).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectHash, remoteMarkerPath, remoteStatePath, stateDir, touchRemoteActive } from './gate.js';
import { writeRemoteMarker } from './listener.js';

let TMP: string;
let savedXdg: string | undefined;
let savedUmask: number;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'hwip-state-modes-'));
    savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(TMP, 'state');
    savedUmask = process.umask(0o022);
});

afterEach(() => {
    process.umask(savedUmask);
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
    rmSync(TMP, { recursive: true, force: true });
});

describe('state dir and file modes (t89)', () => {
    it('gate first writer: state dir is 0700', () => {
        const dir = stateDir();
        expect(() => statSync(dir)).toThrow(); // absent before
        touchRemoteActive(TMP, () => 1_800_000_000_000);
        expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
    });

    it('gate first writer: remote-active state file is 0600', () => {
        touchRemoteActive(TMP, () => 1_800_000_000_000);
        const file = remoteStatePath(projectHash(TMP)!);
        expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    });

    it('remote marker file is 0600', () => {
        expect(writeRemoteMarker(TMP, 'hello')).toBe(true);
        const file = remoteMarkerPath(projectHash(TMP)!);
        expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    });
});
