import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_CONTEXT_SCREEN_WINDOW_LINES, gatherAskContext } from './ask-context.js';
import { captureAskScreen, type ScreenDeps } from './ask-context-screen.js';

const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

const fake = (answer: { status: number | null; stdout: string }, target: string | null = '%7') => {
    const calls: string[][] = [];
    const deps: ScreenDeps = { targetOf: () => target, tmux: (args) => (calls.push(args), answer) };
    return { deps, calls };
};

describe('captureAskScreen', () => {
    it('reads the last lines of the pane the session name resolves to, as plain text', () => {
        const { deps, calls } = fake({ status: 0, stdout: 'a\nb\n' });

        expect(captureAskScreen('hwip-a', deps)).toBe('a\nb\n');
        expect(calls).toEqual([['capture-pane', '-p', '-J', '-t', '%7', '-S', `-${ASK_CONTEXT_SCREEN_WINDOW_LINES}`]]);
        expect(calls[0]).not.toContain('-e'); // no escape sequences: the text is masked and read by a person
    });

    it('is null when the name resolves to no pane, and does not run tmux at all', () => {
        const { deps, calls } = fake({ status: 0, stdout: 'x' }, null);

        expect(captureAskScreen('hwip-a.2', deps)).toBeNull();
        expect(calls).toEqual([]);
    });

    it.each([[1], [null]])('is null when tmux fails (status %s), not the text it printed', (status) => {
        expect(captureAskScreen('hwip-a', fake({ status, stdout: 'half' }).deps)).toBeNull();
    });
});

const tmuxPath = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 ? 'tmux' : null;

describe.skipIf(tmuxPath === null)('against a real tmux server', () => {
    // A private socket: nothing here touches the tmux server the developer works in.
    const socket = `hwip-ask-screen-${process.pid}`;
    const tmux = (args: string[]) => {
        const r = spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { status: r.status, stdout: r.stdout ?? '' };
    };
    const deps: ScreenDeps = { targetOf: (name) => name, tmux };

    beforeAll(() => {
        const made = tmux(['new-session', '-d', '-s', 'shot', '-x', '100', '-y', '8', `printf 'first\\nsecret %s\\nlast\\n' ${GH}; sleep 30`]);
        expect(made.status).toBe(0);
    });
    afterAll(() => void tmux(['kill-server']));

    const screenWith = async (needle: string, session = 'shot'): Promise<string> => {
        for (let i = 0; i < 40; i++) {
            const text = captureAskScreen(session, deps);
            if (text?.includes(needle)) return text;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`the pane never showed ${needle}`);
    };

    it('captures what the pane shows', async () => {
        const text = await screenWith('last');

        expect(text).toContain('first');
        expect(text).toContain(`secret ${GH}`);
    });

    it('hides a token wider than the pane whole, not row by row', async () => {
        const key = `sk-ant-api03-${'Qz8Lm2Vx9Rt4'.repeat(9)}`; // 121 characters in a 60-column pane
        expect(tmux(['new-session', '-d', '-s', 'narrow', '-x', '60', '-y', '8', `printf 'export KEY=%s\\nend\\n' ${key}; sleep 30`]).status).toBe(0);
        const wrapped = await screenWith('end', 'narrow');

        const ctx = gatherAskContext('/not/a/repo', wrapped, { repoRootOf: () => null });

        expect(ctx?.original.screen).toContain('export KEY=***');
        expect(JSON.stringify(ctx)).not.toMatch(/Qz8L|sk-ant/);
    });

    it('is null for a session that is not there', () => {
        expect(captureAskScreen('nope', deps)).toBeNull();
    });

    it('feeds the collector, which hides the token before anything leaves', async () => {
        const text = await screenWith('last');

        const ctx = gatherAskContext('/not/a/repo', text, { repoRootOf: () => null });

        expect(ctx?.original.screen).toContain('secret ***');
        expect(JSON.stringify(ctx)).not.toContain(GH);
        expect(ctx?.summary.masked).toBe(1);
    });
});
