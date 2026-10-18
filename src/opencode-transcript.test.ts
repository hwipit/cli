import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    opencodeDbPath,
    opencodeLinesOf,
    opencodeRowsSql,
    opencodeSourcePath,
    OPENCODE_MIN_QUERY_MS,
    OPENCODE_OPEN_WINDOW,
    projectOpencodeEntries,
    readOpencodeTranscript,
    type OpencodeRow,
} from './opencode-transcript.js';
import { sqliteJson } from './remote-agents.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS, type TurnEvent } from './transcript-tail.js';

/**
 * Rows shaped like what `opencodeRowsSql` returns, built by hand from the
 * opencode 2.0.24 store's structure (see the file header) — no row of a real
 * conversation is copied here.
 */
const T0 = Date.parse('2026-10-10T08:00:00.000Z');

const user = (seq: number, text: string): OpencodeRow => ({ id: `msg_u${seq}`, seq, type: 'user', created: T0 + seq, text });

const step = (seq: number, items: OpencodeRow['items'], done = true, extra: Partial<OpencodeRow> = {}): OpencodeRow => ({
    id: `msg_a${seq}`,
    seq,
    type: 'assistant',
    created: T0 + seq,
    completed: done ? T0 + seq + 1 : null,
    model: 'big-pickle',
    out: 20,
    input: 100,
    cacheRead: 1000,
    cacheWrite: 5,
    items,
    ...extra,
});

const events = (lines: string[]): TurnEvent[] => lines.map((l) => JSON.parse(l) as TurnEvent);

describe('opencodeLinesOf', () => {
    it('reads a finished turn into prompt, text, tool, result and usage', () => {
        const out = opencodeLinesOf(
            [
                user(1, 'make hello.txt'),
                step(2, [
                    { type: 'reasoning' },
                    { type: 'tool', id: 'call_1', name: 'write', status: 'completed', target: '/repo/hello.txt', lines: 1 },
                ]),
                step(3, [{ type: 'text', text: 'Done.' }]),
            ],
            { from: 0, emitted: [] },
        );
        expect(events(out.lines).map((e) => e.kind)).toEqual(['prompt', 'tool', 'tool_result', 'msg', 'text', 'msg']);
        const [prompt, tool, result, msg] = events(out.lines);
        expect(prompt).toMatchObject({ kind: 'prompt', text: 'make hello.txt', at: new Date(T0 + 1).toISOString() });
        expect(tool).toMatchObject({ kind: 'tool', id: 'call_1', name: 'write', target: '/repo/hello.txt' });
        expect(result).toMatchObject({ kind: 'tool_result', id: 'call_1', ok: true, lines: 1 });
        // `input` leaves the cached prompt out, so the context adds it back.
        expect(msg).toMatchObject({ kind: 'msg', mid: 'msg_a2', model: 'big-pickle', out: 20, ctx: 1105, thinking: 1 });
        expect(out.from).toBe(4);
    });

    it('marks a failed call as not ok', () => {
        const out = opencodeLinesOf([step(1, [{ type: 'tool', id: 'c', name: 'shell', status: 'error' }])], { from: 0, emitted: [] });
        expect(events(out.lines)[1]).toMatchObject({ kind: 'tool_result', id: 'c', ok: false });
    });

    it('sends each piece of a streaming step once, as it settles', () => {
        // Read 1: the step is mid-stream — the call has started, the text is still growing.
        const first = opencodeLinesOf(
            [user(1, 'go'), step(2, [{ type: 'tool', id: 'c1', name: 'read', status: 'running' }, { type: 'text', text: 'Rea' }], false)],
            { from: 0, emitted: [] },
        );
        expect(events(first.lines).map((e) => e.kind)).toEqual(['prompt', 'tool']);
        expect(first.from).toBe(2);

        // Read 2: the same row again, now finished. Only what is new goes out.
        const second = opencodeLinesOf(
            [step(2, [{ type: 'tool', id: 'c1', name: 'read', status: 'completed' }, { type: 'text', text: 'Read it.' }])],
            first,
        );
        expect(events(second.lines).map((e) => e.kind)).toEqual(['tool_result', 'text', 'msg']);
        expect(events(second.lines)[1]).toMatchObject({ text: 'Read it.' });
        expect(second.from).toBe(3);
        // Nothing before the read position is remembered.
        expect(second.emitted).toEqual([]);
    });

    it('holds a call back while its input is still streaming, so its target goes out with it', () => {
        // Measured on 2.0.24: a write first seen mid-stream had no input yet.
        const first = opencodeLinesOf([step(1, [{ type: 'tool', id: 'c', name: 'write', status: 'pending' }], false)], { from: 0, emitted: [] });
        expect(first.lines).toEqual([]);
        const second = opencodeLinesOf([step(1, [{ type: 'tool', id: 'c', name: 'write', status: 'running', target: '/repo/a.txt' }], false)], first);
        expect(events(second.lines)).toEqual([expect.objectContaining({ kind: 'tool', target: '/repo/a.txt' })]);
    });

    it('sends text that something already follows in an unfinished step', () => {
        const out = opencodeLinesOf(
            [step(1, [{ type: 'text', text: 'Looking.' }, { type: 'tool', id: 'c', name: 'grep', status: 'running' }], false)],
            { from: 0, emitted: [] },
        );
        expect(events(out.lines).map((e) => e.kind)).toEqual(['text', 'tool']);
    });

    it('does not let a step that never finished hold the read position for ever', () => {
        const rows = [step(1, [], false), ...Array.from({ length: OPENCODE_OPEN_WINDOW + 50 }, (_, i) => user(i + 2, `p${i}`))];
        const out = opencodeLinesOf(rows, { from: 0, emitted: [] });
        const newest = OPENCODE_OPEN_WINDOW + 51;
        expect(out.from).toBe(newest + 1);
    });

    it('closes a step that died mid-stream once a later step exists, and sends what it had', () => {
        const rows = [
            step(1, [{ type: 'text', text: 'Half a thought' }, { type: 'tool', id: 'c', name: 'edit', status: 'pending' }], false),
            step(2, [{ type: 'text', text: 'Next.' }]),
        ];
        const out = opencodeLinesOf(rows, { from: 0, emitted: [] });
        expect(events(out.lines).map((e) => e.kind)).toEqual(['text', 'tool', 'text', 'msg']);
        expect(events(out.lines)[0]).toMatchObject({ text: 'Half a thought' });
        expect(out.from).toBe(3);
    });

    it('keeps a streaming step open behind a prompt queued after it', () => {
        const rows = [step(1, [{ type: 'text', text: 'Still writi' }], false), user(2, 'also do this')];
        const out = opencodeLinesOf(rows, { from: 0, emitted: [] });
        expect(events(out.lines).map((e) => e.kind)).toEqual(['prompt']);
        expect(out.from).toBe(1);
    });

    it('says why a step failed', () => {
        const out = opencodeLinesOf([step(1, [], true, { errorType: 'provider.quota', errorText: 'Rate limit\nexceeded' })], { from: 0, emitted: [] });
        expect(events(out.lines)[0]).toMatchObject({ kind: 'text', text: 'opencode stopped: provider.quota — Rate limit exceeded' });
        expect(events(out.lines).map((e) => e.kind)).toEqual(['text', 'msg']);
    });

    it('starts a turn on a prompt of attachments alone', () => {
        const out = opencodeLinesOf([user(1, '')], { from: 0, emitted: [] });
        expect(events(out.lines)).toEqual([expect.objectContaining({ kind: 'prompt', text: '(attachment)' })]);
    });

    it('names content it cannot draw instead of dropping it', () => {
        const onUnknown = vi.fn();
        const rows = [step(1, '{not json'), step(2, [{ type: 'tool', name: 'grep', status: 'completed' }, null as never])];
        projectOpencodeEntries(opencodeLinesOf(rows, { from: 0, emitted: [] }).lines, { onUnknown });
        expect(onUnknown.mock.calls.map((c) => c[0])).toEqual([
            'opencode content that is not a list',
            'opencode tool call without an id or name',
            'opencode content item that is not an object',
        ]);
    });

    it('never moves the read position backwards', () => {
        const out = opencodeLinesOf([], { from: 7, emitted: ['7:p'] });
        expect(out).toEqual({ lines: [], from: 7, emitted: ['7:p'] });
    });

    it('cuts prose at the event cap', () => {
        const long = 'x'.repeat(MAX_EVENT_TEXT_CHARS + 1);
        const out = opencodeLinesOf([user(1, long)], { from: 0, emitted: [] });
        expect((events(out.lines)[0] as { text: string }).text.length).toBeLessThanOrEqual(MAX_EVENT_TEXT_CHARS + 1);
        expect((events(out.lines)[0] as { text: string }).text).not.toBe(long);
    });

    it('names a content type it does not draw, once', () => {
        const rows = [step(1, [{ type: 'patch' }], false)];
        const first = opencodeLinesOf(rows, { from: 0, emitted: [] });
        const second = opencodeLinesOf(rows, first);
        const onUnknown = vi.fn();
        projectOpencodeEntries([...first.lines, ...second.lines], { onUnknown });
        expect(onUnknown).toHaveBeenCalledTimes(1);
        expect(onUnknown).toHaveBeenCalledWith('opencode content type patch');
    });

    it('cuts a call target at the field cap, so one long pattern cannot outgrow a frame', () => {
        const long = 'p'.repeat(MAX_EVENT_FIELD_CHARS * 4);
        const out = opencodeLinesOf([step(1, [{ type: 'tool', id: 'c', name: 'grep', status: 'running', target: long }], false)], { from: 0, emitted: [] });
        expect((events(out.lines)[0] as { target: string }).target.length).toBeLessThanOrEqual(MAX_EVENT_FIELD_CHARS + 1);
    });

    it('reads items handed over as the JSON text sqlite3 prints', () => {
        const out = opencodeLinesOf([step(1, JSON.stringify([{ type: 'text', text: 'hi' }]))], { from: 0, emitted: [] });
        expect(events(out.lines)[0]).toMatchObject({ kind: 'text', text: 'hi' });
    });
});

describe('opencodeRowsSql', () => {
    it('refuses a session id that is not one opencode mints', () => {
        expect(() => opencodeRowsSql("ses_x' OR '1'='1", null)).toThrow();
        expect(() => opencodeRowsSql('ses_abc', 1.5)).toThrow();
        expect(opencodeRowsSql('ses_abcDEF123', 4)).toContain("m.session_id = 'ses_abcDEF123'");
    });
});

describe('projectOpencodeEntries', () => {
    it('keeps only the turn in flight on a backfill', () => {
        const lines = [
            JSON.stringify({ kind: 'prompt', text: 'one' }),
            JSON.stringify({ kind: 'text', text: 'a' }),
            JSON.stringify({ kind: 'prompt', text: 'two' }),
            JSON.stringify({ kind: 'text', text: 'b' }),
            'not json',
            JSON.stringify({ kind: 'nonsense' }),
        ];
        const out = projectOpencodeEntries(lines, { sinceLastPrompt: true });
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'text']);
        expect(out[0]).toMatchObject({ text: 'two' });
    });
});

describe('opencodeDbPath', () => {
    it('follows the overrides opencode itself follows', () => {
        expect(opencodeDbPath({ OPENCODE_DB: '/x/oc.db' })).toBe('/x/oc.db');
        expect(opencodeDbPath({ XDG_DATA_HOME: '/data' })).toBe('/data/opencode/opencode.db');
        expect(opencodeDbPath({ OPENCODE_DB: 'relative.db', XDG_DATA_HOME: '/data' })).toBe('/data/opencode/opencode.db');
    });
});

describe('readOpencodeTranscript', () => {
    const PATH = opencodeSourcePath('/store/opencode.db', 'ses_abc');

    const harness = () => {
        let clock = 10_000;
        let stamp = 's1';
        const queries: string[] = [];
        let rows: unknown[] | null = [user(1, 'hi')];
        const deps = {
            query: (_db: string, sql: string) => {
                queries.push(sql);
                return rows;
            },
            stamp: () => stamp,
            now: () => clock,
        };
        return {
            deps,
            queries,
            setRows: (r: unknown[] | null) => (rows = r),
            touch: (s: string) => (stamp = s),
            tick: (ms: number) => (clock += ms),
        };
    };

    it('backfills on the first read, then asks only from where it stopped', () => {
        const h = harness();
        const first = readOpencodeTranscript(PATH, null, h.deps);
        expect(first?.lines).toHaveLength(1);
        expect(h.queries[0]).toContain('ORDER BY m.seq DESC LIMIT');

        h.touch('s2');
        h.tick(OPENCODE_MIN_QUERY_MS);
        h.setRows([user(2, 'again')]);
        const second = readOpencodeTranscript(PATH, first!.state, h.deps);
        expect(h.queries[1]).toContain('m.seq >= 2');
        expect(events(second!.lines)).toEqual([expect.objectContaining({ text: 'again' })]);
    });

    // The path comes back from the recorder's state file too, and its store part goes to `sqlite3` as an argument.
    it('reads nothing from a store path that is not absolute', () => {
        const h = harness();
        expect(readOpencodeTranscript('-cmd#ses_abc', null, h.deps)).toBeNull();
        expect(readOpencodeTranscript('rel/opencode.db#ses_abc', null, h.deps)).toBeNull();
        expect(h.queries).toHaveLength(0);
    });

    it('does not query when the store has not moved', () => {
        const h = harness();
        const first = readOpencodeTranscript(PATH, null, h.deps)!;
        h.tick(OPENCODE_MIN_QUERY_MS * 5);
        expect(readOpencodeTranscript(PATH, first.state, h.deps)).toBeNull();
        expect(h.queries).toHaveLength(1);
    });

    it('queries one session at most once a second, however often the store moves', () => {
        const h = harness();
        const first = readOpencodeTranscript(PATH, null, h.deps)!;
        h.touch('s2');
        h.tick(OPENCODE_MIN_QUERY_MS - 1);
        expect(readOpencodeTranscript(PATH, first.state, h.deps)).toBeNull();
        h.tick(1);
        expect(readOpencodeTranscript(PATH, first.state, h.deps)).not.toBeNull();
        expect(h.queries).toHaveLength(2);
    });

    it('reads nothing, and throws nothing, when sqlite3 fails', () => {
        const h = harness();
        h.setRows(null);
        expect(readOpencodeTranscript(opencodeSourcePath('/store/opencode.db', 'ses_fail1'), null, h.deps)).toBeNull();
    });

    it('asks a failing store at most once a second too', () => {
        const h = harness();
        const path = opencodeSourcePath('/store/opencode.db', 'ses_fail2');
        h.setRows(null);
        readOpencodeTranscript(path, null, h.deps);
        h.tick(OPENCODE_MIN_QUERY_MS - 1);
        expect(readOpencodeTranscript(path, null, h.deps)).toBeNull();
        expect(h.queries).toHaveLength(1);
        h.tick(1);
        h.setRows([user(1, 'back')]);
        expect(readOpencodeTranscript(path, null, h.deps)?.lines).toHaveLength(1);
        expect(h.queries).toHaveLength(2);
    });

    it('skips a row that is not shaped like one the query returns', () => {
        const h = harness();
        h.setRows([{ seq: 'one', type: 'user', id: 'm' }, null, user(2, 'kept')]);
        const read = readOpencodeTranscript(opencodeSourcePath('/store/opencode.db', 'ses_rows'), null, h.deps);
        expect(events(read!.lines)).toEqual([expect.objectContaining({ text: 'kept' })]);
    });

    it('reads nothing from a path that does not name a session', () => {
        const h = harness();
        expect(readOpencodeTranscript('/store/opencode.db', null, h.deps)).toBeNull();
        expect(readOpencodeTranscript("/store/opencode.db#ses_x'--", null, h.deps)).toBeNull();
        expect(h.queries).toEqual([]);
    });

    it('starts over when the state belongs to another session', () => {
        const h = harness();
        const first = readOpencodeTranscript(PATH, null, h.deps)!;
        h.touch('s2');
        h.tick(OPENCODE_MIN_QUERY_MS);
        readOpencodeTranscript(opencodeSourcePath('/store/opencode.db', 'ses_other'), first.state, h.deps);
        expect(h.queries[1]).toContain('ORDER BY m.seq DESC LIMIT');
    });
});

/**
 * The SQL against a real SQLite file with opencode 2.0.24's own `CREATE TABLE`
 * (copied from `.schema` on this machine), so a renamed column or a JSON path
 * that does not match fails here — the unit tests above inject rows and never
 * run the query.
 */
describe('readOpencodeTranscript against a real opencode store', () => {
    const SCHEMA = `CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        );`;

    const sqlite = (db: string, sql: string) => {
        const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf-8' });
        if (r.status !== 0) throw new Error(`sqlite3 setup failed: ${r.stderr}`);
    };
    const insert = (db: string, seq: number, type: string, data: unknown) =>
        sqlite(db, `INSERT INTO session_message VALUES ('msg_${seq}', 'ses_real1', '${type}', ${seq}, ${T0 + seq}, ${T0 + seq}, '${JSON.stringify(data).replace(/'/g, "''")}');`);

    it('reads prompt, tool call, result line count and usage out of the stored JSON', () => {
        const db = join(mkdtempSync(join(tmpdir(), 'hwip-oc-')), 'opencode.db');
        sqlite(db, SCHEMA);
        insert(db, 1, 'user', { text: 'make it', time: { created: T0 + 1 }, files: [], agents: [], skills: [] });
        insert(db, 2, 'assistant', {
            agent: 'build',
            model: { providerID: 'opencode', id: 'big-pickle', variant: 'default' },
            content: [
                { type: 'reasoning', text: 'thinking', time: { created: T0 + 2 } },
                {
                    type: 'tool', id: 'call_9', name: 'read',
                    state: { status: 'completed', input: { filePath: '/repo/a.ts', limit: 5 }, content: [{ type: 'text', text: 'l1\nl2\nl3' }], metadata: {} },
                    time: { created: T0 + 3, ran: T0 + 4, completed: T0 + 5 },
                },
                { type: 'tool', id: 'call_10', name: 'shell', state: { status: 'running', input: { command: 'secret --token x' } } },
            ],
            tokens: { input: 279, output: 282, reasoning: 0, cache: { read: 140145, write: 0 } },
            time: { created: T0 + 2, completed: T0 + 9 },
            finish: 'stop',
        });
        insert(db, 3, 'idle', { time: T0 + 10, outcome: 'succeeded' });

        const read = readOpencodeTranscript(opencodeSourcePath(db, 'ses_real1'), null, { query: sqliteJson });
        const out = events(read!.lines);
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'tool', 'tool_result', 'tool', 'msg']);
        expect(out[1]).toMatchObject({ id: 'call_9', name: 'read', target: '/repo/a.ts', at: new Date(T0 + 3).toISOString() });
        expect(out[2]).toMatchObject({ id: 'call_9', ok: true, lines: 3 });
        // A command line is never a target.
        expect(out[3]).toEqual(expect.not.objectContaining({ target: expect.anything() }));
        expect(out[4]).toMatchObject({ mid: 'msg_2', model: 'big-pickle', out: 282, ctx: 279 + 140145, thinking: 1 });
    });
});
