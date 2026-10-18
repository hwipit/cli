import { beforeEach, describe, expect, it, vi } from 'vitest';

let listing: { status: number | null; stdout: string; error?: Error } = { status: 0, stdout: '' };
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) =>
            cmd === 'tmux' && args.includes('list-sessions') && args.includes('#{session_name}')
                ? listing
                : { status: 1, stdout: '', stderr: '' },
    };
});

const { liveSessionNames, sessionExists, sessionLiveness } = await import('./tmux-liveness.js');
const { recordSubagentTranscripts, recordTargets } = await import('./tmux-pane.js');
const { silenceListenerLog } = await import('./listener-log.js');

silenceListenerLog();

describe('tmux liveness', () => {
    beforeEach(() => {
        delete process.env.HWIP_TMUX_SOCKET;
        listing = { status: 0, stdout: 'hwip-app\nhwip-appx\n\n' };
        recordTargets(null);
        recordSubagentTranscripts(null);
    });

    it('lists the names the server holds, without blanks', () => {
        expect(liveSessionNames()).toEqual(['hwip-app', 'hwip-appx']);
    });

    it('compares names exactly, so an ended prefix does not read as running', () => {
        expect(sessionLiveness('hwip-app')).toBe('running');
        expect(sessionLiveness('hwip')).toBe('ended');
        expect(sessionExists('hwip-app')).toBe(true);
        expect(sessionExists('hwip')).toBe(false);
    });

    it('says unknown, not ended, when no server answered', () => {
        listing = { status: 1, stdout: '' };
        expect(liveSessionNames()).toBeNull();
        expect(sessionLiveness('hwip-app')).toBe('unknown');
        expect(sessionExists('hwip-app')).toBe(false);
    });

    it('answers a subagent from the sweep maps, never from tmux', () => {
        listing = { status: 1, stdout: '' };
        expect(sessionLiveness('hwip-app.48')).toBe('ended');
        recordTargets({ 'hwip-app.48': '%9' });
        expect(sessionLiveness('hwip-app.48')).toBe('running');
        recordSubagentTranscripts({ 'hwip-app.7': '/tmp/t.jsonl' });
        expect(sessionLiveness('hwip-app.7')).toBe('running');
    });
});
