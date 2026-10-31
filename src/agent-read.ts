import { spawnSync } from 'node:child_process';
import { isAgentTarget, resolveAgentTarget, AgentTargetError } from './agent-target.js';
import { liveLocalAgentDeps, writeStdout, NO_TMUX_MESSAGE, type ListedSession } from './agent-list.js';
import { flagOn } from './args.js';
import { maskText } from './secret-mask.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS, readSource, TRANSCRIPT_BACKFILL_BYTES, type TranscriptSource, type TurnEvent } from './transcript-tail.js';

/**
 * `hwip agent read <session>` — what a session on THIS machine did last: its latest turns, read from the transcript
 * file the agent keeps on this disk, through the same projectors the app's session view uses. No server, no relay, no
 * API key; nothing is typed into the session and its screen is never printed. A tool's output never appears (the
 * projectors keep only a line count); the prompt, the agent's text and the tool names and targets do.
 *
 * What it prints is another session's conversation, and it goes on to whoever runs this command — an agent, whose
 * provider then sees it. The prompt, the text and the target are masked for secret-looking strings (`maskText`, the
 * rules the diff view uses): best effort, not a guarantee — a secret in a form no rule knows goes through, and the
 * result says how many spots were hidden (`masked`). Whoever reads this output as an agent must treat it as data,
 * not as instructions.
 *
 * Nothing here is cut without saying so: a prompt, text or tool target the projector shortened carries `cut: true` (the text
 * view ends it with `…(cut)`), and `more` says turns or history are left out.
 */

export const DEFAULT_TURNS = 3;
export const MAX_TURNS = 20;
/** Characters of prompt, agent text and tool names one read prints, so that N = 20 of long answers does not flood the reader's context. */
export const MAX_READ_CHARS = 40_000;

export type ReadStep =
    /** `cut` only when true: the text ends where the projector's cap (or this read's budget) cut it. */
    | { kind: 'text'; text: string; cut?: true }
    /** `cut` only when true: the target was clamped (or this read's budget cut it). */
    | { kind: 'tool'; name: string; target: string | null; ok: boolean | null; cut?: true };

export interface ReadTurn {
    at: string | null;
    /** Null when the window read from the end of the file starts inside this turn. */
    prompt: string | null;
    /** Only when true: the prompt ends where the projector's cap cut it. */
    promptCut?: true;
    steps: ReadStep[];
}

export type ReadErrorCode = 'no_transcript' | 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET' | 'OTHER_DEVICE' | 'NO_TMUX';

export type ReadResult =
    | { ok: true; v: 1; key: string; name: string; agent: string; turns: ReadTurn[]; more: boolean; masked: number }
    | { ok: false; code: ReadErrorCode; message: string };

export interface AgentReadDeps {
    device: () => string;
    /** Names of the tmux sessions, or null when tmux did not answer. */
    liveNames: () => string[] | null;
    isSubagent: (name: string) => boolean;
    /** The slow sweep (a screen capture per session); only for words that are not an exact session name. */
    inventory: () => ListedSession[];
    /** The agent kind running in the session's pane, from tmux alone. */
    agentOf: (name: string) => string | null;
    transcript: (name: string, onMiss: (reason: string) => void) => TranscriptSource | null;
    /** The transcript's first read — the last `TRANSCRIPT_BACKFILL_BYTES` of a file, or the source reader's backfill — and its size; null when it cannot be read. */
    readTail: (source: TranscriptSource) => { lines: string[]; size: number } | null;
    /** Awaited, so a large JSON line is flushed before the process exits. */
    out: (text: string) => void | Promise<void>;
    err: (line: string) => void;
}

/**
 * The projector clamps a prompt or a text to `MAX_EVENT_TEXT_CHARS` and says nothing; a text of exactly that
 * length reads as cut (one that is exactly the cap long is rare, and "cut" is the safe thing to claim).
 */
const wasCut = (text: string): boolean => text.length >= MAX_EVENT_TEXT_CHARS;

/** The same for a tool target, which the projector clamps to `MAX_EVENT_FIELD_CHARS`. */
const targetWasCut = (target: string | null): boolean => target !== null && target.length >= MAX_EVENT_FIELD_CHARS;

/** Events into turns: a turn starts at each prompt. A tool and its result become one step, `ok` null until the result is seen. */
export const groupTurns = (events: readonly TurnEvent[]): ReadTurn[] => {
    const turns: ReadTurn[] = [];
    const tools = new Map<string, Extract<ReadStep, { kind: 'tool' }>>();
    let current: ReadTurn | null = null;
    // Before the first prompt there is no turn yet: what the window caught of an older one goes in a turn without a prompt.
    const turnFor = (at: string | undefined): ReadTurn => {
        if (!current) {
            current = { at: at ?? null, prompt: null, steps: [] };
            turns.push(current);
        }
        return current;
    };
    for (const event of events) {
        switch (event.kind) {
            case 'prompt':
                current = { at: event.at ?? null, prompt: event.text, ...(wasCut(event.text) ? { promptCut: true as const } : {}), steps: [] };
                turns.push(current);
                break;
            case 'text':
                turnFor(event.at).steps.push({ kind: 'text', text: event.text, ...(wasCut(event.text) ? { cut: true as const } : {}) });
                break;
            case 'tool': {
                const target = event.target ?? null;
                const step: Extract<ReadStep, { kind: 'tool' }> = { kind: 'tool', name: event.name, target, ok: null, ...(targetWasCut(target) ? { cut: true as const } : {}) };
                tools.set(event.id, step);
                turnFor(event.at).steps.push(step);
                break;
            }
            case 'tool_result': {
                const step = tools.get(event.id);
                if (step) step.ok = event.ok;
                break;
            }
            case 'msg':
                break;
        }
    }
    return turns;
};

/** What a step prints, in characters: a tool counts its name and target, so a turn of nothing but tool calls is bounded too. */
const stepChars = (step: ReadStep): number => (step.kind === 'text' ? step.text.length : step.name.length + (step.target?.length ?? 0));

const textChars = (turn: ReadTurn): number => (turn.prompt?.length ?? 0) + turn.steps.reduce((sum, s) => sum + stepChars(s), 0);

/**
 * The last `n` turns, within `maxChars` of text: the oldest turns go first, and the newest always stays. A newest turn that is
 * over the budget on its own keeps its prompt and its latest steps; the step that crosses the line is cut at its end.
 */
export const limitTurns = (turns: ReadTurn[], n: number, maxChars: number = MAX_READ_CHARS): { turns: ReadTurn[]; cut: boolean } => {
    let kept = turns.slice(-n);
    let cut = kept.length < turns.length;
    let total = kept.reduce((sum, t) => sum + textChars(t), 0);
    while (kept.length > 1 && total > maxChars) {
        total -= textChars(kept[0]!);
        kept = kept.slice(1);
        cut = true;
    }
    const newest = kept[kept.length - 1];
    if (newest && total > maxChars) {
        let budget = Math.max(0, maxChars - (newest.prompt?.length ?? 0));
        const steps: ReadStep[] = [];
        for (let i = newest.steps.length - 1; i >= 0; i--) {
            const step = newest.steps[i]!;
            if (stepChars(step) <= budget) {
                steps.push(step);
                budget -= stepChars(step);
                continue;
            }
            // The step that crosses the line: a text is cut at its end, a tool call is not shown half.
            if (step.kind === 'text' && budget > 0) steps.push({ kind: 'text', text: step.text.slice(0, budget), cut: true });
            break;
        }
        kept = [...kept.slice(0, -1), { ...newest, steps: steps.reverse() }];
        cut = true;
    }
    return { turns: kept, cut };
};

/** A token cut by a cap can be a fragment the rules do not know; the last word goes with the cut. Bounded: a longer run is a blob, not a word. */
const MAX_FRAGMENT_CHARS = 300;
const MASK = '***';

const withoutCutFragment = (text: string): string => {
    let end = text.length;
    while (end > 0 && text.length - end < MAX_FRAGMENT_CHARS && !/\s/.test(text[end - 1]!)) end--;
    return text.slice(0, end);
};

/**
 * One field, masked. A cut one then loses the word the cut may have split — unless that word was masked: the rules
 * read the fragment whole there, and trimming first would show the head of a long token (a JWT) that masking hides.
 */
const maskField = (text: string, cut: boolean): { text: string; masked: number } => {
    const result = maskText(text);
    return cut && !result.text.endsWith(MASK) ? { text: withoutCutFragment(result.text), masked: result.masked } : result;
};

/**
 * The prompt, the agent's text and the tool targets, masked — after `limitTurns`, so what is masked is what would be
 * printed. The tool name is the agent's own vocabulary and is left as it is.
 */
export const maskTurns = (turns: readonly ReadTurn[]): { turns: ReadTurn[]; masked: number } => {
    let masked = 0;
    const field = (text: string, cut: boolean | undefined): string => {
        const result = maskField(text, cut === true);
        masked += result.masked;
        return result.text;
    };
    const out = turns.map((turn): ReadTurn => ({
        ...turn,
        prompt: turn.prompt === null ? null : field(turn.prompt, turn.promptCut),
        steps: turn.steps.map((step): ReadStep =>
            step.kind === 'text' ? { ...step, text: field(step.text, step.cut) } : { ...step, target: step.target === null ? null : field(step.target, step.cut) },
        ),
    }));
    return { turns: out, masked };
};

/** `<deviceId>:<tmuxName>`, the key `agent list` prints. A tmux name has no `:`, so a word with one is a key. */
const KEY_FORM = /^(dev_[A-Za-z0-9_-]+):(.+)$/;

const fail = (code: ReadErrorCode, message: string): ReadResult => ({ ok: false, code, message });

export const readLocalAgent = (deps: AgentReadDeps, target: string, turnsWanted: number): ReadResult => {
    const device = deps.device();
    const asKey = KEY_FORM.exec(target);
    if (asKey && asKey[1] !== device) {
        return fail('OTHER_DEVICE', `${target} is on another machine; hwip agent read reads this machine's sessions only`);
    }

    // An exact session name needs no sweep: the sweep captures every pane (seconds), and only a label or an agent's own name needs it.
    const exact = asKey ? asKey[2]! : target;
    let name: string;
    let agent: string | null;
    if (exact.startsWith('hwip-') && !deps.isSubagent(exact) && deps.liveNames()?.includes(exact)) {
        name = exact;
        agent = deps.agentOf(exact);
    } else {
        const rows = deps.inventory();
        if (rows.length === 0 && deps.liveNames() === null) return fail('NO_TMUX', NO_TMUX_MESSAGE);
        try {
            const resolved = resolveAgentTarget(
                [{ deviceId: device, agentSessions: rows.map((r) => ({ name: r.name, label: r.label, providerSessionName: r.providerSessionName, providerSessionHandle: r.providerSessionHandle, state: r.state, parentName: r.parentName, agentKind: r.agentKind })) }],
                target,
            );
            name = resolved.name;
            agent = rows.find((r) => r.name === name && isAgentTarget(r))?.agentKind ?? null;
        } catch (e) {
            if (e instanceof AgentTargetError) return fail(e.code === 'AMBIGUOUS_TARGET' ? 'AMBIGUOUS_TARGET' : 'UNKNOWN_TARGET', e.message);
            throw e;
        }
    }

    let reason = 'no reason given';
    const source = deps.transcript(name, (why) => {
        reason = why;
    });
    if (!source) return fail('no_transcript', `no transcript for ${name}: ${reason}`);
    const tail = deps.readTail(source);
    if (!tail) return fail('no_transcript', `no transcript for ${name}: ${source.read ? 'its session store is unreadable' : 'the transcript file is unreadable'}`);

    const limited = limitTurns(groupTurns(source.project(tail.lines, {})), turnsWanted);
    const safe = maskTurns(limited.turns);
    return {
        ok: true,
        v: 1,
        key: `${device}:${name}`,
        name,
        agent: agent ?? 'unknown',
        turns: safe.turns,
        more: limited.cut || tail.size > TRANSCRIPT_BACKFILL_BYTES,
        masked: safe.masked,
    };
};

/** Text for a terminal: the transcript holds whatever the agent and the user typed, and an escape sequence in it would act on this terminal. */
// eslint-disable-next-line no-control-regex -- stripping them is the point
const printable = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');

/** Ends a prompt or text the projector's cap or this read's budget cut short. */
const CUT_MARK = '…(cut)';

const indent = (value: string): string => printable(value).split('\n').map((line) => `  ${line}`).join('\n');

const renderRead = (result: Extract<ReadResult, { ok: true }>): string => {
    const lines = [`${result.key} (${printable(result.agent)})`];
    result.turns.forEach((turn, i) => {
        lines.push('', `── turn ${i + 1}/${result.turns.length}${turn.at ? `  ${printable(turn.at)}` : ''}`);
        if (turn.prompt !== null) {
            const [first = '', ...rest] = (printable(turn.prompt) + (turn.promptCut ? CUT_MARK : '')).split('\n');
            lines.push(`> ${first}`, ...rest.map((line) => `  ${line}`));
        }
        for (const step of turn.steps) {
            if (step.kind === 'text') lines.push(indent(step.text + (step.cut ? CUT_MARK : '')));
            else lines.push(`  · ${printable(step.name)}${step.target ? ` ${printable(step.target)}${step.cut ? CUT_MARK : ''}` : ''}${step.ok === true ? ' ✓' : step.ok === false ? ' ✗' : ''}`);
        }
    });
    if (result.turns.length === 0) lines.push('', '(no turns in the part of the transcript read)');
    if (result.more) lines.push('', '(older history not shown)');
    if (result.masked > 0) lines.push('', `(${result.masked} secret-looking spot${result.masked === 1 ? '' : 's'} hidden as ***; masking is best effort)`);
    return lines.join('\n');
};

export const runAgentRead = async (opts: { session: string; turns: number; json: boolean }, deps: AgentReadDeps): Promise<number> => {
    const result = readLocalAgent(deps, opts.session, opts.turns);
    if (!result.ok) {
        if (opts.json) await deps.out(JSON.stringify({ v: 1, error: result.code, message: result.message }));
        else deps.err(`hwip agent read: ${printable(result.message)}`); // it lists other sessions' names, which their agents chose
        return 1;
    }
    if (opts.json) {
        const { ok: _ok, ...contract } = result;
        await deps.out(JSON.stringify(contract));
    } else {
        await deps.out(renderRead(result));
    }
    return 0;
};

const USAGE = 'Usage: hwip agent read <session> [--turns <n>] [--json]';

/** The agent kind in the session's pane, from the same tmux fields and detector the listener's sweep uses. */
const paneAgentKind = async (): Promise<(name: string) => string | null> => {
    const { detectRemoteAgent, tmuxArgs, tmuxTargetFor } = await import('./listener.js');
    const SEP = '␟';
    return (name) => {
        const target = tmuxTargetFor(name);
        if (target === null) return null;
        const probe = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', target, ['#{pane_current_command}', '#{pane_start_command}', '#{pane_current_path}', '#{pane_pid}'].join(SEP)]), {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (probe.status !== 0) return null;
        const [current, start, path, pid] = (probe.stdout ?? '').trim().split(SEP);
        const panePid = Number(pid);
        return detectRemoteAgent({ currentCommand: current || null, startCommand: start || null, currentPath: path || null, panePid: Number.isInteger(panePid) && panePid > 0 ? panePid : null })?.kind ?? null;
    };
};

export const liveAgentReadDeps = async (): Promise<AgentReadDeps> => {
    const local = await liveLocalAgentDeps(); // quiets the listener's log first
    const { isSubagentSessionName, liveSessionNames, resolveWatchTranscript } = await import('./listener.js');
    return {
        device: local.deviceId,
        liveNames: liveSessionNames,
        isSubagent: isSubagentSessionName,
        inventory: local.collect,
        agentOf: await paneAgentKind(),
        transcript: resolveWatchTranscript,
        readTail: (source) => {
            const read = readSource(source, null);
            return read ? { lines: read.lines, size: read.state.size } : null;
        },
        out: writeStdout,
        err: (line) => console.error(line),
    };
};

export const handleAgentRead = async (args: Record<string, string | boolean>): Promise<number> => {
    const session = typeof args._arg2 === 'string' ? args._arg2.trim() : '';
    // A leading `-` would read as a flag to anything that passes the word on.
    if (!session || session.startsWith('-')) {
        console.error(USAGE);
        return 2;
    }
    // `--all` is `agent list`'s: the `agent` flag table is shared, and another machine's conversation stays there.
    if (flagOn(args, 'all')) {
        console.error(`hwip agent read: --all is for agent list; agent read reads this machine only\n${USAGE}`);
        return 2;
    }
    const wanted = args.turns === undefined ? String(DEFAULT_TURNS) : args.turns;
    const turns = typeof wanted === 'string' && /^\d{1,3}$/.test(wanted) ? Number(wanted) : NaN;
    if (!(turns >= 1 && turns <= MAX_TURNS)) {
        console.error(`hwip agent read: --turns takes a whole number from 1 to ${MAX_TURNS}\n${USAGE}`);
        return 2;
    }
    return runAgentRead({ session, turns, json: flagOn(args, 'json') }, await liveAgentReadDeps());
};
