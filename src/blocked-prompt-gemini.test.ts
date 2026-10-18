import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import { clearRegexCache, evaluateState } from './agent-state.js';
import { parseBlockedDialog } from './blocked-prompt.js';
import { promptStillShown } from './blocked-prompt-seal.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');

const SHELL = pane('gemini-blocked-shell.txt');
const EDIT = pane('gemini-blocked-edit.txt');
const STACKED = pane('gemini-blocked-writefile-stacked.txt');

/** The same dialog with the `●` highlight moved from option 1 to option `to`. */
const highlight = (text: string, to: number): string =>
    text.replace('│ ● 1.', '│   1.').replace(`│   ${to}.`, `│ ● ${to}.`);

describe('parseBlockedDialog — Gemini CLI approval dialogs (captured, v0.46.0)', () => {
    it('reads the Shell approval: tool, command, question and answers', () => {
        const prompt = parseBlockedDialog(SHELL, 'gemini');
        expect(prompt).toMatchObject({
            title: 'Shell',
            subtitle: 'touch c.txt',
            detail: ['touch c.txt'],
            question: 'Allow execution of [Shell]?',
            options: [
                { n: 1, label: 'Allow once', keys: ['enter'] },
                { n: 2, label: 'Allow for this session', keys: ['down', 'enter'], persistent: true },
                { n: 3, label: 'No, suggest changes (esc)', keys: ['down', 'down', 'enter'] },
            ],
        });
        expect(prompt?.options[0]).not.toHaveProperty('persistent');
    });

    it('reads the Edit approval: the diff is the detail', () => {
        const prompt = parseBlockedDialog(EDIT, 'gemini');
        expect(prompt).toMatchObject({
            title: 'Edit',
            subtitle: 'a.txt: hello => goodbye',
            detail: ['1 - hello', '1 + goodbye'],
            question: 'Apply this change?',
        });
        expect(prompt?.options.map((o) => o.label)).toEqual([
            'Allow once', 'Allow for this session', 'Modify with external editor', 'No, suggest changes (esc)',
        ]);
    });

    it('reads a queued dialog under a later notice box, without the queue counter', () => {
        const prompt = parseBlockedDialog(STACKED, 'gemini');
        expect(prompt).toMatchObject({
            title: 'WriteFile',
            subtitle: 'Writing to b.txt',
            detail: ['No changes detected.'],
            question: 'Apply this change?',
        });
        expect(prompt?.options).toHaveLength(4);
    });

    it('counts keys from the highlight the screen shows, up as well as down', () => {
        const prompt = parseBlockedDialog(highlight(SHELL, 3), 'gemini');
        expect(prompt?.options.map((o) => o.keys)).toEqual([['up', 'up', 'enter'], ['up', 'enter'], ['enter']]);
    });

    it('gives a new id when the highlight moves, and the bound check sees it', () => {
        const first = parseBlockedDialog(SHELL, 'gemini')!;
        const moved = highlight(SHELL, 2);
        expect(parseBlockedDialog(moved, 'gemini')!.id).not.toBe(first.id);
        expect(promptStillShown(first.id, SHELL)).toBe(true);
        expect(promptStillShown(first.id, moved)).toBe(false);
    });

    it('reads nothing without exactly one highlight', () => {
        expect(parseBlockedDialog(SHELL.replace('│ ● 1.', '│   1.'), 'gemini')).toBeUndefined();
        expect(parseBlockedDialog(SHELL.replace('│   2.', '│ ● 2.'), 'gemini')).toBeUndefined();
    });

    it('reads nothing when the input box is drawn below: the same box in the agent\'s own text', () => {
        const spoof = `${SHELL.trimEnd()}\n${pane('gemini-idle.txt')}`;
        expect(parseBlockedDialog(spoof, 'gemini')).toBeUndefined();
    });

    it('is not read as a Claude dialog, nor a Claude dialog as Gemini', () => {
        expect(parseBlockedDialog(SHELL, 'claude')).toBeUndefined();
        expect(parseBlockedDialog(pane('claude-blocked-bash.txt'), 'gemini')).toBeUndefined();
    });
});

describe('gemini rules — tool approval reads blocked', () => {
    const classify = (text: string) => {
        clearRegexCache();
        return evaluateState(text, 'gemini', DEFAULT_MANIFEST);
    };

    it.each([['shell', SHELL], ['edit', EDIT], ['stacked', STACKED]])('%s approval is blocked', (_, text) => {
        expect(classify(text)).toMatchObject({ state: 'blocked', ruleId: 'gemini-blocked-tool-approval' });
    });

    it('does not fire on a tool output box whose text prints the answer row', () => {
        const output = [
            '╭──────────────────────────────────────────╮',
            '│ ✓  Shell cat answers.txt                 │',
            '│                                          │',
            '│ 1. Allow once                            │',
            '│ 2. Allow for this session                │',
            '╰──────────────────────────────────────────╯',
        ].join('\n');
        expect(classify(`${pane('gemini-idle.txt')}\n${output}\n`).ruleId).not.toBe('gemini-blocked-tool-approval');
    });

    it('does not fire when the input box is on screen: a dialog drawn in the agent\'s own text', () => {
        expect(classify(`${SHELL.trimEnd()}\n${pane('gemini-idle.txt')}`).ruleId).not.toBe('gemini-blocked-tool-approval');
    });

    it('does not fire on agent text that names the answer outside a dialog box', () => {
        const idle = `${pane('gemini-idle.txt')}\n✦ Pick "1. Allow once" when Gemini asks.\n 1. Allow once\n`;
        expect(classify(idle).ruleId).not.toBe('gemini-blocked-tool-approval');
    });
});
