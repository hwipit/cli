import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlockedDialog } from './blocked-prompt.js';
import { promptStillShown } from './blocked-prompt-seal.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');

const GATE = pane('pi-blocked-permission-gate.txt');

/** The same dialog with the `→` highlight on "No". */
const onNo = GATE.replace(' → Yes', '   Yes').replace('   No', ' → No');

describe('parseBlockedDialog — pi extension select (captured, pi 1.2.0 permission-gate example)', () => {
    it('reads the title, the command, the question and the answers', () => {
        expect(parseBlockedDialog(GATE, 'pi')).toMatchObject({
            title: '⚠️ Dangerous command:',
            detail: ['rm -rf /tmp/proj/zz-not-there'],
            question: 'Allow?',
            options: [
                { n: 1, label: 'Yes', keys: ['enter'] },
                { n: 2, label: 'No', keys: ['down', 'enter'] },
            ],
        });
    });

    it('counts keys from the highlight the screen shows', () => {
        expect(parseBlockedDialog(onNo, 'pi')?.options.map((o) => o.keys)).toEqual([['up', 'enter'], ['enter']]);
    });

    it('gives a new id when the highlight moves, and the bound check sees it', () => {
        const id = parseBlockedDialog(GATE, 'pi')!.id;
        expect(parseBlockedDialog(onNo, 'pi')!.id).not.toBe(id);
        expect(promptStillShown(id, GATE)).toBe(true);
        expect(promptStillShown(id, onNo)).toBe(false);
    });

    it('reads a one-line title as the question too', () => {
        const oneLine = GATE.replace(' ⚠️ Dangerous command:\n\n   rm -rf /tmp/proj/zz-not-there\n\n', '');
        expect(parseBlockedDialog(oneLine, 'pi')).toMatchObject({ title: 'Allow?', detail: [], question: 'Allow?' });
    });

    it('leaves out the countdown a select with a timeout ticks on its title', () => {
        const at = (s: number) => GATE.replace(' Allow?\n', ` Allow? (${s}s)\n`);
        const prompt = parseBlockedDialog(at(30), 'pi')!;
        expect(prompt.question).toBe('Allow?');
        expect(parseBlockedDialog(at(29), 'pi')!.id).toBe(prompt.id);
    });

    it('reads nothing without exactly one highlight', () => {
        expect(parseBlockedDialog(GATE.replace(' → Yes', '   Yes'), 'pi')).toBeUndefined();
        expect(parseBlockedDialog(GATE.replace('   No', ' → No'), 'pi')).toBeUndefined();
    });

    it('reads nothing when a line runs into the answers without the gap pi draws (a wrapped label)', () => {
        expect(parseBlockedDialog(GATE.replace(' Allow?\n\n', ' Allow?\n'), 'pi')).toBeUndefined();
    });

    it('reads nothing when the editor is drawn below: the same select in the agent\'s own text', () => {
        const footer = GATE.indexOf(' ↑↓ navigate');
        const end = GATE.indexOf('\n', footer) + 1;
        const editor = '\n' + '─'.repeat(80) + '\n\n' + '─'.repeat(80) + '\n~/proj\n';
        expect(parseBlockedDialog(GATE.slice(0, end) + editor, 'pi')).toBeUndefined();
    });

    it('does not read a working or idle pane', () => {
        expect(parseBlockedDialog(pane('pi-working.txt'), 'pi')).toBeUndefined();
        expect(parseBlockedDialog(pane('pi-idle.txt'), 'pi')).toBeUndefined();
    });
});

const ASK = pane('pi-blocked.txt');
/** ASK with the `>` highlight on "Beta". */
const askOnBeta = ASK.replace('> 1. Alpha', '  1. Alpha').replace('  2. Beta', '> 2. Beta');

describe('parseBlockedDialog — pi ask_user_question picker (captured, pi 0.85.1)', () => {
    it('reads the question and the numbered answers, without "Other"', () => {
        expect(parseBlockedDialog(ASK, 'pi')).toMatchObject({
            title: 'Pick one',
            detail: [],
            question: 'Pick one',
            options: [
                { n: 1, label: 'Alpha', keys: ['enter'] },
                { n: 2, label: 'Beta', keys: ['down', 'enter'] },
            ],
        });
    });

    it('counts keys from the highlight the screen shows, and a new highlight is a new prompt', () => {
        expect(parseBlockedDialog(askOnBeta, 'pi')?.options.map((o) => o.keys)).toEqual([['up', 'enter'], ['enter']]);
        const id = parseBlockedDialog(ASK, 'pi')!.id;
        expect(promptStillShown(id, ASK)).toBe(true);
        expect(promptStillShown(id, askOnBeta)).toBe(false);
    });

    it('still reads the answers when "Other" holds the highlight', () => {
        const onOther = ASK.replace('> 1. Alpha', '  1. Alpha').replace('  Other', '> Other');
        expect(parseBlockedDialog(onOther, 'pi')?.options.map((o) => o.keys)).toEqual([['up', 'up', 'enter'], ['up', 'enter']]);
    });

    it('reads the context and the answers\' notes as detail', () => {
        const withNotes = ASK.replace(' Pick one\n\n>', ' Pick one\n\n Which build to ship\n\n>')
            .replace('> 1. Alpha\n', '> 1. Alpha\n     the old one\n');
        expect(parseBlockedDialog(withNotes, 'pi')).toMatchObject({
            question: 'Pick one',
            detail: ['Which build to ship', 'Alpha: the old one'],
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
        });
    });

    it('reads nothing from the multi-select picker or the custom-answer editor', () => {
        const multi = ASK.replace(' ↑↓ navigate • Enter select • Esc cancel', ' ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel');
        expect(parseBlockedDialog(multi, 'pi')).toBeUndefined();
        const editor = ASK.replace(' ↑↓ navigate • Enter select • Esc cancel', ' Enter to submit • Esc to go back');
        expect(parseBlockedDialog(editor, 'pi')).toBeUndefined();
    });

    it('reads nothing when the editor is drawn below: the same picker in the agent\'s own text', () => {
        const footer = ASK.indexOf(' ↑↓ navigate');
        const end = ASK.indexOf('\n', footer) + 1;
        const editor = '─'.repeat(85) + '\n\n' + '─'.repeat(85) + '\n~/pibench\n';
        expect(parseBlockedDialog(ASK.slice(0, end) + editor, 'pi')).toBeUndefined();
    });
});
