import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let overrideUp = true;
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) =>
            cmd === 'tmux' && args[0] === '-S' && args[1] === '/tmp/hwip-test.sock' && args[2] === 'list-sessions'
                ? { status: overrideUp ? 0 : 1, stdout: '', stderr: '' }
                : { status: 1, stdout: '', stderr: 'no server' },
    };
});

const { invalidateTmuxSocketCache, socketKey, tmuxArgs } = await import('./tmux-socket.js');
const { silenceListenerLog } = await import('./listener-log.js');

describe('tmuxArgs', () => {
    afterEach(() => {
        delete process.env.HWIP_TMUX_SOCKET;
        invalidateTmuxSocketCache();
        overrideUp = true;
    });

    it('prepends -S for a live HWIP_TMUX_SOCKET and remembers it', () => {
        silenceListenerLog();
        process.env.HWIP_TMUX_SOCKET = '/tmp/hwip-test.sock';
        expect(tmuxArgs(['list-sessions'])).toEqual(['-S', '/tmp/hwip-test.sock', 'list-sessions']);
        overrideUp = false;
        expect(tmuxArgs(['ls'])).toEqual(['-S', '/tmp/hwip-test.sock', 'ls']);
    });

    it('forgets the socket after invalidation', () => {
        silenceListenerLog();
        process.env.HWIP_TMUX_SOCKET = '/tmp/hwip-test.sock';
        expect(tmuxArgs(['ls'])).toEqual(['-S', '/tmp/hwip-test.sock', 'ls']);
        invalidateTmuxSocketCache();
        delete process.env.HWIP_TMUX_SOCKET;
        expect(tmuxArgs(['ls'])).toEqual(['ls']);
    });
});

describe('socketKey', () => {
    it('names a socket the same through a symlinked directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'hwip-socket-key-'));
        try {
            mkdirSync(join(root, 'real'));
            writeFileSync(join(root, 'real', 'default'), '');
            symlinkSync(join(root, 'real'), join(root, 'link'));
            expect(socketKey(join(root, 'link', 'default'))).toBe(socketKey(join(root, 'real', 'default')));
            expect(socketKey(join(root, 'real', 'other'))).not.toBe(socketKey(join(root, 'real', 'default')));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the path as given when nothing is there', () => {
        expect(socketKey('/nonexistent/tmux-0/default')).toBe('/nonexistent/tmux-0/default');
    });
});
