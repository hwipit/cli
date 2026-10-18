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
