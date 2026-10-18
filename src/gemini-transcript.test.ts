import { describe, it, expect, vi } from 'vitest';

import { projectGeminiEntries } from './gemini-transcript.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS } from './transcript-tail.js';

/**
 * Gemini CLI's line shapes, built by hand from what the writer emits
 * (`@google/gemini-cli` bundle, session recording at 0.46.0) and the structure
 * of eight real sessions on this machine. Hand-built rather than copied from a
 * live file: a fixture lifted out of a transcript the projector also parsed
 * proves only that it agrees with itself, and a real transcript carries
 * conversation text that has no business in a repository.
 */
const line = (obj: unknown): string => JSON.stringify(obj);

const AT = '2026-10-08T00:00:00.000Z';

const header = () =>
    line({ sessionId: 'sess-1', projectHash: 'h', startTime: AT, lastUpdated: AT, kind: 'main' });

const setLine = (set: Record<string, unknown>) => line({ $set: set });

const userLine = (parts: unknown, id = 'u1') => line({ id, timestamp: AT, type: 'user', content: parts });

const typed = (text: string, id = 'u1') => userLine([{ text }], id);

const tokens = (over: Record<string, unknown> = {}) => ({
    input: 100,
    output: 20,
    cached: 40,
    thoughts: 0,
    tool: 0,
    total: 120,
    ...over,
});

const geminiLine = (id: string, extra: Record<string, unknown> = {}) =>
    line({ id, timestamp: AT, type: 'gemini', content: '', model: 'gemini-test', tokens: tokens(), thoughts: [], ...extra });

const call = (id: string, name: string, args: Record<string, unknown>, status = 'success', extra: Record<string, unknown> = {}) => ({
    id,
    name,
    args,
    status,
    result: [{ functionResponse: { id, name, response: { output: 'SECRET BODY' } } }],
    timestamp: AT,
    ...extra,
});

describe('projectGeminiEntries', () => {
    it('reads nothing from the header, $set updates, or the injected context snapshot', () => {
        const events = projectGeminiEntries([
            header(),
            setLine({ lastUpdated: AT }),
            setLine({ messages: [{ id: 'ctx', type: 'user', content: [{ text: '<session_context>injected</session_context>' }] }] }),
            setLine({ summary: 'a summary' }),
        ]);
        expect(events).toEqual([]);
    });

    it('does not call onUnknown for the lines it skips on purpose', () => {
        const onUnknown = vi.fn();
        projectGeminiEntries([header(), setLine({ lastUpdated: AT }), line({ id: 'i', type: 'info', content: 'x' }), line({ id: 'e', type: 'error', content: 'x' })], { onUnknown });
        expect(onUnknown).not.toHaveBeenCalled();
    });

    it('carries what the person typed, with its time', () => {
        expect(projectGeminiEntries([typed('ship the thing')])).toEqual([
            { kind: 'prompt', text: 'ship the thing', at: AT },
        ]);
    });

    it('joins several text parts and accepts a plain string', () => {
        expect(projectGeminiEntries([userLine([{ text: 'a' }, { text: 'b' }])])).toEqual([{ kind: 'prompt', text: 'ab', at: AT }]);
        expect(projectGeminiEntries([userLine('plain')])).toEqual([{ kind: 'prompt', text: 'plain', at: AT }]);
    });

    it('does not mistake a tool answer for a prompt', () => {
        const answer = userLine([{ functionResponse: { id: 'c1', name: 'read_file', response: { output: 'body' } } }]);
        expect(projectGeminiEntries([answer])).toEqual([]);
    });

    it('keeps referenced file bodies out of the prompt', () => {
        const expanded = 'explain @a.ts\n--- Content from referenced files ---\n--- /a.ts ---\nSECRET FILE BODY\n--- End of content ---';
        const viaContent = projectGeminiEntries([userLine([{ text: expanded }])]);
        expect(viaContent).toEqual([{ kind: 'prompt', text: 'explain @a.ts', at: AT }]);
        expect(JSON.stringify(viaContent)).not.toContain('SECRET FILE BODY');

        const viaDisplay = projectGeminiEntries([line({ id: 'u', timestamp: AT, type: 'user', content: [{ text: expanded }], displayContent: [{ text: 'explain @a.ts' }] })]);
        expect(viaDisplay).toEqual([{ kind: 'prompt', text: 'explain @a.ts', at: AT }]);
    });

    it('does not filter a typed message that opens with an angle bracket', () => {
        expect(projectGeminiEntries([typed('<b>bold</b> please')])).toEqual([{ kind: 'prompt', text: '<b>bold</b> please', at: AT }]);
    });

    it('turns a plain answer into a msg and a text', () => {
        const events = projectGeminiEntries([geminiLine('g1', { content: 'hello' })]);
        expect(events).toEqual([
            { kind: 'msg', mid: 'g1', model: 'gemini-test', out: 20, ctx: 100, at: AT },
            { kind: 'text', text: 'hello', at: AT },
        ]);
    });

    it('does not repeat the text when the same id is written again with toolCalls', () => {
        const first = geminiLine('g1', { content: 'let me look' });
        const second = geminiLine('g1', {
            content: 'let me look',
            toolCalls: [call('c1', 'read_file', { file_path: '/src/a.ts' }, 'success', { resultDisplay: 'one\ntwo\n' })],
        });
        const events = projectGeminiEntries([first, second]);

        expect(events.filter((e) => e.kind === 'text')).toHaveLength(1);
        expect(events.slice(2)).toEqual([
            { kind: 'msg', mid: 'g1', model: 'gemini-test', out: 20, ctx: 100, at: AT },
            { kind: 'tool', id: 'c1', name: 'read_file', target: '/src/a.ts', at: AT },
            { kind: 'tool_result', id: 'c1', ok: true, lines: 2, at: AT },
        ]);
    });

    it('emits no text for a new message that starts empty and carries toolCalls', () => {
        const events = projectGeminiEntries([geminiLine('g2', { content: '', toolCalls: [call('c2', 'glob', { pattern: '**/*.ts' })] })]);
        expect(events.map((e) => e.kind)).toEqual(['msg', 'tool', 'tool_result']);
    });

    it.each([
        ['error', false],
        ['cancelled', false],
        ['success', true],
    ])('settles a %s call with ok %s', (status, ok) => {
        const events = projectGeminiEntries([geminiLine('g', { toolCalls: [call('c', 'run_shell_command', {}, status)] })]);
        expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ id: 'c', ok });
    });

    it.each(['validating', 'scheduled', 'executing', 'awaiting_approval'])('leaves a %s call without a result', (status) => {
        const events = projectGeminiEntries([geminiLine('g', { toolCalls: [call('c', 'edit', {}, status)] })]);
        expect(events.map((e) => e.kind)).toEqual(['msg', 'tool']);
    });

    it('counts result lines only from a string resultDisplay, and omits zero', () => {
        const withText = projectGeminiEntries([geminiLine('g', { toolCalls: [call('c', 'ls', {}, 'success', { resultDisplay: 'a\nb\nc' })] })]);
        expect(withText.find((e) => e.kind === 'tool_result')).toMatchObject({ lines: 3 });

        const structured = projectGeminiEntries([geminiLine('g', { toolCalls: [call('c', 'edit', {}, 'success', { resultDisplay: { fileDiff: 'x' } })] })]);
        expect(structured.find((e) => e.kind === 'tool_result')).not.toHaveProperty('lines');

        const empty = projectGeminiEntries([geminiLine('g', { toolCalls: [call('c', 'ls', {}, 'success', { resultDisplay: '' })] })]);
        expect(empty.find((e) => e.kind === 'tool_result')).not.toHaveProperty('lines');
    });

    it('never carries the command line, the result body, or the thoughts', () => {
        const events = projectGeminiEntries([
            geminiLine('g', {
                thoughts: [{ subject: 'S', description: 'PRIVATE THOUGHT', timestamp: AT }],
                toolCalls: [call('c', 'run_shell_command', { command: 'curl -H "Authorization: Bearer abc" https://x' })],
            }),
        ]);
        const wire = JSON.stringify(events);
        expect(wire).not.toContain('Bearer');
        expect(wire).not.toContain('SECRET BODY');
        expect(wire).not.toContain('PRIVATE THOUGHT');
        expect(events.find((e) => e.kind === 'tool')).not.toHaveProperty('target');
    });

    it('labels a call by its human-written description before its arguments', () => {
        const events = projectGeminiEntries([
            geminiLine('g', { toolCalls: [call('c', 'run_shell_command', { command: 'rm -rf x', description: 'Remove\nthe build dir' })] }),
        ]);
        expect(events.find((e) => e.kind === 'tool')).toMatchObject({ target: 'Remove the build dir' });
    });

    it('leaves out msg when there are no tokens, and zeroes a non-numeric count', () => {
        const noTokens = projectGeminiEntries([geminiLine('g', { content: 'hi', tokens: undefined })]);
        expect(noTokens).toEqual([{ kind: 'text', text: 'hi', at: AT }]);

        const odd = projectGeminiEntries([geminiLine('g', { tokens: tokens({ input: 'x', output: null }) })]);
        expect(odd[0]).toMatchObject({ kind: 'msg', out: 0, ctx: 0 });
    });

    it('does not add cached tokens on top of input', () => {
        const events = projectGeminiEntries([geminiLine('g', { tokens: tokens({ input: 100, cached: 90 }) })]);
        expect(events[0]).toMatchObject({ ctx: 100 });
    });

    it('counts thoughts as thinking, and omits the field at zero', () => {
        const two = projectGeminiEntries([geminiLine('g', { thoughts: [{}, {}] })]);
        expect(two[0]).toMatchObject({ thinking: 2 });
        const none = projectGeminiEntries([geminiLine('g', { thoughts: [] })]);
        expect(none[0]).not.toHaveProperty('thinking');
    });

    it('names an unknown record type once, and an unknown type only', () => {
        const onUnknown = vi.fn();
        projectGeminiEntries([line({ id: 'x', type: 'mystery', content: 'x' })], { onUnknown });
        expect(onUnknown).toHaveBeenCalledTimes(1);
        expect(onUnknown).toHaveBeenCalledWith('gemini record type mystery');
    });

    it('reads the lines around a broken one', () => {
        const events = projectGeminiEntries([typed('before', 'u1'), '{not json', '42', 'null', typed('after', 'u2')]);
        expect(events.map((e) => (e.kind === 'prompt' ? e.text : e.kind))).toEqual(['before', 'after']);
    });

    it('starts from the last prompt when asked', () => {
        const events = projectGeminiEntries([typed('one', 'u1'), geminiLine('g1', { content: 'a' }), typed('two', 'u2'), geminiLine('g2', { content: 'b' })], {
            sinceLastPrompt: true,
        });
        expect(events[0]).toMatchObject({ kind: 'prompt', text: 'two' });
        expect(events.some((e) => e.kind === 'text' && e.text === 'a')).toBe(false);
    });

    it('cuts text and names to the wire budget', () => {
        const events = projectGeminiEntries([
            typed('p'.repeat(MAX_EVENT_TEXT_CHARS + 50)),
            geminiLine('g', { content: 't'.repeat(MAX_EVENT_TEXT_CHARS + 50), tokens: undefined }),
            geminiLine('g2', { tokens: undefined, toolCalls: [call('c', 'n'.repeat(MAX_EVENT_FIELD_CHARS + 50), {})] }),
        ]);
        const prompt = events.find((e) => e.kind === 'prompt');
        const text = events.find((e) => e.kind === 'text');
        const tool = events.find((e) => e.kind === 'tool');
        expect(prompt && 'text' in prompt && prompt.text).toHaveLength(MAX_EVENT_TEXT_CHARS);
        expect(text && 'text' in text && text.text).toHaveLength(MAX_EVENT_TEXT_CHARS);
        expect(tool && 'name' in tool && tool.name).toHaveLength(MAX_EVENT_FIELD_CHARS);
    });
});
