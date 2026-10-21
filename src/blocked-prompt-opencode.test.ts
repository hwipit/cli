import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlockedDialog, stripEscapes } from './blocked-prompt.js';
import { promptStillShown } from './blocked-prompt-seal.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');

// Captured with `tmux capture-pane -e`: OpenCode shows the chosen button by its background colour only.
const BASH = pane('opencode-blocked-permission.ansi.txt');
const BASH_ALWAYS = pane('opencode-blocked-permission-always.ansi.txt');
const EDIT = pane('opencode-blocked-edit.ansi.txt');

const SELECTED_BG = '\u001b[48;2;250;178;131m';
const PANEL_BG = '\u001b[48;2;30;30;30m';

describe('parseBlockedDialog — OpenCode permission (captured, v2.0.29, default theme)', () => {
    it('reads the bash request: command, fixed question, buttons and left/right keys', () => {
        const prompt = parseBlockedDialog(BASH, 'opencode');
        expect(prompt).toMatchObject({
            title: 'Permission required',
            detail: ['$ touch e.txt'],
            question: 'Allow this request?',
            options: [
                { n: 1, label: 'Allow once', keys: ['enter'] },
                { n: 2, label: 'Always allow', keys: ['right', 'enter'], persistent: true },
                { n: 3, label: 'Reject', keys: ['right', 'right', 'enter'] },
            ],
        });
        expect(prompt).not.toHaveProperty('subtitle');
    });

    it('reads the edit request: the target is the subtitle, the diff the detail', () => {
        expect(parseBlockedDialog(EDIT, 'opencode')).toMatchObject({
            title: 'Permission required',
            subtitle: 'Edit a.txt',
            detail: ['1 - hello', '1 + goodbye'],
        });
    });

    it('counts keys from the button the screen highlights (captured after one right)', () => {
        // OpenCode spells out what "Always allow" grants while it is chosen.
        expect(parseBlockedDialog(BASH_ALWAYS, 'opencode')).toMatchObject({
            detail: ['This will always allow the following patterns for this project.', '', '- touch *'],
            options: [{ keys: ['left', 'enter'] }, { keys: ['enter'] }, { keys: ['right', 'enter'] }],
        });
    });

    it('gives a new id when only the background moves, and the bound check sees it', () => {
        const ALWAYS = '\u001b[38;2;238;238;238mAlways allow\u001b[38;2;255;255;255m';
        const moved = BASH.replace(SELECTED_BG, PANEL_BG).replace(`${PANEL_BG}  ${ALWAYS}`, `${PANEL_BG}  ${SELECTED_BG}${ALWAYS}${PANEL_BG}`);
        expect(stripEscapes(moved)).toBe(stripEscapes(BASH));
        expect(parseBlockedDialog(moved, 'opencode')?.options.map((o) => o.keys))
            .toEqual([['left', 'enter'], ['enter'], ['right', 'enter']]);
        const id = parseBlockedDialog(BASH, 'opencode')!.id;
        expect(parseBlockedDialog(moved, 'opencode')!.id).not.toBe(id);
        expect(promptStillShown(id, BASH)).toBe(true);
        expect(promptStillShown(id, moved)).toBe(false);
    });

    it('counts left keys when the last button is highlighted: the row wraps, so no key may assume it does not', () => {
        const REJECT = '\u001b[38;2;238;238;238mReject\u001b[38;2;255;255;255m';
        const onReject = BASH.replace(SELECTED_BG, PANEL_BG).replace(`   ${REJECT}`, `   ${SELECTED_BG}${REJECT}${PANEL_BG}`);
        expect(stripEscapes(onReject)).toBe(stripEscapes(BASH));
        expect(parseBlockedDialog(onReject, 'opencode')?.options.map((o) => o.keys))
            .toEqual([['left', 'left', 'enter'], ['left', 'enter'], ['enter']]);
    });

    it('takes the button row from the bottom of the panel, not from a request that prints the hint text', () => {
        const echo = BASH.replace('$ touch e.txt', '$ echo "Allow once  Always allow  ⇆ select  enter confirm"');
        expect(parseBlockedDialog(echo, 'opencode')).toMatchObject({
            detail: ['$ echo "Allow once  Always allow  ⇆ select  enter confirm"'],
            options: [{ keys: ['enter'] }, { keys: ['right', 'enter'] }, { keys: ['right', 'right', 'enter'] }],
        });
    });

    it('reads nothing from a capture without escapes: the highlight cannot be seen', () => {
        expect(parseBlockedDialog(pane('opencode-blocked-permission.txt'), 'opencode')).toBeUndefined();
        expect(parseBlockedDialog(pane('opencode-blocked-edit.txt'), 'opencode')).toBeUndefined();
    });

    it('reads nothing unless exactly one button stands out', () => {
        expect(parseBlockedDialog(BASH.replace(SELECTED_BG, PANEL_BG), 'opencode')).toBeUndefined();
        const twoLit = BASH.replace(`${PANEL_BG}  \u001b[38;2;238;238;238mAlways allow`, `${SELECTED_BG}  \u001b[38;2;238;238;238mAlways allow`);
        expect(twoLit).not.toBe(BASH);
        expect(parseBlockedDialog(twoLit, 'opencode')).toBeUndefined();
    });

    it('reads colours given in one sequence, foreground and background together', () => {
        // tmux writes one sequence per attribute; another terminal or version may join them.
        const joined = BASH.replace('\u001b[48;2;250;178;131m \u001b[38;2;10;10;10mAllow once', '\u001b[38;2;10;10;10;48;2;250;178;131m Allow once');
        expect(joined).not.toBe(BASH);
        expect(parseBlockedDialog(joined, 'opencode')?.options.map((o) => o.keys))
            .toEqual([['enter'], ['right', 'enter'], ['right', 'right', 'enter']]);
        expect(parseBlockedDialog(BASH.replace(SELECTED_BG, '\u001b[48;2;250;178;131;7m'), 'opencode')).toBeUndefined();
    });

    it('reads nothing when a theme marks the button with reverse video', () => {
        expect(parseBlockedDialog(BASH.replace(SELECTED_BG, `${PANEL_BG}\u001b[7m`), 'opencode')).toBeUndefined();
    });

    it('is not read as another agent', () => {
        expect(parseBlockedDialog(BASH, 'claude')).toBeUndefined();
        expect(parseBlockedDialog(BASH, 'gemini')).toBeUndefined();
        expect(parseBlockedDialog(BASH, 'pi')).toBeUndefined();
    });
});

// Captured from a live OpenCode v2.1.2 session (`tmux capture-pane -e`): the question tool's panel, highlight on 2.
const QUESTION = pane('opencode-blocked-question.ansi.txt');
const LIT = '\u001b[38;2;250;178;131m';
const DIM = '\u001b[38;2;128;128;128m';
/** QUESTION with the highlight moved from option 2 to option `to`. */
const highlightOn = (to: number): string =>
    QUESTION.replace(`${LIT}2.`, `${DIM}2.`).replace(`${LIT}PR까지`, '\u001b[38;2;238;238;238mPR까지')
        .replace(`${DIM}${to}.`, `${LIT}${to}.`);

describe('parseBlockedDialog — OpenCode question tool (captured, v2.1.2, default theme)', () => {
    it('reads the question, the answers with their notes, and up/down keys from the highlight', () => {
        expect(parseBlockedDialog(QUESTION, 'opencode')).toMatchObject({
            title: 'Question',
            question: '`docs/agents-instructions` 브랜치를 origin에 push해도 될까요? (커밋 `3d19917`)',
            detail: [
                'Push만 (Recommended): 브랜치를 origin에 올리고 PR은 만들지 않는다',
                'PR까지: push 후 main 대상 PR을 만든다',
                '아직 안 함: 커밋만 두고 push하지 않는다',
            ],
            options: [
                { n: 1, label: 'Push만 (Recommended)', keys: ['up', 'enter'] },
                { n: 2, label: 'PR까지', keys: ['enter'] },
                { n: 3, label: '아직 안 함', keys: ['down', 'enter'] },
            ],
        });
    });

    it('leaves out "Type your own answer": choosing it opens a text field the keys cannot fill', () => {
        const labels = parseBlockedDialog(QUESTION, 'opencode')!.options.map((o) => o.label);
        expect(labels).not.toContain('Type your own answer');
        expect(parseBlockedDialog(highlightOn(4), 'opencode')!.options.map((o) => o.keys)).toEqual([
            ['up', 'up', 'up', 'enter'],
            ['up', 'up', 'enter'],
            ['up', 'enter'],
        ]);
    });

    it('gives a new id when the highlight moves, and the bound check sees it', () => {
        const id = parseBlockedDialog(QUESTION, 'opencode')!.id;
        const moved = highlightOn(1);
        expect(parseBlockedDialog(moved, 'opencode')!.id).not.toBe(id);
        expect(promptStillShown(id, QUESTION)).toBe(true);
        expect(promptStillShown(id, moved)).toBe(false);
    });

    it('reads nothing from a capture without escapes: the highlight cannot be seen', () => {
        expect(parseBlockedDialog(stripEscapes(QUESTION), 'opencode')).toBeUndefined();
    });

    it('reads nothing unless exactly one answer stands out', () => {
        expect(parseBlockedDialog(highlightOn(1).replace(`${DIM}3.`, `${LIT}3.`), 'opencode')).toBeUndefined();
    });

    it('reads nothing from a footer it has not seen (several questions, a multi-select)', () => {
        const footer = (from: string, to: string) => QUESTION.replace(from, to);
        expect(parseBlockedDialog(footer('select\u001b[38;2;255;255;255m  ', 'select  tab next  '), 'opencode')).toBeUndefined();
        expect(parseBlockedDialog(footer('submit', 'toggle'), 'opencode')).toBeUndefined();
    });

    it('is not read as another agent', () => {
        expect(parseBlockedDialog(QUESTION, 'claude')).toBeUndefined();
        expect(parseBlockedDialog(QUESTION, 'pi')).toBeUndefined();
    });
});
