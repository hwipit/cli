import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_SUBAGENT_ROWS,
    SUBAGENT_ADDRESSABLE_MS,
    SUBAGENT_STALE_RECHECK_MS,
    isSubagentTranscriptPath,
    SUBAGENT_LIVE_MS,
    SUBAGENT_WORKING_MS,
    initialSubagentScanState,
    scanSubagents,
    subagentDirFor,
} from './subagent-transcripts.js';

// Counts the stats a sweep makes on subagent transcripts; everything passes through.
const stats = vi.hoisted(() => ({ agentFiles: 0 }));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        statSync: ((...args: Parameters<typeof actual.statSync>) => {
            if (/agent-[^/]*\.jsonl$/.test(String(args[0]))) stats.agentFiles++;
            return actual.statSync(...args);
        }) as typeof actual.statSync,
    };
});

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const dirs: string[] = [];

/** A parent transcript plus its `subagents/` directory, as Claude Code lays them out. */
const projectFixture = (): { parentPath: string; subagentDir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'hwip-subagents-'));
    dirs.push(root);
    const sessionId = '962a64bb-b1bd-4a4c-9ce5-d4bab12e1567';
    const parentPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(parentPath, '');
    // Through the module's own resolver: a fixture that spells the layout out
    // again would keep passing after the scanner started looking elsewhere.
    return { parentPath, subagentDir: subagentDirFor(parentPath) };
};

/** One `agent-<id>.jsonl` aged `ageMs` before NOW, plus the sidecar that names it. */
const writeSubagentFile = (
    dir: string,
    agentId: string,
    ageMs: number,
    meta?: Record<string, string>,
): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'assistant', agentId, isSidechain: true })}\n`);
    if (meta) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
};

/** Lines a subagent writes as it works: one `at`-stamped call each. Appending
 *  moves the file's mtime to the real clock, so it is put back afterwards —
 *  every other case in this file ages files against the fixed NOW. */
const writeSubagentWork = (dir: string, agentId: string, calls: number, firstAt: string, ageMs = 1_000): void => {
    const lines = Array.from({ length: calls }, (_, i) =>
        JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            timestamp: i === 0 ? firstAt : new Date(Date.parse(firstAt) + i * 1_000).toISOString(),
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { description: 'work' } }],
            },
        }),
    );
    const path = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'a' });
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
};

/** The parent's `Agent` tool call — the only proof a spawn happened at all. */
const appendLaunch = (parentPath: string): void => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

/** The body Claude Code wraps a background subagent's end in — measured shape,
 *  trimmed to the fields that identify it. */
const notificationText = (agentId: string, status: string): string =>
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n`
    + `<status>${status}</status>\n<summary>Agent "work" finished</summary>\n</task-notification>`;

/** A background subagent ending: the parent receives the notice as a user turn. */
const appendTaskNotification = (parentPath: string, agentId: string, status: string, atMs: number): void => {
    const line = JSON.stringify({
        type: 'user',
        timestamp: new Date(atMs).toISOString(),
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: notificationText(agentId, status) },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

/** A foreground subagent ending: its `Agent` call returns, carrying the agent id. */
const appendForegroundResult = (parentPath: string, agentId: string, atMs: number): void => {
    const line = JSON.stringify({
        type: 'user',
        timestamp: new Date(atMs).toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
        toolUseResult: { status: 'completed', agentId, totalToolUseCount: 3 },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isSubagentTranscriptPath', () => {
    it('tells a subagent transcript from the parent it sits under', () => {
        const { parentPath, subagentDir } = projectFixture();

        expect(isSubagentTranscriptPath(join(subagentDir, 'agent-x.jsonl'))).toBe(true);
        expect(isSubagentTranscriptPath(parentPath)).toBe(false);
    });
});

describe('scanSubagents', () => {
    it('reports a live subagent as a view-only row named after its parent', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'a1b2c3', 1_000, {
            agentType: 'cavecrew-investigator',
            description: 'Describe screenshot',
        });
        appendLaunch(parentPath);

        const rows = scanSubagents('hwip-hwipit', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            name: 'hwip-hwipit.1',
            agentId: 'a1b2c3',
            label: 'Describe screenshot',
            working: true,
        });
        expect(rows[0]!.transcriptPath).toContain('agent-a1b2c3.jsonl');
    });

    it('names a subagent by its type when the sidecar carries no description', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'typed', 1_000, { agentType: 'reviewer' });

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.label).toBe('reviewer');
    });

    it('falls back to a positional label when there is no sidecar at all', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'nameless', 1_000);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.label).toBe('Agent 1');
    });

    it('picks up a sidecar that lands after the subagent was first seen', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'late', 1_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.label).toBe('Agent 1');
        writeSubagentFile(subagentDir, 'late', 1_000, { description: 'Map subagent surfaces' });

        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.label).toBe('Map subagent surfaces');
    });

    it('keeps a subagent at the number it was first given', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'first', 60_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.name).toBe('hwip-x.1');

        // A second subagent starts later and is written more recently, so a
        // by-mtime numbering would renumber the first one.
        writeSubagentFile(subagentDir, 'second', 1_000);
        const rows = scanSubagents('hwip-x', parentPath, state, { now: NOW });

        expect(rows.map((r) => `${r.agentId}:${r.name}`)).toEqual(['first:hwip-x.1', 'second:hwip-x.2']);
    });

    it('never takes a number a pane subagent of the same session already owns', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'inprocess', 1_000);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), {
            now: NOW,
            reserved: new Set([1, 2]),
        });

        expect(rows[0]!.name).toBe('hwip-x.3');
    });

    it('drops subagents whose transcripts went quiet long ago', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'ancient', 2 * 60 * 60_000);
        writeSubagentFile(subagentDir, 'recent', 1_000);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows.map((r) => r.agentId)).toEqual(['recent']);
    });

    it('keeps a subagent addressable after it leaves the roster, so its reader is not cut off', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'thinking', SUBAGENT_LIVE_MS * 2);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ agentId: 'thinking', live: false });
    });

    it('marks a subagent idle once its transcript stops growing', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'paused', SUBAGENT_WORKING_MS * 2);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.working).toBe(false);
    });

    it('keeps the most recently active subagents when there are more than fit', () => {
        const { parentPath, subagentDir } = projectFixture();
        for (let i = 0; i < MAX_SUBAGENT_ROWS + 3; i++) writeSubagentFile(subagentDir, `agent${i}`, (i + 1) * 1_000);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        const roster = rows.filter((r) => r.live);

        expect(roster).toHaveLength(MAX_SUBAGENT_ROWS);
        expect(roster.map((r) => r.agentId)).not.toContain(`agent${MAX_SUBAGENT_ROWS + 2}`);
    });

    it('gives up a number that a pane subagent takes over later', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'inprocess', 1_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.name).toBe('hwip-x.1');

        // A pi pane split off after the fact: its pane id decides its name, so
        // this row is the one that has to move.
        const rows = scanSubagents('hwip-x', parentPath, state, { now: NOW, reserved: new Set([1]) });

        expect(rows[0]!.name).toBe('hwip-x.2');
    });

    it('says once when the parent launched a subagent but no transcript directory exists', () => {
        // Claude Code owns that directory's layout. If it moves, this scanner
        // finds nothing and the feature disappears without an error — so the
        // one state that proves the layout changed gets said out loud.
        const { parentPath } = projectFixture();
        appendLaunch(parentPath);
        const state = initialSubagentScanState();
        const logged: string[] = [];
        const opts = { now: NOW, log: (m: string) => logged.push(m) };

        expect(scanSubagents('hwip-x', parentPath, state, opts)).toEqual([]);
        expect(scanSubagents('hwip-x', parentPath, state, opts)).toEqual([]);

        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('subagents');
    });

    it('does not read a quoted tool name in the transcript as a launch', () => {
        const { parentPath } = projectFixture();
        writeFileSync(
            parentPath,
            `${JSON.stringify({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'the line reads "name":"Agent" here' }] },
            })}\n`,
        );
        const logged: string[] = [];

        scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW, log: (m) => logged.push(m) });

        expect(logged).toEqual([]);
    });

    // What the phone shows beside a subagent's name: a session that is quiet
    // because its subagent is thinking looks the same as one that is stuck,
    // until the count moves.
    it('counts the calls a subagent has made, and when it started', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'busy', 1_000);
        writeSubagentWork(subagentDir, 'busy', 3, '2026-09-13T12:00:00.000Z');

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]).toMatchObject({ toolCount: 3, startedAt: '2026-09-13T12:00:00.000Z' });
    });

    it('keeps counting across sweeps instead of re-reading the file', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'busy', 1_000);
        writeSubagentWork(subagentDir, 'busy', 2, '2026-09-13T12:00:00.000Z');
        const state = initialSubagentScanState();

        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(2);
        writeSubagentWork(subagentDir, 'busy', 2, '2026-09-13T12:00:10.000Z');

        // The second sweep reads only what was appended — the count is carried,
        // not recomputed, which is what keeps a megabyte transcript cheap.
        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(4);
        expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.startedAt).toBe(
            '2026-09-13T12:00:00.000Z',
        );
    });

    it('says nothing about work it cannot see', () => {
        const { parentPath, subagentDir } = projectFixture();
        // A subagent whose transcript holds no stamped call yet: the file is
        // there, the work is not — a zero would read as "did nothing".
        writeSubagentFile(subagentDir, 'fresh', 1_000);

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.toolCount).toBe(0);
        expect(rows[0]!.startedAt).toBeNull();
    });


    // The count and the start are what the phone shows for a subagent, and the
    // start is also the row's `createdAt` — so a listener that restarts must not
    // see a different subagent than the one that was running before it.
    describe('a subagent first seen with a long transcript', () => {
        /** A subagent that has made `calls` calls, each padded so the file is large. */
        const writeLongWork = (dir: string, agentId: string, calls: number, padChars: number): void => {
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `agent-${agentId}.jsonl`);
            const pad = 'x'.repeat(padChars);
            const lines: string[] = [];
            for (let i = 0; i < calls; i++) {
                lines.push(JSON.stringify({
                    type: 'assistant',
                    isSidechain: true,
                    timestamp: new Date(Date.parse('2026-09-13T11:00:00.000Z') + i * 1_000).toISOString(),
                    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { description: pad } }] },
                }));
            }
            writeFileSync(path, `${lines.join('\n')}\n`);
            const seconds = (NOW - 1_000) / 1000;
            utimesSync(path, seconds, seconds);
        };

        it('counts from the first line, not from the last 256 KiB', () => {
            const { parentPath, subagentDir } = projectFixture();
            // ~1.2 MB: well past the window the first read used to open.
            writeLongWork(subagentDir, 'long', 600, 2_000);

            const [row] = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(row).toMatchObject({ toolCount: 600, startedAt: '2026-09-13T11:00:00.000Z' });
        });

        it('shows a restarted listener the same count and start as the one that followed it all along', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeLongWork(subagentDir, 'long', 300, 2_000);
            const following = initialSubagentScanState();
            scanSubagents('hwip-x', parentPath, following, { now: NOW });
            // It keeps working; the listener that was following reads only the new lines.
            const path = join(subagentDir, 'agent-long.jsonl');
            const more = Array.from({ length: 300 }, (_, i) => JSON.stringify({
                type: 'assistant',
                isSidechain: true,
                timestamp: new Date(Date.parse('2026-09-13T11:30:00.000Z') + i * 1_000).toISOString(),
                message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_more${i}`, name: 'Bash', input: { description: 'x'.repeat(2_000) } }] },
            }));
            writeFileSync(path, `${more.join('\n')}\n`, { flag: 'a' });
            utimesSync(path, (NOW - 1_000) / 1000, (NOW - 1_000) / 1000);

            const before = scanSubagents('hwip-x', parentPath, following, { now: NOW })[0]!;
            const restarted = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW })[0]!;

            expect(before.toolCount).toBe(600);
            expect(restarted).toMatchObject({ toolCount: before.toolCount, startedAt: before.startedAt });
        });

        // One sweep reads a bounded amount, so a very large transcript is
        // caught up over several; the count only ever rises toward the truth.
        const SWEEP_BUDGET = 512 * 1024;
        const sweep = (parentPath: string, state: ReturnType<typeof initialSubagentScanState>) =>
            scanSubagents('hwip-x', parentPath, state, { now: NOW, catchUp: { bytes: SWEEP_BUDGET } });

        it('catches a transcript larger than one sweep reads up over later sweeps, never counting backwards', () => {
            const { parentPath, subagentDir } = projectFixture();
            const calls = Math.ceil((SWEEP_BUDGET * 3) / 2_100);
            writeLongWork(subagentDir, 'huge', calls, 2_000);
            const state = initialSubagentScanState();

            const counts: number[] = [];
            for (let i = 0; i < 6; i++) counts.push(sweep(parentPath, state)[0]!.toolCount);

            expect(counts[0]).toBeGreaterThan(0);
            expect(counts[0]).toBeLessThan(calls);
            expect([...counts].sort((a, b) => a - b)).toEqual(counts);
            expect(counts.at(-1)).toBe(calls);
        });

        it('knows when it started from the first sweep even while it is still catching up', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeLongWork(subagentDir, 'huge', Math.ceil((SWEEP_BUDGET * 3) / 2_100), 2_000);

            const [row] = sweep(parentPath, initialSubagentScanState());

            expect(row!.startedAt).toBe('2026-09-13T11:00:00.000Z');
        });

        // After a restart every session's subagents are first sights at once;
        // the budget is the sweep's, not each subagent's.
        it('spends one budget across every subagent it reads in a sweep', () => {
            const { parentPath, subagentDir } = projectFixture();
            const calls = Math.ceil((SWEEP_BUDGET * 0.8) / 2_100);
            writeLongWork(subagentDir, 'a', calls, 2_000);
            writeLongWork(subagentDir, 'b', calls, 2_000);
            const state = initialSubagentScanState();

            const counts = sweep(parentPath, state).map((row) => row.toolCount);

            // Together they hold 1.6x the budget: not both can have been read whole.
            expect(counts.reduce((sum, n) => sum + n, 0)).toBeLessThan(calls * 2);
            const settled = [sweep(parentPath, state), sweep(parentPath, state)].at(-1)!.map((row) => row.toolCount);
            expect(settled).toEqual([calls, calls]);
        });

        it('reads only the subagents the phone shows', () => {
            const { parentPath, subagentDir } = projectFixture();
            // Quiet for ten minutes: still addressable, off the roster.
            writeLongWork(subagentDir, 'quiet', 50, 100);
            const path = join(subagentDir, 'agent-quiet.jsonl');
            utimesSync(path, (NOW - 10 * 60_000) / 1000, (NOW - 10 * 60_000) / 1000);

            const [row] = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(row).toMatchObject({ live: false, toolCount: 0 });
        });

        it('starts a count over when the file is cut in place instead of adding the whole of it again', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeLongWork(subagentDir, 'cut', 40, 100);
            const state = initialSubagentScanState();
            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(40);

            // Same file, same inode, shorter than where the reader had got to.
            writeLongWork(subagentDir, 'cut', 10, 10);

            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(10);
        });
    });

    // A finished subagent's file stays forever, so the directory only grows.
    describe('what a sweep costs as the directory grows', () => {
        const staleAge = SUBAGENT_ADDRESSABLE_MS + 60_000;

        it('does not stat a file that has been quiet for hours on every sweep', () => {
            const { parentPath, subagentDir } = projectFixture();
            for (let i = 0; i < 30; i++) writeSubagentFile(subagentDir, `old${i}`, staleAge);
            writeSubagentFile(subagentDir, 'now', 1_000);
            const state = initialSubagentScanState();
            scanSubagents('hwip-x', parentPath, state, { now: NOW });

            stats.agentFiles = 0;
            scanSubagents('hwip-x', parentPath, state, { now: NOW + 5_000 });

            // Only the one that could still be changing is looked at again
            // (and the progress read stats it once more) — not the thirty.
            expect(stats.agentFiles).toBeLessThanOrEqual(2);
        });

        it('looks at the quiet ones again after a while, so a resumed one is found', () => {
            const { parentPath, subagentDir } = projectFixture();
            const path = writeSubagentFile(subagentDir, 'sleeper', staleAge);
            const state = initialSubagentScanState();
            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })).toEqual([]);

            // It writes again an hour on.
            const woke = (NOW - 1_000) / 1000;
            utimesSync(path, woke, woke);

            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW + 5_000 })).toEqual([]);
            const rows = scanSubagents('hwip-x', parentPath, state, { now: NOW + SUBAGENT_STALE_RECHECK_MS + 5_000 });
            expect(rows.map((r) => r.agentId)).toEqual(['sleeper']);
        });

        it('stats a file the first time it appears, however old it claims to be', () => {
            const { parentPath, subagentDir } = projectFixture();
            const state = initialSubagentScanState();
            writeSubagentFile(subagentDir, 'a', 1_000);
            scanSubagents('hwip-x', parentPath, state, { now: NOW });

            writeSubagentFile(subagentDir, 'b', 1_000);

            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW + 1_000 }).map((r) => r.agentId).sort()).toEqual(['a', 'b']);
        });

        it('keeps every number and count through a listing that failed, instead of forgetting them', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'one', 1_000);
            writeSubagentWork(subagentDir, 'one', 3, '2026-09-13T12:00:00.000Z');
            writeSubagentFile(subagentDir, 'two', 1_000);
            const state = initialSubagentScanState();
            const before = scanSubagents('hwip-x', parentPath, state, { now: NOW }).map((r) => r.name);

            chmodSync(subagentDir, 0o000);
            try {
                expect(scanSubagents('hwip-x', parentPath, state, { now: NOW, log: () => undefined })).toEqual([]);
            } finally {
                chmodSync(subagentDir, 0o700);
            }

            // The same chips under the same names, and the count was not read over.
            const after = scanSubagents('hwip-x', parentPath, state, { now: NOW });
            expect(after.map((r) => r.name)).toEqual(before);
            expect(after.find((r) => r.agentId === 'one')!.toolCount).toBe(3);
        });

        it('looks again at a quiet file when the clock has gone backwards', () => {
            const { parentPath, subagentDir } = projectFixture();
            const path = writeSubagentFile(subagentDir, 'sleeper', 3 * SUBAGENT_ADDRESSABLE_MS);
            const state = initialSubagentScanState();
            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })).toEqual([]);

            // The wall clock is set back five minutes and the file writes then.
            const back = NOW - 300_000;
            utimesSync(path, (back - 1_000) / 1000, (back - 1_000) / 1000);

            const rows = scanSubagents('hwip-x', parentPath, state, { now: back });
            expect(rows.map((r) => r.agentId)).toEqual(['sleeper']);
        });

        it('forgets what it kept about a subagent once its file is gone or long quiet', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'gone', 1_000, { description: 'goes away' });
            writeSubagentWork(subagentDir, 'gone', 2, '2026-09-13T12:00:00.000Z');
            writeSubagentFile(subagentDir, 'quiet', 1_000, { description: 'goes quiet' });
            appendTaskNotification(parentPath, 'gone', 'completed', NOW - 60_000);
            const state = initialSubagentScanState();
            scanSubagents('hwip-x', parentPath, state, { now: NOW });
            expect([state.order.size, state.progress.size, state.labels.size, state.endedAt.size]).toEqual([2, 2, 2, 1]);

            rmSync(join(subagentDir, 'agent-gone.jsonl'));
            // 'quiet' keeps its mtime; only the clock moves on past an hour.
            scanSubagents('hwip-x', parentPath, state, { now: NOW + SUBAGENT_ADDRESSABLE_MS + 120_000 });

            expect([state.order.size, state.progress.size, state.labels.size, state.endedAt.size]).toEqual([0, 0, 0, 0]);
        });
    });

    // A finished subagent's transcript simply stops growing, which is also what
    // a thinking one looks like. The parent is told when it ends, in one of two
    // shapes, and that is what takes it off the roster — not five quiet minutes.
    describe('ends a subagent when the parent is told it finished', () => {
        it('on a background task notification', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendLaunch(parentPath);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            // Off the roster, still addressable: a viewer reading it keeps reading.
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ agentId: 'bg', live: false, working: false });
        });

        it('on every way a background subagent can stop, not only success', () => {
            const { parentPath, subagentDir } = projectFixture();
            for (const status of ['failed', 'killed', 'stopped']) {
                writeSubagentFile(subagentDir, status, 10_000);
                appendTaskNotification(parentPath, status, status, NOW - 5_000);
            }

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows.map((r) => r.live)).toEqual([false, false, false]);
        });

        it('on a foreground call returning its result', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'fg', 10_000);
            appendForegroundResult(parentPath, 'fg', NOW - 5_000);

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]).toMatchObject({ agentId: 'fg', live: false });
        });

        it('finds out on a later sweep, after the parent had already been read', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendLaunch(parentPath);
            const state = initialSubagentScanState();
            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.live).toBe(true);

            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            expect(scanSubagents('hwip-x', parentPath, state, { now: NOW })[0]!.live).toBe(false);
        });

        // SendMessage resumes a finished subagent into the same transcript. A
        // write after the notice is new work, and the notice no longer describes it.
        it('brings a subagent back when it writes again after the notice', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 1_000);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]).toMatchObject({ agentId: 'bg', live: true, working: true });
        });

        // The subagent's last write can land a few milliseconds after the parent
        // records its end — measured on real transcripts, the final flush trails.
        it('still ends a subagent whose last write trails the notice by a moment', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 10_000 - 40);

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]!.live).toBe(false);
        });

        it('does not read a notice that is only quoted as one', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            // The parent's own reply repeating the notice text, as this very
            // conversation does when it reports a subagent finishing.
            const quoted = JSON.stringify({
                type: 'assistant',
                timestamp: new Date(NOW - 5_000).toISOString(),
                message: { role: 'assistant', content: [{ type: 'text', text: notificationText('bg', 'completed') }] },
            });
            writeFileSync(parentPath, `${quoted}\n`, { flag: 'a' });

            const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]!.live).toBe(true);
        });
    });

    it('stays quiet for a session that never launched a subagent', () => {
        const { parentPath } = projectFixture();
        const logged: string[] = [];

        const rows = scanSubagents('hwip-x', parentPath, initialSubagentScanState(), {
            now: NOW,
            log: (m) => logged.push(m),
        });

        expect(rows).toEqual([]);
        expect(logged).toEqual([]);
    });
});
