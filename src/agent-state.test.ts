import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    advanceState, clearRegexCache, evaluateState,
    ENGINE_VERSION,
    type DetectionManifest, type DetectionRule, type StateTracker,
} from './agent-state.js';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import { stripEscapes } from './blocked-prompt.js';

// ── Synthetic pane fixtures ──────────────────────────────────────
// Hand-written approximations of Claude Code screens; the point is to
// exercise the rule shapes (affordance text + prompt glyph), not to be
// pixel-faithful.

const PANE_WORKING = [
    '● Reading src/listener.ts…',
    '',
    '✻ Churning… (12s · esc to interrupt)',
].join('\n');

const PANE_BLOCKED_PERMISSION = [
    'Bash command: rm -rf ./dist',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, tell Claude what to do differently',
    '',
    'Enter to select · esc to cancel',
].join('\n');

const PANE_IDLE = [
    '● Done. All tests green.',
    '',
    '╭──────────────────────────────╮',
    '│ ❯                            │',
    '╰──────────────────────────────╯',
    '  ? for shortcuts',
].join('\n');

const PANE_TRANSCRIPT = [
    'Showing detailed transcript',
    'some scrolled content here',
    'ctrl+o to toggle',
].join('\n');

const PANE_GIBBERISH = 'lorem ipsum nothing recognizable';

beforeEach(() => {
    clearRegexCache();
});

describe('evaluateState against DEFAULT_MANIFEST (claude)', () => {
    it('detects working from the interrupt hint', () => {
        const r = evaluateState(PANE_WORKING, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-interrupt-hint');
    });

    it('detects a blocking permission dialog', () => {
        const r = evaluateState(PANE_BLOCKED_PERMISSION, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('blocked');
        expect(r.ruleId).toBe('claude-blocked-dialog');
    });

    it('does not classify working-with-interrupt as blocked', () => {
        // "esc to interrupt" contains "esc" — the not-clause must keep
        // the blocked rule from firing on a working screen that also
        // shows a navigation hint in scrollback.
        const pane = PANE_WORKING + '\nuse arrows to navigate history';
        const r = evaluateState(pane, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
    });

    it('detects idle from the prompt glyph', () => {
        const r = evaluateState(PANE_IDLE, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('idle');
    });

    it('freezes state on the transcript overlay (skipStateUpdate)', () => {
        const r = evaluateState(PANE_TRANSCRIPT, 'claude', DEFAULT_MANIFEST, 'working');
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-transcript-overlay');
    });

    it('returns unknown when nothing matches', () => {
        expect(evaluateState(PANE_GIBBERISH, 'claude', DEFAULT_MANIFEST).state).toBe('unknown');
    });

    it('returns unknown for agents with no rules (opencode)', () => {
        expect(evaluateState(PANE_WORKING, 'opencode', DEFAULT_MANIFEST).state).toBe('unknown');
        expect(evaluateState(PANE_IDLE, 'opencode', DEFAULT_MANIFEST).state).toBe('unknown');
    });
});

describe('manifest safety', () => {
    const manifestWith = (rules: DetectionManifest['agents']['claude']): DetectionManifest => ({
        engineVersion: ENGINE_VERSION,
        version: '2026.01.01.1',
        agents: { claude: rules, codex: [], gemini: [] },
    });

    it('honors disabledRuleIds as a kill-switch', () => {
        const manifest: DetectionManifest = {
            ...DEFAULT_MANIFEST,
            disabledRuleIds: [
                'claude-working-interrupt-hint',
                'claude-working-token-counter',
                'claude-working-elapsed-spinner',
            ],
        };
        expect(evaluateState(PANE_WORKING, 'claude', manifest).state).toBe('unknown');
    });

    it('isolates an invalid regex to its own rule', () => {
        const manifest = manifestWith([
            { id: 'bad', state: 'blocked', priority: 900, regex: ['[unclosed'] },
            { id: 'good', state: 'working', priority: 800, contains: ['esc to interrupt'] },
        ]);
        const r = evaluateState(PANE_WORKING, 'claude', manifest);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('good');
    });

    it('rejects patterns above the length cap', () => {
        const manifest = manifestWith([
            { id: 'huge', state: 'blocked', priority: 900, regex: ['a'.repeat(201)] },
        ]);
        expect(evaluateState('aaa', 'claude', manifest).state).toBe('unknown');
    });

    it('truncates oversized input from the front and still matches the tail', () => {
        const noise = 'x'.repeat(20_000);
        const pane = noise + '\n' + PANE_WORKING;
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('working');
    });

    it('higher priority wins regardless of array order', () => {
        const manifest = manifestWith([
            { id: 'low', state: 'idle', priority: 100, contains: ['marker'] },
            { id: 'high', state: 'blocked', priority: 200, contains: ['marker'] },
        ]);
        expect(evaluateState('marker', 'claude', manifest).ruleId).toBe('high');
    });
});

describe('advanceState flap suppression', () => {
    const at = (state: 'working' | 'blocked' | 'idle' | 'unknown') => ({ state });

    it('confirms the first observation immediately (baseline)', () => {
        const t = advanceState(undefined, at('working'), 1000);
        expect(t.confirmed).toBe('working');
        expect(t.confirmedAt).toBe(1000);
    });

    it('requires two consecutive sightings to change state', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('blocked'), 5000);
        expect(t.confirmed).toBe('working');      // candidate only
        expect(t.candidate).toBe('blocked');
        t = advanceState(t, at('blocked'), 10000);
        expect(t.confirmed).toBe('blocked');      // promoted
        expect(t.confirmedAt).toBe(10000);
    });

    it('drops a one-cycle flap', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('idle'), 5000);    // menu flash
        t = advanceState(t, at('working'), 10000); // back to normal
        expect(t.confirmed).toBe('working');
        expect(t.candidate).toBeUndefined();
        t = advanceState(t, at('idle'), 15000);
        expect(t.confirmed).toBe('working');       // still one sighting
    });

    it('resets the candidate when a third state appears', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('idle'), 5000);
        t = advanceState(t, at('blocked'), 10000);
        expect(t.confirmed).toBe('working');
        expect(t.candidate).toBe('blocked');       // idle candidate replaced
        t = advanceState(t, at('blocked'), 15000);
        expect(t.confirmed).toBe('blocked');
    });
});

describe('working detection on hint-less CC skins (2026.07.04.2 rules)', () => {
    // Real capture from a Fable 5 session: no "esc to interrupt" hint,
    // prompt box ❯ visible WHILE working — the token-counter spinner
    // line is the only working signal.
    const PANE_WORKING_NO_HINT = [
        '⏺ Running 3 shell commands…',
        '',
        '✶ Fiddle-faddling… (1m 2s · ↓ 1.2k tokens)',
        '',
        '─────────────────────────────',
        '❯',
        '─────────────────────────────',
        '  Fable 5 | cli • feat/agent-state | 55%',
    ].join('\n');

    it('classifies the token-counter spinner as working (not idle)', () => {
        const r = evaluateState(PANE_WORKING_NO_HINT, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-token-counter');
    });

    it('elapsed-only spinner (before token counter appears) is working', () => {
        const pane = '✻ Pondering… (3s · esc? no)\n❯';
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('working');
    });

    it('compact pass reads as working despite lacking every spinner signal', () => {
        // Real capture: /compact renders "(51s)" with no "·" suffix, no
        // token counter, no interrupt hint — previously classified idle.
        const pane = [
            '❯ /compact',
            '',
            '✱ Compacting conversation… (51s)',
            '▰▰▰▰▰▰▰▰▱▱▱▱ 44%',
            '─────────────',
            '❯',
        ].join('\n');
        const r = evaluateState(pane, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-compacting');
    });

    it('still idle when spinner line is gone', () => {
        const pane = [
            '⏺ Done.',
            '─────────────',
            '❯',
            '─────────────',
            '  ? for shortcuts',
        ].join('\n');
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('idle');
    });
});

// The bundled pi rules on screens the bench did not capture. Each line below
// is the vendor's own string (pi v0.85.1 dist/modes/interactive/components) or
// a live pane's footer, so these pin the pattern edges the bench cannot reach.
describe('pi rules — screens not captured', () => {
    const pi = (lines: string[]) => evaluateState(lines.join('\n'), 'pi', DEFAULT_MANIFEST).state;

    beforeEach(() => clearRegexCache());

    it('pi core selector dialog → blocked', () => {
        expect(pi(['  Pick a branch', '→ main', '  dev', ' ↑↓ navigate  enter select  escape/ctrl+c cancel', '───', '0.4%/1.0M (auto)'])).toBe('blocked');
    });

    it('pi core input dialog → blocked', () => {
        expect(pi(['  Branch name', '> feat/x', ' enter submit  escape/ctrl+c cancel', '───', '0.4%/1.0M (auto)'])).toBe('blocked');
    });

    it("an ask picker's free-text Other entry → blocked", () => {
        expect(pi(['  Other answer', '> foo', ' Enter to submit • Esc to go back', '───', '0.4%/1.0M'])).toBe('blocked');
    });

    it('a picker still wins over the Working spinner it opened under', () => {
        expect(pi(['── ⠦ Working ──', '> 1. Alpha', '  2. Beta', ' ↑↓ navigate • Enter select • Esc cancel', '0.4%/1.0M'])).toBe('blocked');
    });

    it('footer right after a compaction (context usage unknown) → idle', () => {
        expect(pi(['▎', ' dou-app on  feat/x [░░░░░░░░░░] ?/1.0M', ' ↑258k ↓24k 99.6%'])).toBe('idle');
    });

    it('the startup key legend is not a dialog', () => {
        expect(pi([' escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more', '───', '0.0%/1.0M (auto)'])).toBe('idle');
    });

    it('a status line drawn in braille that is not a spinner frame stays idle', () => {
        expect(pi(['───', '↑531k ↓139k $0.316 5.0%/1.0M (auto)', '⠠⠄ caveman level: FULL'])).toBe('idle');
    });

    it('the spinner counts bare at line start, as a custom editor draws it', () => {
        expect(pi([' ⠦ Working', '▎', ' dou-app on  main [░░░] 7.0%/1.0M'])).toBe('working');
    });

    it('a braille glyph mid-line in leftover output is not the spinner', () => {
        expect(pi(['  build: 12 files ⠙ cached', '───', '↑3.8k ↓33 0.4%/1.0M (auto)'])).toBe('idle');
    });
});

// opencode has no bench fixture: the bench holds verbatim captures only, and
// these screens are rebuilt from the strings recorded in the C136 backlog row
// (opencode 1.18.35, `Allow once   Allow always   Reject`) and a user's
// permission screen (`Allow once   Always allow   Reject … enter confirm`).
// Only those strings are real; the layout around them is a guess.
describe('opencode rules — screens rebuilt from recorded strings', () => {
    const opencode = (lines: string[]) => evaluateState(lines.join('\n'), 'opencode', DEFAULT_MANIFEST).state;

    beforeEach(() => clearRegexCache());

    it.each([
        ['Allow always', '  Allow once   Allow always   Reject'],
        ['Always allow', '  Allow once   Always allow   Reject'],
    ])('permission request with the "%s" button wording → blocked', (_wording, buttons) => {
        expect(opencode(['  △ Permission required', '    bash: rm -rf ./dist', '', buttons, '', '  enter confirm'])).toBe('blocked');
    });

    it('a permission request still wins over an esc interrupt hint beside it', () => {
        expect(opencode(['  △ Permission required', '  Allow once   Always allow   Reject', '  esc interrupt   enter confirm'])).toBe('blocked');
    });

    it('an edit request with a long diff keeps the title in reach', () => {
        const diff = Array.from({ length: 20 }, (_, i) => `    + line ${i}`);
        expect(opencode(['  △ Permission required', '  Edit src/a.ts', ...diff, '  Allow once   Always allow   Reject', '  enter confirm'])).toBe('blocked');
    });

    it('the phrase in tool output without any button is not a dialog', () => {
        expect(opencode(['  $ cat error.log', '  EACCES: permission required for /etc/hosts', '', '  esc interrupt   ctrl+p commands'])).toBe('working');
    });

    it('the esc interrupt footer → working', () => {
        expect(opencode(['  Reading src/listener.ts…', '', '  esc interrupt   ctrl+p commands'])).toBe('working');
    });

    it('reads the question tool\'s panel as blocked (captured, v2.1.2)', () => {
        const pane = readFileSync(new URL('./fixtures/panes/opencode-blocked-question.ansi.txt', import.meta.url), 'utf-8');
        expect(evaluateState(stripEscapes(pane), 'opencode', DEFAULT_MANIFEST).state).toBe('blocked');
    });

    it('does not read the panel\'s words in agent text as a question', () => {
        expect(opencode(['  ┃  Questions', '  ┃  ↑↓ select  enter submit  esc dismiss', '', '  esc interrupt   ctrl+p commands'])).toBe('working');
    });

    it.each([
        ['a fresh session', ['  Ask anything…', '', '  ctrl+p commands']],
        ['a finished turn', ['  ▣  Build · muse-spark-1.3-contributor-free · 1m 21s', '', '  ctrl+p commands']],
    ])('%s has no rule → unknown, not a guessed state', (_screen, lines) => {
        expect(opencode(lines)).toBe('unknown');
    });
});

// C61: OTA rules and phone-authored watch patterns run synchronously on the
// daemon's thread; a backtracking pattern froze streams, pushes and
// heartbeats. They run on RE2, whose time is linear in the input.
// The server refuses at PUT time what the listener would refuse here (C75):
// hwip server/src/__tests__/watch-pattern.test.ts carries the same vectors —
// keep the two in step.
describe('pattern engine', () => {
    // Each of these takes seconds to forever on V8 (measured on node 24).
    it.each([
        ['(a+)+$', `${'a'.repeat(8000)}b`],
        ['.*.*.*x', 'a'.repeat(8000)],
        ['\\w*\\w*\\w*x', 'a'.repeat(8000)],
        ['(.*a){10}x', 'a'.repeat(8000)],
        ['(\\w*){3}x', 'a'.repeat(8000)],
        ['.*a.*b', 'a'.repeat(8000)],
        // Linear in program size too; this one is just under the cap.
        ['(?:.?){30}c', 'a'.repeat(8000)],
        ['(?:a*){30}bz', `${'a'.repeat(8000)}b`],
    ])('runs %s over 8 KiB without hanging', async (pattern, text) => {
        const { findPatternMatch, patternError } = await import('./agent-state.js');
        expect(patternError(pattern)).toBeNull(); // timed, not refused
        const started = Date.now();
        expect(findPatternMatch(pattern, text)).toBeNull();
        expect(Date.now() - started).toBeLessThan(500);
    });

    it.each(['(\\d+)\\1', '(?<x>a)\\k<x>', '(?=a)b', '(?<=a)b', `x${'y'.repeat(200)}`, '\\w{1,1000}\\w{1,1000}z', '(?:.{0,100}){10}z', '(?:a*){98}bz'])('refuses %s', async (pattern) => {
        const { patternError, findPatternMatch } = await import('./agent-state.js');
        expect(patternError(pattern)).not.toBeNull();
        expect(findPatternMatch(pattern, 'ab')).toBeNull();
    });

    it('compiles every bundled rule pattern', async () => {
        const { patternError } = await import('./agent-state.js');
        const { DEFAULT_MANIFEST } = await import('./agent-rules.default.js');
        const patterns = Object.values(DEFAULT_MANIFEST.agents).flatMap((rules) => (rules ?? []).flatMap((r) => [
            ...(r.regex ?? []), ...(r.any ?? []).flatMap((c) => c.regex ?? []), ...(r.not ?? []).flatMap((c) => c.regex ?? []),
        ]));
        expect(patterns.length).toBeGreaterThan(0);
        expect(patterns.filter((p) => patternError(p) !== null)).toEqual([]);
    });

    it('reads the last 8 KiB of UTF-8, not of UTF-16 units', async () => {
        const { findPatternMatch } = await import('./agent-state.js');
        // 3000 Hangul syllables are 9000 bytes: the first lines fall outside.
        const pane = `FIRST\n${'가'.repeat(3000)}\nLAST`;
        expect(findPatternMatch('first', pane)).toBeNull();
        expect(findPatternMatch('last', pane)).toEqual({ line: 'LAST' });
    });

    it('matches case-insensitively, per line, and returns the whole matched line', async () => {
        const { findPatternMatch } = await import('./agent-state.js');
        expect(findPatternMatch('^build ok$', '진행 중…\n  BUILD OK\nBUILD OK\n❯')).toEqual({ line: 'BUILD OK' });
        expect(findPatternMatch('error: .*', '한글 출력\nfoo error: disk full\n')).toEqual({ line: 'foo error: disk full' });
    });
});
