import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    KNOWN_TITLES, MAX_DETAIL_LINES, MAX_DETAIL_LINE_CHARS, MAX_PROMPT_BYTES, parseBlockedDialog, promptPlaintext,
} from './blocked-prompt.js';
import { resolveKeys } from './listener.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');

const RULE = '─'.repeat(40);
const DASH = '╌'.repeat(40);

/** A Bash dialog around `command`, the highlight on option `selected` (1-based). */
const bashDialog = (command: string[], selected = 1, options = ['Yes', 'Yes, and don’t ask again for: rtk ls *', 'No']): string => [
    '⏺ Reading 1 file…',
    '',
    RULE,
    ' Bash command',
    ' Run shell command',
    DASH,
    ...command.map((l) => ` ${l}`),
    DASH,
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ...options.map((label, i) => ` ${i + 1 === selected ? '❯' : ' '} ${i + 1}. ${label}`),
    '',
    ' Esc to cancel · Tab to amend',
].join('\n');

describe('parseBlockedDialog — captured dialogs', () => {
    it('reads the Bash approval dialog', () => {
        const p = parseBlockedDialog(pane('claude-blocked-bash.txt'), 'claude')!;
        expect(p).toMatchObject({
            title: 'Bash command',
            subtitle: 'Run shell command',
            detail: ['rtk ls -la /home/dev/demo'],
            note: 'This command requires approval',
            question: 'Do you want to proceed?',
        });
        expect(p.options).toEqual([
            { n: 1, label: 'Yes', keys: ['enter'] },
            { n: 2, label: 'Yes, and don’t ask again for: rtk ls *', keys: ['down', 'enter'], persistent: true },
            { n: 3, label: 'No', keys: ['down', 'down', 'enter'] },
        ]);
        expect(p.id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('reads the Create-file dialog: the diff is the detail, no note', () => {
        const p = parseBlockedDialog(pane('claude-blocked-create.txt'), 'claude')!;
        expect(p).toMatchObject({ title: 'Create file', subtitle: 'notes.txt', detail: [' 1 alpha'], question: 'Do you want to create notes.txt?' });
        expect(p.note).toBeUndefined();
        expect(p.options.map((o) => o.persistent)).toEqual([undefined, true, undefined]);
    });

    it('reads the Edit dialog: the diff lines keep their markers', () => {
        const p = parseBlockedDialog(pane('claude-blocked-edit.txt'), 'claude')!;
        expect(p.title).toBe('Edit file');
        expect(p.detail).toEqual(['1 -alpha', '1   No newline at end of file', '2 +beta', '3   No newline at end of file']);
        expect(p.question).toBe('Do you want to make this edit to notes.txt?');
    });

    it('yields nothing for the dialogs it has no layout for', () => {
        expect(parseBlockedDialog(pane('claude-blocked-askuserquestion.txt'), 'claude')).toBeUndefined();
        expect(parseBlockedDialog(pane('claude-blocked-trust-dialog.txt'), 'claude')).toBeUndefined();
        expect(parseBlockedDialog(pane('claude-idle.txt'), 'claude')).toBeUndefined();
        expect(parseBlockedDialog(pane('claude-working.txt'), 'claude')).toBeUndefined();
        expect(parseBlockedDialog('Do you want to proceed?\n❯ 1. Yes\nEnter to select · esc to cancel', 'claude')).toBeUndefined();
    });
});

describe('parseBlockedDialog — shape', () => {
    it('joins a multi-line command as detail lines', () => {
        const p = parseBlockedDialog(bashDialog(['git add -A && \\', '  git commit -m "x"']), 'claude')!;
        expect(p.detail).toEqual(['git add -A && \\', '  git commit -m "x"']);
    });

    it('ignores a status line drawn below the footer', () => {
        const base = bashDialog(['ls']);
        const withStatus = `${base}\n\n${RULE}\n  Haiku 4.5 | demo | 23%\n  -- INSERT --`;
        const a = parseBlockedDialog(base, 'claude')!;
        const b = parseBlockedDialog(withStatus, 'claude')!;
        expect(b).toBeDefined();
        expect(b.id).toBe(a.id);
    });

    it('joins a label that wraps onto an indented line', () => {
        const p = parseBlockedDialog(bashDialog(['ls'], 1, ['Yes', 'Yes, and don’t ask again for\n      very long thing', 'No']), 'claude')!;
        expect(p.options[1]!.label).toBe('Yes, and don’t ask again for very long thing');
    });

    it('refuses numbering that does not run 1..n, no highlight, or two highlights', () => {
        expect(parseBlockedDialog(bashDialog(['ls']).replace('  2. Yes', '  3. Yes'), 'claude')).toBeUndefined();
        expect(parseBlockedDialog(bashDialog(['ls']).replace('❯', ' '), 'claude')).toBeUndefined();
        expect(parseBlockedDialog(bashDialog(['ls']).replace('  3. No', '❯ 3. No'), 'claude')).toBeUndefined();
    });

    it('refuses more than 9 options', () => {
        const many = Array.from({ length: 10 }, (_, i) => `option ${i}`);
        expect(parseBlockedDialog(bashDialog(['ls'], 1, many), 'claude')).toBeUndefined();
    });

    it('reads a title only from the known list', () => {
        expect(KNOWN_TITLES).toEqual(['Bash command', 'Edit file', 'Create file']);
        expect(parseBlockedDialog(bashDialog(['ls']).replace('Bash command', 'Fetch'), 'claude')).toBeUndefined();
    });

    it('does not take a numbered line of the command for an option', () => {
        const p = parseBlockedDialog(bashDialog(['echo "1. fake"', '2. also fake']), 'claude')!;
        expect(p.options.map((o) => o.label)).toEqual(['Yes', 'Yes, and don’t ask again for: rtk ls *', 'No']);
        expect(p.detail).toEqual(['echo "1. fake"', '2. also fake']);
    });

    it('caps detail at 12 lines and 300 characters a line, and says so', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
        const p = parseBlockedDialog(bashDialog(lines), 'claude')!;
        expect(p.detail).toHaveLength(MAX_DETAIL_LINES);
        expect(p.detailTruncated).toBe(true);
        const long = parseBlockedDialog(bashDialog(['x'.repeat(500)]), 'claude')!;
        expect(long.detail[0]).toHaveLength(MAX_DETAIL_LINE_CHARS);
        expect(long.detailTruncated).toBe(true);
        expect(parseBlockedDialog(bashDialog(['short']), 'claude')!.detailTruncated).toBeUndefined();
    });

    it('marks the options that grant more than this request', () => {
        const labels = ['Yes', 'Yes, allow always', 'Yes, for this session', 'Yes, and never ask again', 'No'];
        const p = parseBlockedDialog(bashDialog(['ls'], 1, labels), 'claude')!;
        expect(p.options.map((o) => o.persistent === true)).toEqual([false, true, true, true, false]);
    });

    // The wording Claude Code puts on a standing grant. The first two are on the captured screens; the others are
    // reported from live screens (worker3's review) and not captured here — keep adding the ones a screen shows.
    it.each([
        'Yes, and don’t ask again for: rtk ls *',
        'Yes, and allow Claude to edit files in its ~/.claude folder for this session',
        'Yes, allow all edits during this session (shift+tab)',
        'Yes, allow all edits during this session',
        'Yes, allow all edits in this project',
        'Yes, and always allow access to src/ from this project',
        'Yes, and don\'t ask again for git commit commands in /home/dev/demo',
        'Yes, allow Claude to run this tool from now on',
    ])('marks "%s" as a standing grant', (label) => {
        const p = parseBlockedDialog(bashDialog(['ls'], 1, ['Yes', label, 'No']), 'claude')!;
        expect(p.options.map((o) => o.persistent === true)).toEqual([false, true, false]);
    });

    it.each([
        'Yes',
        'Yes, proceed',
        'No',
        'No, and tell Claude what to do differently (esc)',
        'Yes, and tell Claude what to do next',
    ])('does not mark "%s"', (label) => {
        const p = parseBlockedDialog(bashDialog(['ls'], 1, ['Yes', label, 'No']), 'claude')!;
        expect(p.options[1]!.persistent).toBeUndefined();
    });

    it('reads the standing grant off a whole Edit screen too', () => {
        const edit = pane('claude-blocked-edit.txt').replace(
            'Yes, and allow Claude to edit files in its ~/.claude folder for this session',
            'Yes, allow all edits during this session (shift+tab)',
        );
        expect(parseBlockedDialog(edit, 'claude')!.options.map((o) => o.persistent === true)).toEqual([false, true, false]);
    });
});

describe('keys follow the highlight', () => {
    it('counts from the highlighted option, up or down', () => {
        const p = parseBlockedDialog(bashDialog(['ls'], 2), 'claude')!;
        expect(p.options.map((o) => o.keys)).toEqual([['up', 'enter'], ['enter'], ['down', 'enter']]);
    });

    it('uses only keys the listener accepts', () => {
        const p = parseBlockedDialog(bashDialog(['ls'], 3), 'claude')!;
        for (const o of p.options) expect(resolveKeys(o.keys)).not.toBeNull();
    });
});

describe('id', () => {
    it('is the same for the same screen', () => {
        expect(parseBlockedDialog(bashDialog(['ls']), 'claude')!.id).toBe(parseBlockedDialog(bashDialog(['ls']), 'claude')!.id);
    });

    it('changes when the highlight moves — a key sent for the old position must not apply', () => {
        const ids = [1, 2, 3].map((n) => parseBlockedDialog(bashDialog(['ls'], n), 'claude')!.id);
        expect(new Set(ids).size).toBe(3);
    });

    it('changes with the command', () => {
        expect(parseBlockedDialog(bashDialog(['ls']), 'claude')!.id).not.toBe(parseBlockedDialog(bashDialog(['rm x']), 'claude')!.id);
    });

    it('does not change with what is above the dialog', () => {
        const a = bashDialog(['ls']);
        const b = `scrollback line\nmore\n${a}`;
        expect(parseBlockedDialog(b, 'claude')!.id).toBe(parseBlockedDialog(a, 'claude')!.id);
    });

    it('is the same from a capture with colour escapes (`capture-pane -e`) as from a plain one', () => {
        const plain = pane('claude-blocked-bash.txt');
        const coloured = plain
            .split('\n')
            .map((l) => (l.trim() === '' ? l : `\u001b[38;2;215;119;87m${l}\u001b[39m\u001b[0m`))
            .join('\n')
            .replace('❯', '\u001b[1m❯\u001b[22m');
        expect(coloured).not.toBe(plain);
        expect(parseBlockedDialog(coloured, 'claude')!.id).toBe(parseBlockedDialog(plain, 'claude')!.id);
    });

    it('is the same with an OSC 8 hyperlink drawn in the dialog, and no escape reaches the summary', () => {
        const plain = pane('claude-blocked-bash.txt');
        const command = parseBlockedDialog(plain, 'claude')!.detail[0]!.trim();
        const linked = plain.replace(command, `\u001b]8;;file:///tmp/x\u001b\\${command}\u001b]8;;\u001b\\`);
        expect(linked).not.toBe(plain);
        const read = parseBlockedDialog(linked, 'claude')!;
        expect(read.id).toBe(parseBlockedDialog(plain, 'claude')!.id);
        expect(JSON.stringify(read)).not.toContain('\\u001b');
    });
});

describe('promptPlaintext', () => {
    const ctx = { sessionName: 'hwip-demo', deviceId: 'dev_mac', at: '2026-10-03T02:00:00.000Z' };

    it('carries the session, the device and the time', () => {
        const p = parseBlockedDialog(pane('claude-blocked-bash.txt'), 'claude')!;
        const json = JSON.parse(promptPlaintext(p, ctx)!);
        expect(json).toMatchObject({ v: 1, ...ctx, id: p.id, kind: 'permission', title: 'Bash command', question: 'Do you want to proceed?' });
        expect(json.options).toHaveLength(3);
    });

    it('stays within the byte cap by dropping detail from the end', () => {
        const lines = Array.from({ length: 12 }, () => '가'.repeat(100));
        const p = parseBlockedDialog(bashDialog(lines), 'claude')!;
        const json = promptPlaintext(p, ctx)!;
        expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
        const parsed = JSON.parse(json);
        expect(parsed.detail.length).toBeLessThan(12);
        expect(parsed.detailTruncated).toBe(true);
    });

    it('gives up when even without detail it does not fit', () => {
        const p = parseBlockedDialog(bashDialog(['ls']), 'claude')!;
        p.options = p.options.map((o) => ({ ...o, label: '가'.repeat(200) }));
        expect(promptPlaintext(p, ctx)).toBeUndefined();
    });
});
