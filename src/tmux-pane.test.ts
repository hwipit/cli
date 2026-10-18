import { describe, expect, it } from 'vitest';
import {
    detectRemoteAgent,
    isSubagentSessionName,
    recordSubagentTranscripts,
    recordTargets,
    subagentTranscriptFor,
    tmuxTargetFor,
} from './tmux-pane.js';

const pane = (startCommand: string | null, currentCommand: string | null = null) => ({
    currentCommand,
    startCommand,
    currentPath: null,
    panePid: null,
});

describe('tmuxTargetFor', () => {
    it('answers a pinned pane id, and the bare name for a main session not yet swept', () => {
        recordTargets({ 'hwip-app': '%7' });
        expect(tmuxTargetFor('hwip-app')).toBe('%7');
        expect(tmuxTargetFor('hwip-other')).toBe('hwip-other');
    });

    it('answers null for a subagent name the sweep has not pinned', () => {
        recordTargets({ 'hwip-app.48': '%9' });
        expect(isSubagentSessionName('hwip-app.48')).toBe(true);
        expect(tmuxTargetFor('hwip-app.48')).toBe('%9');
        expect(tmuxTargetFor('hwip-app.99')).toBeNull();
    });

    it('replaces the whole map on each sweep', () => {
        recordTargets({ 'hwip-a': '%1' });
        recordTargets({ 'hwip-b': '%2' });
        expect(tmuxTargetFor('hwip-a')).toBe('hwip-a');
        recordTargets(null);
        expect(tmuxTargetFor('hwip-b')).toBe('hwip-b');
    });
});

describe('subagentTranscriptFor', () => {
    it('answers the recorded transcript and null for anything else', () => {
        recordSubagentTranscripts({ 'hwip-app.1': '/tmp/t.jsonl' });
        expect(subagentTranscriptFor('hwip-app.1')).toBe('/tmp/t.jsonl');
        expect(subagentTranscriptFor('hwip-app.2')).toBeNull();
        recordSubagentTranscripts(undefined);
        expect(subagentTranscriptFor('hwip-app.1')).toBeNull();
    });
});

describe('detectRemoteAgent', () => {
    it('reads the start command first, quotes unwrapped', () => {
        expect(detectRemoteAgent(pane('"claude --resume abc"', 'node'))?.kind).toBe('claude');
    });

    it('falls back to the current command when the start command is empty', () => {
        expect(detectRemoteAgent(pane(null, 'claude'))?.kind).toBe('claude');
    });

    it('answers null for a pane that runs no registered agent', () => {
        expect(detectRemoteAgent(pane('vim notes.md', 'vim'))).toBeNull();
    });
});
