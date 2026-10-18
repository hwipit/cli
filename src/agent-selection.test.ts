import { describe, expect, it } from 'vitest';
import { filterAgentsByIds, firstStderrLine, unknownOnlyIds } from './installer.js';
import type { Agent } from './agents.js';

// Backs `hwip install --only <ids>`. The interactive picker uses an
// @inquirer/prompts checkbox (not unit-tested here — it needs a TTY);
// filterAgentsByIds is the pure, scriptable path and is fully covered.

const mk = (...ids: string[]): Agent[] =>
    ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), detected: true }));

const ALL = mk('claude', 'cursor', 'gemini', 'copilot');

describe('filterAgentsByIds (--only)', () => {
    it('matches by agent id', () => {
        expect(filterAgentsByIds(ALL, 'cursor,gemini').map((a) => a.id)).toEqual(['cursor', 'gemini']);
    });

    it('is case-insensitive and space-tolerant', () => {
        expect(filterAgentsByIds(ALL, ' Cursor , GEMINI ').map((a) => a.id)).toEqual(['cursor', 'gemini']);
    });

    it('drops ids that are not detected (unknownOnlyIds flags typos)', () => {
        expect(filterAgentsByIds(ALL, 'cursor,bogus,vscode').map((a) => a.id)).toEqual(['cursor']);
    });

    it('empty string → no agents', () => {
        expect(filterAgentsByIds(ALL, '')).toEqual([]);
    });

    it('single id', () => {
        expect(filterAgentsByIds(ALL, 'claude').map((a) => a.id)).toEqual(['claude']);
    });

    it('output follows detected order, not input order', () => {
        expect(filterAgentsByIds(ALL, 'copilot,claude').map((a) => a.id)).toEqual(['claude', 'copilot']);
    });

    it('de-duplicates repeated ids', () => {
        expect(filterAgentsByIds(ALL, 'cursor,cursor').map((a) => a.id)).toEqual(['cursor']);
    });
});

describe('--only aliases and typos', () => {
    it('cc means claude', () => {
        expect(filterAgentsByIds(ALL, 'cc').map((a) => a.id)).toEqual(['claude']);
        expect(unknownOnlyIds(ALL, 'cc')).toEqual([]);
    });

    it('names the ids that match no agent, not the ones that are merely not detected', () => {
        const all = [...ALL, { id: 'aider', name: 'Aider', detected: false }];
        expect(unknownOnlyIds(all, 'aider,cursor,bogus, Vscode')).toEqual(['bogus', 'vscode']);
    });

    it('is empty when every id is known', () => {
        expect(unknownOnlyIds(ALL, 'claude,gemini')).toEqual([]);
    });
});

describe('firstStderrLine (why a child command failed)', () => {
    it('returns the first non-empty stderr line', () => {
        expect(firstStderrLine({ stderr: Buffer.from('\n  Repository not found\nsecond') })).toBe('Repository not found');
    });

    it('strips colour codes and cuts a long line', () => {
        expect(firstStderrLine({ stderr: '\u001b[31mboom\u001b[0m' })).toBe('boom');
        expect(firstStderrLine({ stderr: 'x'.repeat(300) })).toHaveLength(160);
    });

    it('is undefined when there is nothing to say', () => {
        expect(firstStderrLine(new Error('no stderr'))).toBeUndefined();
        expect(firstStderrLine({ stderr: Buffer.from('  \n') })).toBeUndefined();
        expect(firstStderrLine(null)).toBeUndefined();
    });
});
