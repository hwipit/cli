import { describe, expect, it } from 'vitest';
import type { DetectionManifest, DetectionRule } from './agent-state.js';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import { evaluateState } from './agent-state.js';
import { READ_PAIR_MAX_MS, canPromptKind, createReadyCheck, hasIdleRule, promptableKinds, promptableScheduleKinds, scheduleScreenState } from './schedule-ready.js';

const rule = (over: Partial<DetectionRule> & Pick<DetectionRule, 'id' | 'state'>): DetectionRule => ({ priority: 1, ...over }) as DetectionRule;
const manifest = (agents: DetectionManifest['agents'], disabledRuleIds?: string[]): DetectionManifest =>
    ({ engineVersion: 1, version: 'test', agents, ...(disabledRuleIds ? { disabledRuleIds } : {}) });

describe('createReadyCheck', () => {
    const IDLE = '> \n? for shortcuts';
    const POLL = 5_000;
    /** A check whose clock moves one poll per read. */
    const check = (screen: () => string | null, opts: { foreground?: () => boolean; states?: Record<string, string> } = {}) => {
        const states: Record<string, string> = { [IDLE]: 'idle', ...opts.states };
        let clock = 0;
        return createReadyCheck({
            foregroundIsAgent: opts.foreground ?? (() => true),
            screenOf: screen,
            stateOf: (s) => states[s] ?? 'unknown',
            now: () => (clock += POLL),
        });
    };

    it('is not ready while the shell is still the foreground program, whatever the rules say', () => {
        const ready = check(() => IDLE, { foreground: () => false });
        for (let poll = 0; poll < 3; poll++) expect(ready('hwip-app-sched-abc123', 'claude')).toBe(false);
    });

    it('is ready only after two reads in a row show the same idle screen', () => {
        const ready = check(() => IDLE);
        expect(ready('s', 'claude')).toBe(false); // the first idle read only marks the screen
        expect(ready('s', 'claude')).toBe(true);
    });

    it('starts over when a read in between is not idle', () => {
        let screen = IDLE;
        const ready = check(() => screen, { states: { 'working…': 'working', 'Trust this folder? (y)': 'blocked' } });
        expect(ready('s', 'claude')).toBe(false);
        for (const notIdle of ['working…', 'Trust this folder? (y)', 'starting']) {
            screen = notIdle;
            expect(ready('s', 'claude')).toBe(false);
        }
        screen = IDLE;
        expect(ready('s', 'claude')).toBe(false);
        expect(ready('s', 'claude')).toBe(true);
    });

    it('starts over when the shell takes the foreground in between', () => {
        let agent = true;
        const ready = check(() => IDLE, { foreground: () => agent });
        expect(ready('s', 'claude')).toBe(false);
        agent = false;
        expect(ready('s', 'claude')).toBe(false);
        agent = true;
        expect(ready('s', 'claude')).toBe(false);
        expect(ready('s', 'claude')).toBe(true);
    });

    it('is not ready when the idle screen changed between the two reads', () => {
        const other = '> \n? for shortcuts  ⏵ update available';
        let screen = IDLE;
        const ready = check(() => screen, { states: { [other]: 'idle' } });
        expect(ready('s', 'claude')).toBe(false);
        screen = other; // still idle by the rules, but something moved on the screen
        expect(ready('s', 'claude')).toBe(false);
        expect(ready('s', 'claude')).toBe(true);
    });

    it('does not count a footer whose numbers tick (clock, cost, tokens) as a change', () => {
        const at = (clock: string) => `> \n? for shortcuts  ${clock}  $0.12`;
        let screen = at('16:07:13');
        const ready = check(() => screen, { states: { [at('16:07:13')]: 'idle', [at('16:07:18')]: 'idle' } });
        expect(ready('s', 'claude')).toBe(false);
        screen = at('16:07:18');
        expect(ready('s', 'claude')).toBe(true);
    });

    it('does not pair a read with one from longer ago than two polls (a past run under the same name)', () => {
        let clock = 0;
        const ready = createReadyCheck({ foregroundIsAgent: () => true, screenOf: () => IDLE, stateOf: () => 'idle', now: () => clock });
        expect(ready('hwip-app-sched-abc123', 'claude')).toBe(false); // the last read of a run that then ended
        clock += READ_PAIR_MAX_MS + 1; // the next run starts under the same session name
        expect(ready('hwip-app-sched-abc123', 'claude')).toBe(false);
        clock += 5_000;
        expect(ready('hwip-app-sched-abc123', 'claude')).toBe(true);
    });

    it('needs two fresh reads again after it said ready once', () => {
        const ready = check(() => IDLE);
        ready('s', 'claude');
        expect(ready('s', 'claude')).toBe(true);
        expect(ready('s', 'claude')).toBe(false);
        expect(ready('s', 'claude')).toBe(true);
    });

    it('keeps each session to its own reads', () => {
        const ready = createReadyCheck({ foregroundIsAgent: () => true, screenOf: () => IDLE, stateOf: () => 'idle', now: () => 0 });
        expect(ready('a', 'claude')).toBe(false);
        expect(ready('b', 'claude')).toBe(false);
        expect(ready('a', 'claude')).toBe(true);
    });

    it('is not ready when the pane cannot be read', () => {
        let screen: string | null = IDLE;
        const ready = check(() => screen);
        ready('s', 'claude');
        screen = null;
        expect(ready('s', 'claude')).toBe(false);
        screen = IDLE;
        expect(ready('s', 'claude')).toBe(false);
    });

    it('never takes a screen that has stopped changing for ready', () => {
        const ready = createReadyCheck({ foregroundIsAgent: () => true, screenOf: () => 'static', stateOf: () => 'unknown' });
        for (let poll = 0; poll < 5; poll++) expect(ready('s', 'amp')).toBe(false);
    });
});

describe('hasIdleRule', () => {
    it('is true for an agent with an idle rule', () => {
        expect(hasIdleRule(manifest({ claude: [rule({ id: 'a', state: 'working' }), rule({ id: 'b', state: 'idle' })] }), 'claude')).toBe(true);
    });

    it('is false for an agent with rules but none that say idle (codex, opencode)', () => {
        expect(hasIdleRule(manifest({ codex: [rule({ id: 'a', state: 'working' }), rule({ id: 'b', state: 'blocked' })] }), 'codex')).toBe(false);
    });

    it('is false for an agent with no rules at all', () => {
        expect(hasIdleRule(manifest({}), 'cursor')).toBe(false);
    });

    it('does not count an idle rule that is switched off or only keeps the previous state', () => {
        const m = manifest({ claude: [rule({ id: 'off', state: 'idle' }), rule({ id: 'keep', state: 'idle', skipStateUpdate: true })] }, ['off']);
        expect(hasIdleRule(m, 'claude')).toBe(false);
    });
});

describe('promptableKinds', () => {
    it('keeps the kinds that have an idle rule, in order', () => {
        const m = manifest({ claude: [rule({ id: 'b', state: 'idle' })], codex: [rule({ id: 'c', state: 'working' })], pi: [rule({ id: 'd', state: 'idle' })] });
        expect(promptableKinds(m, ['codex', 'pi', 'claude', 'cursor'])).toEqual(['pi', 'claude']);
    });
});

// The OTA manifest is not signed and replaces the bundle whole; a schedule must not trust it with "this dialog is idle".
describe('the bundled rules only', () => {
    const approvalScreen = 'Allow Codex to run `rm -rf build`?\n  1. Yes\n  2. No, and tell Codex what to do differently\nenter to confirm';
    const hostile: DetectionManifest = {
        ...DEFAULT_MANIFEST,
        agents: { ...DEFAULT_MANIFEST.agents, codex: [{ id: 'codex-idle-anything', state: 'idle', priority: 1000, regex: ['.'] }] },
    };

    it('the hostile manifest does call the dialog idle, for the code that reads the active manifest', () => {
        expect(hasIdleRule(hostile, 'codex')).toBe(true);
        expect(evaluateState(approvalScreen, 'codex', hostile).state).toBe('idle');
    });

    it('does not take a prompt for an agent whose bundled rules have no idle rule', () => {
        expect(canPromptKind('opencode')).toBe(false);
        expect(promptableScheduleKinds(['claude', 'codex', 'opencode'])).not.toContain('opencode');
    });

    it('takes a prompt for the agents whose bundled rules have an idle rule', () => {
        expect(canPromptKind('claude')).toBe(true);
        expect(canPromptKind('codex')).toBe(true);
        expect(promptableScheduleKinds(['claude', 'codex', 'opencode'])).toEqual(['claude', 'codex']);
    });

    it('reads a screen with the bundled rules: a codex approval dialog is not idle', () => {
        expect(scheduleScreenState(approvalScreen, 'codex')).not.toBe('idle');
    });

    // The codex tool-approval dialog was never captured; if it keeps the `? for shortcuts` footer, the idle rule must still refuse it.
    it.each([
        ['an option list', 'Allow Codex to run `rm -rf build`?\n› 1. Yes\n  2. No\n? for shortcuts'],
        ['an esc footer', 'Allow Codex to run `rm -rf build`?\n  y yes · n no · esc cancel\n? for shortcuts'],
        ['an enter-to-confirm footer', 'Allow Codex to run `rm -rf build`?\n> Yes, proceed\n  No\nPress enter to confirm\n? for shortcuts'],
        ['an esc-to-cancel hint', 'Allow Codex to run `rm -rf build`?\n> Yes, proceed\n  No\n(esc to cancel)\n? for shortcuts'],
        ['an option list far above the footer', `Allow Codex to run \`rm -rf build\`?\n› 1. Yes\n  2. No\n${'  build/out.log\n'.repeat(12)}? for shortcuts`],
        ['key hints on the options', 'Allow Codex to run `rm -rf build`?\n  Yes, proceed (y)\n  No (n)\n? for shortcuts'],
    ])('does not read a codex dialog with %s as idle, even beside the footer', (_shape, screen) => {
        expect(scheduleScreenState(screen, 'codex')).not.toBe('idle');
    });
});
