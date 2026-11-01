import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlockedDialog, promptPlaintext, MAX_PROMPT_BYTES } from './blocked-prompt.js';
import { resolveKeys } from './listener.js';

const pane = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');
const read = (name: string) => parseBlockedDialog(pane(name), 'claude');

describe('Claude AskUserQuestion', () => {
    it('single question: reads the question and options, leaving out the free-text rows', () => {
        const p = read('claude-blocked-ask-single.txt')!;
        expect(p.title).toBe('Claude is asking');
        expect(p.question).toBe('Which environment should I deploy to?');
        expect(p.subtitle).toBe('☐ Env');
        expect(p.options.map((o) => [o.n, o.label, o.keys])).toEqual([
            [1, 'Staging — safe test target', ['enter']],
            [2, 'Production — live users', ['down', 'enter']],
        ]);
    });

    it('single question: every option key is one the listener accepts', () => {
        for (const o of read('claude-blocked-ask-single.txt')!.options) expect(resolveKeys(o.keys)).not.toBeNull();
    });

    it('single question: an option that only repeats its label gets no description', () => {
        const p = read('claude-blocked-ask-multiq-single.txt')!;
        expect(p.subtitle).toBe('☐ Color · ☐ Tags');
        expect(p.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue']);
    });

    it('single question: the old capture reads too', () => {
        expect(parseBlockedDialog(pane('claude-blocked-askuserquestion.txt'), 'claude')?.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue']);
    });

    it('does not read a dialog whose highlight sits on the free-text row or text is being typed', () => {
        expect(read('claude-blocked-ask-other-typing.txt')).toBeUndefined();
    });
});

describe('Claude AskUserQuestion multiselect', () => {
    it('keeps the checkbox in the label and adds Submit, keys skipping the free-text row', () => {
        const p = read('claude-blocked-ask-multiselect.txt')!;
        expect(p.subtitle).toBe('☒ Color · ☐ Tags');
        expect(p.options.map((o) => [o.n, o.label])).toEqual([[1, '[ ] A'], [2, '[ ] B'], [3, '[ ] C'], [4, 'Submit']]);
        // From A: toggle in place; B one down; Submit is past the Type something row.
        expect(p.options.map((o) => o.keys)).toEqual([['enter'], ['down', 'enter'], ['down', 'down', 'enter'], ['down', 'down', 'down', 'down', 'enter']]);
    });

    it('a toggle changes the prompt id', () => {
        expect(read('claude-blocked-ask-multiselect-toggled.txt')!.id).not.toBe(read('claude-blocked-ask-multiselect.txt')!.id);
        expect(read('claude-blocked-ask-multiselect-toggled.txt')!.options[0]!.label).toBe('[✔] A');
    });

    it('with the highlight on Submit, the other rows are reached upward', () => {
        const p = read('claude-blocked-ask-multiselect-submit-row.txt')!;
        expect(p.options.map((o) => o.keys)).toEqual([
            ['up', 'up', 'up', 'up', 'enter'], ['up', 'up', 'up', 'enter'], ['up', 'up', 'enter'], ['enter'],
        ]);
    });
});

describe('Claude AskUserQuestion review', () => {
    it('reads the review of several answers: the answers as detail, Submit answers and Cancel as options', () => {
        const p = read('claude-blocked-ask-review.txt')!;
        expect(p.title).toBe('Review your answers');
        expect(p.question).toBe('Ready to submit your answers?');
        expect(p.detail).toEqual(['● Pick a color', '  → Red', '● Pick tags', '  → A']);
        expect(p.options.map((o) => [o.label, o.keys])).toEqual([['Submit answers', ['enter']], ['Cancel', ['down', 'enter']]]);
    });
});

describe('Claude ExitPlanMode', () => {
    it('reads the plan, the plan file and the two answers that need no text', () => {
        const p = read('claude-blocked-exitplan-short.txt')!;
        expect(p.title).toBe('Ready to code?');
        expect(p.subtitle).toBe("Here is Claude's plan:");
        expect(p.detail[0]).toBe('Plan: Create hello.txt');
        expect(p.detail).toContain('- Report result to user.');
        expect(p.note).toBe('~/.claude/plans/make-a-plan-with-dreamy-eich.md');
        expect(p.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?');
        expect(p.options.map((o) => [o.n, o.label, o.persistent === true])).toEqual([
            [1, 'Yes, and use auto mode', true],
            [2, 'Yes, manually approve edits', false],
        ]);
    });

    it('a long plan shows what the viewport shows, flagged truncated, and numbered steps are not options', () => {
        const p = read('claude-blocked-exitplan-long.txt')!;
        expect(p.detailTruncated).toBe(true);
        expect(p.detail[0]).toMatch(/^1\. List all files/);
        expect(p.detail.every((l) => !/[↓↑]$/.test(l))).toBe(true);
        expect(p.options).toHaveLength(2);
    });

    it('a plan that does not fit the cap is cut from its end and still seals', () => {
        const p = read('claude-blocked-exitplan-long.txt')!;
        const json = promptPlaintext(p, { sessionName: 's', deviceId: 'd', at: '2026-11-01T00:00:00Z' });
        expect(json).toBeDefined();
        expect(Buffer.byteLength(json!)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    });

    it('narrow pane: the wrapped question and footer read the same', () => {
        const p = read('claude-blocked-exitplan-long-narrow58.txt')!;
        expect(p.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?');
        expect(p.note).toBe('~/.claude/plans/make-a-plan-with-dreamy-eich.md');
        expect(p.options.map((o) => o.n)).toEqual([1, 2]);
    });

    it('with the highlight on the text-input answer there is no prompt', () => {
        expect(read('claude-blocked-exitplan-tell-claude.txt')).toBeUndefined();
    });
});

describe('existing dialogs', () => {
    it('are read as before, and the trust dialog and idle screens still are not', () => {
        expect(read('claude-blocked-bash.txt')!.title).toBe('Bash command');
        expect(read('claude-blocked-trust-dialog.txt')).toBeUndefined();
        expect(read('claude-idle.txt')).toBeUndefined();
        expect(read('claude-working.txt')).toBeUndefined();
    });
});

describe('persistent marking', () => {
  it('still marks the approvals that last, and not an ordinary choice', () => {
    const bash = read('claude-blocked-bash.txt')!;
    expect(bash.options.map((o) => o.persistent === true)).toEqual([false, true, false]);
    expect(read('claude-blocked-ask-single.txt')!.options.some((o) => o.persistent)).toBe(false);
  });
});

describe('persistent marking beside the Codex reader', () => {
  it('still marks the Codex "don\'t ask again" choices as persistent, and not the plain ones', () => {
    for (const name of ['codex-blocked-tool-exec.txt', 'codex-blocked-tool-exec-wrapped.txt', 'codex-blocked-tool-edit.txt']) {
      const p = parseBlockedDialog(pane(name), 'codex')!;
      const lasting = p.options.filter((o) => /don.?t ask again/i.test(o.label));
      expect(lasting.length, name).toBeGreaterThan(0);
      expect(lasting.every((o) => o.persistent === true), name).toBe(true);
      expect(p.options.filter((o) => !/don.?t ask again/i.test(o.label)).every((o) => !o.persistent), name).toBe(true);
    }
  });
});
