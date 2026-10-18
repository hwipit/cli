import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { SealPurpose } from './crypto.js';
import { parseBlockedDialog } from './blocked-prompt.js';

// tmux is faked wholesale (as in listener-stream-lease.test.ts): what is under
// test is the ephemeral input path's guards and ordering, not tmux itself.
// `hwip-shell` reports a shell as its pane command — the RCE guard's subject.
// `hwip-marked` is a shell too, but carries `@hwip_shell` (`hwip sh`).
const FIELD_SEP = '␟';
const SESSIONS = ['hwip-a', 'hwip-shell', 'hwip-rate', 'hwip-cost', 'hwip-marked'];

/** Every tmux call the code made, in order — the injection evidence. */
let tmuxCalls: string[][] = [];

let bufferFails = false;
let pasteFails = false;
/** What `capture-pane` shows: the screen a bound input (`ifPrompt`) is checked against. */
let paneText = 'idle pane\n';

const fakeTmux = (args: readonly string[]) => {
    // Drop the optional `-S <socket>` prefix tmuxArgs() prepends.
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    // One pane per session, pinned id `%<index>` — what the sweep records in
    // its targets map, so display/capture/send calls arrive with pane ids.
    if (a[0] === 'list-panes') {
        const rows = SESSIONS.map((n, i) => [n, '0', '1700000000', '1700000000', '0', '0', `%${i}`, 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''].join(FIELD_SEP));
        return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'display-message') {
        const target = a[a.indexOf('-t') + 1];
        const session = SESSIONS[Number(target.slice(1))] ?? target;
        const paneCommand = session === 'hwip-shell' || session === 'hwip-marked' ? 'zsh' : 'node';
        // `hwip-shell` sees a marker naming another session — what a stray
        // `set -g @hwip_shell …` inherits into every session. Not its own name: unmarked.
        const shellMark = session === 'hwip-marked' ? 'hwip-marked' : session === 'hwip-shell' ? 'hwip-marked' : '';
        // Three callers, three formats: the inject guard asks for the current
        // command AND the owning session (a stale pane id must not receive an
        // inject), the bare-command probe, and the four-field pane record.
        if (a[4]?.includes('#{session_name}')) return { status: 0, stdout: [paneCommand, session, shellMark].join(FIELD_SEP), stderr: '' };
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: paneCommand, stderr: '' };
        return { status: 0, stdout: [paneCommand, 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: paneText, stderr: '' };
    if (a[0] === 'send-keys') return { status: 0, stdout: '', stderr: '' };
    // Text is delivered as a paste, not as typing (see pasteText). `bufferFails`
    // / `pasteFails` let a test drive the fallback back onto `send-keys -l`.
    if (a[0] === 'set-buffer') return { status: bufferFails ? 1 : 0, stdout: '', stderr: '' };
    if (a[0] === 'paste-buffer') return { status: pasteFails ? 1 : 0, stdout: '', stderr: '' };
    if (a[0] === 'delete-buffer') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

// Redirect the device-id file and the remote-origin marker into a temp dir
// before listener.ts resolves either at import time.
const TMP = mkdtempSync(join(tmpdir(), 'hwip-input-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    handleCommandInput,
    handleStreamControl,
    stopAllStreams,
    computeListenerDeviceId,
    checkRateLimit,
    validateInputMessage,
    pendingInputDecrypts,
    setSubscriberTrust,
    MAX_INPUT_KEYS,
    MAX_INPUT_BODY_CHARS,
} = await import('./listener.js');
const { admissionSettled, trustEveryKey } = await import('../tests/helpers/trust.js');
// What is under test here starts after a subscriber's key checked out.
setSubscriberTrust(trustEveryKey);

const { INPUT_HOLD_MS, MAX_PENDING_INPUTS } = await import('./input-sequencer.js');

describe('agent.command.input — ephemeral injection into a streamed pane', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;

    const send = (data: Record<string, unknown>) => { sent.push(data); };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        bufferFails = false;
        pasteFails = false;
        paneText = 'idle pane\n';
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Take the stream lease that input rides on. */
    const openStream = (sessionName: string) => {
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: true },
            send,
        );
        sent = [];
        tmuxCalls = [];
    };

    const input = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.command.input',
        targetDeviceId: device,
        sessionName: 'hwip-a',
        keys: ['down'],
        seq: 1,
        epoch: 100,
        ...over,
    });

    const injections = () => tmuxCalls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(1).join(' '));
    /** Every tmux call the delivery made, in order — the paste path spans three. */
    const tmuxInvocations = () =>
        tmuxCalls.filter((c) => ['send-keys', 'set-buffer', 'paste-buffer', 'delete-buffer'].includes(c[0])).map((c) => c.join(' '));
    const rejections = () => sent.filter((f) => f.error === 'input_rejected');

    it('injects whitelisted keys into a session with a live stream', () => {
        openStream('hwip-a');
        expect(handleCommandInput(input(), send)).toBe(true);
        expect(injections()).toEqual(['-t %0 Down']);
        expect(rejections()).toEqual([]);
    });

    it('delivers text as a paste, then Enter — never as a burst of typing', () => {
        // A TUI that re-renders per character cannot keep up with a whole
        // Hangul message arriving as keystrokes: characters go missing and the
        // wrapped line is painted twice. `-p` brackets the paste only when the
        // application asked for it, so this is safe against one that did not.
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, body: 'hello; rm -rf /' }), send);
        expect(tmuxInvocations()).toEqual([
            // `--` so a message beginning with a dash stays data, and the
            // buffer contents are data to paste-buffer — same property `-l`
            // had: no escape inside a message can drive another tmux command.
            'set-buffer -b hwip-inject -- hello; rm -rf /',
            'paste-buffer -d -p -b hwip-inject -t %0',
            'send-keys -t %0 Enter',
        ]);
    });

    // ── insert: text WITHOUT the submitting Enter ──
    //
    // A phone answering a y/n prompt, or typing half a command so a TUI menu
    // opens, needs the text in the pane and the submit left to the user. The
    // wire says that with a separate `insert` field rather than a flag on
    // `body`, so a daemon too old to know the field injects NOTHING instead of
    // submitting text the user never meant to send.

    it('inserts text as a paste and leaves the pane holding it — no Enter', () => {
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, insert: 'y' }), send);
        expect(tmuxInvocations()).toEqual([
            'set-buffer -b hwip-inject -- y',
            'paste-buffer -d -p -b hwip-inject -t %0',
        ]);
        expect(rejections()).toEqual([]);
    });

    it('refuses an insert that arrives alongside a body', () => {
        // One message may only mean one thing: submitting and not-submitting
        // the same text are opposite instructions.
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, insert: 'y', body: 'hi' }), send);
        expect(tmuxInvocations()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('refuses an insert that arrives alongside keys', () => {
        openStream('hwip-a');
        handleCommandInput(input({ insert: 'y' }), send);
        expect(tmuxInvocations()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('refuses an insert past the injection cap', () => {
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, insert: 'x'.repeat(MAX_INPUT_BODY_CHARS + 1) }), send);
        expect(tmuxInvocations()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('refuses an empty insert', () => {
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, insert: '' }), send);
        expect(tmuxInvocations()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('REST path: an insert push pastes without Enter too', async () => {
        // The fallback transport must agree with the live one — a key that
        // lands differently depending on whether a stream happened to be up
        // is the worst kind of inconsistency to debug.
        const { handlePush } = await import('./listener.js');
        await handlePush(
            { pushId: '1', type: 'agent.command', agentSessionName: 'hwip-a', insert: 'y' },
            { rateLimit: () => true, paneCwd: () => null },
        );
        expect(tmuxInvocations()).toEqual([
            'set-buffer -b hwip-inject -- y',
            'paste-buffer -d -p -b hwip-inject -t %0',
        ]);
    });

    it('falls back to typing when the buffer cannot be set', () => {
        // Delivered imperfectly beats not delivered.
        bufferFails = true;
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, body: 'hello' }), send);
        expect(injections()).toEqual(['-l -t %0 hello', '-t %0 Enter']);
    });

    it('drops the buffer it filled when the paste fails, then falls back', () => {
        // `-d` never ran, so the message would otherwise sit in a tmux buffer.
        pasteFails = true;
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, body: 'hello' }), send);
        expect(tmuxInvocations()).toContain('delete-buffer -b hwip-inject');
        expect(injections()).toEqual(['-l -t %0 hello', '-t %0 Enter']);
    });

    it('refuses input for a session with no live stream', () => {
        // No lease means nobody is watching the pane this would type into.
        // The rejection is what tells the sender to fall back to a REST push.
        expect(handleCommandInput(input(), send)).toBe(true);
        expect(injections()).toEqual([]);
        expect(rejections()[0]).toMatchObject({
            subtype: 'agent.stream.frame',
            sessionName: 'hwip-a',
            error: 'input_rejected',
        });
        // Nothing was refused by a check here — the lease is simply gone — so
        // there is no reason to give; the REST fallback names it if it fails.
        expect(rejections()[0]).not.toHaveProperty('reason');
    });

    it('names the refused sender on the rejection so devices cannot claim each other\'s refusals', () => {
        // Two devices type into one pane with independent seq/epoch runs; a
        // colliding stamp alone must not trigger the other device's REST resend.
        handleCommandInput(input({ deviceId: 'dev-phone' }), send);
        expect(rejections()[0]).toMatchObject({
            error: 'input_rejected',
            seq: 1,
            epoch: 100,
            inputDeviceId: 'dev-phone',
        });
    });

    it('stops accepting input once the stream is gone', () => {
        openStream('hwip-a');
        stopAllStreams();
        handleCommandInput(input(), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('leaves another machine\'s input alone', () => {
        // The relay fans ephemeral messages out to every connection of this
        // user, and two machines can run the same tmux session name.
        openStream('hwip-a');
        expect(handleCommandInput(input({ targetDeviceId: 'dev_someone_else' }), send)).toBe(false);
        expect(injections()).toEqual([]);
        expect(sent).toEqual([]);
    });

    it('refuses prototype-chain key names — the whitelist knows only what was put in', () => {
        // Plain-object indexing resolved `constructor`/`__proto__` to functions
        // that spawnSync stringified straight into the pane. The Map-backed
        // whitelist must refuse both like any unknown key.
        openStream('hwip-a');
        handleCommandInput(input({ keys: ['constructor'] }), send);
        handleCommandInput(input({ keys: ['__proto__'], seq: 2 }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses keys outside the whitelist, and refuses the batch wholesale', () => {
        openStream('hwip-a');
        handleCommandInput(input({ keys: ['C-c'] }), send);
        // A partial batch would leave the pane in a worse mid-state than none.
        handleCommandInput(input({ seq: 2, keys: ['down', 'M-x'] }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses an encrypted payload on a plaintext stream', () => {
        // Nothing binds the envelope to a subscriber on a stream that handshook
        // no key, and injecting the plaintext riding alongside would leave a
        // sender believing its input was protected when it was not.
        openStream('hwip-a');
        handleCommandInput(input({ encrypted: { iv: 'x', ciphertext: 'y' } }), send);
        handleCommandInput(input({ seq: 2, keys: undefined, body: 'hi', encrypted: {} }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses malformed messages', () => {
        openStream('hwip-a');
        for (const bad of [
            { keys: undefined, body: undefined },
            { keys: ['down'], body: 'both' },
            { seq: undefined },
            { epoch: undefined },
        ]) handleCommandInput(input(bad), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(4);
        // Nothing to address the error to when the session is unnamed.
        sent = [];
        expect(handleCommandInput(input({ sessionName: undefined }), send)).toBe(true);
        expect(sent).toEqual([]);
    });

    it('refuses more keys than the REST path accepts', () => {
        // Parity with the server's MAX_KEYS_PER_COMMAND (apps/server pushes.ts):
        // the low-latency door into the same pane must not be the wider one.
        expect(MAX_INPUT_KEYS).toBe(10);
        openStream('hwip-a');
        handleCommandInput(input({ keys: new Array(MAX_INPUT_KEYS + 1).fill('down') }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
        handleCommandInput(input({ seq: 2, keys: new Array(MAX_INPUT_KEYS).fill('down') }), send);
        expect(injections()).toHaveLength(1);
    });

    it('refuses a body past the injection cap', () => {
        expect(MAX_INPUT_BODY_CHARS).toBe(4096);
        openStream('hwip-a');
        handleCommandInput(input({ keys: undefined, body: 'x'.repeat(MAX_INPUT_BODY_CHARS + 1) }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
        handleCommandInput(input({ seq: 2, keys: undefined, body: 'x'.repeat(MAX_INPUT_BODY_CHARS) }), send);
        expect(tmuxInvocations()).toHaveLength(3); // set-buffer + paste-buffer + Enter
    });

    it('lets a burst of key taps through, and still caps command submits at 30', () => {
        // Arrowing through a menu or holding Backspace is ordinary human speed.
        // Charging a keystroke as if it were a whole instruction refused the
        // phone's key row after a couple of seconds of normal tapping.
        // A session of its own: the bucket is module state, and another test
        // in this file drains `hwip-rate` on purpose.
        openStream('hwip-cost');
        let landed = 0;
        for (let seq = 1; seq <= 60; seq++) {
            tmuxCalls = [];
            handleCommandInput(input({ sessionName: 'hwip-cost', seq }), send);
            if (injections().length) landed++;
        }
        expect(landed).toBe(60);

        // Submits are the expensive half, and their ceiling is unchanged: the
        // 60 taps above cost 60 of 120, leaving room for 15 of the 30.
        let submits = 0;
        for (let seq = 61; seq <= 100; seq++) {
            tmuxCalls = [];
            handleCommandInput(input({ sessionName: 'hwip-cost', seq, keys: undefined, body: 'go' }), send);
            if (injections().length) submits++;
        }
        expect(submits).toBe(15);
    });

    it('refuses a seq or epoch that is not a safe non-negative integer', () => {
        // Number.isFinite admits 1e21, which parks the high-water mark past
        // anything a sender can count back to, and 1.5, which no later integer
        // can ever equal — every following key would sit out the hold.
        for (const bad of [{ seq: 1.5 }, { seq: -1 }, { seq: 1e21 }, { epoch: 2.5 }, { epoch: -1 }, { epoch: 1e21 }]) {
            openStream('hwip-a');
            handleCommandInput(input(bad), send);
            expect(injections(), JSON.stringify(bad)).toEqual([]);
            expect(rejections(), JSON.stringify(bad)).toHaveLength(1);
        }
    });

    it('rejects input once the reorder buffer is full', () => {
        expect(MAX_PENDING_INPUTS).toBe(32);
        openStream('hwip-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        // seq 2 never arrives, so each of these buffers behind the gap.
        for (let i = 0; i < MAX_PENDING_INPUTS; i++) {
            handleCommandInput(input({ seq: 3 + i, keys: ['down'] }), send);
        }
        expect(rejections()).toEqual([]);
        handleCommandInput(input({ seq: 3 + MAX_PENDING_INPUTS, keys: ['down'] }), send);
        expect(rejections()).toHaveLength(1);
    });

    it('echoes seq/epoch on a rejection so the sender can match it', () => {
        // The web has several keystrokes in flight at once; a bare
        // input_rejected tells it something failed but not which one.
        openStream('hwip-a');
        handleCommandInput(input({ seq: 5, epoch: 100, keys: ['C-c'] }), send);
        expect(rejections()[0]).toMatchObject({ error: 'input_rejected', seq: 5, epoch: 100 });
    });

    it('orders each sender separately so two devices do not silence each other', () => {
        // The relay stamps the sending connection's deviceId onto every
        // ephemeral payload. One sequencer per session would let the web's
        // epoch supersede the phone's and drop everything the phone types next.
        openStream('hwip-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 1, epoch: 100, keys: ['up'] }), send);
        handleCommandInput(input({ deviceId: 'dev_web', seq: 1, epoch: 200, keys: ['down'] }), send);
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 2, epoch: 100, keys: ['left'] }), send);
        expect(injections()).toEqual(['-t %0 Up', '-t %0 Down', '-t %0 Left']);
    });

    it('drops every sender\'s ordering state when the stream stops', () => {
        openStream('hwip-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 7, keys: ['up'] }), send);
        stopAllStreams();
        openStream('hwip-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 1, epoch: 100, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t %0 Down']);
    });

    it('refuses plaintext input on an E2EE stream', () => {
        // Outbound frames are already encrypted for this subscriber, so typing
        // a plaintext keystroke in would leave the inbound half in the clear.
        // An encrypted stream takes encrypted input or none.
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'hwip-a', renew: true, subscriberPublicKey: 'pk' },
            send,
        );
        sent = [];
        tmuxCalls = [];
        handleCommandInput(input(), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('consults the rate bucket before probing the pane', () => {
        // A flushed hold delivers a whole burst back to back, and the pane
        // probe is a blocking spawnSync — the cheap gate has to come first.
        openStream('hwip-rate');
        while (checkRateLimit('hwip-rate')) { /* drain the shared bucket */ }
        tmuxCalls = [];
        handleCommandInput(input({ sessionName: 'hwip-rate' }), send);
        expect(tmuxCalls).toEqual([]);
    });

    it('refuses ill-typed fields instead of throwing into the socket handler', () => {
        // The wire shape is an unchecked cast over relay JSON. A throw here
        // would escape the ws message handler and take the daemon with it.
        openStream('hwip-a');
        for (const bad of [
            { keys: 'down' },
            { keys: [] },
            { keys: [1, 2] },
            { keys: [{ length: 1 }] },
            { keys: undefined, body: { toString: 'nope' } },
            { sessionName: 42 },
        ]) expect(() => handleCommandInput(input(bad), send)).not.toThrow();
        expect(injections()).toEqual([]);
    });

    it('refuses to type into a pane sitting at a shell', () => {
        // Same RCE guard as the REST path: a shell prompt + send-keys is
        // arbitrary command execution.
        openStream('hwip-shell');
        handleCommandInput(input({ sessionName: 'hwip-shell', body: 'id', keys: undefined }), send);
        expect(injections()).toEqual([]);
        // A silent drop here contradicts the handler's own contract: the
        // sender learns nothing and never falls back to a REST push.
        expect(rejections()).toHaveLength(1);
        // And a sealed sender, which never falls back, hears why (C9).
        expect(rejections()[0]).toMatchObject({ reason: 'shell_pane' });
    });

    // Stream input only ever arrives on this listener's own subscription, so
    // it counts as addressed to this device.
    it('types into a shell pane marked by `hwip sh`', () => {
        openStream('hwip-marked');
        handleCommandInput(input({ sessionName: 'hwip-marked', body: 'id', keys: undefined }), send);
        expect(injections().length).toBeGreaterThan(0);
        expect(rejections()).toEqual([]);
        // The stream path audits too, into the redirected state dir.
        const audit = readFileSync(join(TMP, 'state', 'hwip', 'shell-audit.log'), 'utf-8');
        expect(audit).toMatch(/\t"hwip-marked"\t"%4"\tbody\t"zsh"\t"id"\n$/);
    });

    it('spends the same rate-limit budget as the REST push path', () => {
        // A private counter here would double the effective 30/min cap.
        // Its own session: a drained bucket doesn't refill under fake timers,
        // so draining hwip-a's would silently gag every later test.
        openStream('hwip-rate');
        while (checkRateLimit('hwip-rate')) { /* drain the shared bucket */ }
        handleCommandInput(input({ sessionName: 'hwip-rate' }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
        expect(rejections()[0]).toMatchObject({ reason: 'rate_limited' });
    });

    it('reorders keys that arrive out of sequence', () => {
        openStream('hwip-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 3, keys: ['left'] }), send);
        handleCommandInput(input({ seq: 2, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t %0 Up', '-t %0 Down', '-t %0 Left']);
    });

    it('types a held key once its gap times out rather than dropping it', () => {
        openStream('hwip-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 3, keys: ['left'] }), send);
        expect(injections()).toEqual(['-t %0 Up']);
        vi.advanceTimersByTime(INPUT_HOLD_MS);
        expect(injections()).toEqual(['-t %0 Up', '-t %0 Left']);
    });

    it('drops a duplicate rather than typing the key twice', () => {
        openStream('hwip-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        expect(injections()).toEqual(['-t %0 Up']);
    });

    it('accepts the first key of a re-subscribed stream', () => {
        // A restarted sender counts from seq 1 again; the previous run's
        // high-water mark must not swallow the new run's opening keys.
        openStream('hwip-a');
        handleCommandInput(input({ seq: 7, keys: ['up'] }), send);
        stopAllStreams();
        openStream('hwip-a');
        handleCommandInput(input({ seq: 1, epoch: 100, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t %0 Down']);
    });

    it('validateInputMessage keeps the wire contract without touching tmux', () => {
        const ok = validateInputMessage({ sessionName: 'hwip-a', keys: ['escape'], seq: 4, epoch: 9 });
        expect(ok).toEqual({
            ok: true,
            input: { sessionName: 'hwip-a', seq: 4, epoch: 9, tokens: ['Escape'], text: null, submit: false },
        });
        expect(validateInputMessage({ sessionName: 'hwip-a', body: 'hi', seq: 4, epoch: 9 })).toMatchObject({
            ok: true,
            input: { tokens: null, text: 'hi', submit: true },
        });
        // `insert` carries the same text with the submit withheld — that flag
        // is the whole difference between the two.
        expect(validateInputMessage({ sessionName: 'hwip-a', insert: 'hi', seq: 4, epoch: 9 })).toMatchObject({
            ok: true,
            input: { tokens: null, text: 'hi', submit: false },
        });
        expect(tmuxCalls).toEqual([]);
    });

    // ─── E2EE input ─────────────────────────────────────────────────
    //
    // Real ECDH keys throughout — a stubbed envelope would prove nothing about
    // a path whose whole job is cryptographic. The subscriber is played by this
    // host's own device keypair: an envelope v2 it seals for its own key opens
    // as that key's (sender = recipient), which is the shape a real phone's
    // input has with the two keys apart. That the app seals the same envelope
    // is crypto-v2.test.ts's job (the vectors); what is under test here is the
    // routing and the guards around it.
    describe('ifPrompt — an input bound to a blocked prompt', () => {
        const shown = readFileSync(new URL('./fixtures/panes/claude-blocked-bash.txt', import.meta.url), 'utf-8');
        // The same dialog with the highlight on "No": a different prompt, whatever its text says.
        const moved = shown.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No');
        const id = parseBlockedDialog(shown, 'claude')!.id;

        it('types while the pane still shows that prompt', () => {
            openStream('hwip-a');
            paneText = shown;
            handleCommandInput(input({ keys: ['down', 'enter'], ifPrompt: id }), send);
            expect(injections()).toEqual(['-t %0 Down Enter']);
            expect(rejections()).toEqual([]);
            // Captured with escapes, the way the prompt was read for the report.
            const captures = tmuxCalls.filter((c) => c[0] === 'capture-pane');
            expect(captures.length).toBeGreaterThan(0);
            expect(captures.every((c) => c.includes('-e'))).toBe(true);
        });

        it('refuses with prompt_changed once the highlight has moved, and types nothing', () => {
            openStream('hwip-a');
            paneText = moved;
            handleCommandInput(input({ keys: ['enter'], ifPrompt: id }), send);
            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
            expect(rejections()[0]!.reason).toBe('prompt_changed');
        });

        it('refuses when the dialog is gone', () => {
            openStream('hwip-a');
            paneText = 'idle pane\n';
            handleCommandInput(input({ keys: ['enter'], ifPrompt: id }), send);
            expect(injections()).toEqual([]);
            expect(rejections()[0]!.reason).toBe('prompt_changed');
        });

        it('refuses a malformed id without looking at the screen', () => {
            openStream('hwip-a');
            tmuxCalls = [];
            paneText = shown;
            handleCommandInput(input({ keys: ['enter'], ifPrompt: 'a b' }), send);
            handleCommandInput(input({ seq: 2, keys: ['enter'], ifPrompt: 42 }), send);
            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(2);
            expect(tmuxCalls.filter((c) => c[0] === 'capture-pane')).toEqual([]);
        });

        it('spends no rate-limit token on an input that is refused as stale', () => {
            openStream('hwip-a');
            paneText = 'idle pane\n';
            for (let seq = 1; seq <= 40; seq++) handleCommandInput(input({ seq, keys: ['enter'], ifPrompt: id }), send);
            expect(rejections()).toHaveLength(40);
            paneText = shown;
            handleCommandInput(input({ seq: 41, keys: ['enter'], ifPrompt: id }), send);
            expect(injections()).toEqual(['-t %0 Enter']);
        });
    });

    describe('encrypted input', () => {
        /** The stream epoch of the latest start: this listener's, sealed to the phone with every frame. */
        let streamEpoch = 0;

        /** Start an E2EE stream whose subscriber holds `subscriberPublicKey`; its key is still being checked. */
        const startE2eeStream = (subscriberPublicKey: string, sessionName = 'hwip-a') => {
            // Timers are fake: the clock does not move between here and the start.
            streamEpoch = Date.now();
            handleStreamControl(
                { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: true, subscriberPublicKey },
                send,
            );
            sent = [];
            tmuxCalls = [];
        };

        /** Open one: started, and its subscriber key checked out. */
        const openE2eeStream = async (subscriberPublicKey: string, sessionName = 'hwip-a') => {
            startE2eeStream(subscriberPublicKey, sessionName);
            await admissionSettled();
        };

        /** A stranger's public key — a device that is not the subscriber. */
        const strangerPublicKey = async (): Promise<string> => {
            const { webcrypto } = await import('node:crypto');
            const wc = webcrypto as unknown as Crypto;
            const pair = await wc.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
            ) as CryptoKeyPair;
            const spki = new Uint8Array(await wc.subtle.exportKey('spki', pair.publicKey));
            let bin = '';
            for (let i = 0; i < spki.length; i++) bin += String.fromCharCode(spki[i]);
            return btoa(bin);
        };

        const hostKey = () => import('./crypto.js').then((m) => m.initDeviceCrypto());

        /**
         * Seal one payload the way the web does: the routing stamp
         * (sessionName, seq, epoch) rides INSIDE the ciphertext next to the
         * keys, so a relay that captured an envelope cannot replay it under a
         * fresh plaintext stamp. Defaults match `input()`'s, so a sealed
         * message and the frame carrying it agree unless a test says otherwise.
         */
        const seal = async (
            payload: Record<string, unknown>,
            stamp: Record<string, unknown> = {},
            recipient?: string,
            purpose: SealPurpose = 'stream.input',
        ) => {
            const { sealV2 } = await import('./crypto.js');
            const sealed = { sessionName: 'hwip-a', seq: 1, epoch: 100, streamEpoch, ...payload, ...stamp };
            // Bound to the stream it is typed into (the envelope's context).
            return sealV2(purpose, JSON.stringify(sealed), recipient ?? (await hostKey()), 'hwip-a');
        };

        describe('ifPrompt inside the envelope', () => {
            const shown = readFileSync(new URL('./fixtures/panes/claude-blocked-bash.txt', import.meta.url), 'utf-8');
            const moved = shown.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No');
            const id = parseBlockedDialog(shown, 'claude')!.id;

            it('types while the prompt is shown, and refuses once it has changed', async () => {
                await openE2eeStream(await hostKey());
                paneText = shown;
                handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['enter'], ifPrompt: id }) }), send);
                await pendingInputDecrypts();
                expect(injections()).toEqual(['-t %0 Enter']);

                paneText = moved;
                handleCommandInput(input({ seq: 2, keys: undefined, encrypted: await seal({ keys: ['enter'], ifPrompt: id }, { seq: 2 }) }), send);
                await pendingInputDecrypts();
                expect(injections()).toEqual(['-t %0 Enter']);
                expect(rejections().map((f) => f.reason)).toEqual(['prompt_changed']);
            });

            it('does not read the plaintext field beside an envelope: only the sealed one decides', async () => {
                await openE2eeStream(await hostKey());
                paneText = 'idle pane\n';
                // A relay adding a binding, or one the sealed message never had, changes nothing.
                handleCommandInput(input({ keys: undefined, ifPrompt: id, encrypted: await seal({ keys: ['down'] }) }), send);
                await pendingInputDecrypts();
                expect(injections()).toEqual(['-t %0 Down']);
            });

            it('refuses a malformed sealed id', async () => {
                await openE2eeStream(await hostKey());
                handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['enter'], ifPrompt: 'x y' }) }), send);
                await pendingInputDecrypts();
                expect(injections()).toEqual([]);
                expect(rejections()).toHaveLength(1);
            });
        });

        it('refuses new envelopes once the decrypt queue is full', async () => {
            // The subscriber-key binding is a string compare against a public
            // key every same-account connection saw, so it cannot bound the
            // ECDH work a flooding client queues — the depth cap must.
            const { MAX_PENDING_DECRYPTS } = await import('./listener.js');
            await openE2eeStream(await hostKey());
            const envelope = await seal({ keys: ['down'] });

            for (let i = 0; i < MAX_PENDING_DECRYPTS + 5; i++) {
                handleCommandInput(input({ seq: 1, keys: undefined, encrypted: envelope }), send);
            }
            expect(rejections().length).toBeGreaterThanOrEqual(5);
            await pendingInputDecrypts();
        });

        it('stops taking sealed input after repeated failed decrypts', async () => {
            // The binding says who may enqueue an ECDH derive, not that they
            // can produce an openable envelope — so a flood of garbage would
            // otherwise spend the one shared decrypt chain indefinitely.
            const subscriberKey = await hostKey();
            await openE2eeStream(subscriberKey, 'hwip-a');
            const garbage = { v: 2, salt: 'AAAA', iv: 'AAAA', ciphertext: 'AAAA', senderPublicKey: subscriberKey };

            for (let i = 0; i < 6; i++) {
                handleCommandInput(input({ sessionName: 'hwip-a', seq: i + 1, keys: undefined, encrypted: garbage }), send);
                await pendingInputDecrypts();
            }
            // Struck out: a genuine envelope now gets no decrypt either, until
            // the stream is re-subscribed.
            handleCommandInput(
                input({ sessionName: 'hwip-a', seq: 9, keys: undefined, encrypted: await seal({ keys: ['down'] }, { sessionName: 'hwip-a', seq: 9 }) }),
                send,
            );
            await pendingInputDecrypts();
            expect(injections()).toEqual([]);

            // A fresh subscription mints a fresh entry, so the strikes are gone.
            await openE2eeStream(subscriberKey, 'hwip-a');
            handleCommandInput(
                input({ sessionName: 'hwip-a', seq: 1, keys: undefined, encrypted: await seal({ keys: ['down'] }, { sessionName: 'hwip-a', seq: 1 }) }),
                send,
            );
            await pendingInputDecrypts();
            expect(injections()).toEqual(['-t %0 Down']);
        });

        it('injects keys carried inside an envelope from the stream subscriber', async () => {
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t %0 Down']);
            expect(rejections()).toEqual([]);
        });

        it('injects literal text carried inside an envelope', async () => {
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ body: 'hello; rm -rf /' }) }), send);
            await pendingInputDecrypts();

            expect(tmuxInvocations()).toEqual([
                'set-buffer -b hwip-inject -- hello; rm -rf /',
                'paste-buffer -d -p -b hwip-inject -t %0',
                'send-keys -t %0 Enter',
            ]);
        });

        it('inserts sealed text without the submitting Enter', async () => {
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ insert: 'y' }) }), send);
            await pendingInputDecrypts();

            expect(tmuxInvocations()).toEqual([
                'set-buffer -b hwip-inject -- y',
                'paste-buffer -d -p -b hwip-inject -t %0',
            ]);
        });

        it('ignores a plaintext insert stapled beside an envelope', async () => {
            // The relay can append fields to a message it forwards, and submit
            // vs no-submit is exactly the kind of difference it would be worth
            // flipping. Only the ciphertext decides what gets typed.
            await openE2eeStream(await hostKey());

            handleCommandInput(
                input({ keys: undefined, insert: 'rm -rf /', encrypted: await seal({ insert: 'y' }) }),
                send,
            );
            await pendingInputDecrypts();

            expect(tmuxInvocations()).toEqual([
                'set-buffer -b hwip-inject -- y',
                'paste-buffer -d -p -b hwip-inject -t %0',
            ]);
        });

        it('never puts the decrypted payload back on the wire', async () => {
            // The relay carries the refusal frames, so a decrypted key name
            // echoed into one would undo the encryption it just came out of.
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['C-c'] }) }), send);
            await pendingInputDecrypts();

            expect(rejections()).toHaveLength(1);
            expect(JSON.stringify(sent)).not.toContain('C-c');
        });

        // ── Replay binding ──
        //
        // The relay is the party E2EE distrusts, and it sees every envelope go
        // past. Without the stamp sealed inside, it could keep a captured
        // keystroke and re-send it under a seq the daemon has not used yet —
        // the ciphertext still opens, the subscriber key still matches, and a
        // real key lands in the pane a second time at a moment of its choosing.

        it('refuses a captured envelope replayed under a fresh seq', async () => {
            await openE2eeStream(await hostKey());
            const encrypted = await seal({ keys: ['down'] }, { seq: 1 });

            // The genuine send, then the relay's replay of the very same bytes
            // under the next seq — which the sequencer would otherwise take as
            // an ordinary following keystroke.
            handleCommandInput(input({ seq: 1, keys: undefined, encrypted }), send);
            await pendingInputDecrypts();
            handleCommandInput(input({ seq: 2, keys: undefined, encrypted }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t %0 Down']);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an envelope re-stamped with another epoch or session', async () => {
            await openE2eeStream(await hostKey());
            await openE2eeStream(await hostKey(), 'hwip-rate'); // a second stream to aim at

            // Same three seals, each contradicted by the plaintext frame in one
            // field. Every one of them decrypts perfectly.
            handleCommandInput(input({ keys: undefined, epoch: 999, encrypted: await seal({ keys: ['down'] }) }), send);
            handleCommandInput(input({ seq: 2, keys: undefined, encrypted: await seal({ keys: ['down'] }, { seq: 2, sessionName: 'hwip-rate' }) }), send);
            handleCommandInput(input({ seq: 3, keys: undefined, encrypted: await seal({ keys: ['down'] }, { seq: 3, epoch: 7 }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(3);
        });

        it('refuses an envelope carrying no stamp at all', async () => {
            // A sealed payload from a client too old to stamp: it cannot be
            // told apart from a replay, so it is refused rather than trusted.
            await openE2eeStream(await hostKey());
            const { sealV2 } = await import('./crypto.js');

            handleCommandInput(
                input({ keys: undefined, encrypted: await sealV2('stream.input', JSON.stringify({ keys: ['down'] }), await hostKey(), 'hwip-a') }),
                send,
            );
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it.each([
            ['a stream frame handed back', 'stream.frame'],
            ['a screen snapshot', 'screen.snapshot'],
            ['an alive answer', 'stream.alive'],
            ['a start answer', 'stream.started'],
        ] as const)('refuses an envelope sealed for another purpose: %s', async (_, purpose) => {
            // Everything this listener seals for a viewer is sealed between the
            // same two keys; the purpose, part of the key, is what keeps any of
            // it from opening as input.
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ body: 'rm -rf ~' }, {}, undefined, purpose) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        // The relay can replay a captured envelope after restarting the stream
        // (a start in the phone's name), or under another device id (a fresh
        // input lane). The sealed stream epoch and device id rule both out.
        it('refuses an envelope sealed for an earlier start of the stream', async () => {
            await openE2eeStream(await hostKey());
            const envelope = await seal({ keys: ['down'] });
            vi.advanceTimersByTime(5);
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: envelope }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an envelope replayed under another device id', async () => {
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, deviceId: 'dev_relay', encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an envelope sealed by anyone but the stream subscriber', async () => {
            // The binding is what makes E2EE input exclusive to the device that
            // is watching. This envelope is perfectly decryptable by this host —
            // only the key it names is not the one that handshook the stream.
            // `openV2` compares the sender again, so the refusal alone cannot show
            // the binding is there: the next test pins what only the binding does
            // (a refused sender costs no decrypt strike).
            await openE2eeStream(await strangerPublicKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('does not let envelopes from another key use up the subscriber\'s decrypt strikes', async () => {
            // The binding runs BEFORE the decrypt: a sender that is not the subscriber is
            // dropped for the price of a string compare. Without it the same envelope
            // reaches `openV2`, fails there, and counts as a failed decrypt — so anyone who
            // knows this host's key could strike the stream out and cut off its real
            // subscriber (the cap is STREAM_MAX_ENCRYPT_FAILURES, 3).
            const subscriberKey = await hostKey();
            await openE2eeStream(subscriberKey, 'hwip-a');
            const hostile = { v: 2, salt: 'AAAA', iv: 'AAAA', ciphertext: 'AAAA', senderPublicKey: await strangerPublicKey() };

            for (let i = 0; i < 6; i++) {
                handleCommandInput(input({ sessionName: 'hwip-a', seq: i + 1, keys: undefined, encrypted: hostile }), send);
                await pendingInputDecrypts();
            }
            expect(rejections()).toHaveLength(6);

            handleCommandInput(
                input({ sessionName: 'hwip-a', seq: 9, keys: undefined, encrypted: await seal({ keys: ['down'] }, { sessionName: 'hwip-a', seq: 9 }) }),
                send,
            );
            await pendingInputDecrypts();
            expect(injections()).toEqual(['-t %0 Down']);
        });

        describe('the device the stream admitted', () => {
            /** A stream whose admitted subscriber is `deviceId` (the key is this host\'s, as above). */
            const openFor = async (deviceId: string) => {
                streamEpoch = Date.now();
                handleStreamControl(
                    { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'hwip-a', renew: true, subscriberPublicKey: await hostKey(), deviceId },
                    send,
                );
                await admissionSettled();
                sent = [];
                tmuxCalls = [];
            };

            it('takes an envelope sealed by that device, under its id', async () => {
                await openFor('dev_phone');

                handleCommandInput(input({ keys: undefined, deviceId: 'dev_phone', encrypted: await seal({ keys: ['down'], deviceId: 'dev_phone' }) }), send);
                await pendingInputDecrypts();

                expect(injections()).toEqual(['-t %0 Down']);
                expect(rejections()).toEqual([]);
            });

            it('refuses an envelope sealed under another device id, even when the frame says the same', async () => {
                // Frame and ciphertext agree with each other, and the key is the subscriber\'s —
                // only the admitted device id says this is not the phone that is watching.
                await openFor('dev_phone');

                handleCommandInput(input({ keys: undefined, deviceId: 'dev_other', encrypted: await seal({ keys: ['down'], deviceId: 'dev_other' }) }), send);
                await pendingInputDecrypts();

                expect(injections()).toEqual([]);
                expect(rejections()).toHaveLength(1);
            });

            it('refuses a frame that names another device than the ciphertext does', async () => {
                await openFor('dev_phone');

                handleCommandInput(input({ keys: undefined, deviceId: 'dev_relay', encrypted: await seal({ keys: ['down'], deviceId: 'dev_phone' }) }), send);
                await pendingInputDecrypts();

                expect(injections()).toEqual([]);
                expect(rejections()).toHaveLength(1);
            });
        });

        it('refuses input until the subscriber key has been verified', async () => {
            // Started, not yet admitted: the key the binding compares against is only
            // what the phone claimed. An envelope that would open fine is still refused.
            const key = await hostKey();
            // Sealed before the start, so it must carry the epoch the start will have: the clock
            // is fake and does not move, and `startE2eeStream` takes the same reading.
            streamEpoch = Date.now();
            const envelope = await seal({ keys: ['down'] });
            const second = await seal({ keys: ['down'] }, { seq: 2 });
            // Nothing awaited between the start and the input: the check runs in microtasks.
            startE2eeStream(key);

            handleCommandInput(input({ keys: undefined, encrypted: envelope }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);

            await admissionSettled();
            handleCommandInput(input({ seq: 2, keys: undefined, encrypted: second }), send);
            await pendingInputDecrypts();
            expect(injections()).toEqual(['-t %0 Down']);
        });

        it('refuses an undecryptable envelope without taking the daemon down', async () => {
            const subscriberKey = await hostKey();
            await openE2eeStream(subscriberKey);

            // Passes the binding check, then fails every way an envelope can:
            // unparseable Base64, valid Base64 that is not ciphertext, and a
            // shape missing fields entirely.
            const garbage = [
                { v: 2, salt: '!!!', iv: '!!!', ciphertext: '!!!', senderPublicKey: subscriberKey },
                { v: 2, salt: 'AAAA', iv: 'AAAA', ciphertext: 'AAAA', senderPublicKey: subscriberKey },
                { senderPublicKey: subscriberKey },
            ];
            garbage.forEach((encrypted, i) =>
                handleCommandInput(input({ seq: i + 1, keys: undefined, encrypted }), send));
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(3);
        });

        it('refuses an envelope that is not an envelope at all', async () => {
            await openE2eeStream(await hostKey());

            // `encrypted` is relay JSON like every other field — a string, an
            // array or a null must be refused, not thrown on.
            for (const [i, encrypted] of ['nope', 42, null, [], { senderPublicKey: 7 }].entries()) {
                handleCommandInput(input({ seq: i + 1, keys: undefined, encrypted }), send);
            }
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(5);
        });

        it('applies the whitelist and the caps to the DECRYPTED payload', async () => {
            // The envelope hides the payload from the relay, not from the
            // daemon's own guards — every check the plaintext path runs has to
            // run again on the other side of the decrypt.
            await openE2eeStream(await hostKey());

            const payloads = [
                { keys: Array.from({ length: MAX_INPUT_KEYS + 1 }, () => 'down') },
                { keys: ['M-x'] },
                { keys: ['__proto__'] },
                { body: 'x'.repeat(MAX_INPUT_BODY_CHARS + 1) },
                { keys: ['down'], body: 'both' },
                {},
            ];
            for (const [i, payload] of payloads.entries()) {
                handleCommandInput(
                    input({ seq: i + 1, keys: undefined, encrypted: await seal(payload, { seq: i + 1 }) }),
                    send,
                );
            }
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(payloads.length);
        });

        it('ignores plaintext keys riding alongside an envelope', async () => {
            // A relay that appends its own `keys` to a real encrypted message
            // must not get them typed. Only the ciphertext decides.
            await openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: ['up'], body: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t %0 Down']);
        });

        it('refuses input for a stream that was replaced while the decrypt was in flight', async () => {
            // A re-subscribe can swap the subscriber key under an in-flight
            // decrypt; delivering into the new incarnation would type a key the
            // current subscriber never sent.
            await openE2eeStream(await hostKey());

            // Both prepared up front: the replacement has to land in the same
            // synchronous run as the send, or the decrypt simply wins the race
            // and the test proves nothing.
            const encrypted = await seal({ keys: ['down'] });
            const newSubscriber = await strangerPublicKey();
            handleCommandInput(input({ keys: undefined, encrypted }), send);
            startE2eeStream(newSubscriber); // restarts the stream under the decrypt
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('echoes the refused seq/epoch and sender so the web can fall back', async () => {
            const subscriberKey = await hostKey();
            await openE2eeStream(subscriberKey);

            handleCommandInput(
                input({ keys: undefined, deviceId: 'dev-phone', seq: 5, epoch: 42, encrypted: { senderPublicKey: subscriberKey } }),
                send,
            );
            await pendingInputDecrypts();

            expect(rejections()[0]).toMatchObject({
                subtype: 'agent.stream.frame',
                sessionName: 'hwip-a',
                error: 'input_rejected',
                seq: 5,
                epoch: 42,
                inputDeviceId: 'dev-phone',
            });
        });
    });
});
