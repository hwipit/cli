import { describe, expect, it } from 'vitest';
import { handlePush } from './listener.js';
import {
    COMMAND_REFUSALS,
    commandRefusedFrame,
    createRefusalLimiter,
    createRefusalReporter,
    isSessionStateRefusal,
    reasonForPhone,
    type CommandRefusal,
} from './command-refusal.js';

// C9: a command the phone sent that this listener refuses used to leave one
// log line and nothing else — the phone kept showing "sent". The listener now
// names the reason in an `agent.command.refused` ephemeral frame. These cases
// are the contract the app builds its message on: the reason codes, that only
// the addressed machine says anything, and that nothing about the command
// itself (text, keys, paths) rides the frame.

const ME = 'dev_listener_me';
const pane = (command: string, shellMarked = false) => ({ command, shellMarked });

interface Report { sessionName: string; pushId: string; reason: CommandRefusal }

const run = async (
    push: Partial<Parameters<typeof handlePush>[0]>,
    deps: Parameters<typeof handlePush>[1] = {},
): Promise<{ ok: boolean; reports: Report[] }> => {
    const reports: Report[] = [];
    const ok = await handlePush(
        { pushId: 'p1', type: 'agent.command', agentSessionName: 'hwip-app', body: 'do it', targetDeviceId: ME, ...push },
        {
            deviceId: () => ME,
            paneProbe: () => pane('claude'),
            inject: () => true,
            insertText: () => true,
            sendKeys: () => true,
            rateLimit: () => true,
            paneCwd: () => null,
            reportRefusal: (r) => reports.push(r),
            ...deps,
        },
    );
    return { ok, reports };
};

describe('a refused command is reported to the phone', () => {
    it.each<[string, Partial<Parameters<typeof handlePush>[0]>, Parameters<typeof handlePush>[1], CommandRefusal]>([
        ['the session bucket is empty', {}, { rateLimit: () => false }, 'rate_limited'],
        ['no tmux session has that name', {}, { paneProbe: () => null }, 'unknown_session'],
        ['the session is a subagent pane', { agentSessionName: 'hwip-app.12' }, {}, 'subagent_view_only'],
        ['the pane sits at an unmarked shell', {}, { paneProbe: () => pane('zsh') }, 'shell_pane'],
        ['a marked shell refuses a control character', { body: 'ls\x1b[A' }, { paneProbe: () => pane('zsh', true) }, 'shell_input'],
        ['a marked shell refuses attachments', { files: [{ fileKey: 'k', fileName: 'a.txt' }] }, { paneProbe: () => pane('zsh', true) }, 'shell_input'],
        ['a key name is not on the list', { body: undefined, keys: ['rm-rf'] }, {}, 'unknown_key'],
        ['an insert comes with a body', { insert: 'x' }, {}, 'invalid_command'],
        ['the keystrokes do not land (text)', {}, { inject: () => false }, 'inject_failed'],
        ['the keystrokes do not land (insert)', { body: undefined, insert: 'x' }, { insertText: () => false }, 'inject_failed'],
        ['the keystrokes do not land (keys)', { body: undefined, keys: ['enter'] }, { sendKeys: () => false }, 'inject_failed'],
        ['a sealed command does not check out', { isEncrypted: true }, {}, 'sealed_rejected'],
        ['an empty command', { body: '' }, {}, 'invalid_command'],
        [
            'an attachment-only command whose download fails',
            { body: '', files: [{ fileKey: 'k', fileName: 'a.txt' }] },
            { downloadAttachments: async () => { throw new Error('boom'); } },
            'attachment_failed',
        ],
    ])('%s → %s', async (_why, push, deps, reason) => {
        const { ok, reports } = await run(push, deps);
        expect(ok).toBe(false);
        expect(reports).toEqual([{ sessionName: push.agentSessionName ?? 'hwip-app', pushId: 'p1', reason }]);
    });

    it('says nothing when the command lands', async () => {
        const { ok, reports } = await run({});
        expect(ok).toBe(true);
        expect(reports).toEqual([]);
    });

    it('says nothing for a command addressed to another machine (push.new fans out to all of them)', async () => {
        // Every other listener of the account would answer unknown_session.
        const { ok, reports } = await run({ targetDeviceId: 'dev_other' }, { paneProbe: () => null });
        expect(ok).toBe(false);
        expect(reports).toEqual([]);
    });

    it('says nothing for an unaddressed (older sender) command either', async () => {
        const { reports } = await run({ targetDeviceId: undefined }, { paneProbe: () => null });
        expect(reports).toEqual([]);
    });

    it('says nothing for pushes that are not commands', async () => {
        expect((await run({ type: 'note' }, { paneProbe: () => null })).reports).toEqual([]);
        expect((await run({ type: 'agent.command', agentSessionName: undefined })).reports).toEqual([]);
    });

    it('reports once per push, with the first reason', async () => {
        // The download fails, which is the cause; the empty text that follows
        // (invalid_command) is fallout.
        const { reports } = await run(
            { body: '', files: [{ fileKey: 'k', fileName: 'a.txt' }] },
            { downloadAttachments: async () => { throw new Error('boom'); } },
        );
        expect(reports).toHaveLength(1);
        expect(reports[0]!.reason).toBe('attachment_failed');
    });

    it('does not report a refusal when the command is typed anyway', async () => {
        // An attachment that fails to download does not stop a command that has a body.
        const { ok, reports } = await run(
            { files: [{ fileKey: 'k', fileName: 'a.txt' }] },
            { downloadAttachments: async () => { throw new Error('boom'); } },
        );
        expect(ok).toBe(true);
        expect(reports).toEqual([]);
    });
});

describe('what the relay may learn', () => {
    it('keeps a property of sealed text out of the code', () => {
        // shell_input (control character, newline) and invalid_command are
        // read off the decrypted text: for a sealed command they say too much.
        expect(reasonForPhone('shell_input', true)).toBe('sealed_rejected');
        expect(reasonForPhone('invalid_command', true)).toBe('sealed_rejected');
        // A schedule request's fields and its limit are plaintext facts too.
        expect(reasonForPhone('schedule_invalid', true)).toBe('sealed_rejected');
        expect(reasonForPhone('schedule_limit', true)).toBe('sealed_rejected');
        expect(reasonForPhone('schedule_invalid', false)).toBe('schedule_invalid');
        expect(reasonForPhone('schedule_limit', false)).toBe('schedule_limit');
        expect(reasonForPhone('shell_input', false)).toBe('shell_input');
        expect(reasonForPhone('rate_limited', true)).toBe('rate_limited');
        expect(reasonForPhone('shell_pane', true)).toBe('shell_pane');
    });

    it('puts only session-state reasons on a stream rejection', () => {
        const stateReasons = COMMAND_REFUSALS.filter(isSessionStateRefusal);
        expect(stateReasons).toEqual(['rate_limited', 'unknown_session', 'subagent_view_only', 'shell_pane', 'inject_failed', 'prompt_changed']);
    });
});

describe('createRefusalReporter', () => {
    it('sends the frame, and nothing of the command', () => {
        const sent: Record<string, unknown>[] = [];
        const report = createRefusalReporter((data) => sent.push(data), createRefusalLimiter(30, 60_000));
        report({ sessionName: 'hwip-app', pushId: 'p1', reason: 'rate_limited' });
        expect(sent).toEqual([{ subtype: 'agent.command.refused', sessionName: 'hwip-app', pushId: 'p1', reason: 'rate_limited' }]);
    });

    it('stays quiet past the per-session limit, and for other sessions keeps talking', () => {
        const sent: Record<string, unknown>[] = [];
        const report = createRefusalReporter((data) => sent.push(data), createRefusalLimiter(2, 60_000));
        for (let i = 0; i < 5; i++) report({ sessionName: 'a', pushId: `p${i}`, reason: 'rate_limited' });
        report({ sessionName: 'b', pushId: 'q', reason: 'rate_limited' });
        expect(sent.map((f) => f.pushId)).toEqual(['p0', 'p1', 'q']);
    });
});

describe('commandRefusedFrame', () => {
    it('is the ephemeral frame the app reads', () => {
        expect(commandRefusedFrame('hwip-app', 'p1', 'rate_limited')).toEqual({
            subtype: 'agent.command.refused',
            sessionName: 'hwip-app',
            pushId: 'p1',
            reason: 'rate_limited',
        });
    });

    it('caps what a push can make the listener echo', () => {
        const long = 'x'.repeat(5000);
        const frame = commandRefusedFrame(long, long, 'unknown_session');
        expect(frame.sessionName.length).toBeLessThanOrEqual(200);
        expect(frame.pushId.length).toBeLessThanOrEqual(200);
    });

    it('lists every reason once', () => {
        expect(new Set(COMMAND_REFUSALS).size).toBe(COMMAND_REFUSALS.length);
        expect([...COMMAND_REFUSALS].sort()).toEqual([
            'attachment_failed', 'e2ee_required', 'inject_failed', 'invalid_command', 'prompt_changed', 'rate_limited',
            'schedule_failed', 'schedule_invalid', 'schedule_limit', 'sealed_rejected', 'shell_input', 'shell_pane', 'subagent_view_only',
            'unknown_key', 'unknown_session',
        ]);
    });
});

describe('createRefusalLimiter', () => {
    it('lets a few through per window, then stays quiet', () => {
        const allow = createRefusalLimiter(3, 60_000);
        expect([1, 2, 3, 4, 5].map(() => allow('s', 1_000))).toEqual([true, true, true, false, false]);
    });

    it('opens again once the window has passed', () => {
        const allow = createRefusalLimiter(2, 60_000);
        allow('s', 0); allow('s', 1);
        expect(allow('s', 2)).toBe(false);
        expect(allow('s', 60_001)).toBe(true);
    });

    it('counts each session on its own', () => {
        const allow = createRefusalLimiter(1, 60_000);
        expect(allow('a', 0)).toBe(true);
        expect(allow('a', 1)).toBe(false);
        expect(allow('b', 1)).toBe(true);
    });

    it('forgets idle sessions once their window has passed', () => {
        const allow = createRefusalLimiter(1, 1_000);
        for (let i = 0; i < 100; i++) allow(`s${i}`, 0);
        allow('late', 10_000);
        expect(allow.size()).toBe(1);
    });

    it('tracks a bounded number of sessions: a flood of names inside one window cannot grow it, and gets no frames', () => {
        const allow = createRefusalLimiter(1, 60_000, 4);
        expect([1, 2, 3, 4, 5, 6].map((i) => allow(`s${i}`, 0))).toEqual([true, true, true, true, false, false]);
        expect(allow.size()).toBe(4);
        // A session already tracked still gets its own answer once the window passes.
        expect(allow('s1', 60_001)).toBe(true);
    });
});

// C96: the push is whatever the relay sent. A push.new with no pushId (or a
// session name that is not text) made the frame's slice() throw inside
// handlePush, so the refusal was lost behind a TypeError log line; keys that
// are not names, or files that are not a list, threw the same way before any
// refusal could be reported, and an empty pushId made every such push share
// one attachment folder.
describe('a push the relay sent in the wrong shape', () => {
    const sealed = { isEncrypted: true, targetDeviceId: ME };
    it.each<[string, Record<string, unknown>]>([
        ['no pushId', { pushId: undefined }],
        ['a pushId that is not text', { pushId: 7 }],
        ['an empty pushId', { pushId: '' }],
        ['a session name that is not text', { agentSessionName: 42 }],
        ['a body that is not text', { body: { text: 'x' } }],
        ['an insert that is not text', { body: undefined, insert: 5 }],
        ['a key that is not a name', { body: undefined, keys: ['escape', 5] }],
        ['keys that are not a list', { body: undefined, keys: 'escape' }],
        ['sealed files that are not a list', { ...sealed, files: 'x' }],
        ['files that are not a list', { files: { 0: { fileKey: 'k', fileName: 'a.txt' } } }],
    ])('%s: is ignored, with nothing injected, reported or thrown', async (_why, odd) => {
        const sent: Record<string, unknown>[] = [];
        const reportRefusal = createRefusalReporter((data) => sent.push(data), createRefusalLimiter(30, 60_000));
        const touched: string[] = [];
        const { ok } = await run({ ...odd } as never, {
            reportRefusal,
            inject: () => { touched.push('inject'); return true; },
            insertText: () => { touched.push('insert'); return true; },
            sendKeys: () => { touched.push('keys'); return true; },
            downloadAttachments: async () => { touched.push('download'); return []; },
        });
        expect(ok).toBe(false);
        expect(sent).toEqual([]);
        expect(touched).toEqual([]);
    });

    it.each([null, 'push', 7])('%s is not a push at all', async (junk) => {
        await expect(handlePush(junk as never, {})).resolves.toBe(false);
    });

    it('a well-formed push of the same kind still goes through', async () => {
        const { ok } = await run({ body: undefined, keys: ['escape'] });
        expect(ok).toBe(true);
    });
});

// C97: slice(0, 200) counts UTF-16 units, so a pair that straddles the cap came
// out as a lone surrogate, which JSON.stringify writes as an invalid escape.
describe('the echo cap cuts on a character boundary', () => {
    const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

    it.each([198, 199, 200])('an emoji starting at index %i leaves no lone surrogate', (at) => {
        const name = 'a'.repeat(at) + '😀'.repeat(5);
        const frame = commandRefusedFrame(name, name, 'unknown_session');
        expect(wellFormed(frame.sessionName)).toBe(true);
        expect(wellFormed(frame.pushId)).toBe(true);
        expect(frame.sessionName.length).toBeLessThanOrEqual(200);
        expect(JSON.stringify(frame)).not.toMatch(/\\ud[89ab]/i);
    });

    it('keeps a whole character that ends exactly at the cap', () => {
        const name = 'a'.repeat(198) + '😀';
        expect(commandRefusedFrame(name, 'p', 'unknown_session').sessionName).toBe(name);
    });

    it('leaves a short name alone', () => {
        expect(commandRefusedFrame('héllo-😀', 'p', 'unknown_session').sessionName).toBe('héllo-😀');
    });
});
