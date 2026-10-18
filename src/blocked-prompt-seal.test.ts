import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseBlockedDialog } from './blocked-prompt.js';
import { PROMPT_SEAL_RETRY_MS, createPromptSealer, promptStillShown, type PromptSealerDeps } from './blocked-prompt-seal.js';
import type { RecorderRecipient, SealedChunk } from './turn-recorder.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');
const BASH = fixture('claude-blocked-bash.txt');
/** The same dialog with the highlight moved to "No". */
const MOVED = BASH.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No');

const RECIPIENTS: RecorderRecipient[] = [{ deviceId: 'phone', publicKey: 'pk-phone', pinnedAt: 'x' } as RecorderRecipient];

const harness = (over: Partial<PromptSealerDeps> = {}) => {
    let t = Date.parse('2026-10-03T02:00:00.000Z');
    const sealed: string[] = [];
    const logs: string[] = [];
    const deps: PromptSealerDeps = {
        deviceId: () => 'dev_mac',
        recipients: async () => RECIPIENTS,
        seal: async (plaintext) => {
            sealed.push(plaintext);
            return { body: `sealed-${sealed.length}`, deviceKeyMap: { phone: 'k' }, senderPublicKey: 'spk' } as SealedChunk;
        },
        log: (m) => logs.push(m),
        now: () => t,
        ...over,
    };
    const sealer = createPromptSealer(deps);
    /** Let the in-flight seal finish. */
    const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    return { sealer, sealed, logs, settle, advance: (ms: number) => { t += ms; } };
};

describe('createPromptSealer', () => {
    it('says while a seal is running, so a report can wait for it', async () => {
        const h = harness();
        expect(h.sealer.sealing()).toBeUndefined();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        const sealing = h.sealer.sealing();
        expect(sealing).toBeInstanceOf(Promise);
        await sealing;
        expect(h.sealer.sealing()).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)?.id).toBe(parseBlockedDialog(BASH, 'claude')!.id);
    });

    it('settles a failed seal too, leaving the prompt out', async () => {
        const h = harness({ seal: async () => { throw new Error('ecdh failed'); } });
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.sealer.sealing();
        expect(h.sealer.sealing()).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeUndefined();
    });

    it('seals a blocked dialog without holding the report, and hands the result to the next cycle', async () => {
        const h = harness();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeUndefined();
        await h.settle();
        const wire = h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)!;
        expect(wire.id).toBe(parseBlockedDialog(BASH, 'claude')!.id);
        expect(wire.at).toBe('2026-10-03T02:00:00.000Z');
        expect(wire.sealed).toEqual({ body: 'sealed-1', deviceKeyMap: { phone: 'k' }, senderPublicKey: 'spk' });
    });

    it('seals the summary with the session and the listener device in it', async () => {
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(JSON.parse(h.sealed[0]!)).toMatchObject({
            v: 1, sessionName: 'hwip-a', deviceId: 'dev_mac', at: '2026-10-03T02:00:00.000Z',
            id: parseBlockedDialog(BASH, 'claude')!.id, title: 'Bash command',
        });
    });

    it('keeps one sealed object while the prompt is unchanged (the report stays unchanged)', async () => {
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        const first = h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        h.advance(60_000);
        const second = h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        expect(second).toBe(first);
        expect(h.sealed).toHaveLength(1);
    });

    it('seals once while the first seal is still running', async () => {
        const h = harness();
        for (let i = 0; i < 5; i++) h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealed).toHaveLength(1);
    });

    it('makes a new prompt, with a new time, when the highlight moves', async () => {
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        const before = h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)!;
        h.advance(5_000);
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', MOVED)).toBeUndefined();
        await h.settle();
        const after = h.sealer.observe('hwip-a', 'claude', 'blocked', MOVED)!;
        expect(after.id).not.toBe(before.id);
        expect(after.at).toBe('2026-10-03T02:00:05.000Z');
        expect(h.sealed).toHaveLength(2);
    });

    it('reports nothing once the session is no longer blocked, and seals again for the next prompt', async () => {
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealer.observe('hwip-a', 'claude', 'working', 'esc to interrupt')).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeUndefined();
        await h.settle();
        expect(h.sealed).toHaveLength(2);
    });

    it('leaves out a dialog it has no layout for, and seals nothing', async () => {
        const h = harness();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', fixture('claude-blocked-askuserquestion.txt'))).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', fixture('claude-blocked-trust-dialog.txt'))).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', null)).toBeUndefined();
        await h.settle();
        expect(h.sealed).toEqual([]);
    });

    it('ignores a dialog on a screen whose state is not blocked', async () => {
        const h = harness();
        expect(h.sealer.observe('hwip-a', 'claude', 'working', BASH)).toBeUndefined();
        expect(h.sealer.observe('hwip-a', 'claude', undefined, BASH)).toBeUndefined();
        await h.settle();
        expect(h.sealed).toEqual([]);
    });

    it('seals nothing when no device is trusted, and tries again after a while', async () => {
        let trusted: RecorderRecipient[] = [];
        const h = harness({ recipients: async () => trusted });
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealed).toEqual([]);
        trusted = RECIPIENTS;
        h.advance(PROMPT_SEAL_RETRY_MS - 1);
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealed).toEqual([]);
        h.advance(1);
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeDefined();
    });

    it('leaves the prompt out when sealing fails, logs no dialog text, and tries again later', async () => {
        const seal = vi.fn<PromptSealerDeps['seal']>().mockRejectedValueOnce(new Error('no key'));
        seal.mockResolvedValue({ body: 'b', deviceKeyMap: { phone: 'k' }, senderPublicKey: 's' } as SealedChunk);
        const h = harness({ seal });
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeUndefined();
        expect(h.logs).toHaveLength(1);
        expect(h.logs[0]).toContain('hwip-a');
        for (const secret of ['/home/dev/demo', 'rtk ls', 'Bash command', 'Do you want']) expect(h.logs.join('\n')).not.toContain(secret);
        h.advance(PROMPT_SEAL_RETRY_MS);
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeDefined();
    });

    it('does not retry a prompt too large to seal', async () => {
        // Five options of 200 three-byte characters: over the 2 KiB cap with no detail left to drop.
        const label = 'あ'.repeat(200);
        const big = BASH.replace('  3. No', [3, 4, 5, 6, 7].map((n) => `  ${n}. ${label}`).join('\n'));
        expect(parseBlockedDialog(big, 'claude')).toBeDefined();
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', big);
        await h.settle();
        h.advance(PROMPT_SEAL_RETRY_MS * 10);
        h.sealer.observe('hwip-a', 'claude', 'blocked', big);
        await h.settle();
        expect(h.sealed).toEqual([]);
        expect(h.logs).toEqual([]);
    });

    it('forgets sessions that are gone', async () => {
        const h = harness();
        h.sealer.observe('hwip-a', 'claude', 'blocked', BASH);
        await h.settle();
        h.sealer.prune(new Set(['hwip-b']));
        expect(h.sealer.observe('hwip-a', 'claude', 'blocked', BASH)).toBeUndefined();
        await h.settle();
        expect(h.sealed).toHaveLength(2);
    });
});

describe('promptStillShown', () => {
    const id = parseBlockedDialog(BASH, 'claude')!.id;

    it('is true for the same screen', () => {
        expect(promptStillShown(id, BASH)).toBe(true);
    });

    it('is false once the highlight moved, the dialog is gone, or the pane cannot be read', () => {
        expect(promptStillShown(id, MOVED)).toBe(false);
        expect(promptStillShown(id, 'idle pane\n')).toBe(false);
        expect(promptStillShown(id, null)).toBe(false);
    });
});
