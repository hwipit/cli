import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { parseBlockedDialog } from './blocked-prompt.js';
import { createPromptSealer } from './blocked-prompt-seal.js';
import type { SealedChunk } from './turn-recorder.js';

/**
 * The blocked prompt on the session report, and the `ifPrompt` check on a REST
 * command. tmux is faked: `list-panes` gives one Claude Code session and
 * `capture-pane` shows whatever `paneText` is.
 */
const FIELD_SEP = '␟';
let paneText = '';
/** The arguments of every `capture-pane` call. */
let captures: string[][] = [];
/** False: the session is gone from tmux. */
let sessionAlive = true;

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-panes') {
        if (!sessionAlive) return { status: 0, stdout: '', stderr: '' };
        const row = ['hwip-a', '0', '1700000000', '1700000000', '0', '0', '%0', 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''].join(FIELD_SEP);
        return { status: 0, stdout: `${row}\n`, stderr: '' };
    }
    if (a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'display-message') return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    if (a[0] === 'capture-pane') {
        captures.push([...a]);
        return { status: 0, stdout: paneText, stderr: '' };
    }
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

const TMP = mkdtempSync(join(tmpdir(), 'hwip-blocked-prompt-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { collectSessionsVerbose, resetSessionStates, setPromptSealer, sessionsFingerprint, handlePush, withBlockedPrompts, withSettledPrompts, PROMPT_SEAL_WAIT_MS } = await import('./listener.js');

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/panes/${name}`, import.meta.url), 'utf-8');
const BASH = fixture('claude-blocked-bash.txt');
const MOVED = BASH.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No');
const IDLE = fixture('claude-idle.txt');
const ID = parseBlockedDialog(BASH, 'claude')!.id;

const SEALED: SealedChunk = { body: 'sealed-body', deviceKeyMap: { phone: 'k' }, senderPublicKey: 'spk' } as SealedChunk;

describe('blockedPrompt on the session report', () => {
    const sealed: string[] = [];
    let sealer: ReturnType<typeof createPromptSealer>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-03T02:00:00.000Z'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        resetSessionStates();
        sessionAlive = true;
        sealed.length = 0;
        sealer = createPromptSealer({
            deviceId: () => 'dev_mac',
            recipients: async () => [{ deviceId: 'phone', publicKey: 'pk', pinnedAt: 'x' } as never],
            seal: async (plaintext) => { sealed.push(plaintext); return SEALED; },
        });
        setPromptSealer(sealer);
    });
    afterEach(() => {
        setPromptSealer(null);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /**
     * One report cycle, ten seconds after the last (long enough for the state to confirm): the sweep, then what the
     * main thread adds before it publishes.
     */
    const cycle = async () => {
        vi.setSystemTime(Date.now() + 10_000);
        const sessions = withBlockedPrompts(collectSessionsVerbose());
        await vi.advanceTimersByTimeAsync(0);
        return sessions.find((s) => s.name === 'hwip-a')!;
    };

    // The sweep runs on the inventory worker (inventory-offload.ts), a module instance of its own where no sealer is
    // ever set: the prompt is added on the main thread, where the sealer is.
    it('adds the prompt to a sweep made where no sealer is set', async () => {
        paneText = BASH;
        const sweep = async () => {
            vi.setSystemTime(Date.now() + 10_000);
            setPromptSealer(null);
            const result = collectSessionsVerbose();
            setPromptSealer(sealer);
            const sessions = withBlockedPrompts(result);
            await vi.advanceTimersByTimeAsync(0);
            return sessions.find((s) => s.name === 'hwip-a')!;
        };
        await sweep();
        const session = await sweep();
        expect(session.state).toBe('blocked');
        expect(session.blockedPrompt).toMatchObject({ id: ID, sealed: SEALED });
    });

    // The server pushes on the first report that says blocked, and the phone reads the prompt for the push's buttons
    // right then: that report must carry it, not the one five seconds on.
    it('holds the first blocked report until its seal is done, so it carries the prompt', async () => {
        paneText = BASH;
        let session;
        for (let i = 0; i < 5; i++) {
            vi.setSystemTime(Date.now() + 10_000);
            session = (await withSettledPrompts(collectSessionsVerbose())).find((s) => s.name === 'hwip-a')!;
            if (session.state === 'blocked') break;
        }
        expect(session!.state).toBe('blocked');
        expect(session!.blockedPrompt).toMatchObject({ id: ID, sealed: SEALED });
    });

    it('sends the report without the prompt when the seal takes too long', async () => {
        setPromptSealer(createPromptSealer({
            deviceId: () => 'dev_mac',
            recipients: () => new Promise(() => {}),
            seal: async () => SEALED,
        }));
        paneText = BASH;
        let session;
        for (let i = 0; i < 5; i++) {
            vi.setSystemTime(Date.now() + 10_000);
            const report = withSettledPrompts(collectSessionsVerbose());
            await vi.advanceTimersByTimeAsync(PROMPT_SEAL_WAIT_MS);
            session = (await report).find((s) => s.name === 'hwip-a')!;
            if (session.state === 'blocked') break;
        }
        expect(session!.state).toBe('blocked');
        expect(session!.blockedPrompt).toBeUndefined();
    });

    it('carries the sealed prompt once the session is confirmed blocked and the seal is done', async () => {
        paneText = BASH;
        // withBlockedPrompts alone does not wait: the first cycle that sees the dialog only starts the seal.
        expect((await cycle()).blockedPrompt).toBeUndefined();
        const session = await cycle();
        expect(session.state).toBe('blocked');
        expect(session.blockedPrompt).toMatchObject({ id: ID, sealed: SEALED });
        expect(JSON.parse(sealed[0]!)).toMatchObject({ sessionName: 'hwip-a', deviceId: 'dev_mac', id: ID });
    });

    it('does not put the dialog text anywhere but the sealed body', async () => {
        paneText = BASH;
        await cycle(); await cycle();
        const session = await cycle();
        const wire = JSON.stringify(session.blockedPrompt);
        for (const text of ['rtk ls', 'Bash command', 'proceed', '/home/dev/demo']) expect(wire).not.toContain(text);
    });

    it('is absent when the session is not blocked', async () => {
        paneText = IDLE;
        await cycle(); await cycle();
        const session = await cycle();
        expect(session.state).toBe('idle');
        expect(session.blockedPrompt).toBeUndefined();
        expect(sealed).toEqual([]);
    });

    it('is absent when no sealer is set (turn history off)', async () => {
        setPromptSealer(null);
        paneText = BASH;
        await cycle(); await cycle();
        expect((await cycle()).blockedPrompt).toBeUndefined();
    });

    it('forgets a session that is gone, so a session of the same name seals its own prompt', async () => {
        paneText = BASH;
        await cycle(); await cycle();
        expect(sealed).toHaveLength(1);
        sessionAlive = false;
        await cycle();
        sessionAlive = true;
        await cycle(); await cycle();
        expect(sealed).toHaveLength(2);
    });

    // Contract (SERVER-API.md `blockedPrompt.at`): when the listener first saw this prompt id — not `stateChangedAt`.
    // Approvals that follow one another inside one blocked run are new prompts with a later `at` and the same state time.
    it('stamps a prompt with when its id was first seen, which can be later than the session\'s stateChangedAt', async () => {
        paneText = BASH;
        await cycle();
        const first = await cycle();
        paneText = MOVED;
        await cycle();
        const second = await cycle();

        expect(first.state).toBe('blocked');
        expect(second.state).toBe('blocked');
        expect(second.stateChangedAt).toBe(first.stateChangedAt); // one blocked run
        expect(Date.parse(first.blockedPrompt!.at)).toBeGreaterThanOrEqual(Date.parse(first.stateChangedAt!));
        expect(second.blockedPrompt!.at).not.toBe(first.blockedPrompt!.at);
        expect(Date.parse(second.blockedPrompt!.at)).toBeGreaterThan(Date.parse(second.stateChangedAt!));
    });

    it('keeps the same time on later cycles of the same prompt', async () => {
        paneText = BASH;
        await cycle();
        const first = await cycle();
        const later = await cycle();
        expect(later.blockedPrompt!.at).toBe(first.blockedPrompt!.at);
    });

    it('moves to a new prompt, and a new fingerprint, when the highlight moves', async () => {
        paneText = BASH;
        await cycle(); await cycle();
        const before = await cycle();
        paneText = MOVED;
        await cycle();
        const after = await cycle();
        expect(after.blockedPrompt!.id).not.toBe(before.blockedPrompt!.id);
        expect(sessionsFingerprint([after])).not.toBe(sessionsFingerprint([before]));
    });

    it('keeps the fingerprint steady while the prompt is unchanged', async () => {
        paneText = BASH;
        await cycle(); await cycle();
        const a = await cycle();
        const b = await cycle();
        expect(sessionsFingerprint([b])).toBe(sessionsFingerprint([a]));
    });
});

describe('sessionsFingerprint — blockedPrompt', () => {
    const base = { name: 'hwip-a', attached: false, agentKind: 'claude', project: 'a', state: 'blocked' };

    it('changes with the prompt id and with the time', () => {
        const p = { id: 'a1', at: '2026-10-03T02:00:00.000Z', sealed: SEALED };
        const plain = sessionsFingerprint([base as never]);
        expect(sessionsFingerprint([{ ...base, blockedPrompt: p } as never])).not.toBe(plain);
        expect(sessionsFingerprint([{ ...base, blockedPrompt: { ...p, id: 'a2' } } as never]))
            .not.toBe(sessionsFingerprint([{ ...base, blockedPrompt: p } as never]));
        expect(sessionsFingerprint([{ ...base, blockedPrompt: { ...p, at: '2026-10-03T02:00:01.000Z' } } as never]))
            .not.toBe(sessionsFingerprint([{ ...base, blockedPrompt: p } as never]));
    });
});

describe('handlePush — ifPrompt', () => {
    const keyPush = (over: Record<string, unknown> = {}) => ({
        pushId: 'p1', type: 'agent.command' as const, agentSessionName: 'hwip-a', targetDeviceId: 'dev_mac', keys: ['enter'], ...over,
    });
    const deps = (shown: string | null, over: Record<string, unknown> = {}) => {
        const sent: string[][] = [];
        const refusals: string[] = [];
        const spent: number[] = [];
        return {
            sent, refusals, spent,
            deps: {
                paneProbe: () => ({ command: 'claude', shellMarked: false }),
                capturePane: () => shown,
                sendKeys: (_s: string, t: string[]) => { sent.push(t); return true; },
                rateLimit: () => { spent.push(1); return true; },
                deviceId: () => 'dev_mac',
                reportRefusal: (f: { reason: string }) => { refusals.push(f.reason); },
                ...over,
            },
        };
    };

    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('types while the pane shows that prompt', async () => {
        const d = deps(BASH);
        expect(await handlePush(keyPush({ ifPrompt: ID }), d.deps as never)).toBe(true);
        expect(d.sent).toEqual([['Enter']]);
        expect(d.refusals).toEqual([]);
    });

    it('captures the pane with escapes by default, the way the prompt was read for the report', async () => {
        paneText = BASH;
        captures = [];
        const d = deps(BASH, { capturePane: undefined });
        expect(await handlePush(keyPush({ ifPrompt: ID }), d.deps as never)).toBe(true);
        expect(captures.length).toBeGreaterThan(0);
        expect(captures.every((c) => c.includes('-e'))).toBe(true);
    });

    it('refuses with prompt_changed when the highlight moved, types nothing, spends no rate limit', async () => {
        const d = deps(MOVED);
        expect(await handlePush(keyPush({ ifPrompt: ID }), d.deps as never)).toBe(false);
        expect(d.sent).toEqual([]);
        expect(d.spent).toEqual([]);
        expect(d.refusals).toEqual(['prompt_changed']);
    });

    it('refuses when the dialog is gone or the pane cannot be read', async () => {
        for (const shown of [IDLE, null]) {
            const d = deps(shown);
            expect(await handlePush(keyPush({ ifPrompt: ID }), d.deps as never)).toBe(false);
            expect(d.refusals).toEqual(['prompt_changed']);
            expect(d.sent).toEqual([]);
        }
    });

    it('binds a text command and an insert as well', async () => {
        for (const over of [{ keys: undefined, body: 'y' }, { keys: undefined, insert: 'y' }]) {
            const injected: string[] = [];
            const d = deps(MOVED, { inject: (_s: string, t: string) => { injected.push(t); return true; }, insertText: (_s: string, t: string) => { injected.push(t); return true; } });
            expect(await handlePush(keyPush({ ifPrompt: ID, ...over }), d.deps as never)).toBe(false);
            expect(injected).toEqual([]);
            expect(d.refusals).toEqual(['prompt_changed']);
        }
    });

    it('leaves a command without ifPrompt alone, whatever the screen shows', async () => {
        const d = deps(MOVED);
        expect(await handlePush(keyPush(), d.deps as never)).toBe(true);
        expect(d.sent).toEqual([['Enter']]);
    });

    it('drops a push whose ifPrompt is not a string', async () => {
        const d = deps(BASH);
        expect(await handlePush(keyPush({ ifPrompt: 7 }), d.deps as never)).toBe(false);
        expect(d.sent).toEqual([]);
    });
});
