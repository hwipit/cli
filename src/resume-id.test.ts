import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectHermesResumeId, paneSince, transcriptIdSince } from './remote-agents.js';

/**
 * A resumed conversation is told by being written to after the pane started; a fresh start has written nothing
 * yet, so the folder's older conversations must not be read as the one it carries on.
 */
const PANE_START = 1_792_480_000_000;
const deps = (rows?: unknown[]) => ({ rows, startTimes: new Map([[100, PANE_START]]), descendants: new Set([90, 100]) });

describe('paneSince', () => {
    it('is the earliest process start less the tolerance, null with none known', () => {
        expect(paneSince(90, deps())).toBe(PANE_START - 10_000);
        expect(paneSince(90, { startTimes: new Map(), descendants: new Set([90]) })).toBeNull();
    });
});

describe('transcriptIdSince', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'resume-id-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const file = (name: string, mtimeMs: number): string => {
        const path = join(dir, name);
        writeFileSync(path, '{}\n');
        utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
        return path;
    };

    it('names the file a resume appended to since the pane started', () => {
        const path = file('2026-10-20T08-10-45-634Z_01a1585c.jsonl', PANE_START + 5_000);
        expect(transcriptIdSince(path, PANE_START)).toBe('2026-10-20T08-10-45-634Z_01a1585c');
    });

    it('is null for a file last written before the pane started — a fresh start, not a resume', () => {
        expect(transcriptIdSince(file('old.jsonl', PANE_START - 60_000), PANE_START)).toBeNull();
    });

    it('is null for no file, a gone file, or no known start', () => {
        expect(transcriptIdSince(null, PANE_START)).toBeNull();
        expect(transcriptIdSince(join(dir, 'gone.jsonl'), PANE_START)).toBeNull();
        expect(transcriptIdSince(file('x.jsonl', PANE_START), null)).toBeNull();
    });
});

describe('detectHermesResumeId', () => {
    // `started_at` and the last message are REAL seconds.
    const row = (id: string, activeSec: number | null, cwd = '/proj') => ({ id, cwd, started_at: 1_792_000_000, active: activeSec });

    it('is the session in this folder messaged since the pane started, though started long before it', () => {
        const rows = [row('20261020_171203_c60148', PANE_START / 1000 + 30), row('older', PANE_START / 1000 - 3_600)];
        expect(detectHermesResumeId('/proj', 90, deps(rows))).toBe('20261020_171203_c60148');
    });

    it('is null before the pane writes, for another folder, and without a pid', () => {
        expect(detectHermesResumeId('/proj', 90, deps([row('older', PANE_START / 1000 - 3_600)]))).toBeNull();
        expect(detectHermesResumeId('/proj', 90, deps([row('elsewhere', PANE_START / 1000 + 30, '/other')]))).toBeNull();
        expect(detectHermesResumeId('/proj', 90, deps([row('empty', null)]))).toBeNull();
        expect(detectHermesResumeId('/proj', undefined, deps([row('x', PANE_START / 1000 + 30)]))).toBeNull();
    });
});
