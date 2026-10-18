import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSubcommandError, parseSendArgs, runSend, sendReadsStdin, usageFor, USAGE, type SendDeps } from './send.js';
import type { AgentTargetDevice } from './agent-target.js';
import { QuotaExceededError } from './errors.js';
import { COMMAND_REFUSAL_TEXT, sealedCommand, type AgentCommandPayload, type CommandRefusal, type CommandSealDeps } from './command-seal.js';

// Whether and how to seal is command-seal.test.ts's; here only what `runSend` does with the answer.
vi.mock('./command-seal.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./command-seal.js')>()),
    sealedCommand: vi.fn(),
}));

const fields = { body: 'CIPHERTEXT', senderPublicKey: 'SENDER_KEY', deviceKeyMap: { dev_linux: 'SLOT' } };

beforeEach(() => {
    vi.mocked(sealedCommand).mockReset();
    vi.mocked(sealedCommand).mockResolvedValue({ kind: 'sealed', fields });
});

/** The text `runSend` handed to the sealer: the header and the message, which only the envelope carries to the server. */
const sealedMessage = (): string => vi.mocked(sealedCommand).mock.calls[0]![0].message;

const devices: AgentTargetDevice[] = [
    {
        deviceId: 'dev_mac',
        nickname: 'takPC',
        agentSessions: [{ name: 'hwip-proj' }, { name: 'pi-brain' }],
        agentSessionAliases: { 'pi-brain': 'brain' },
    },
    { deviceId: 'dev_linux', nickname: 'test-machine', agentSessions: [{ name: 'hwip-api' }] },
];

const deps = (over: Partial<SendDeps> = {}) => {
    const d = {
        listDevices: vi.fn(async () => devices),
        sendAgentCommand: vi.fn(async (_payload: AgentCommandPayload) => ({
            pushId: 'push_1',
        })),
        seal: {} as CommandSealDeps,
        context: vi.fn(() => ({ agentDeviceId: 'dev_mac', agentSessionName: 'pi-brain' })),
        hostname: () => 'laptop.local',
        out: vi.fn(),
        err: vi.fn(),
        ...over,
    };
    return d;
};

describe('hwip send', () => {
    it('types the message into the target, headed by who sent it and the key to reply on', async () => {
        const d = deps();

        const code = await runSend({ target: 'dev_linux:hwip-api', message: '빌드 로그 확인해줘' }, d);

        expect(code).toBe(0);
        expect(sealedMessage()).toBe('[from brain@takPC · reply: dev_mac:pi-brain] 빌드 로그 확인해줘');
        expect(d.sendAgentCommand).toHaveBeenCalledWith({ targetDeviceId: 'dev_linux', agentSessionName: 'hwip-api', isEncrypted: true, ...fields });
        expect(d.out).toHaveBeenCalledWith('sent → dev_linux:hwip-api (stored; not confirmed typed)');
    });

    it('outside tmux, signs as the CLI on this host and offers no reply key', async () => {
        const d = deps({ context: () => null });

        await runSend({ target: 'hwip-api', message: 'hi' }, d);

        expect(sealedMessage()).toBe('[from cli@laptop.local] hi');
    });

    it('exits 1 and lists both keys when two machines share the name', async () => {
        const twice = [...devices, { deviceId: 'dev_win', nickname: 'win', agentSessions: [{ name: 'hwip-api' }] }];
        const d = deps({ listDevices: async () => twice });

        expect(await runSend({ target: 'hwip-api', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('dev_linux:hwip-api');
        expect(d.err.mock.calls[0][0]).toContain('dev_win:hwip-api');
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    it('refuses to send to its own session', async () => {
        const d = deps();

        expect(await runSend({ target: 'brain', message: 'hi' }, d)).toBe(1);
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    it('exits 1 when the API refuses, e.g. over the daily push quota', async () => {
        const d = deps({
            sendAgentCommand: vi.fn(async () => {
                throw new QuotaExceededError('Daily push limit reached');
            }),
        });

        expect(await runSend({ target: 'hwip-api', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('Daily push limit reached');
    });

    it('exits 1 on an unknown name, listing the other sessions', async () => {
        const d = deps();

        expect(await runSend({ target: 'nothing-like-this', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('dev_linux:hwip-api');
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    // A tmux session the listener does not report has no key anyone could answer on.
    it('offers no reply key from a session the listener does not report', async () => {
        const d = deps({ context: () => ({ agentDeviceId: 'dev_mac', agentSessionName: 'scratch' }) });

        await runSend({ target: 'hwip-api', message: 'hi' }, d);

        expect(sealedMessage()).toBe('[from scratch@takPC] hi');
    });

    // A pi subagent pane names itself `<#S>.<pane>`; replies only resolve to top-level sessions.
    it('offers no reply key from a subagent', async () => {
        const withSubagent = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'pi-brain.2', parentName: 'pi-brain' }] },
            devices[1],
        ];
        const d = deps({
            listDevices: async () => withSubagent,
            context: () => ({ agentDeviceId: 'dev_mac', agentSessionName: 'pi-brain.2' }),
        });

        await runSend({ target: 'hwip-api', message: 'hi' }, d);

        expect(sealedMessage()).toBe('[from pi-brain.2@takPC] hi');
    });

    // An agent started inside a `hwip sh` session: the shell is never a target,
    // so a reply key pointing at it would not resolve.
    it('offers no reply key from a shell session', async () => {
        const withShell = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'hwip-api-sh', agentKind: 'shell' }] },
            devices[1],
        ];
        const d = deps({
            listDevices: async () => withShell,
            context: () => ({ agentDeviceId: 'dev_mac', agentSessionName: 'hwip-api-sh' }),
        });

        await runSend({ target: 'hwip-api', message: 'hi' }, d);

        expect(sealedMessage()).toBe('[from hwip-api-sh@takPC] hi');
    });
});

describe('parseSendArgs', () => {
    it('takes the first word as the target and joins the rest into the message', () => {
        expect(parseSendArgs(['dev_linux:hwip-api', '빌드', '로그', '확인해줘'])).toEqual({
            target: 'dev_linux:hwip-api',
            message: '빌드 로그 확인해줘',
        });
    });

    it('is a usage error when the target or the message is missing', () => {
        for (const argv of [[], ['hwip-api'], ['hwip-api', '  ']]) {
            expect(parseSendArgs(argv)).toEqual({ error: USAGE });
        }
    });

    // Everything after `send` is message text: a key placed there would reach the other session in plaintext.
    it('refuses --key or --base-url after send without echoing the key', () => {
        for (const argv of [
            ['hwip-api', 'run', '--key', 'ak_secret'],
            ['--key', 'ak_secret', 'hwip-api', 'run'],
            ['hwip-api', 'run', '--key=ak_secret'],
            ['hwip-api', 'run', '--base-url', 'http://elsewhere'],
        ]) {
            const parsed = parseSendArgs(argv);
            expect('error' in parsed && parsed.error).toContain(USAGE);
            expect(JSON.stringify(parsed)).not.toContain('ak_secret');
        }
    });

    // The heredoc form an agent writes: nothing in the message is expanded by the shell.
    it('reads the message from stdin on -, keeping its lines and backticks', () => {
        expect(parseSendArgs(['hwip-api', '-'], 'Build is green.\n`npm test` passed.\n')).toEqual({
            target: 'hwip-api',
            message: 'Build is green.\n`npm test` passed.',
        });
        expect(parseSendArgs(['hwip-api', '-'], '  \n')).toEqual({ error: USAGE });
    });

    it('reads stdin only on - alone, so a bare target never waits on it', () => {
        expect(sendReadsStdin(['hwip-api', '-'])).toBe(true);
        expect(sendReadsStdin(['hwip-api'])).toBe(false);
        expect(sendReadsStdin(['hwip-api', '-', 'x'])).toBe(false);
        expect(parseSendArgs(['hwip-api', 'a', '-'], 'ignored')).toEqual({ target: 'hwip-api', message: 'a -' });
    });

    it('sends a message quoted as one argument that only mentions --key', () => {
        expect(parseSendArgs(['hwip-api', 'what does --key do'])).toEqual({ target: 'hwip-api', message: 'what does --key do' });
    });
});

// `hwip agent send` is the new name of `hwip send` (C82): the same command, the same header, its own name in what it says.
describe('hwip agent send', () => {
    it('sends exactly what hwip send sends, under the same header', async () => {
        const old = deps();
        const named = deps();

        await runSend({ target: 'dev_linux:hwip-api', message: 'hi' }, old);
        await runSend({ target: 'dev_linux:hwip-api', message: 'hi' }, named, 'agent send');

        expect(named.sendAgentCommand.mock.calls).toEqual(old.sendAgentCommand.mock.calls);
        const [first, second] = vi.mocked(sealedCommand).mock.calls;
        expect(second![0]).toEqual(first![0]);
        expect(first![0].message).toBe('[from brain@takPC · reply: dev_mac:pi-brain] hi');
    });

    it('names itself in its errors', async () => {
        const d = deps();

        expect(await runSend({ target: 'dev_mac:pi-brain', message: 'hi' }, d, 'agent send')).toBe(1);
        expect(d.err).toHaveBeenCalledWith('hwip agent send: the target is this session itself — pick another agent');

        const failing = deps({ sendAgentCommand: vi.fn(async () => { throw new Error('boom'); }) });
        await runSend({ target: 'dev_linux:hwip-api', message: 'hi' }, failing, 'agent send');
        expect(failing.err).toHaveBeenCalledWith('hwip agent send: boom');
    });

    it('keeps its own usage line, and the old name keeps the old one', () => {
        expect(parseSendArgs([], undefined, 'agent send')).toEqual({ error: usageFor('agent send') });
        expect(usageFor('agent send')).toContain(' agent send <deviceId:session | name>');
        expect(usageFor('send')).toBe(USAGE);
    });

    it('refuses --key after agent send, saying where it goes', () => {
        const parsed = parseSendArgs(['hwip-api', 'run', '--key', 'ak_secret'], undefined, 'agent send');

        expect('error' in parsed && parsed.error).toContain("hwip agent send: --key goes before 'agent'");
        expect(JSON.stringify(parsed)).not.toContain('ak_secret');
    });

    it('answers agent with anything but send, list or read, or nothing, as a usage error', () => {
        for (const word of ['send', 'list', 'read']) expect(agentSubcommandError(word)).toBeNull();
        for (const word of ['', 'sned', 'lists']) {
            expect(agentSubcommandError(word)).toContain('hwip agent: subcommands are send, list, read');
        }
        expect(agentSubcommandError('sned')).toContain("not 'sned'");
    });
});

describe('hwip send seals', () => {
    it('sends only the envelope: the header and message are inside it, and the push still names the target session', async () => {
        const d = deps();

        const code = await runSend({ target: 'dev_linux:hwip-api', message: 'rotate the key' }, d);

        expect(code).toBe(0);
        expect(sealedCommand).toHaveBeenCalledWith(
            { targetDeviceId: 'dev_linux', session: 'hwip-api', message: '[from brain@takPC · reply: dev_mac:pi-brain] rotate the key' },
            d.seal,
        );
        expect(d.sendAgentCommand).toHaveBeenCalledWith({
            targetDeviceId: 'dev_linux',
            agentSessionName: 'hwip-api',
            isEncrypted: true,
            ...fields,
        });
        expect(JSON.stringify(d.sendAgentCommand.mock.calls)).not.toContain('rotate the key');
        expect(d.out).toHaveBeenCalledWith('sent → dev_linux:hwip-api (stored; not confirmed typed)');
    });

    // Every cause the sealer can refuse with: none of them is a reason to send the text as it is.
    it.each(Object.keys(COMMAND_REFUSAL_TEXT) as CommandRefusal[])('exits 1 with the reason and sends nothing when sealing is refused (%s) — never a plaintext fallback', async (cause) => {
        vi.mocked(sealedCommand).mockResolvedValue({ kind: 'refused', cause });
        const d = deps();

        expect(await runSend({ target: 'dev_linux:hwip-api', message: 'rotate the key' }, d)).toBe(1);

        expect(d.sendAgentCommand).not.toHaveBeenCalled();
        expect(d.err.mock.calls[0][0]).toContain(COMMAND_REFUSAL_TEXT[cause]);
        expect(d.err.mock.calls[0][0]).not.toContain('rotate the key');
    });

    it('does not decide anything about a target that did not resolve', async () => {
        const d = deps();

        expect(await runSend({ target: 'nothing-like-this', message: 'hi' }, d)).toBe(1);

        expect(sealedCommand).not.toHaveBeenCalled();
    });
});
