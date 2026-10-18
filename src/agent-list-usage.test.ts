import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAgentList } from './agent-list.js';

// These return before any tmux is asked.
describe('handleAgentList: usage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ['a flag that belongs to agent read', { _command: 'agent', _arg1: 'list', _arg2: '', turns: '3' }],
        ['the same flag with no value', { _command: 'agent', _arg1: 'list', _arg2: '', turns: true }],
        ['an extra word', { _command: 'agent', _arg1: 'list', _arg2: 'hwip-a' }],
    ])('is a usage error (exit 2) for %s', async (_, args) => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await handleAgentList(args)).toBe(2);
        expect(err).toHaveBeenCalledWith('Usage: hwip agent list [--json]');
    });
});
