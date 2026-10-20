import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The unit tests for these resolvers inject rows, which proves the join and the
 * unit conversions but never the SQL string or the schema it runs against — the
 * two things that break when an agent migrates its store. These cases build a
 * real SQLite file with the real `CREATE TABLE` (copied from the shipped stores)
 * and let the resolver find its own way to it, so a renamed column or a moved
 * file fails here instead of silently returning no name in production.
 *
 * They also close the observation gap those agents leave on this machine: every
 * measured Hermes row has a NULL title and the Codex thread table is empty, so
 * nothing live can demonstrate a name actually arriving.
 */
const sqlite = (db: string, sql: string) => {
    const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`sqlite3 setup failed: ${r.stderr}`);
};

const HERMES_SCHEMA = `CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT,
    started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT
);`;

const CODEX_SCHEMA = `CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
    created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER, name TEXT
);`;

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'hwip-store-read-'));
    process.env.HOME = TMP;
    // The store paths are computed at module load — re-import per test.
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/** This process's own start time, so a row can be stamped to match it. */
const ownProcStart = async (): Promise<number> => {
    const { psStartTimes } = await import('./remote-agents.js');
    const started = psStartTimes().get(process.pid);
    if (started === undefined) throw new Error('ps did not report a start time for this process');
    return started;
};

describe('Hermes store, read for real', () => {
    it('finds the title of the row stamped when this process started', async () => {
        const started = await ownProcStart();
        const db = join(TMP, '.hermes', 'state.db');
        mkdirSync(join(TMP, '.hermes'), { recursive: true });
        sqlite(db, HERMES_SCHEMA);
        // started_at in SECONDS, as Hermes writes it.
        sqlite(db, `INSERT INTO sessions (id, source, started_at, cwd, title) VALUES
            ('20260814_115454_01b750', 'cli', ${started / 1_000}, '${TMP}', 'Fix listener race'),
            ('20260814_112441_5d0c6f', 'cli', ${started / 1_000 - 3_600}, '${TMP}', 'An hour earlier');`);

        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toEqual({ name: 'Fix listener race', source: 'auto' });
    });

    it('returns null when the store has no row for this directory', async () => {
        const started = await ownProcStart();
        const db = join(TMP, '.hermes', 'state.db');
        mkdirSync(join(TMP, '.hermes'), { recursive: true });
        sqlite(db, HERMES_SCHEMA);
        sqlite(db, `INSERT INTO sessions (id, source, started_at, cwd, title)
            VALUES ('x', 'cli', ${started / 1_000}, '/somewhere/else', 'Other');`);

        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toBeNull();
    });

    it('returns null when the store does not exist', async () => {
        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toBeNull();
    });

    it('finds the session `-c` carried on by its last message, not its start', async () => {
        const started = await ownProcStart();
        const db = join(TMP, '.hermes', 'state.db');
        mkdirSync(join(TMP, '.hermes'), { recursive: true });
        sqlite(db, HERMES_SCHEMA);
        // hermes 0.20.0's columns this read touches.
        sqlite(db, 'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp REAL NOT NULL);');
        sqlite(db, `INSERT INTO sessions (id, source, started_at, cwd) VALUES
            ('20261020_171203_c60148', 'cli', ${started / 1_000 - 86_400}, '${TMP}'),
            ('20261019_090000_aaaaaa', 'cli', ${started / 1_000 - 3_600}, '${TMP}');
            INSERT INTO messages (session_id, timestamp) VALUES
            ('20261020_171203_c60148', ${started / 1_000 - 86_000}),
            ('20261020_171203_c60148', ${started / 1_000 + 1}),
            ('20261019_090000_aaaaaa', ${started / 1_000 - 3_500});`);

        const { detectHermesResumeId } = await import('./remote-agents.js');
        expect(detectHermesResumeId(TMP, process.pid)).toBe('20261020_171203_c60148');
    });
});

// opencode 2.0.24's own `CREATE TABLE`s (`.schema`, this machine, 2026-10-10).
const OPENCODE_SCHEMA = `CREATE TABLE \`session_v2\` (
          \`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text,
          \`fork_session_id\` text, \`fork_boundary\` text, \`slug\` text NOT NULL, \`directory\` text NOT NULL,
          \`path\` text, \`title\` text, \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer,
          \`summary_deletions\` integer, \`summary_files\` integer, \`summary_diffs\` text, \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL, \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text, \`permission\` text, \`agent\` text, \`model\` text,
          \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`time_compacting\` integer, \`time_archived\` integer,
          \`time_suspended\` integer, \`resume_attempts\` integer DEFAULT 0 NOT NULL, \`time_idle\` integer, \`time_viewed\` integer, \`idle_outcome\` text);
    CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`type\` text NOT NULL, \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL);`;

describe('opencode store, read for real', () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const originalDb = process.env.OPENCODE_DB;
    afterEach(() => {
        if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdg;
        if (originalDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = originalDb;
    });

    it('finds the session this pane wrote to, in the directory opencode recorded', async () => {
        delete process.env.XDG_DATA_HOME;
        delete process.env.OPENCODE_DB;
        const started = await ownProcStart();
        mkdirSync(join(TMP, '.local', 'share', 'opencode'), { recursive: true });
        const db = join(TMP, '.local', 'share', 'opencode', 'opencode.db');
        sqlite(db, OPENCODE_SCHEMA);
        // opencode records the real path; the pane may report the other one.
        const dir = realpathSync(TMP);
        const session = (id: string, parent: string | null, title: string | null) =>
            `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES ('${id}', 'p', ${parent ? `'${parent}'` : 'NULL'}, 's', '${dir}', ${title ? `'${title}'` : 'NULL'}, '2.0.24', ${started}, ${started});`;
        const message = (id: string, sid: string, at: number) =>
            `INSERT INTO session_message VALUES ('${id}', '${sid}', 'user', 1, ${at}, ${at}, '{}');`;
        sqlite(db, session('ses_main1', null, 'Ping test check-in')
            + session('ses_child1', 'ses_main1', 'A subagent')
            + session('ses_stale1', null, 'Yesterday')
            + message('m1', 'ses_main1', started + 2_000)
            + message('m2', 'ses_child1', started + 9_000)
            + message('m3', 'ses_stale1', started - 86_400_000));

        const { detectOpencodeSession, opencodeTranscriptPath, REMOTE_AGENTS } = await import('./remote-agents.js');
        expect(detectOpencodeSession(TMP, process.pid)).toEqual({ id: 'ses_main1', title: 'Ping test check-in' });
        expect(opencodeTranscriptPath(TMP, process.pid)).toBe(`${db}#ses_main1`);
        // What the report sends: the row's own resolvers, id and title each in its place.
        const row = REMOTE_AGENTS.find((a) => a.kind === 'opencode');
        expect(row?.resolveSessionId?.(TMP, process.pid)).toBe('ses_main1');
        expect(row?.resolveSessionName?.(TMP, process.pid)).toEqual({ name: 'Ping test check-in', source: 'auto' });
    });

    // C140: the recorder follows the session through the real reader and SQL, a step rewritten in
    // place goes out once it is over, and a restart goes on from the cursor in the state file.
    it('records a session from the store, a step rewritten in place once, across a restart', async () => {
        const db = join(TMP, 'opencode.db');
        sqlite(db, OPENCODE_SCHEMA);
        const t0 = Date.UTC(2026, 9, 10, 9);
        // `data` is opencode's own JSON column, whatever shape a row type gives it.
        const put = (id: string, seq: number, type: string, data: Record<string, unknown>) =>
            sqlite(db, `INSERT OR REPLACE INTO session_message VALUES ('${id}', 'ses_rec1', '${type}', ${seq}, ${t0 + seq}, ${t0 + seq}, '${JSON.stringify(data)}');`);
        put('m1', 1, 'user', { text: 'what is in a.ts' });
        put('m2', 2, 'assistant', { content: [{ type: 'text', text: 'Reading' }], time: { created: t0 + 2 } });

        const { sqliteJson } = await import('./remote-agents.js');
        const { projectOpencodeEntries, readOpencodeTranscript } = await import('./opencode-transcript.js');
        const { createTurnRecorder } = await import('./turn-recorder.js');
        let clock = t0 + 60_000;
        const uploads: string[] = [];
        const make = () => createTurnRecorder({
            dir: join(TMP, 'state'),
            deviceId: () => 'dev_rec',
            uploadReady: () => true,
            devicePublicKey: () => 'k',
            projectorFor: (k) => (k === 'opencode' ? projectOpencodeEntries : null),
            readerFor: (k) => (k === 'opencode' ? (path, prev) => readOpencodeTranscript(path, prev, { query: sqliteJson, now: () => clock }) : null),
            recipients: async () => [{ deviceId: 'dev_phone', publicKey: 'p' }],
            seal: async (plaintext) => ({ body: plaintext, deviceKeyMap: { dev_phone: 'k' }, senderPublicKey: 'k' }),
            upload: async (_key, chunk) => {
                for (const e of (JSON.parse(chunk.sealed.body) as { events: { kind: string; text?: string }[] }).events) uploads.push(e.text ?? e.kind);
                return { kind: 'ok' };
            },
            log: () => {},
            now: () => clock,
        });
        const run = async (r: ReturnType<typeof make>) => {
            for (let i = 0; i < 4; i++) {
                clock += 1_000;
                r.observe({ 'hwip-oc': { path: `${db}#ses_rec1`, kind: 'opencode' } });
                await r.tick();
            }
        };

        const first = make();
        await run(first);
        // The step is still streaming: its text may yet change, so only the prompt is out.
        expect(uploads).toEqual(['what is in a.ts']);

        first.stop();
        put('m2', 2, 'assistant', { content: [{ type: 'text', text: 'Reading a.ts: one export.' }], time: { created: t0 + 2, completed: t0 + 9 }, tokens: { output: 7 } });
        const second = make();
        await run(second);
        expect(uploads).toEqual(['what is in a.ts', 'Reading a.ts: one export.', 'msg']);
    });
});

describe('Codex store, read for real', () => {
    it('finds the newest schema version and reads the thread name from it', async () => {
        const started = await ownProcStart();
        mkdirSync(join(TMP, '.codex'), { recursive: true });
        // An older version file that must be ignored, and the current one.
        const stale = join(TMP, '.codex', 'state_5.sqlite');
        sqlite(stale, CODEX_SCHEMA);
        sqlite(stale, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms, name)
            VALUES ('old', '${TMP}', 'From the old schema', 0, ${started}, 'stale db');`);
        const current = join(TMP, '.codex', 'state_10.sqlite');
        sqlite(current, CODEX_SCHEMA);
        sqlite(current, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms, name)
            VALUES ('new', '${TMP}', 'Investigate flaky deploy', 0, ${started}, 'deploy audit');`);

        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toEqual({ name: 'deploy audit', source: 'user' });
    });

    it('reads the generated title when the thread was never named', async () => {
        const started = await ownProcStart();
        mkdirSync(join(TMP, '.codex'), { recursive: true });
        const db = join(TMP, '.codex', 'state_5.sqlite');
        sqlite(db, CODEX_SCHEMA);
        // created_at_ms NULL, as rows written before that column exist — the
        // seconds column has to carry the match.
        sqlite(db, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms)
            VALUES ('t', '${TMP}', 'Investigate flaky deploy', ${Math.floor(started / 1_000)}, NULL);`);

        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toEqual({ name: 'Investigate flaky deploy', source: 'auto' });
    });

    it('returns null when codex was never installed here', async () => {
        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toBeNull();
    });
});
