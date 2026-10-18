import { describe, expect, it } from 'vitest';
import type { ListedSession } from './agent-list.js';
import { limitTurns, readLocalAgent, runAgentRead, type AgentReadDeps, type ReadTurn } from './agent-read.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS, projectTranscriptEntries, type TranscriptSource, type TurnEvent } from './transcript-tail.js';

// What goes out of `agent read` reaches the reader's model provider: secret-looking strings are hidden, and
// nothing is cut without a mark.

const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const rows: ListedSession[] = [{ name: 'hwip-a', attached: false, agentKind: 'claude', project: 'proj' }];

const depsFor = (project: TranscriptSource['project'], lines: string[] = ['x']): AgentReadDeps => ({
    device: () => 'dev_mac',
    liveNames: () => ['hwip-a'],
    isSubagent: () => false,
    inventory: () => rows,
    agentOf: () => 'claude',
    transcript: () => ({ path: '/t/a.jsonl', project }),
    readTail: () => ({ lines, size: 100 }),
    out: () => {},
    err: () => {},
});

const fromEvents = (events: TurnEvent[]): AgentReadDeps => depsFor(() => events);

const read = (events: TurnEvent[]) => {
    const r = readLocalAgent(fromEvents(events), 'hwip-a', 3);
    if (!r.ok) throw new Error(r.message);
    return r;
};

describe('masking what agent read prints', () => {
    it('hides a token at the head of a prompt line, in the middle of a sentence, and over several lines', () => {
        const r = read([
            { kind: 'prompt', text: `${GH}\nthen use ${GH} again\npassword=hunter2hunter2` },
        ]);

        expect(r.turns[0]!.prompt).toBe('***\nthen use *** again\npassword=***');
        expect(r.masked).toBe(3);
    });

    it('hides it in the agent text and in a tool target, and counts every spot', () => {
        const r = read([
            { kind: 'prompt', text: 'go' },
            { kind: 'text', text: `${GH} is the token` },
            { kind: 'tool', id: 'a', name: 'Bash', target: `curl -H "Authorization: Bearer ${'abcdefghij'.repeat(3)}" https://x` },
        ]);

        const steps = r.turns[0]!.steps;
        expect(steps[0]).toEqual({ kind: 'text', text: '*** is the token' });
        expect(steps[1]).toMatchObject({ kind: 'tool', target: expect.not.stringContaining('abcdefghij') });
        expect(r.masked).toBe(2);
        expect(JSON.stringify(r)).not.toContain(GH);
    });

    it('says 0 when nothing was hidden, and says so in the JSON contract', async () => {
        const out: string[] = [];
        await runAgentRead({ session: 'hwip-a', turns: 3, json: true }, { ...fromEvents([{ kind: 'prompt', text: 'hi' }]), out: (t) => void out.push(t) });

        expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, masked: 0 });
    });

    it('tells the text reader how many spots were hidden, and that masking is best effort', async () => {
        const out: string[] = [];
        await runAgentRead({ session: 'hwip-a', turns: 3, json: false }, { ...fromEvents([{ kind: 'prompt', text: `use ${GH}` }]), out: (t) => void out.push(t) });

        expect(out.join('\n')).toContain('> use ***');
        expect(out.join('\n')).toContain('1 secret-looking spot hidden as ***; masking is best effort');
        expect(out.join('\n')).not.toContain(GH);
    });
});

describe('a token the cap cut in two', () => {
    // The real projector over a line of a Claude Code transcript: it clamps a text to MAX_EVENT_TEXT_CHARS and says nothing.
    const entry = (text: string): string =>
        JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T01:00:01.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] } });
    const readLine = (line: string) => {
        const r = readLocalAgent(depsFor(projectTranscriptEntries, [line]), 'hwip-a', 3);
        if (!r.ok) throw new Error(r.message);
        return r;
    };

    // `ghp_` plus this many characters is what the cap leaves of the token.
    it.each([[0], [3], [10], [16], [30]])('shows no part of it when the cap leaves %i characters after the prefix', (kept) => {
        const lead = 'word '.repeat(Math.floor((MAX_EVENT_TEXT_CHARS - 4 - kept) / 5));
        const filler = ' '.repeat(MAX_EVENT_TEXT_CHARS - 4 - kept - lead.length);
        const text = `${lead}${filler}${GH}`; // GH is 44 long: the cap lands inside it

        const r = readLine(entry(text));

        const step = r.turns[0]!.steps[0]! as { text: string; cut?: true };
        expect(step.cut).toBe(true);
        expect(step.text).not.toContain('ghp_');
        expect(step.text.length).toBeLessThan(MAX_EVENT_TEXT_CHARS);
        expect(JSON.stringify(r)).not.toMatch(/ghp_|A1b2/);
    });
});

describe('a long token the cap cut is masked before anything is trimmed', () => {
    // A JWT of 36 + 600 + 260 characters whose first 700 sit at the end of a text the cap cut: trimming the unbroken
    // last 300 first used to leave its header and 363 characters of the payload in plaintext, with `masked` 0.
    const jwt = `eyJ${'h'.repeat(33)}.${'P'.repeat(600)}.${'S'.repeat(260)}`;
    const cutText = `${'word '.repeat(860)}${jwt}`.slice(0, MAX_EVENT_TEXT_CHARS);

    it('hides the whole token and counts it, instead of showing its head', () => {
        const r = read([{ kind: 'prompt', text: 'go' }, { kind: 'text', text: cutText }]);

        const step = r.turns[0]!.steps[0]! as { text: string; cut?: true };
        expect(step.cut).toBe(true);
        expect(step.text.endsWith('***')).toBe(true);
        expect(step.text).not.toMatch(/eyJ|PPPP|hhhh/);
        expect(r.masked).toBe(1);
    });

    it('does the same for a prompt', () => {
        const r = read([{ kind: 'prompt', text: cutText }]);

        expect(r.turns[0]!.promptCut).toBe(true);
        expect(r.turns[0]!.prompt).not.toMatch(/eyJ|PPPP/);
        expect(r.masked).toBe(1);
    });

    it('still drops the last word when the end of a cut text is not masked', () => {
        const r = read([{ kind: 'text', text: `${'word '.repeat(990)}${' '.repeat(42)}ghp_A1b2` }]);

        expect((r.turns[0]!.steps[0]! as { text: string }).text).not.toContain('ghp_');
    });
});

describe('a tool target the clamp cut', () => {
    const readTarget = (target: string) => {
        const r = read([{ kind: 'prompt', text: 'go' }, { kind: 'tool', id: 'a', name: 'Bash', target }]);
        return { r, step: r.turns[0]!.steps[0]! as Extract<ReadTurn['steps'][number], { kind: 'tool' }> };
    };

    // `ghp_` plus this many characters is what the clamp leaves of the token.
    it.each([[0], [3], [10], [18], [30]])('shows no part of a token when the clamp leaves %i characters after the prefix', (kept) => {
        const lead = 'a '.repeat(Math.floor((MAX_EVENT_FIELD_CHARS - 4 - kept) / 2));
        const target = `${lead}${' '.repeat(MAX_EVENT_FIELD_CHARS - 4 - kept - lead.length)}${GH}`.slice(0, MAX_EVENT_FIELD_CHARS);

        const { r, step } = readTarget(target);

        expect(target).toHaveLength(MAX_EVENT_FIELD_CHARS);
        expect(step.cut).toBe(true);
        expect(JSON.stringify(r)).not.toMatch(/ghp_|A1b2/);
    });

    it('marks a target at the clamp and not one just under it', () => {
        expect(readTarget('x '.repeat(MAX_EVENT_FIELD_CHARS / 2).slice(0, MAX_EVENT_FIELD_CHARS)).step.cut).toBe(true);
        expect(readTarget('x '.repeat(MAX_EVENT_FIELD_CHARS / 2).slice(0, MAX_EVENT_FIELD_CHARS - 1)).step).not.toHaveProperty('cut');
    });

    it('ends a cut target with …(cut) in the text view', async () => {
        const out: string[] = [];
        const events: TurnEvent[] = [{ kind: 'prompt', text: 'go' }, { kind: 'tool', id: 'a', name: 'Bash', target: 'x '.repeat(MAX_EVENT_FIELD_CHARS / 2) }];

        await runAgentRead({ session: 'hwip-a', turns: 3, json: false }, { ...fromEvents(events), out: (t) => void out.push(t) });

        expect(out.join('\n').split('\n').filter((l) => l.endsWith('…(cut)'))).toHaveLength(1);
    });
});

describe('a cut is never silent', () => {
    const textOf = (n: number) => `${'ab '.repeat(Math.ceil(n / 3))}`.slice(0, n);

    it('marks a prompt and a text the projector clamped, and not ones just under the cap', () => {
        const r = read([
            { kind: 'prompt', text: textOf(MAX_EVENT_TEXT_CHARS) },
            { kind: 'text', text: textOf(MAX_EVENT_TEXT_CHARS - 1) },
            { kind: 'text', text: textOf(MAX_EVENT_TEXT_CHARS) },
        ]);

        const turn = r.turns[0]!;
        expect(turn.promptCut).toBe(true);
        expect(turn.steps[0]).not.toHaveProperty('cut');
        expect(turn.steps[1]).toMatchObject({ cut: true });
    });

    it('keeps the cut flags out of the JSON of a turn that was not cut', () => {
        const r = read([{ kind: 'prompt', text: 'short' }, { kind: 'text', text: 'short too' }]);

        expect(JSON.stringify(r.turns)).not.toContain('Cut');
        expect(JSON.stringify(r.turns)).not.toContain('"cut"');
    });

    it('ends a cut prompt and a cut text with …(cut) in the text view', async () => {
        const out: string[] = [];
        const events: TurnEvent[] = [
            { kind: 'prompt', text: textOf(MAX_EVENT_TEXT_CHARS) },
            { kind: 'text', text: textOf(MAX_EVENT_TEXT_CHARS) },
            { kind: 'text', text: 'whole' },
        ];

        await runAgentRead({ session: 'hwip-a', turns: 3, json: false }, { ...fromEvents(events), out: (t) => void out.push(t) });

        const lines = out.join('\n').split('\n');
        expect(lines.filter((l) => l.endsWith('…(cut)'))).toHaveLength(2);
        expect(lines).toContain('  whole');
    });

    it('marks the text step the read budget cut', () => {
        const turn: ReadTurn = { at: null, prompt: 'go', steps: [{ kind: 'text', text: 'x'.repeat(500) }] };

        expect(limitTurns([turn], 3, 100).turns[0]!.steps[0]).toEqual({ kind: 'text', text: 'x'.repeat(98), cut: true });
    });
});
