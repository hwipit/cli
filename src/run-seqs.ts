/**
 * The seq block each run of a session took (hwip docs/session-runs.md Q24).
 *
 * The recorder numbers a name's chunks in one rising sequence, and a new run
 * carries the numbering on — so a run's chunks sit between the smallest and the
 * largest seq it was handed. The listener reports that block with each run, and
 * the server reads a run's conversation from that key range alone instead of
 * every chunk the name ever had.
 *
 * Kept in a file of its own rather than on the registry entry: the registry is
 * rewritten from the inventory sweep, and a chunk can be numbered before the
 * sweep has written its run down. A bound that is lost reads too narrow, and a
 * block reported too narrow hides chunks — so the smallest seq only goes down
 * and the largest only up, here and on the server.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateDir } from './gate.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { KNOWN_SESSION_TTL_MS } from './session-registry.js';

export interface RunSeqs {
    firstSeq: number;
    lastSeq: number;
}

interface Row extends RunSeqs {
    name: string;
    runId: string;
    /** Last time a chunk of this run was numbered: a run unseen for the registry's TTL is dropped. */
    at: string;
}

/** Ceiling on rows: far above the registry's own 100 runs, only so the file cannot grow without bound. */
const MAX_ROWS = 500;

const filePath = (): string => join(stateDir(), 'run-seqs.json');

const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

const readAll = (): Row[] => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(filePath(), 'utf-8'));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (r): r is Row =>
                !!r && typeof r === 'object' &&
                typeof (r as Row).name === 'string' && typeof (r as Row).runId === 'string' && typeof (r as Row).at === 'string' &&
                isSeq((r as Row).firstSeq) && isSeq((r as Row).lastSeq),
        );
    } catch {
        return [];
    }
};

const writeAll = (rows: Row[]): void => {
    const path = filePath();
    try {
        mkdirHandedBack(dirname(path), 0o700);
        writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
        handBackToSudoUser(path);
    } catch {
        // A block that cannot be written costs the narrow read, not the chunk: the server reads the whole name.
    }
};

/** Widen run `runId` of `name` to cover the seqs `firstSeq`..`lastSeq` it was just handed. */
export const noteRunSeqs = (name: string, runId: string, firstSeq: number, lastSeq: number, now: number = Date.now()): void => {
    if (!isSeq(firstSeq) || !isSeq(lastSeq)) return;
    const at = new Date(now).toISOString();
    const rows = readAll().filter((r) => now - Date.parse(r.at) < KNOWN_SESSION_TTL_MS);
    const had = rows.find((r) => r.name === name && r.runId === runId);
    const row: Row = had
        ? { ...had, firstSeq: Math.min(had.firstSeq, firstSeq), lastSeq: Math.max(had.lastSeq, lastSeq), at }
        : { name, runId, firstSeq, lastSeq, at };
    writeAll([row, ...rows.filter((r) => r !== had)].slice(0, MAX_ROWS));
};

/** Every run's block, keyed by `runSeqsKey`: one read for a whole report. */
export const runSeqsByRun = (): Map<string, RunSeqs> =>
    new Map(readAll().map((r) => [runSeqsKey(r.name, r.runId), { firstSeq: r.firstSeq, lastSeq: r.lastSeq }]));

/** NUL-separated, like the registry's `runKey`: a name holding the separator cannot forge another run's key. */
export const runSeqsKey = (name: string, runId: string): string => `${name}\u0000${runId}`;

/** Test seam: the file this module reads and writes. */
export const runSeqsPath = filePath;
