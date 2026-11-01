import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    HERMES_MIN_QUERY_MS,
    hermesLinesOf,
    hermesRowsSql,
    hermesSourcePath,
    projectHermesEntries,
    readHermesTranscript,
    type HermesRow,
} from './hermes-transcript.js';
import { sqliteJson } from './remote-agents.js';
import { MAX_EVENT_TEXT_CHARS, type TurnEvent } from './transcript-tail.js';

/**
 * Rows shaped like what `hermesRowsSql` returns, built by hand from the
 * hermes 0.20.0 store's structure (see the module header) — no row of a real
 * conversation is copied here.
 */
const T0 = 1_793_437_342; // seconds

const user = (id: number, text: string): HermesRow => ({ id, role: 'user', ts: T0 + id, text });
const reply = (id: number, text: string, tools?: HermesRow['tools']): HermesRow => ({ id, role: 'assistant', ts: T0 + id, text, tools });
const result = (id: number, callId: string, lines = 3): HermesRow => ({ id, role: 'tool', ts: T0 + id, callId, lines });

const events = (rows: HermesRow[]): TurnEvent[] => projectHermesEntries(hermesLinesOf(rows));

describe('hermes transcript projects', () => {
    it('projects a prompt, a tool round trip and the reply in order', () => {
        const out = events([
            user(1, 'read the file'),
            reply(2, '', [{ id: 'call_1', name: 'read_file', target: '/tmp/a.txt' }]),
            result(3, 'call_1', 12),
            reply(4, 'done'),
        ]);
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'tool', 'tool_result', 'text']);
        expect(out[1]).toMatchObject({ kind: 'tool', id: 'call_1', name: 'read_file', target: '/tmp/a.txt' });
        expect(out[2]).toMatchObject({ kind: 'tool_result', id: 'call_1', ok: true, lines: 12 });
        expect(out[3]).toMatchObject({ kind: 'text', text: 'done' });
    });

    it('stamps seconds as an ISO time, not 1970', () => {
        const [prompt] = events([user(1, 'hi')]);
        expect(prompt?.at).toBe(new Date(T0 * 1000 + 1000).toISOString());
    });

    it('draws no empty reply for an assistant row that only calls tools', () => {
        const out = events([user(1, 'go'), reply(2, '  ', [{ id: 'c', name: 'ls' }])]);
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'tool']);
    });

    it('cuts prose at the event cap', () => {
        const [prompt] = events([user(1, 'x'.repeat(MAX_EVENT_TEXT_CHARS * 2))]);
        expect((prompt as { text: string }).text.length).toBeLessThanOrEqual(MAX_EVENT_TEXT_CHARS);
    });

    it('skips a malformed tool list without throwing and names it', () => {
        const unknown: string[] = [];
        const lines = hermesLinesOf([user(1, 'go'), reply(2, 'x', 'not json'), reply(3, 'y', [{ name: 'no id' } as never])]);
        const out = projectHermesEntries(lines, { onUnknown: (w) => unknown.push(w) });
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'text', 'text']);
        expect(unknown).toHaveLength(2);
    });

    it('keeps only the turn in flight on a backfill', () => {
        const rows = [user(1, 'old'), reply(2, 'old reply'), user(3, 'new'), reply(4, 'new reply')];
        const out = projectHermesEntries(hermesLinesOf(rows), { sinceLastPrompt: true });
        expect(out.map((e) => e.kind)).toEqual(['prompt', 'text']);
        expect((out[0] as { text: string }).text).toBe('new');
    });
});

describe('hermes transcript never carries a command', () => {
    it('drops command and cmd arguments in SQL, keeps a path', () => {
        const db = join(mkdtempSync(join(tmpdir(), 'hwip-hermes-')), 'state.db');
        const calls = JSON.stringify([
            { id: 'c1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer SECRET"' }) } },
            { id: 'c2', type: 'function', function: { name: 'sh', arguments: JSON.stringify({ cmd: 'echo SECRET' }) } },
            { id: 'c3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/ok.txt', command: 'SECRET' }) } },
            { id: 'c4', type: 'function', function: { name: 'broken', arguments: 'not json SECRET' } },
        ]).replace(/'/g, "''");
        const sql = `
            CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
              tool_call_id TEXT, tool_calls TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1);
            INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_1', 'user', 'go', ${T0});
            INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES ('s_1', 'assistant', '', '${calls}', ${T0 + 1});
            INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES ('s_1', 'tool', 'a
b
c', 'c3', ${T0 + 2});
            INSERT INTO messages (session_id, role, content, timestamp, active) VALUES ('s_1', 'user', 'rewound', ${T0 + 3}, 0);
            INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_2', 'user', 'other session', ${T0 + 4});`;
        const made = spawnSync('sqlite3', [db, sql], { encoding: 'utf-8' });
        expect(made.status).toBe(0);

        const rows = sqliteJson(db, hermesRowsSql('s_1', null));
        expect(rows).not.toBeNull();
        const out = projectHermesEntries(hermesLinesOf(rows as HermesRow[]));
        expect(JSON.stringify(out)).not.toContain('SECRET');
        expect(out.filter((e) => e.kind === 'tool').map((e) => (e as { target?: string }).target)).toEqual([undefined, undefined, '/tmp/ok.txt', undefined]);
        expect(out.find((e) => e.kind === 'tool_result')).toMatchObject({ id: 'c3', lines: 3 });
        expect(out.some((e) => e.kind === 'prompt' && (e as { text: string }).text === 'rewound')).toBe(false);
        expect(out.some((e) => e.kind === 'prompt' && (e as { text: string }).text === 'other session')).toBe(false);
    });
});

describe('hermes transcript reader', () => {
    const db = '/tmp/hermes-state.db';
    const path = hermesSourcePath(db, 's_1');

    it('reads the backfill, then only rows after the last id', () => {
        let clock = 10_000;
        const query = vi.fn((_db: string, sql: string) => (sql.includes('ORDER BY m.id DESC') ? [user(1, 'a'), reply(2, 'b')] : [reply(3, 'c')]));
        const deps = { query, stamp: () => 'v1', now: () => clock };
        const first = readHermesTranscript(path, null, deps);
        expect(first?.lines).toHaveLength(2);
        clock += HERMES_MIN_QUERY_MS;
        const second = readHermesTranscript(path, first!.state, { ...deps, stamp: () => 'v2' });
        expect(second?.lines).toHaveLength(1);
        expect(query.mock.calls[1]![1]).toContain('m.id >= 3');
    });

    it('returns null when the store did not change, or inside the minimum interval', () => {
        let clock = 10_000;
        const query = vi.fn(() => [user(1, 'a')]);
        const deps = { query, stamp: () => 'v1', now: () => clock };
        const first = readHermesTranscript(path, null, deps)!;
        clock += HERMES_MIN_QUERY_MS;
        expect(readHermesTranscript(path, first.state, deps)).toBeNull(); // same stamp
        expect(readHermesTranscript(path, first.state, { ...deps, stamp: () => 'v2', now: () => clock - 1 })).toBeNull(); // too soon
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('starts over when the pane moves to another session', () => {
        const clock = 10_000;
        const query = vi.fn(() => [user(7, 'a')]);
        const first = readHermesTranscript(path, null, { query, stamp: () => 'v1', now: () => clock })!;
        readHermesTranscript(hermesSourcePath(db, 's_2'), first.state, { query, stamp: () => 'v2', now: () => clock + 5000 });
        expect(query.mock.calls[1]![1]).toContain('ORDER BY m.id DESC');
    });

    it('returns null when the query fails', () => {
        expect(readHermesTranscript(path, null, { query: () => null, stamp: () => 'v1', now: () => 10_000 })).toBeNull();
    });
});

describe('hermes transcript session id', () => {
    it('refuses an id that could carry SQL, before any query is built', () => {
        for (const bad of ["x'; DROP TABLE messages; --", '', 'a b', '../x', 'x'.repeat(97)]) {
            expect(() => hermesRowsSql(bad, null)).toThrow();
        }
        expect(() => hermesRowsSql('20260814_112441_5d0c6f', null)).not.toThrow();
    });

    it('reads nothing from a path whose id or db is not safe', () => {
        const query = vi.fn(() => []);
        const deps = { query, stamp: () => 'v', now: () => 10_000 };
        expect(readHermesTranscript("/tmp/state.db#x'; --", null, deps)).toBeNull();
        expect(readHermesTranscript('relative.db#s_1', null, deps)).toBeNull();
        expect(readHermesTranscript('-n#s_1', null, deps)).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });
});
