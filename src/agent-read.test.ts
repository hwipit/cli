import { describe, expect, it, vi } from 'vitest';
import type { ListedSession } from './agent-list.js';
import { groupTurns, limitTurns, MAX_READ_CHARS, readLocalAgent, runAgentRead, type AgentReadDeps, type ReadStep, type ReadTurn } from './agent-read.js';
import { projectTranscriptEntries, type TurnEvent } from './transcript-tail.js';

const DEVICE = 'dev_mac';
const row = (name: string, extra: Partial<ListedSession> = {}): ListedSession => ({ name, attached: false, agentKind: 'claude', project: 'proj', ...extra });

const prompt = (text: string, at?: string): TurnEvent => ({ kind: 'prompt', text, ...(at ? { at } : {}) });
const text = (value: string, at?: string): TurnEvent => ({ kind: 'text', text: value, ...(at ? { at } : {}) });
const tool = (id: string, name: string, target?: string): TurnEvent => ({ kind: 'tool', id, name, ...(target ? { target } : {}) });
const result = (id: string, ok: boolean): TurnEvent => ({ kind: 'tool_result', id, ok, lines: 3 });
const msg = (): TurnEvent => ({ kind: 'msg', mid: 'm1', out: 1, ctx: 2 });

interface Fake {
    deps: AgentReadDeps;
    out: string[];
    err: string[];
    inventory: ReturnType<typeof vi.fn>;
    transcript: ReturnType<typeof vi.fn>;
    readTail: ReturnType<typeof vi.fn>;
}

const fake = (over: Partial<AgentReadDeps> & { events?: TurnEvent[]; rows?: ListedSession[]; size?: number; live?: string[] | null } = {}): Fake => {
    const { events = [], rows = [row('hwip-a')], size = 1000, live = ['hwip-a'], ...rest } = over;
    const out: string[] = [];
    const err: string[] = [];
    const inventory = vi.fn(() => rows);
    const transcript = vi.fn(() => ({ path: '/t/a.jsonl', project: () => events }));
    const readTail = vi.fn(() => ({ lines: ['x'], size }));
    const deps: AgentReadDeps = {
        device: () => DEVICE,
        liveNames: () => live,
        isSubagent: (name) => /^hwip-.+\.\d+$/.test(name),
        inventory,
        agentOf: () => 'claude',
        transcript,
        readTail,
        out: (line) => {
            out.push(line);
        },
        err: (line) => {
            err.push(line);
        },
        ...rest,
    };
    return { deps, out, err, inventory, transcript, readTail };
};

describe('groupTurns', () => {
    it('starts a turn at every prompt and puts the agent text and tools after it in that turn', () => {
        const turns = groupTurns([
            prompt('first', 't1'),
            text('thinking aloud'),
            tool('a', 'Edit', 'src/a.ts'),
            result('a', true),
            prompt('second', 't2'),
            text('done'),
        ]);

        expect(turns).toEqual([
            {
                at: 't1',
                prompt: 'first',
                steps: [
                    { kind: 'text', text: 'thinking aloud' },
                    { kind: 'tool', name: 'Edit', target: 'src/a.ts', ok: true },
                ],
            },
            { at: 't2', prompt: 'second', steps: [{ kind: 'text', text: 'done' }] },
        ]);
    });

    it('keeps what came before the first prompt as a turn without one (the window cut its prompt off)', () => {
        const turns = groupTurns([text('tail of an older turn', 't0'), prompt('next', 't1')]);

        expect(turns).toEqual([
            { at: 't0', prompt: null, steps: [{ kind: 'text', text: 'tail of an older turn' }] },
            { at: 't1', prompt: 'next', steps: [] },
        ]);
    });

    it('marks a tool ok:false for a failed result, and ok:null while no result has come', () => {
        const turns = groupTurns([prompt('p'), tool('a', 'Bash'), tool('b', 'Read', 'x'), result('a', false)]);

        expect(turns[0]!.steps).toEqual([
            { kind: 'tool', name: 'Bash', target: null, ok: false },
            { kind: 'tool', name: 'Read', target: 'x', ok: null },
        ]);
    });

    it('drops the token-count events and a result that has no tool', () => {
        const turns = groupTurns([prompt('p'), msg(), result('ghost', true), text('hi')]);

        expect(turns).toEqual([{ at: null, prompt: 'p', steps: [{ kind: 'text', text: 'hi' }] }]);
    });

    it('never carries a tool result body: the step has no field for it', () => {
        const turns = groupTurns([prompt('p'), tool('a', 'Bash', 'ls'), { kind: 'tool_result', id: 'a', ok: true, lines: 99 }]);

        expect(JSON.stringify(turns)).not.toContain('99');
        expect(Object.keys(turns[0]!.steps[0]!).sort()).toEqual(['kind', 'name', 'ok', 'target']);
    });

    it('is an empty list for no events', () => {
        expect(groupTurns([])).toEqual([]);
    });
});

describe('limitTurns', () => {
    const turn = (n: number, size = 10): ReadTurn => ({ at: null, prompt: `p${n}`, steps: [{ kind: 'text', text: 'x'.repeat(size) }] });

    it('keeps the last N turns, oldest first, and says there is more', () => {
        const all = [turn(1), turn(2), turn(3), turn(4)];

        const limited = limitTurns(all, 2);

        expect(limited.turns.map((t) => t.prompt)).toEqual(['p3', 'p4']);
        expect(limited.cut).toBe(true);
    });

    it('says nothing was cut when everything fits', () => {
        const limited = limitTurns([turn(1), turn(2)], 3);

        expect(limited.turns).toHaveLength(2);
        expect(limited.cut).toBe(false);
    });

    it('drops the oldest turns first when the text is over the budget, keeping the newest', () => {
        const all = [turn(1, 300), turn(2, 300), turn(3, 300)];

        const limited = limitTurns(all, 3, 700);

        expect(limited.turns.map((t) => t.prompt)).toEqual(['p2', 'p3']);
        expect(limited.cut).toBe(true);
    });

    it('keeps the newest turn even when it alone is over the budget, cutting the oldest of its steps and the end of the last one kept', () => {
        const big: ReadTurn = {
            at: null,
            prompt: 'p',
            steps: [
                { kind: 'text', text: 'a'.repeat(400) },
                { kind: 'tool', name: 'Edit', target: null, ok: true },
                { kind: 'text', text: 'b'.repeat(400) },
            ],
        };

        const limited = limitTurns([big], 1, 500);

        expect(limited.cut).toBe(true);
        expect(limited.turns).toHaveLength(1);
        const kept = limited.turns[0]!;
        expect(kept.prompt).toBe('p');
        const chars = kept.steps.reduce((sum, s) => sum + (s.kind === 'text' ? s.text.length : 0), 0) + (kept.prompt?.length ?? 0);
        expect(chars).toBeLessThanOrEqual(500);
        const lastText = [...kept.steps].reverse().find((s) => s.kind === 'text');
        expect(lastText && lastText.kind === 'text' && lastText.text.startsWith('b')).toBe(true);
    });

    it('counts tool names and targets against the budget, so a turn of tool calls is bounded too', () => {
        const tools: ReadStep[] = Array.from({ length: 50 }, (_, i) => ({ kind: 'tool', name: 'Read', target: `src/file-${i}.ts`, ok: true }));

        const limited = limitTurns([{ at: null, prompt: 'p', steps: tools }], 1, 200);

        expect(limited.cut).toBe(true);
        expect(limited.turns[0]!.steps.length).toBeLessThan(15);
        expect(limited.turns[0]!.steps.at(-1)).toEqual(tools.at(-1));
    });

    it('uses a 40,000 character budget by default', () => {
        expect(MAX_READ_CHARS).toBe(40_000);
    });
});

describe('readLocalAgent: which session', () => {
    it('reads an exact tmux name without sweeping the inventory', () => {
        const f = fake({ events: [prompt('hi')] });

        const r = readLocalAgent(f.deps, 'hwip-a', 3);

        expect(r).toMatchObject({ ok: true, key: 'dev_mac:hwip-a', name: 'hwip-a', agent: 'claude' });
        expect(f.inventory).not.toHaveBeenCalled();
    });

    it('reads the key list printed, with the name part taken from it', () => {
        const f = fake({ events: [prompt('hi')] });

        expect(readLocalAgent(f.deps, 'dev_mac:hwip-a', 3)).toMatchObject({ ok: true, name: 'hwip-a' });
        expect(f.inventory).not.toHaveBeenCalled();
    });

    it('resolves a label and the agent’s own name through the inventory', () => {
        const rows = [row('hwip-a', { label: 'worker', providerSessionName: 'hwipit-95', agentKind: 'pi' }), row('hwip-b')];
        for (const word of ['worker', 'hwipit-95']) {
            const f = fake({ rows, events: [prompt('hi')] });

            const r = readLocalAgent(f.deps, word, 3);

            expect(r).toMatchObject({ ok: true, key: 'dev_mac:hwip-a', agent: 'pi' });
            expect(f.transcript).toHaveBeenCalledWith('hwip-a', expect.any(Function));
        }
    });

    // The name Claude Code shows for the session, which the shown name leaves out when it is only cwd-derived.
    it('resolves the session handle through the inventory', () => {
        const rows = [row('hwip-ko-qmd', { providerSessionHandle: 'ko-qmd-70' }), row('hwip-b')];
        const f = fake({ rows, events: [prompt('hi')] });

        expect(readLocalAgent(f.deps, 'ko-qmd-70', 3)).toMatchObject({ ok: true, key: 'dev_mac:hwip-ko-qmd' });
    });

    it('reads its own session too', () => {
        const f = fake({ events: [prompt('hi')] });

        expect(readLocalAgent(f.deps, 'hwip-a', 3).ok).toBe(true);
    });

    // Two same-named sessions are told apart by what each is doing.
    it('lists each ambiguous candidate with its state', () => {
        const f = fake({ rows: [row('hwip-a', { label: 'dup', state: 'working' }), row('hwip-b', { label: 'dup', state: 'idle' })], live: ['hwip-a', 'hwip-b'] });

        const r = readLocalAgent(f.deps, 'dup', 3);

        expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS_TARGET' });
        expect(r.ok ? '' : r.message).toContain('dev_mac:hwip-a (dup on dev_mac, working)');
    });

    it('is AMBIGUOUS_TARGET when two sessions answer to the word, listing their keys', () => {
        const f = fake({ rows: [row('hwip-a', { label: 'dup' }), row('hwip-b', { label: 'dup' })], live: ['hwip-a', 'hwip-b'] });

        const r = readLocalAgent(f.deps, 'dup', 3);

        expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS_TARGET' });
        expect(!r.ok && r.message).toContain('dev_mac:hwip-a');
        expect(!r.ok && r.message).toContain('dev_mac:hwip-b');
    });

    it('is UNKNOWN_TARGET for a word no session answers to', () => {
        const f = fake();

        expect(readLocalAgent(f.deps, 'nope', 3)).toMatchObject({ ok: false, code: 'UNKNOWN_TARGET' });
        expect(f.transcript).not.toHaveBeenCalled();
    });

    it('is UNKNOWN_TARGET for a subagent pane name, which is no session of its own to read', () => {
        const f = fake({ live: ['hwip-a'], rows: [row('hwip-a'), row('hwip-a.48', { parentName: 'hwip-a' })] });

        expect(readLocalAgent(f.deps, 'hwip-a.48', 3)).toMatchObject({ ok: false, code: 'UNKNOWN_TARGET' });
    });

    it('is OTHER_DEVICE for a key of another machine, without reading anything', () => {
        const f = fake();

        const r = readLocalAgent(f.deps, 'dev_other:hwip-a', 3);

        expect(r).toMatchObject({ ok: false, code: 'OTHER_DEVICE' });
        expect(!r.ok && r.message).toContain('this machine');
        expect(f.inventory).not.toHaveBeenCalled();
        expect(f.transcript).not.toHaveBeenCalled();
        expect(f.readTail).not.toHaveBeenCalled();
    });

    it('is NO_TMUX when nothing is listed and tmux did not answer', () => {
        const f = fake({ rows: [], live: null });

        expect(readLocalAgent(f.deps, 'worker', 3)).toMatchObject({ ok: false, code: 'NO_TMUX' });
    });
});

describe('readLocalAgent: the transcript', () => {
    it('is no_transcript with the resolver’s reason when the agent has none', () => {
        const f = fake({
            transcript: (_name, onMiss) => {
                onMiss('gemini has no transcript resolver');
                return null;
            },
        });

        const r = readLocalAgent(f.deps, 'hwip-a', 3);

        expect(r).toMatchObject({ ok: false, code: 'no_transcript' });
        expect(!r.ok && r.message).toContain('gemini has no transcript resolver');
    });

    it('is no_transcript (unreadable) when the file cannot be read', () => {
        const f = fake({ readTail: () => null });

        const r = readLocalAgent(f.deps, 'hwip-a', 3);

        expect(r).toMatchObject({ ok: false, code: 'no_transcript' });
        expect(!r.ok && r.message).toContain('unreadable');
    });

    it('is an honest empty list when the file holds nothing the projector knows', () => {
        const f = fake({ events: [] });

        expect(readLocalAgent(f.deps, 'hwip-a', 3)).toMatchObject({ ok: true, turns: [], more: false });
    });

    it('says more when the file is larger than the window read from its end', () => {
        const f = fake({ events: [prompt('hi')], size: 300 * 1024 });

        expect(readLocalAgent(f.deps, 'hwip-a', 3)).toMatchObject({ ok: true, more: true });
    });

    it('says more when turns were left out for N', () => {
        const f = fake({ events: [prompt('1'), prompt('2'), prompt('3'), prompt('4')] });

        const r = readLocalAgent(f.deps, 'hwip-a', 3);

        expect(r.ok && r.turns.map((t) => t.prompt)).toEqual(['2', '3', '4']);
        expect(r).toMatchObject({ more: true });
    });
});

describe('runAgentRead', () => {
    const events: TurnEvent[] = [
        prompt('fix the bug\nsecond line', '2026-10-09T01:00:00.000Z'),
        text('on it'),
        tool('a', 'Edit', 'src/a.ts'),
        result('a', true),
        tool('b', 'Bash', 'npm test'),
        result('b', false),
    ];

    it('prints the v1 contract as one JSON line with --json', async () => {
        const f = fake({ events });

        const code = await runAgentRead({ session: 'hwip-a', turns: 3, json: true }, f.deps);

        expect(code).toBe(0);
        expect(f.out).toHaveLength(1);
        expect(JSON.parse(f.out[0]!)).toEqual({
            v: 1,
            key: 'dev_mac:hwip-a',
            name: 'hwip-a',
            agent: 'claude',
            turns: [
                {
                    at: '2026-10-09T01:00:00.000Z',
                    prompt: 'fix the bug\nsecond line',
                    steps: [
                        { kind: 'text', text: 'on it' },
                        { kind: 'tool', name: 'Edit', target: 'src/a.ts', ok: true },
                        { kind: 'tool', name: 'Bash', target: 'npm test', ok: false },
                    ],
                },
            ],
            more: false,
            masked: 0,
        });
    });

    it('prints a failure as {v,error,message} on stdout with --json, exit 1, nothing on stderr', async () => {
        const f = fake();

        const code = await runAgentRead({ session: 'nope', turns: 3, json: true }, f.deps);

        expect(code).toBe(1);
        expect(JSON.parse(f.out[0]!)).toEqual({ v: 1, error: 'UNKNOWN_TARGET', message: expect.any(String) });
        expect(f.err).toEqual([]);
    });

    it('prints a failure on stderr in text mode, exit 1', async () => {
        const f = fake();

        expect(await runAgentRead({ session: 'nope', turns: 3, json: false }, f.deps)).toBe(1);
        expect(f.out).toEqual([]);
        expect(f.err.join('\n')).toContain('hwip agent read:');
    });

    it('strips control sequences from an error too: it lists the names other sessions chose for themselves', async () => {
        const f = fake({ rows: [row('hwip-b', { providerSessionName: 'x\u001b]0;owned\u0007y' })], live: ['hwip-b'] });

        const code = await runAgentRead({ session: 'nope', turns: 3, json: false }, f.deps);

        expect(code).toBe(1);
        expect(f.err.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
        expect(f.err.join('\n')).toContain('x');
    });

    it('strips control sequences from the turn timestamp', async () => {
        const f = fake({ events: [prompt('hi', '2026\u001b[2J')] });

        await runAgentRead({ session: 'hwip-a', turns: 3, json: false }, f.deps);

        expect(f.out.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    });

    it('prints the turns in text, oldest first, with tool marks and the older-history note', async () => {
        const f = fake({ events: [prompt('old'), ...events], size: 300 * 1024 });

        const code = await runAgentRead({ session: 'hwip-a', turns: 1, json: false }, f.deps);

        expect(code).toBe(0);
        const textOut = f.out.join('\n');
        expect(textOut).toContain('dev_mac:hwip-a (claude)');
        expect(textOut).toContain('── turn 1/1  2026-10-09T01:00:00.000Z');
        expect(textOut).toContain('> fix the bug');
        expect(textOut).toContain('  second line');
        expect(textOut).toContain('  on it');
        expect(textOut).toContain('  · Edit src/a.ts ✓');
        expect(textOut).toContain('  · Bash npm test ✗');
        expect(textOut).toContain('(older history not shown)');
        expect(textOut).not.toContain('> old');
    });

    it('strips terminal control sequences from the text it prints, but not newlines', async () => {
        const f = fake({ events: [prompt('a\u001b]0;owned\u0007b\nc'), text('x\u001b[31mred')] });

        await runAgentRead({ session: 'hwip-a', turns: 3, json: false }, f.deps);

        expect(f.out.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
        expect(f.out.join('\n')).toContain('red');
    });

    it('waits for an async sink', async () => {
        let flushed = false;
        const f = fake({
            events,
            out: async () => {
                await new Promise((r) => setTimeout(r, 5));
                flushed = true;
            },
        });

        await runAgentRead({ session: 'hwip-a', turns: 3, json: true }, f.deps);

        expect(flushed).toBe(true);
    });
});

// The real Claude Code projector over lines shaped like its transcript: what comes out is the contract, and a tool's output stays behind.
describe('reading a Claude Code transcript', () => {
    const line = (entry: object): string => JSON.stringify(entry);
    const lines = [
        line({ type: 'user', timestamp: '2026-10-09T01:00:00.000Z', message: { role: 'user', content: 'run the tests' } }),
        line({
            type: 'assistant',
            timestamp: '2026-10-09T01:00:01.000Z',
            message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Running them.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] },
        }),
        line({
            type: 'user',
            timestamp: '2026-10-09T01:00:02.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'SECRET-TOOL-OUTPUT-BODY', is_error: false }] },
        }),
        line({ type: 'assistant', timestamp: '2026-10-09T01:00:03.000Z', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'All green.' }] } }),
    ];

    it('gives the prompt, the agent text and the tool with its result mark, and never the tool output', () => {
        const out: string[] = [];
        const f = fake();
        const deps: AgentReadDeps = {
            ...f.deps,
            transcript: () => ({ path: '/t/a.jsonl', project: projectTranscriptEntries }),
            readTail: () => ({ lines, size: 100 }),
            out: (text) => {
                out.push(text);
            },
        };

        const r = readLocalAgent(deps, 'hwip-a', 3);

        expect(r.ok && r.turns).toEqual([
            {
                at: '2026-10-09T01:00:00.000Z',
                prompt: 'run the tests',
                steps: [
                    { kind: 'text', text: 'Running them.' },
                    { kind: 'tool', name: 'Bash', target: null, ok: true }, // the projector keeps a command out of the target
                    { kind: 'text', text: 'All green.' },
                ],
            },
        ]);
        expect(JSON.stringify(r)).not.toContain('SECRET-TOOL-OUTPUT-BODY');
    });
});
