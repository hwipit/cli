import { describe, expect, it, vi } from 'vitest';
import { checkRateLimit, handlePush } from './listener.js';

// t88 (t81 lens notes #2-#4): one admission order for typing into a pane, a bounded rate map,
// and keys that never travel with text.

const ME = 'dev_guards_me';
const claude = () => ({ command: 'claude', shellMarked: false });

const push = (extra: Record<string, unknown>) => ({
    pushId: 'p-guards',
    type: 'agent.command',
    agentSessionName: 'hwip-a',
    targetDeviceId: ME,
    ...extra,
}) as Parameters<typeof handlePush>[0];

const base = (extra: Parameters<typeof handlePush>[1] = {}): Parameters<typeof handlePush>[1] => ({
    deviceId: () => ME,
    paneProbe: claude,
    inject: () => true,
    insertText: () => true,
    sendKeys: () => true,
    rateLimit: () => true,
    paneCwd: () => null,
    ...extra,
});

describe('an attachment is downloaded only for a push that would be typed', () => {
    const files = [{ fileName: 'a.png', fileKey: 'k1' }];

    it('no such session: nothing is downloaded', async () => {
        const download = vi.fn(async () => ['/tmp/a.png']);
        const ok = await handlePush(push({ body: 'hi', files }), base({ paneProbe: () => null, downloadAttachments: download }));
        expect(ok).toBe(false);
        expect(download).not.toHaveBeenCalled();
    });

    it('rate limit spent: nothing is downloaded', async () => {
        const download = vi.fn(async () => ['/tmp/a.png']);
        const ok = await handlePush(push({ body: 'hi', files }), base({ rateLimit: () => false, downloadAttachments: download }));
        expect(ok).toBe(false);
        expect(download).not.toHaveBeenCalled();
    });

    it('an admitted push spends one rate token, not two', async () => {
        const download = vi.fn(async () => ['/tmp/a.png']);
        const rateLimit = vi.fn(() => true);
        const inject = vi.fn(() => true);
        const ok = await handlePush(push({ body: 'hi', files }), base({ rateLimit, inject, downloadAttachments: download }));
        expect(ok).toBe(true);
        expect(download).toHaveBeenCalledTimes(1);
        expect(inject).toHaveBeenCalledTimes(1);
        expect(rateLimit).toHaveBeenCalledTimes(1);
    });
});

describe('the rate map stays bounded', () => {
    it('refuses new names once full of live ones, and frees stale ones on demand', () => {
        const t0 = 1_000_000_000_000;
        let admitted = 0;
        for (let i = 0; i < 20_000; i++) if (checkRateLimit(`bound-${i}`, t0)) admitted++;
        expect(admitted).toBeLessThan(20_000);
        expect(checkRateLimit('bound-one-more', t0)).toBe(false);
        // Two windows later every bucket is idle: a full map clears itself.
        expect(checkRateLimit('bound-later', t0 + 10 * 60_000)).toBe(true);
    });
});

describe('keys never travel with text', () => {
    it.each([
        ['body', { body: 'hello', keys: ['enter'] }],
        ['insert', { insert: 'abc', keys: ['enter'] }],
        ['files', { keys: ['enter'], files: [{ fileName: 'a.png', fileKey: 'k1' }] }],
    ])('keys beside %s are refused whole', async (_w, extra) => {
        const reasons: string[] = [];
        const sendKeys = vi.fn(() => true);
        const download = vi.fn(async () => []);
        const ok = await handlePush(push(extra), base({ sendKeys, downloadAttachments: download, reportRefusal: (r) => reasons.push(r.reason) }));
        expect(ok).toBe(false);
        expect(sendKeys).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(reasons).toEqual(['invalid_command']);
    });

    it('keys alone still go through', async () => {
        await expect(handlePush(push({ keys: ['enter'] }), base())).resolves.toBe(true);
    });
});
