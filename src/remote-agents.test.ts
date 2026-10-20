import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscriptDelta } from './transcript-tail.js';
import { detectClaudeProviderName, detectClaudeSessionIdByPid, findAgentBySubcommand, matchAgentByPaneCommand, REMOTE_AGENTS } from './remote-agents.js';

// Top-level CLI commands the registry's subcommands must never collide
// with — dispatch checks the registry BEFORE the switch, so a collision
// would shadow the built-in command.
const RESERVED_COMMANDS = [
    'install', 'setup', 'login', 'uninstall', 'verify', 'check-update',
    'notify', 'list', 'dismiss', 'test', 'listener', 'help',
];

describe('remote-agents.ts: table invariants', () => {
    it('kinds are unique', () => {
        const kinds = REMOTE_AGENTS.map((a) => a.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
    });

    it('subcommands are globally unique across rows', () => {
        const all = REMOTE_AGENTS.flatMap((a) => [...a.subcommands]);
        expect(new Set(all).size).toBe(all.length);
    });

    // A row that can find a transcript but not read one is the worst of the
    // three states: the watcher accepts the watch, tails a file nothing parses,
    // and the phone shows an empty timeline that reads as a hung agent. The
    // honest `no_transcript` a resolver-less row produces is strictly better,
    // so half a pair must fail here rather than on someone's phone.
    it('a row resolves a transcript and reads it, or does neither', () => {
        for (const a of REMOTE_AGENTS) {
            expect(
                Boolean(a.resolveTranscript),
                `${a.kind}: resolveTranscript and projectTranscript must be set together`,
            ).toBe(Boolean(a.projectTranscript));
        }
    });

    // Cursor and Hermes stay unmeasured (Cursor: no TUI transcript seen;
    // Hermes: SQLite, no reply rows seen), so a projector for either would be a
    // guess. opencode carries the pair since its 2.x store was read (C137).
    it('gemini and opencode carry the transcript pair; cursor and hermes still carry none', () => {
        for (const kind of ['gemini', 'opencode']) {
            const row = REMOTE_AGENTS.find((a) => a.kind === kind);
            expect(typeof row?.resolveTranscript, kind).toBe('function');
            expect(typeof row?.projectTranscript, kind).toBe('function');
        }
        for (const kind of ['cursor', 'hermes']) {
            const row = REMOTE_AGENTS.find((a) => a.kind === kind);
            expect(row?.resolveTranscript, kind).toBeUndefined();
            expect(row?.projectTranscript, kind).toBeUndefined();
        }
    });

    // A reader with no path to read is dead code, and the file tailer is the
    // reader for every row whose transcript is a file — only opencode's is not.
    it('only a row that resolves a transcript carries its own reader, and only opencode does', () => {
        for (const a of REMOTE_AGENTS) {
            if (a.readTranscript) expect(a.resolveTranscript, a.kind).toBeDefined();
        }
        expect(REMOTE_AGENTS.filter((a) => a.readTranscript).map((a) => a.kind)).toEqual(['opencode']);
    });

    it('no subcommand collides with a built-in CLI command', () => {
        const all = REMOTE_AGENTS.flatMap((a) => [...a.subcommands]);
        for (const sub of all) expect(RESERVED_COMMANDS).not.toContain(sub);
    });

    // `--help` builds its agent list from this table, so it can never drift.
    // The README lists them by hand, which is how a shipped agent ends up
    // documented nowhere. This is the only thing that notices.
    it('every agent is documented in the README', () => {
        const readme = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
            'utf-8',
        );
        for (const a of REMOTE_AGENTS) {
            expect(readme, `README.md never mentions \`hwip ${a.subcommands[0]}\``)
                .toContain(`hwip ${a.subcommands[0]}`);
        }
    });

    it('every row has at least one subcommand and a binary', () => {
        for (const a of REMOTE_AGENTS) {
            expect(a.subcommands.length).toBeGreaterThan(0);
            expect(a.binary.length).toBeGreaterThan(0);
        }
    });

    it('only claude and opencode carry a session resolver (every other row is a documented stub)', () => {
        for (const a of REMOTE_AGENTS) {
            if (a.kind === 'claude' || a.kind === 'opencode') expect(typeof a.resolveSessionId).toBe('function');
            else expect(a.resolveSessionId).toBeUndefined();
        }
    });

    // Twin of the invariant above, for the name axis. Gemini and Cursor store no
    // session name at all (their state files carry ids and timestamps only), so a
    // resolver appearing on those rows means someone invented a name — which is
    // exactly the drift this table is here to notice.
    it('cursor and gemini never carry a session-name resolver (no name exists to read)', () => {
        for (const a of REMOTE_AGENTS) {
            if (a.kind === 'cursor' || a.kind === 'gemini') expect(a.resolveSessionName).toBeUndefined();
        }
    });

    // A quit command is typed into a live pane, so each one stands for a run on
    // the real binary (opencode 2.0.24: `/exit` + Enter closed the TUI).
    it('quits only the agents whose command was typed into a real pane', () => {
        const quits = Object.fromEntries(REMOTE_AGENTS.filter((a) => a.quitCommand).map((a) => [a.kind, a.quitCommand]));
        expect(quits).toEqual({ claude: '/exit', opencode: '/exit' });
    });

    /**
     * The rows are the only thing wiring a resolver into the report — every
     * resolver test calls the function directly, so a row that never got its
     * `resolveSessionName` leaves the whole feature dead with a green suite.
     */
    it('every agent with a readable name store is wired to its resolver', () => {
        for (const kind of ['claude', 'hermes', 'codex', 'opencode', 'pi'] as const) {
            const row = REMOTE_AGENTS.find((a) => a.kind === kind);
            expect(typeof row?.resolveSessionName, `${kind} row lost its name resolver`).toBe('function');
        }
    });
});

describe('remote-agents.ts: lookups', () => {
    it('findAgentBySubcommand maps cc → claude (alias support)', () => {
        expect(findAgentBySubcommand('cc')?.kind).toBe('claude');
        expect(findAgentBySubcommand('claude')?.kind).toBe('claude');
        expect(findAgentBySubcommand('codex')?.kind).toBe('codex');
        expect(findAgentBySubcommand('gemini')?.kind).toBe('gemini');
        expect(findAgentBySubcommand('hermes')?.kind).toBe('hermes');
        expect(findAgentBySubcommand('pi')?.kind).toBe('pi');
        expect(findAgentBySubcommand('opencode')?.kind).toBe('opencode');
    });

    it('the minimum-row agents launch by their own binary', () => {
        const rows = [
            ['kimi', 'kimi', 'kimi'],
            ['grok', 'grok', 'grok'],
            ['agy', 'antigravity', 'agy'],
            ['antigravity', 'antigravity', 'agy'],
            ['qwen', 'qwen', 'qwen'],
            ['auggie', 'auggie', 'auggie'],
            ['kilo', 'kilo', 'kilo'],
            ['copilot', 'copilot', 'copilot'],
            ['kiro-cli', 'kiro', 'kiro-cli'],
            // `kiro` is the IDE launcher on PATH; the alias still runs kiro-cli.
            ['kiro', 'kiro', 'kiro-cli'],
            ['droid', 'droid', 'droid'],
        ] as const;
        for (const [subcommand, kind, binary] of rows) {
            expect(findAgentBySubcommand(subcommand)?.kind, subcommand).toBe(kind);
            expect(findAgentBySubcommand(subcommand)?.binary, subcommand).toBe(binary);
            expect(matchAgentByPaneCommand(binary)?.kind, binary).toBe(kind);
        }
    });

    it('kiro is a launch alias only — the bare `kiro` pane is the IDE launcher', () => {
        expect(matchAgentByPaneCommand('kiro')).toBeUndefined();
        expect(matchAgentByPaneCommand('antigravity')).toBeUndefined();
    });

    it('no subcommand or kind is claimed by two rows', () => {
        const subcommands = REMOTE_AGENTS.flatMap((a) => a.subcommands);
        expect(new Set(subcommands).size).toBe(subcommands.length);
        expect(new Set(REMOTE_AGENTS.map((a) => a.kind)).size).toBe(REMOTE_AGENTS.length);
    });

    it('cursor launches the terminal TUI, never the IDE launcher', () => {
        expect(findAgentBySubcommand('cursor')?.binary).toBe('cursor-agent');
        expect(findAgentBySubcommand('cursor-agent')?.kind).toBe('cursor');
    });

    it('matchAgentByPaneCommand accepts registered binaries only', () => {
        expect(matchAgentByPaneCommand('claude')?.kind).toBe('claude');
        expect(matchAgentByPaneCommand('codex')?.kind).toBe('codex');
        expect(matchAgentByPaneCommand('cursor-agent')?.kind).toBe('cursor');
        // The IDE launcher is not an agent pane — a `cursor` pane is someone
        // opening the editor, and adopting it would address a dead session.
        expect(matchAgentByPaneCommand('cursor')).toBeUndefined();
        expect(matchAgentByPaneCommand('hermes')?.kind).toBe('hermes');
        expect(matchAgentByPaneCommand('pi')?.kind).toBe('pi');
        expect(matchAgentByPaneCommand('opencode')?.kind).toBe('opencode');
        expect(matchAgentByPaneCommand('bash')).toBeUndefined();
        expect(matchAgentByPaneCommand('node')).toBeUndefined();
        expect(matchAgentByPaneCommand('')).toBeUndefined();
    });

    // Guards the no-paneMatchAliases decision on the hermes row (see the
    // comment there) against being undone as a "fix" for a pane that stopped
    // matching.
    it('never adopts a bare interpreter pane as an agent', () => {
        expect(matchAgentByPaneCommand('python')).toBeUndefined();
        expect(matchAgentByPaneCommand('python3')).toBeUndefined();
        expect(matchAgentByPaneCommand('python3.11')).toBeUndefined();
    });
});

// ── detectClaudeSessionId (moved here from listener.ts) ──────────

const ENV_KEYS = ['HOME', 'GEMINI_CLI_HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'hwip-remote-agents-test-'));
    process.env.HOME = TMP;
    delete process.env.GEMINI_CLI_HOME;
    // CLAUDE_PROJECTS_DIR is computed at module load — reset so the
    // re-import below picks up the overridden HOME (and a fresh cache).
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

describe('remote-agents.ts: detectClaudeSessionId', () => {
    const UUID_OLD = '11111111-1111-1111-1111-111111111111';
    const UUID_NEW = '22222222-2222-2222-2222-222222222222';

    it('returns the most recently modified <uuid>.jsonl for the cwd', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        const cwd = '/some/project';
        const sessionsDir = join(TMP, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        const past = new Date(Date.now() - 60_000);
        writeFileSync(join(sessionsDir, `${UUID_OLD}.jsonl`), '{}');
        const { utimesSync } = await import('node:fs');
        utimesSync(join(sessionsDir, `${UUID_OLD}.jsonl`), past, past);
        writeFileSync(join(sessionsDir, `${UUID_NEW}.jsonl`), '{}');
        expect(detectClaudeSessionId(cwd)).toBe(UUID_NEW);
    });

    it('ignores non-uuid files and returns null when nothing matches', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        const cwd = '/other/project';
        const sessionsDir = join(TMP, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, 'notes.txt'), 'x');
        expect(detectClaudeSessionId(cwd)).toBeNull();
    });

    it('returns null when the projects dir does not exist', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        expect(detectClaudeSessionId('/never/seen')).toBeNull();
    });

    // C60: Claude Code flattens `_`, spaces and Hangul too, so a repo like
    // `llm_wiki` had no session and no live timeline.
    it('finds the session of a cwd with an underscore, space and Hangul', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        const sessionsDir = join(TMP, '.claude', 'projects', '-Users-x--------work-llm-wiki');
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${UUID_NEW}.jsonl`), '{}');
        expect(detectClaudeSessionId('/Users/x/내 프로젝트/work/llm_wiki')).toBe(UUID_NEW);
    });
});

describe('remote-agents.ts: claudeProjectDirName', () => {
    // Pairs read off a real ~/.claude/projects against each session's cwd.
    it.each([
        ['/Users/me/workspace/acme/team/llm_wiki', '-Users-me-workspace-acme-team-llm-wiki'],
        ['/Users/me/.claude-mem/observer-sessions', '-Users-me--claude-mem-observer-sessions'],
        [
            '/private/var/folders/xz/n9kql91d5bg7mr71dqkz4c_00000gn/T/ux-probe-Pr69TH/vault',
            '-private-var-folders-xz-n9kql91d5bg7mr71dqkz4c-00000gn-T-ux-probe-Pr69TH-vault',
        ],
        ['/Users/x/내 프로젝트/a@b_c', '-Users-x--------a-b-c'],
    ])('%s', async (cwd, expected) => {
        const { claudeProjectDirName } = await import('./remote-agents.js');
        expect(claudeProjectDirName(cwd)).toBe(expected);
    });

    // Vector computed outside JS (Python port of the Java-style hash).
    it('cuts a name past 200 characters and suffixes the cwd hash', async () => {
        const { claudeProjectDirName } = await import('./remote-agents.js');
        const cwd = `/Users/dev/${'deep_dir/'.repeat(25)}repo`;
        expect(claudeProjectDirName(cwd)).toBe(`-Users-dev${'-deep-dir'.repeat(21)}--1f4pbr`);
    });

    it('keeps a name of exactly 200 characters and cuts one of 201', async () => {
        const { claudeProjectDirName } = await import('./remote-agents.js');
        expect(claudeProjectDirName(`/${'a'.repeat(199)}`)).toBe(`-${'a'.repeat(199)}`);
        // Vector computed outside JS, as above.
        expect(claudeProjectDirName(`/${'a'.repeat(200)}`)).toBe(`-${'a'.repeat(199)}-b6ymvl`);
    });
});

describe('detectClaudeSessionIdByPid', () => {
    const records = [
        { pid: 100, sessionId: 'sess-tmux', cwd: '/proj' },
        { pid: 200, sessionId: 'sess-plain', cwd: '/proj' },
        { pid: 300, sessionId: 'sess-other', cwd: '/elsewhere' },
    ];

    it('picks the session whose pid is inside the pane process tree', () => {
        // Pane 90 → shell 95 → claude 100. The plain-cli claude (200)
        // shares the cwd but lives outside this pane's tree.
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 95, 100]),
        });
        expect(r).toBe('sess-tmux');
    });

    it('does not steal identity from a same-cwd session in another tree', () => {
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 95, 200]),
        });
        expect(r).toBe('sess-plain');
    });

    it('rejects a pid match with a different cwd (pid reuse guard)', () => {
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 300]),
        });
        expect(r).toBeNull();
    });

    it('returns null with no records (older CC) — caller falls back to mtime', () => {
        expect(detectClaudeSessionIdByPid(90, '/proj', { records: [], descendants: new Set([90]) })).toBeNull();
    });

    it('matches without cwd when the pane path is unknown', () => {
        const r = detectClaudeSessionIdByPid(90, null, {
            records, descendants: new Set([90, 300]),
        });
        expect(r).toBe('sess-other');
    });
});

describe('parseProcTable', () => {
    // `ps -axo pid=,ppid=,lstart=` on macOS: two spaces before a single-digit
    // day, trailing padding after the year. Measured with `cat -A`, not guessed.
    const REAL = '    1     0 Fri Aug  7 11:12:59 2026    \n  182     1 Tue Aug 11 18:13:52 2026    ';

    it('reads both the parent links and the start times from one table', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable(REAL);
        expect(children.get(0)).toEqual([1]);
        expect(children.get(1)).toEqual([182]);
        expect(Number.isFinite(startTimes.get(1))).toBe(true);
        // Aug 11 started after Aug 7 — an ordering the parse cannot fake by
        // returning a constant, and one that holds in any timezone.
        expect(startTimes.get(182)!).toBeGreaterThan(startTimes.get(1)!);
    });

    /**
     * THE regression this file exists for. A start time that this machine's
     * locale cannot parse must cost only the start time. If it took the parent
     * links with it, `collectDescendantPids` would fall back to `{rootPid}` for
     * every pane, `detectClaudeSessionIdByPid` would return null across the
     * board, and Claude Code would silently drop to the mtime heuristic — the
     * identity theft the pid join was built to end (see the comment above
     * CLAUDE_SESSIONS_DIR).
     */
    it('keeps the parent links when the start time is unparseable', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable('  95     1 not a date at all\n 100    95 also not a date');
        expect(children.get(1)).toEqual([95]);
        expect(children.get(95)).toEqual([100]);
        expect(startTimes.has(95)).toBe(false);
    });

    it('still reads a two-field table (a caller that asked for no start times)', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable('90 1\n95 90\n100 95');
        expect(children.get(90)).toEqual([95]);
        expect(startTimes.size).toBe(0);
    });

    it('reads comm with spaces after the 5-token lstart, plus pgid/tpgid', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const t = parseProcTable('  501   400   501   501 Fri Aug  7 11:12:59 2026 tmux: client\n  502   501   777   777 Fri Aug  7 11:13:59 2026 pi');
        expect(t.pgidOf.get(501)).toBe(501);
        expect(t.tpgidOf.get(501)).toBe(501);
        expect(t.commOf.get(501)).toBe('tmux: client');
        expect(t.pgidOf.get(502)).toBe(777);
        expect(t.tpgidOf.get(502)).toBe(777);
        expect(t.commOf.get(502)).toBe('pi');
        expect(Number.isFinite(t.startTimes.get(501))).toBe(true);
    });

    it('ignores lines that are not a process row', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children } = parseProcTable('PID PPID STARTED\n\n  90     1 Fri Aug  7 11:12:59 2026');
        expect(children.get(1)).toEqual([90]);
        expect(children.size).toBe(1);
    });
});

describe('ps snapshot under a non-English locale', () => {
    // A listener started with LANG=ko_KR.UTF-8 got `목  9/24 21:00:39 2026`
    // (4 tokens) or `2026년  9월 24일 목요일 21시 03분 05초` (7) for lstart,
    // so the 5-token cut swallowed or left behind the comm and no pi
    // subagent pane was ever reported (measured 2026-09-24, takui-MacBookPro).
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_TIME: process.env.LC_TIME };
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('still reads start times when the listener runs in ko_KR', async () => {
        process.env.LANG = 'ko_KR.UTF-8';
        process.env.LC_ALL = 'ko_KR.UTF-8';
        process.env.LC_TIME = 'ko_KR.UTF-8';
        vi.resetModules();
        const { psStartTimes } = await import('./remote-agents.js');
        expect(Number.isFinite(psStartTimes().get(process.pid))).toBe(true);
    });

    it('pins ps to the English form whatever the listener\'s locale says, and reads that form', async () => {
        // The test above runs the real `ps`, so it only fails when that `ps` is slow or absent.
        // What it is there to guard is this: the spawn carries LC_ALL=C (which beats LANG and
        // LC_TIME), and the 5-token `lstart` that comes back parses to a start time.
        process.env.LANG = 'ko_KR.UTF-8';
        process.env.LC_ALL = 'ko_KR.UTF-8';
        process.env.LC_TIME = 'ko_KR.UTF-8';
        vi.resetModules();
        const { readProcTable } = await import('./remote-agents.js');
        const seen: Array<Record<string, unknown>> = [];
        const run = ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
            seen.push(opts);
            return { status: 0, stdout: '  600     1   600   600 Thu Sep 24 21:00:39 2026 zsh\n', stderr: '', pid: 1, output: [], signal: null };
        }) as unknown as typeof import('node:child_process').spawnSync;

        const table = readProcTable(run);

        expect((seen[0].env as Record<string, string>).LC_ALL).toBe('C');
        expect(table?.startTimes.get(600)).toBe(new Date(2026, 8, 24, 21, 0, 39).getTime());
        expect(table?.commOf.get(600)).toBe('zsh');
    });
});

describe('foregroundAgentFor — subagent pane detection', () => {
    // A subagent pane's tmux view: pane_pid is the login zsh, but the tty's
    // foreground group is the bash→pi script's group (measured 15:25). A plain
    // prompt has the shell's own group in the foreground.
    const TABLE = [
        '  600     1   600   900 Fri Aug  7 11:12:59 2026 zsh',      // subagent pane's login shell — tty fg group is 900
        '  601   600   900   900 Fri Aug  7 11:12:59 2026 bash',     // the script
        '  602   601   900   900 Fri Aug  7 11:12:59 2026 pi',       // pi in the fg group
        '  610     1   610   610 Fri Aug  7 11:12:59 2026 zsh',      // plain prompt pane
        '  611   610   910   610 Fri Aug  7 11:12:59 2026 vim',      // suspended-ish: fg tty group is the shell's
    ].join('\n');

    it('detects the agent in the foreground group of a subagent pane', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        const agent = foregroundAgentFor(600, parseProcTable(TABLE));
        expect(agent?.kind).toBe('pi');
    });

    it('a pane at its login shell prompt is not a subagent', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        expect(foregroundAgentFor(610, parseProcTable(TABLE))).toBeNull();
    });

    it('a pane whose tty group holds no registered agent is not a subagent', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        const noAgent = parseProcTable('  620     1   620   620 Fri Aug  7 11:12:59 2026 zsh\n  621   620   920   920 Fri Aug  7 11:12:59 2026 bash');
        expect(foregroundAgentFor(620, noAgent)).toBeNull();
    });

    it('answers null without a usable table (ps failed — no subagents this cycle)', async () => {
        const { foregroundAgentFor } = await import('./remote-agents.js');
        expect(foregroundAgentFor(600, null)).toBeNull();
    });
});

describe('collectDescendantPids caching', () => {
    // Two resolvers now ask the same pane for its process tree in one report
    // cycle (session id + session name). The `ps` snapshot was already shared;
    // the walk over it was not, so without this memo a pane pays for two BFS
    // passes every five seconds — on the path whose CPU cost is why the caches
    // in this file exist.
    it('serves the same walk to repeated calls for one pane within the snapshot window', async () => {
        const { collectDescendantPids } = await import('./remote-agents.js');
        const first = collectDescendantPids(process.pid);
        const second = collectDescendantPids(process.pid);
        expect(second).toBe(first);
    });

    it('answers with the root alone for a pid that has no children', async () => {
        const { collectDescendantPids } = await import('./remote-agents.js');
        // pid 1 is init/launchd's parent-of-everything, so an unused high pid is
        // the reliable childless case on a live machine.
        expect([...collectDescendantPids(0x7ff_ffff)]).toEqual([0x7ff_ffff]);
    });
});

describe('detectClaudeProviderName — record match', () => {
    // Names as Claude Code actually writes them: `<cwd-basename>-<hex2>` when
    // derived, free text when the session was named. These records carry no
    // `nameSource` (an older CC), so the name goes out with no source; the
    // nameSource and ai-title rules live in session-name-source.test.ts.
    const noTranscript = () => null;
    const records = [
        { pid: 100, sessionId: 'sess-tmux', cwd: '/proj', name: 'proj-95' },
        { pid: 200, sessionId: 'sess-plain', cwd: '/proj', name: 'cleanup-pr-rules' },
        { pid: 300, sessionId: 'sess-nameless', cwd: '/elsewhere' },
    ];

    it('returns the name of the session inside the pane process tree', () => {
        expect(detectClaudeProviderName(90, '/proj', {
            records, transcriptOf: noTranscript, descendants: new Set([90, 95, 100]),
        })).toEqual({ name: 'proj-95' });
    });

    it('reads the same record the id resolver picked (one lookup, two fields)', () => {
        const deps = { records, transcriptOf: noTranscript, descendants: new Set([90, 95, 200]) };
        expect(detectClaudeSessionIdByPid(90, '/proj', deps)).toBe('sess-plain');
        expect(detectClaudeProviderName(90, '/proj', deps)).toEqual({ name: 'cleanup-pr-rules' });
    });

    it('returns null when the matched record carries no name (older CC)', () => {
        expect(detectClaudeProviderName(90, null, {
            records, transcriptOf: noTranscript, descendants: new Set([90, 300]),
        })).toBeNull();
    });

    it('returns null when no record matches the tree', () => {
        expect(detectClaudeProviderName(90, '/proj', {
            records, transcriptOf: noTranscript, descendants: new Set([90]),
        })).toBeNull();
    });

    // A blank name must not reach the wire: renderers treat '' as falsy and fall
    // back, but the change fingerprints collapse only null/undefined, so '' would
    // ride along as a meaningless "change".
    it('normalizes blank and whitespace-only names to null', () => {
        const blank = [{ pid: 100, sessionId: 's', cwd: '/proj', name: '   ' }];
        expect(detectClaudeProviderName(90, '/proj', {
            records: blank, transcriptOf: noTranscript, descendants: new Set([90, 100]),
        })).toBeNull();
    });
});

// ── piTranscriptPath ─────────────────────────────────────────────

/**
 * The encoding here is not ours and was not guessed. It is copied from pi's own
 * writer, `@earendil-works/pi-coding-agent/dist/core/session-manager.js:245`
 * (`getDefaultSessionDirPath`), read 2026-09-14:
 *
 *     `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 *
 * The dot case is why that matters. Claude Code maps `.` to `-` as well; pi does
 * not. Inferring pi's rule from Claude's would resolve every dotted directory to
 * a path that has never existed, and the watcher would poll it forever without
 * ever saying why.
 */
describe('remote-agents.ts: piTranscriptPath', () => {
    const piDirFor = (encoded: string) => join(TMP, '.pi', 'agent', 'sessions', encoded);

    const writeSession = (encoded: string, file: string, at?: Date) => {
        const dir = piDirFor(encoded);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file);
        writeFileSync(path, '{"type":"session","version":3}\n');
        if (at) utimesSync(path, at, at);
        return path;
    };

    it.each([
        ['/Users/me/projects/app', '--Users-me-projects-app--'],
        // The case Claude's encoder would get wrong: pi keeps the dot.
        ['/Users/me/.config/thing', '--Users-me-.config-thing--'],
        ['/Users/me/repo.git/sub', '--Users-me-repo.git-sub--'],
        // A path segment that already starts with a dash — the encoding is not
        // reversible, and does not need to be.
        ['/private/tmp/x/-Users-y/scratch', '--private-tmp-x--Users-y-scratch--'],
    ])('encodes %s the way pi encodes it', async (cwd, encoded) => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const expected = writeSession(encoded, '2026-09-14T00-00-00-000Z_01a079a7.jsonl');

        expect(piTranscriptPath(cwd)).toBe(expected);
    });

    it('takes the most recently written session in the directory', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-me-projects-app--';
        const past = new Date(Date.now() - 60_000);
        writeSession(encoded, '2026-09-01T00-00-00-000Z_old.jsonl', past);
        const newest = writeSession(encoded, '2026-09-14T00-00-00-000Z_new.jsonl');

        expect(piTranscriptPath('/Users/me/projects/app')).toBe(newest);
    });

    it('ignores the loadout sidecar pi writes beside every session', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-me-projects-app--';
        const transcript = writeSession(encoded, '2026-09-14T00-00-00-000Z_s.jsonl', new Date(Date.now() - 60_000));
        writeSession(encoded, '2026-09-14T00-00-00-000Z_s.jsonl.loadout.json');

        expect(piTranscriptPath('/Users/me/projects/app')).toBe(transcript);
    });

    // pi encodes `resolvePath(cwd)`, not the raw string
    // (`…/pi-coding-agent/dist/core/session-manager.js:243-245` + `utils/paths.js:82-86`).
    // Encoding the raw string turns a trailing slash into `--a-b---` and leaves
    // `..` in the directory name, both of which are paths pi never wrote.
    it.each([
        ['/Users/me/projects/app/', 'a trailing slash'],
        ['/Users/me/projects/./app', 'a dot segment'],
        ['/Users/me/projects/other/../app', 'a parent segment'],
        ['/Users/me//projects/app', 'a doubled separator'],
    ])('normalizes %s (%s) the way pi does before encoding', async (cwd) => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const expected = writeSession('--Users-me-projects-app--', '2026-09-14T00-00-00-000Z_s.jsonl');

        expect(piTranscriptPath(cwd)).toBe(expected);
    });

    // `turn-watch` re-resolves every TRANSCRIPT_RECHECK_MS per watcher, and a
    // directory someone has run pi in for months holds one file per run.
    it('does not re-scan the directory for the same pane', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const dir = piDirFor('--Users-me-projects-app--');
        const path = writeSession('--Users-me-projects-app--', '2026-09-14T00-00-00-000Z_s.jsonl');

        expect(piTranscriptPath('/Users/me/projects/app', 4242)).toBe(path);

        // The directory is gone; only a cached answer can still name the file.
        // Proving it this way rather than by spying on `readdirSync`, which the
        // module binds at import and a namespace spy never reaches.
        rmSync(dir, { recursive: true, force: true });
        expect(piTranscriptPath('/Users/me/projects/app', 4242)).toBe(path);
    });

    // A pi that was restarted in the same directory writes a new file. Keyed on
    // cwd alone, the watch would follow the dead session's transcript for the
    // rest of the TTL — far longer than the 10s recheck that should have caught it.
    it('resolves again when the pane is a different process', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-me-projects-app--';
        const first = writeSession(encoded, '2026-09-14T00-00-00-000Z_old.jsonl', new Date(Date.now() - 60_000));

        expect(piTranscriptPath('/Users/me/projects/app', 1111)).toBe(first);

        const restarted = writeSession(encoded, '2026-09-14T01-00-00-000Z_new.jsonl');
        expect(piTranscriptPath('/Users/me/projects/app', 1111)).toBe(first);
        expect(piTranscriptPath('/Users/me/projects/app', 2222)).toBe(restarted);
    });

    // pi reads PI_CODING_AGENT_DIR before falling back to ~/.pi/agent
    // (`…/pi-coding-agent/dist/config.js:406,421-426`).
    it('follows PI_CODING_AGENT_DIR, the override pi itself honours', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const elsewhere = join(TMP, 'custom-agent-dir');
        process.env.PI_CODING_AGENT_DIR = elsewhere;
        try {
            const dir = join(elsewhere, 'sessions', '--Users-me-projects-app--');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, '2026-09-14T00-00-00-000Z_s.jsonl');
            writeFileSync(path, '{"type":"session","version":3}\n');

            expect(piTranscriptPath('/Users/me/projects/app')).toBe(path);
        } finally {
            delete process.env.PI_CODING_AGENT_DIR;
        }
    });

    it('answers null for a directory pi has never run in, and for no cwd at all', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');

        expect(piTranscriptPath('/nowhere/pi/has/been')).toBeNull();
        expect(piTranscriptPath(null)).toBeNull();
    });
});

// ── geminiTranscriptPath ─────────────────────────────────────────

/**
 * Layout read 2026-10-08 out of `@google/gemini-cli` 0.46.0
 * (`bundle/chunk-6ZHP2EJW.js`): `<home>/.gemini/projects.json` maps an absolute
 * cwd to a slug, and the session files live in `<home>/.gemini/tmp/<slug>/chats/`
 * (`GEMINI_CLI_HOME` replaces `<home>`). The slug used below deliberately differs
 * from `basename(cwd)` — it is a registry value, not a rule.
 */
describe('remote-agents.ts: geminiTranscriptPath', () => {
    const CWD = '/Users/me/projects/app';
    const SLUG = 'app-registered-slug';

    const register = (home: string, projects: Record<string, unknown>) => {
        mkdirSync(join(home, '.gemini'), { recursive: true });
        writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects }));
    };

    const writeChat = (home: string, slug: string, file: string, body = '{"sessionId":"s"}\n', at?: Date) => {
        const dir = join(home, '.gemini', 'tmp', slug, 'chats');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file);
        writeFileSync(path, body);
        if (at) utimesSync(path, at, at);
        return path;
    };

    it('finds the folder through projects.json, not through the cwd name', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        register(TMP, { [CWD]: SLUG });
        const expected = writeChat(TMP, SLUG, 'session-2026-10-08T00-00-abcd1234.jsonl');
        // A folder named after the cwd that the registry does not point at.
        writeChat(TMP, 'app', 'session-2026-10-08T00-00-decoy000.jsonl');

        expect(geminiTranscriptPath(CWD)).toBe(expected);
    });

    it('takes the most recently written session-*.jsonl, and nothing else', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        register(TMP, { [CWD]: SLUG });
        const past = new Date(Date.now() - 60_000);
        writeChat(TMP, SLUG, 'session-2026-10-01T00-00-old00000.jsonl', undefined, past);
        const newest = writeChat(TMP, SLUG, 'session-2026-10-08T00-00-new00000.jsonl', undefined, new Date(Date.now() - 30_000));
        // Newer than both, and not eligible: the legacy whole-file form, a file
        // without the prefix, and a sub-agent transcript one directory down.
        writeChat(TMP, SLUG, 'session-2025-10-16T00-00-legacy00.json');
        writeChat(TMP, SLUG, 'notes.jsonl');
        mkdirSync(join(TMP, '.gemini', 'tmp', SLUG, 'chats', 'session-dir.jsonl'), { recursive: true });
        mkdirSync(join(TMP, '.gemini', 'tmp', SLUG, 'chats', 'parent-id'), { recursive: true });
        writeFileSync(join(TMP, '.gemini', 'tmp', SLUG, 'chats', 'parent-id', 'session-sub.jsonl'), '');

        expect(geminiTranscriptPath(CWD)).toBe(newest);
    });

    it('follows GEMINI_CLI_HOME, the override Gemini itself honours', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        const elsewhere = join(TMP, 'custom-gemini-home');
        process.env.GEMINI_CLI_HOME = elsewhere;
        try {
            register(elsewhere, { [CWD]: SLUG });
            const expected = writeChat(elsewhere, SLUG, 'session-2026-10-08T00-00-abcd1234.jsonl');
            // The default home has a registry too; it must not be consulted.
            register(TMP, { [CWD]: 'other' });
            writeChat(TMP, 'other', 'session-2026-10-08T00-00-wrong000.jsonl');

            expect(geminiTranscriptPath(CWD)).toBe(expected);
        } finally {
            delete process.env.GEMINI_CLI_HOME;
        }
    });

    it('normalizes the cwd the way Gemini does before the lookup', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        register(TMP, { [CWD]: SLUG });
        const expected = writeChat(TMP, SLUG, 'session-2026-10-08T00-00-abcd1234.jsonl');

        expect(geminiTranscriptPath(`${CWD}/`)).toBe(expected);
        expect(geminiTranscriptPath('/Users/me/projects/other/../app')).toBe(expected);
    });

    it('answers null for an unregistered cwd, a missing or broken registry, no chats, and no cwd', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');

        // No registry at all.
        expect(geminiTranscriptPath(CWD)).toBeNull();

        // Unregistered cwd.
        register(TMP, { '/somewhere/else': SLUG });
        writeChat(TMP, SLUG, 'session-2026-10-08T00-00-abcd1234.jsonl');
        expect(geminiTranscriptPath(CWD, 1)).toBeNull();

        // Registered, but the project has no chats directory.
        register(TMP, { [CWD]: 'never-run' });
        expect(geminiTranscriptPath(CWD, 2)).toBeNull();

        // Broken JSON, and `projects` that is not an object.
        writeFileSync(join(TMP, '.gemini', 'projects.json'), '{"projects": {');
        expect(geminiTranscriptPath(CWD, 3)).toBeNull();
        writeFileSync(join(TMP, '.gemini', 'projects.json'), JSON.stringify({ projects: 'nope' }));
        expect(geminiTranscriptPath(CWD, 4)).toBeNull();

        expect(geminiTranscriptPath(null)).toBeNull();
    });

    // The slug is read from a file and joined onto a path.
    it.each(['../escape', '..', '.', 'a/b', '/abs'])('refuses the registry slug %s', async (slug) => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        register(TMP, { [CWD]: slug });
        writeChat(TMP, 'escape', 'session-2026-10-08T00-00-abcd1234.jsonl');
        mkdirSync(join(TMP, '.gemini', 'tmp', 'a', 'b', 'chats'), { recursive: true });
        writeFileSync(join(TMP, '.gemini', 'tmp', 'a', 'b', 'chats', 'session-x.jsonl'), '');

        expect(geminiTranscriptPath(CWD)).toBeNull();
    });

    it('does not re-read the registry for the same pane, but does for a restarted one', async () => {
        const { geminiTranscriptPath } = await import('./remote-agents.js');
        register(TMP, { [CWD]: SLUG });
        const first = writeChat(TMP, SLUG, 'session-2026-10-08T00-00-old00000.jsonl', undefined, new Date(Date.now() - 60_000));
        expect(geminiTranscriptPath(CWD, 1111)).toBe(first);

        const restarted = writeChat(TMP, SLUG, 'session-2026-10-08T01-00-new00000.jsonl');
        expect(geminiTranscriptPath(CWD, 1111)).toBe(first);
        expect(geminiTranscriptPath(CWD, 2222)).toBe(restarted);
    });

    it('feeds the tailer and the projector end to end', async () => {
        const { geminiTranscriptPath, findAgentBySubcommand: find } = await import('./remote-agents.js');
        register(TMP, { [CWD]: SLUG });
        const at = '2026-10-08T00:00:00.000Z';
        const body = [
            { sessionId: 's', projectHash: 'h', startTime: at, lastUpdated: at, kind: 'main' },
            { $set: { messages: [{ id: 'ctx', type: 'user', content: [{ text: '<ctx>injected</ctx>' }] }] } },
            { id: 'u1', timestamp: at, type: 'user', content: [{ text: 'list the files' }] },
            {
                id: 'g1', timestamp: at, type: 'gemini', content: 'looking', model: 'm',
                tokens: { input: 10, output: 2, cached: 0, thoughts: 0, tool: 0, total: 12 },
            },
            {
                id: 'g1', timestamp: at, type: 'gemini', content: 'looking', model: 'm',
                tokens: { input: 10, output: 2, cached: 0, thoughts: 0, tool: 0, total: 12 },
                toolCalls: [{ id: 'c1', name: 'list_directory', args: { dir_path: '/x' }, status: 'success', resultDisplay: 'a\nb' }],
            },
        ].map((o) => JSON.stringify(o)).join('\n') + '\n';
        const path = writeChat(TMP, SLUG, 'session-2026-10-08T00-00-abcd1234.jsonl', body);

        const row = find('gemini');
        const resolved = row?.resolveTranscript?.(CWD, 1);
        expect(resolved).toBe(path);
        expect(geminiTranscriptPath(CWD, 1)).toBe(path);

        const read = readTranscriptDelta(path, null, { fromStart: true });
        expect(read).not.toBeNull();
        expect(row?.projectTranscript?.(read!.lines)).toEqual([
            { kind: 'prompt', text: 'list the files', at },
            { kind: 'msg', mid: 'g1', model: 'm', out: 2, ctx: 10, at },
            { kind: 'text', text: 'looking', at },
            { kind: 'msg', mid: 'g1', model: 'm', out: 2, ctx: 10, at },
            { kind: 'tool', id: 'c1', name: 'list_directory', target: '/x', at },
            { kind: 'tool_result', id: 'c1', ok: true, lines: 2, at },
        ]);
    });
});

// ── codexTranscriptPath ──────────────────────────────────────────

/**
 * Codex shards its rollouts by date and puts no cwd anywhere in the path — the
 * cwd is inside the file, on the `session_meta` first line. So unlike pi's and
 * Claude's resolvers, this one cannot answer from a directory name and has to
 * open files, which is what every bound and cache below exists to limit.
 *
 * Shape measured 2026-09-14 against `~/.codex/sessions/2026/09/14/rollout-…jsonl`
 * written by codex-cli 0.154.0.
 */
describe('remote-agents.ts: codexTranscriptPath', () => {
    const META = (cwd: string, timestamp = '2026-09-14T00:00:00.000Z') =>
        JSON.stringify({ timestamp, type: 'session_meta', payload: { cwd, timestamp, id: 'x' } });

    const writeRollout = (shard: string, file: string, header: string, at?: Date): string => {
        const dir = join(TMP, '.codex', 'sessions', shard);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file);
        writeFileSync(path, `${header}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`);
        if (at) utimesSync(path, at, at);
        return path;
    };

    it('finds the rollout whose session_meta names this pane directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/me/other'));
        const mine = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/me/app'));

        expect(codexTranscriptPath('/Users/me/app')).toBe(mine);
    });

    // The cwd comparison happens after the same normalization pi's encoder does,
    // because tmux reports what the shell reports and a trailing slash there
    // would otherwise miss every rollout Codex ever wrote for that directory.
    it.each([
        ['/Users/me/app/', 'a trailing slash'],
        ['/Users/me/./app', 'a dot segment'],
        ['/Users/me/other/../app', 'a parent segment'],
    ])('normalizes %s (%s) before comparing', async (cwd) => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const mine = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/me/app'));

        expect(codexTranscriptPath(cwd)).toBe(mine);
    });

    it('answers null when no rollout names this directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/me/other'));

        expect(codexTranscriptPath('/Users/me/app')).toBeNull();
        expect(codexTranscriptPath(null)).toBeNull();
    });

    it('takes the most recently written of several rollouts for the directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-old.jsonl', META('/Users/me/app'), new Date(Date.now() - 60_000));
        const newest = writeRollout('2026/09/14', 'rollout-new.jsonl', META('/Users/me/app'));

        expect(codexTranscriptPath('/Users/me/app')).toBe(newest);
    });

    /*
     * The scan is bounded to the two newest date shards. Unbounded, a machine
     * someone has run Codex on for a year would open and parse a 22KB header out
     * of every rollout ever written, every time a watch re-resolved.
     */
    it('never opens a shard older than the two newest', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/10', 'rollout-ancient.jsonl', META('/Users/me/app'));
        writeRollout('2026/09/13', 'rollout-yesterday.jsonl', META('/Users/me/other'));
        writeRollout('2026/09/14', 'rollout-today.jsonl', META('/Users/me/other'));

        expect(codexTranscriptPath('/Users/me/app')).toBeNull();
    });

    it('reaches a session started before midnight and still running', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const yesterday = writeRollout('2026/09/13', 'rollout-y.jsonl', META('/Users/me/app'));
        writeRollout('2026/09/14', 'rollout-t.jsonl', META('/Users/me/other'));

        expect(codexTranscriptPath('/Users/me/app')).toBe(yesterday);
    });

    it('skips a file that is not a session_meta header, and one with no line at all', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-headerless.jsonl', '{"type":"event_msg","payload":{}}');
        writeRollout('2026/09/14', 'rollout-truncated.jsonl', '{"type":"session_meta","payl');
        writeRollout('2026/09/14', 'rollout-garbage.jsonl', 'not json at all');

        expect(codexTranscriptPath('/Users/me/app')).toBeNull();
    });

    /*
     * `session_meta` carries `base_instructions` — measured at 21551 bytes of a
     * 22049-byte header — and that field grows with the user's AGENTS.md and
     * skill set. A fixed single read is a bound someone eventually crosses, and
     * crossing it answers null forever: "this agent has no live timeline", with
     * nothing to say why.
     */
    it('reads a header far past one chunk, and one with a multi-byte character across the boundary', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const header = JSON.stringify({
            type: 'session_meta',
            // 3 bytes each, so the 65536 and 131072 chunk boundaries both land
            // on a continuation byte — decoding per chunk would corrupt them.
            payload: { cwd: '/Users/me/app', timestamp: '2026-09-14T00:00:00.000Z', base_instructions: `${'가'.repeat(50_000)}x` },
        });
        const path = writeRollout('2026/09/14', 'rollout-huge.jsonl', header);

        expect(codexTranscriptPath('/Users/me/app')).toBe(path);
    });

    // The reader's outer cap is a bound on work, not on the answer, so what is
    // pinned here is the answer: a file with no line ending is not a rollout and
    // must not become one. That it stops reading at CODEX_HEADER_MAX rather than
    // consuming the file is stated in the reader and not asserted here — a test
    // that proved it would have to measure the read itself.
    it('answers null for a file with no line ending at all', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const dir = join(TMP, '.codex', 'sessions', '2026', '09', '14');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'rollout-runaway.jsonl'), 'x'.repeat(2 * 1024 * 1024));

        expect(codexTranscriptPath('/Users/me/app')).toBeNull();
    });

    it('ignores files in the shard that are not rollouts', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'notes.jsonl', META('/Users/me/app'));
        writeRollout('2026/09/14', 'rollout-a.json', META('/Users/me/app'));

        expect(codexTranscriptPath('/Users/me/app')).toBeNull();
    });

    // Opening a 22KB header out of every rollout in two shards is the most
    // expensive resolver here, and `turn-watch` re-resolves every
    // TRANSCRIPT_RECHECK_MS per watcher.
    it('does not re-scan the shards for the same pane', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const path = writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/me/app'));

        expect(codexTranscriptPath('/Users/me/app', 4242)).toBe(path);

        // The tree is gone; only a cached answer can still name the file.
        rmSync(join(TMP, '.codex'), { recursive: true, force: true });
        expect(codexTranscriptPath('/Users/me/app', 4242)).toBe(path);
    });

    it('resolves again when the pane is a different process', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const first = writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/me/app'), new Date(Date.now() - 60_000));

        expect(codexTranscriptPath('/Users/me/app', 1111)).toBe(first);

        const restarted = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/me/app'));
        expect(codexTranscriptPath('/Users/me/app', 1111)).toBe(first);
        expect(codexTranscriptPath('/Users/me/app', 2222)).toBe(restarted);
    });

    // The binary reports `CODEX_HOME` in its own `doctor` output and carries
    // `failed to resolve CODEX_HOME`, so the override is the writer's, not ours.
    it('follows CODEX_HOME, the override Codex itself honours', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const elsewhere = join(TMP, 'custom-codex-home');
        process.env.CODEX_HOME = elsewhere;
        try {
            const dir = join(elsewhere, 'sessions', '2026', '09', '14');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, 'rollout-a.jsonl');
            writeFileSync(path, `${META('/Users/me/app')}\n`);

            expect(codexTranscriptPath('/Users/me/app')).toBe(path);
        } finally {
            delete process.env.CODEX_HOME;
        }
    });
});

// C62: the readers ran with the default 1 MiB buffer and `ps` with no timeout;
// past either the read came back null and names / subagents vanished silently.
describe('remote-agents.ts: bounded reader spawns', () => {
    const fakeRun = (result: Partial<ReturnType<typeof import('node:child_process').spawnSync>>) => {
        const calls: Array<{ cmd: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
        const run = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
            calls.push({ cmd, args, opts });
            return { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null, ...result };
        }) as unknown as typeof import('node:child_process').spawnSync;
        return { run, calls };
    };

    it('runs ps and sqlite3 with a timeout and a buffer past the 1 MiB default', async () => {
        const { readProcTable, sqliteJson } = await import('./remote-agents.js');
        const ps = fakeRun({ stdout: '' });
        readProcTable(ps.run);
        expect(ps.calls[0].opts).toMatchObject({ timeout: expect.any(Number), maxBuffer: 16 * 1024 * 1024 });

        const db = fakeRun({ stdout: '[]' });
        expect(sqliteJson('/x/state.db', 'SELECT 1', db.run)).toEqual([]);
        expect(db.calls[0].opts).toMatchObject({ timeout: 1_000, maxBuffer: 16 * 1024 * 1024 });
    });

    it('says once why a read failed, then stays quiet', async () => {
        vi.resetModules();
        const { readProcTable } = await import('./remote-agents.js');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failing = fakeRun({ status: null, error: Object.assign(new Error('spawnSync ps ENOBUFS'), { code: 'ENOBUFS' }) });
        try {
            expect(readProcTable(failing.run)).toBeNull();
            expect(readProcTable(failing.run)).toBeNull();
            expect(errors).toHaveBeenCalledTimes(1);
            expect(String(errors.mock.calls[0][0])).toContain('ENOBUFS');
        } finally {
            errors.mockRestore();
        }
    });
});
