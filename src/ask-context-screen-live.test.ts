import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real tmux deps reach the listener module, whose socket search prints to stdout, and run tmux with limits.
// Both are pinned here with the listener and the process spawner replaced.

const order: string[] = [];
const spawnSync = vi.fn((..._args: unknown[]) => ({ status: 0, stdout: 'screen', error: undefined as Error | undefined }));

vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => (order.push('spawn'), spawnSync(...args)) }));
vi.mock('./listener.js', () => ({
    silenceListenerLog: () => void order.push('silence'),
    tmuxArgs: (args: string[]) => (order.push('socket'), ['-S', '/tmp/sock', ...args]),
    tmuxTargetFor: (name: string) => (name === 'gone' ? null : `%${name}`),
}));

const { liveScreenDeps, captureAskScreen } = await import('./ask-context-screen.js');

beforeEach(() => {
    order.length = 0;
    spawnSync.mockClear();
});

describe('liveScreenDeps', () => {
    it('quiets the listener log before anything can print, then resolves the socket, then runs tmux', async () => {
        const deps = await liveScreenDeps();
        expect(order).toEqual(['silence']);

        expect(captureAskScreen('a', deps)).toBe('screen');
        expect(order).toEqual(['silence', 'socket', 'spawn']);
    });

    it('runs tmux on the discovered socket, with a time limit and a size limit, and never inherits stdout', async () => {
        await captureAskScreen('a', await liveScreenDeps());

        const [cmd, args, options] = spawnSync.mock.calls[0]! as [string, string[], Record<string, unknown>];
        expect(cmd).toBe('tmux');
        expect(args.slice(0, 2)).toEqual(['-S', '/tmp/sock']);
        expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 1024 * 1024 });
    });

    it('is null when tmux times out or overflows (spawnSync reports an error), whatever status it left', async () => {
        spawnSync.mockReturnValueOnce({ status: 0, stdout: 'partial', error: new Error('ETIMEDOUT') });

        expect(captureAskScreen('a', await liveScreenDeps())).toBeNull();
    });

    it('does not run tmux for a name that resolves to no pane', async () => {
        expect(captureAskScreen('gone', await liveScreenDeps())).toBeNull();
        expect(spawnSync).not.toHaveBeenCalled();
    });
});
