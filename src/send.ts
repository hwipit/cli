import { hostname } from 'node:os';
import { agentSessionContext } from './agent-session.js';
import { isAgentTarget, resolveAgentTarget, type AgentTargetDevice } from './agent-target.js';
import { liveSealDeps } from './ask.js';
import { commandRefusalMessage, sealedCommand, type AgentCommandPayload, type CommandSealDeps } from './command-seal.js';

export interface SendDeps {
    listDevices: () => Promise<AgentTargetDevice[]>;
    sendAgentCommand: (payload: AgentCommandPayload) => Promise<{ pushId: string }>;
    /** What `sealedCommand` needs; absent in tests that send plain. */
    seal: CommandSealDeps;
    /** This process's own agent session, or null outside tmux. */
    context: () => { agentDeviceId: string; agentSessionName: string } | null;
    hostname: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
}

/** `hwip agent send` is the name; `hwip send` is the older one for the same command (C82). */
export type SendCommand = 'send' | 'agent send';

export const usageFor = (command: SendCommand): string =>
    `Usage: hwip [--key …] [--base-url …] ${command} <deviceId:session | name> <message… | - (read stdin)>`;

export const USAGE = usageFor('send');

/** `hwip agent` takes `send`, `list` or `read`; null when that is what was typed. */
export const agentSubcommandError = (subcommand: string): string | null =>
    subcommand === 'send' || subcommand === 'list' || subcommand === 'read'
        ? null
        : `hwip agent: subcommands are send, list, read${subcommand ? `, not '${subcommand}'` : ''}\n${usageFor('agent send')}`;

// A CLI flag after `send`. Everything there is message text, so `--key ak_…`
// would be typed into the other session in plaintext: refuse it instead. A
// message quoted as one argument that mentions `--key` is not a flag.
const MISPLACED_FLAG = /^--(key|base-url)(=|$)/;

/**
 * `-` as the whole message: read it from stdin. An agent writes a summary on a
 * quoted heredoc (`hwip agent send <key> - <<'EOF'`), where the shell expands nothing;
 * inside double quotes its backticks or `$(…)` would run. Only on `-`: a bare
 * target with an open, empty stdin would wait forever.
 */
export const sendReadsStdin = (argv: string[]): boolean => argv.length === 2 && argv[1] === '-';

/** The target and the message `hwip send` / `hwip agent send` got, or the usage error to exit 2 with. */
export const parseSendArgs = (
    argv: string[],
    stdin?: string,
    command: SendCommand = 'send',
): { target: string; message: string } | { error: string } => {
    const flag = argv.find((word) => MISPLACED_FLAG.test(word));
    if (flag) {
        return { error: `hwip ${command}: ${flag.split('=')[0]} goes before '${command.split(' ')[0]}' — after it, it is message text\n${usageFor(command)}` };
    }
    const [target, ...words] = argv;
    const message = (sendReadsStdin(argv) ? (stdin ?? '') : words.join(' ')).trim();
    return target && message ? { target, message } : { error: usageFor(command) };
};

/**
 * The header the receiver reads first. It matches the MCP tool's
 * (mcp-server/src/tools/agent-send.ts `senderHeader`); the web app is to parse
 * the same shape to caption the bubble. The reply key is offered only for a
 * session the listener reports, and never for a subagent or a `hwip sh` shell:
 * `resolveAgentTarget` takes none of them, so the reply would not resolve.
 */
const senderHeader = (devices: AgentTargetDevice[], deps: SendDeps): { header: string; ownKey?: string } => {
    const ctx = deps.context();
    const own = ctx ? devices.find((d) => d.deviceId === ctx.agentDeviceId) : undefined;
    const host = own?.nickname ?? deps.hostname();
    const listed = !!ctx && !!own?.agentSessions?.some((s) => s.name === ctx.agentSessionName && isAgentTarget(s));
    if (!ctx || !listed) return { header: `[from ${ctx?.agentSessionName ?? 'cli'}@${host}]` };
    const ownKey = `${ctx.agentDeviceId}:${ctx.agentSessionName}`;
    const label = own?.agentSessionAliases?.[ctx.agentSessionName] ?? ctx.agentSessionName;
    return { header: `[from ${label}@${host} · reply: ${ownKey}]`, ownKey };
};

/**
 * `hwip agent send <target> <message…>` (and `hwip send`, the older name) — type a message into another agent session,
 * the CLI twin of the MCP `hwip_agent_send` for agents without MCP (pi).
 * Takes what `parseSendArgs` read. Exit 0 stored by the server · 1 anything else.
 */
export const runSend = async (
    { target, message }: { target: string; message: string },
    deps: SendDeps,
    command: SendCommand = 'send',
): Promise<number> => {
    try {
        const devices = await deps.listDevices();
        const { header, ownKey } = senderHeader(devices, deps);
        const resolved = resolveAgentTarget(devices, target, ownKey);
        if (resolved.key === ownKey) {
            deps.err(`hwip ${command}: the target is this session itself — pick another agent`);
            return 1;
        }
        const text = `${header} ${message}`;
        const prepared = await sealedCommand({ targetDeviceId: resolved.deviceId, session: resolved.name, message: text }, deps.seal);
        if (prepared.kind === 'refused') {
            deps.err(`hwip ${command}: ${commandRefusalMessage(prepared.cause, prepared.why)}`);
            return 1;
        }
        await deps.sendAgentCommand({
            targetDeviceId: resolved.deviceId,
            agentSessionName: resolved.name,
            isEncrypted: true as const,
            ...prepared.fields,
        });
        // The server stored it. The listener may still refuse it (rate limit, a shell pane, a session gone since), and this
        // command does not wait to hear of it.
        deps.out(`sent → ${resolved.key} (stored; not confirmed typed)`);
        return 0;
    } catch (err) {
        deps.err(`hwip ${command}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
};

export const liveSendDeps = (hook: {
    listDevices: SendDeps['listDevices'];
    sendAgentCommand: SendDeps['sendAgentCommand'];
    account: { apiKey: string; baseUrl: string };
}): SendDeps => ({
    listDevices: () => hook.listDevices(),
    sendAgentCommand: (payload) => hook.sendAgentCommand(payload),
    seal: liveSealDeps(hook.account.apiKey, hook.account.baseUrl),
    context: agentSessionContext,
    hostname,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
});
