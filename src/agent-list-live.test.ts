import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('./listener.js', () => ({
    silenceListenerLog: () => calls.push('silence'),
    collectSessionsVerbose: () => {
        calls.push('collect');
        return { sessions: [] };
    },
    liveSessionNames: () => {
        calls.push('names');
        return [];
    },
}));
vi.mock('./agent-rules-fetch.js', () => ({
    syncManifestFromCache: () => calls.push('sync'),
}));

const { liveLocalAgentDeps } = await import('./agent-list.js');

describe('liveLocalAgentDeps', () => {
    beforeEach(() => {
        calls.length = 0;
    });

    it('silences the listener log before anything sweeps, so --json keeps to one object', async () => {
        const deps = await liveLocalAgentDeps();
        expect(calls).toEqual(['silence']);

        deps.collect();

        expect(calls).toEqual(['silence', 'sync', 'collect']);
    });

    it('asks whether tmux answers only when it is asked', async () => {
        const deps = await liveLocalAgentDeps();

        expect(deps.tmuxVisible()).toBe(true);
        expect(calls).toEqual(['silence', 'names']);
    });
});
