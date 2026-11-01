import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlockedDialog } from './blocked-prompt.js';
import { promptStillShown } from './blocked-prompt-seal.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');

const EXEC = pane('codex-blocked-tool-exec.txt');
const EDIT = pane('codex-blocked-tool-edit.txt');
const WRAPPED = pane('codex-blocked-tool-exec-wrapped.txt');

/** The same dialog with the `›` highlight moved from answer 1 to answer 2. */
const onSecond = (text: string): string => text.replace('› 1. Yes', '  1. Yes').replace(/^ {2}2\. /m, '› 2. ');

describe('parseBlockedDialog — codex tool approval (captured, codex-cli 0.166.0)', () => {
    it('reads a shell command: the command, the reason and the answers', () => {
        expect(parseBlockedDialog(EXEC, 'codex')).toMatchObject({
            title: 'Run command',
            detail: ['$ echo ok > probe.txt'],
            note: 'Allow creating probe.txt in the workspace with the requested shell command?',
            question: 'Would you like to run the following command?',
            options: [
                { n: 1, label: 'Yes, proceed (y)', keys: ['enter'] },
                {
                    n: 2,
                    label: "Yes, and don't ask again for commands that start with `echo ok > probe.txt` (p)",
                    keys: ['down', 'enter'],
                    persistent: true,
                },
                { n: 3, label: 'No, and tell Codex what to do differently (esc)', keys: ['down', 'down', 'enter'] },
            ],
        });
    });

    it('joins an answer that wraps onto an indented line, and takes the command from the dialog, not the history', () => {
        const prompt = parseBlockedDialog(WRAPPED, 'codex')!;
        expect(prompt.detail).toEqual(["$ curl -s -o /dev/null -w '%{http_code}' https://example.com"]);
        expect(prompt.options[1]).toMatchObject({
            label: "Yes, and don't ask again for commands that start with `curl -s -o /dev/null -w '%{http_code}' https://example.com` (p)",
            persistent: true,
        });
        expect(prompt.options).toHaveLength(3);
    });

    it('reads a file edit: description and destination, and "these files" as a lasting answer', () => {
        expect(parseBlockedDialog(EDIT, 'codex')).toMatchObject({
            title: 'Edit files',
            detail: ['Description: Apply proposed file edits', 'Destination: /private/tmp/f27cap/README.md'],
            question: 'Would you like to make the following edits?',
            options: [
                { n: 1, keys: ['enter'] },
                { n: 2, label: "Yes, and don't ask again for these files (a)", persistent: true },
                { n: 3, keys: ['down', 'down', 'enter'] },
            ],
        });
    });

    it('reads the coloured capture the way the plain one reads', () => {
        const ansi = pane('codex-blocked-tool-exec.ansi.txt');
        expect(parseBlockedDialog(ansi, 'codex')).toEqual(parseBlockedDialog(EXEC, 'codex'));
    });

    it('counts keys from the highlight the screen shows, and a moved highlight is another prompt', () => {
        const prompt = parseBlockedDialog(EXEC, 'codex')!;
        const moved = parseBlockedDialog(onSecond(EXEC), 'codex')!;
        expect(moved.options.map((o) => o.keys)).toEqual([['up', 'enter'], ['enter'], ['down', 'enter']]);
        expect(moved.id).not.toBe(prompt.id);
        expect(promptStillShown(prompt.id, EXEC)).toBe(true);
        expect(promptStillShown(prompt.id, onSecond(EXEC))).toBe(false);
    });

    it('reads nothing without the confirm footer, a highlight, or numbers 1..n', () => {
        expect(parseBlockedDialog(EXEC.replace('Press enter to confirm or esc to cancel', ''), 'codex')).toBeUndefined();
        expect(parseBlockedDialog(EXEC.replace('› 1. Yes', '  1. Yes'), 'codex')).toBeUndefined();
        expect(parseBlockedDialog(EXEC.replace('  2. Yes', '  4. Yes'), 'codex')).toBeUndefined();
    });

    it('reads nothing when the question is another one (a numbered list in the agent\'s own text)', () => {
        expect(parseBlockedDialog(EXEC.replace('Would you like to run the following command?', 'Pick one?'), 'codex')).toBeUndefined();
    });

    it('reads nothing from the other Codex dialogs or a screen with no dialog', () => {
        for (const name of ['codex-blocked-hooks-review', 'codex-blocked-trust-dialog', 'codex-blocked-update', 'codex-blocked-usage-limit', 'codex-idle', 'codex-working']) {
            expect(parseBlockedDialog(pane(`${name}.txt`), 'codex'), name).toBeUndefined();
        }
    });

    it('reads nothing once the dialog has scrolled off: the history above it is not a prompt', () => {
        expect(parseBlockedDialog(WRAPPED.split('Would you like')[0]!, 'codex')).toBeUndefined();
    });
});
