import { beforeEach, describe, expect, it, vi } from 'vitest';

let listing: { status: number | null; stdout: string; error?: Error } = { status: 0, stdout: '' };
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) =>
            cmd === 'tmux' && args.includes('list-sessions') && args.includes('#{session_name}\t#{session_created}')
                ? listing
                : { status: 1, stdout: '', stderr: '' },
    };
});

const { liveRunIdOf, liveRunOf, liveTmuxRuns } = await import('./tmux-liveness.js');

describe('liveRunIdOf — the three-state run id the delete paths refuse on', () => {
    beforeEach(() => {
        delete process.env.HWIP_TMUX_SOCKET;
        listing = { status: 0, stdout: 'hwip-app\t1700000000\nhwip-appx\t1700000099\n' };
    });

    it('returns the session_created of the exact name', () => {
        expect(liveRunIdOf('hwip-app')).toBe('1700000000');
        expect(liveRunIdOf('hwip-appx')).toBe('1700000099');
    });

    it('is null (not running) for a name tmux does not hold, prefixes included', () => {
        expect(liveRunIdOf('hwip')).toBeNull();
        expect(liveRunIdOf('hwip-ap')).toBeNull();
    });

    it('is undefined, not null, when no tmux answered', () => {
        listing = { status: 1, stdout: '' };
        expect(liveRunIdOf('hwip-app')).toBeUndefined();
        expect(liveRunOf('hwip-app')).toBeUndefined();
        listing = { status: null, stdout: '', error: new Error('ENOENT') };
        expect(liveRunIdOf('hwip-app')).toBeUndefined();
    });

    it('is undefined for a created value that is not epoch seconds', () => {
        listing = { status: 0, stdout: 'hwip-app\tnot-a-number\n' };
        expect(liveRunIdOf('hwip-app')).toBeUndefined();
        listing = { status: 0, stdout: 'hwip-app\t1234567890123\n' };
        expect(liveRunIdOf('hwip-app')).toBeUndefined();
    });

    it('splits at the last tab, so a name holding a tab is matched whole', () => {
        listing = { status: 0, stdout: 'a\tb\t1700000001\n' };
        expect(liveRunIdOf('a\tb')).toBe('1700000001');
        expect(liveRunIdOf('a')).toBeNull();
    });

    it('liveRunOf passes null through and falls back to the raw id with no registry record', () => {
        expect(liveRunOf('hwip-zzz')).toBeNull();
        expect(liveRunOf('hwip-app')).toBe('1700000000');
    });

    it('liveTmuxRuns wires the two probes', () => {
        expect(liveTmuxRuns.runIdOf('hwip-app')).toBe('1700000000');
    });
});
