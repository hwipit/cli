import { describe, expect, it, vi } from 'vitest';
import { createWorktreeCleanup } from './listener-worktree-cleanup.js';
import type { GitRun, ReconcileReport } from './worktree.js';

const NO_REPORT: ReconcileReport = { removed: [], kept: [], inUse: [], gone: [] };
const tmux: GitRun = async () => ({ ok: true, stdout: '' });

const setup = (over: { hasRows?: boolean; panes?: string[] | null; report?: ReconcileReport; notify?: () => Promise<unknown> } = {}) => {
    const logs: string[] = [];
    const readPanes = vi.fn(async () => (over.panes === undefined ? ['/p'] : over.panes));
    const reconcile = vi.fn(async () => over.report ?? NO_REPORT);
    const notify = vi.fn(over.notify ?? (async () => true));
    const cleanup = createWorktreeCleanup({
        log: (m) => logs.push(m), notify, tmux,
        hasRows: () => over.hasRows ?? true, readPanes, reconcile,
    });
    // `observe` starts a pass and returns; the pass is a few microtasks.
    const settle = () => new Promise((done) => setTimeout(done, 0));
    return { cleanup, logs, readPanes, reconcile, notify, settle };
};

describe('createWorktreeCleanup', () => {
    it('runs a pass at the first publish, with the panes tmux reported', async () => {
        const t = setup();
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.reconcile).toHaveBeenCalledWith({ paneCwds: ['/p'] });
    });

    it('asks neither tmux nor git when the names did not change, whatever order they come in', async () => {
        const t = setup();
        t.cleanup.observe(['hwip-a', 'hwip-b']);
        await t.settle();
        t.cleanup.observe(['hwip-b', 'hwip-a']);
        await t.settle();
        expect(t.readPanes).toHaveBeenCalledTimes(1);
        expect(t.reconcile).toHaveBeenCalledTimes(1);
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.reconcile).toHaveBeenCalledTimes(2);
    });

    it('asks nothing at all while no worktree is on record', async () => {
        const t = setup({ hasRows: false });
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.readPanes).not.toHaveBeenCalled();
        expect(t.reconcile).not.toHaveBeenCalled();
    });

    it('judges nothing when the tmux panes could not be read', async () => {
        const t = setup({ panes: null });
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.reconcile).not.toHaveBeenCalled();
        expect(t.logs).toEqual(['! worktree cleanup skipped: could not read the tmux panes']);
    });

    it('logs what it removed, and one line and one banner for what it kept', async () => {
        const t = setup({
            report: {
                removed: [{ path: '/w/app-wt-a', branch: 'a', branchDeleted: true }, { path: '/w/app-wt-b', branch: 'b', branchDeleted: false }],
                kept: [{ path: '/w/app-wt-c', branch: 'c', reasons: ['2 uncommitted or untracked', '1 unpushed commit'], removeFailed: false }],
                inUse: [], gone: ['/w/app-wt-d'],
            },
        });
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.logs).toEqual([
            'worktree removed: /w/app-wt-a (branch a deleted)',
            'worktree removed: /w/app-wt-b',
            'worktree forgotten, its directory is gone: /w/app-wt-d',
            'worktree kept: /w/app-wt-c — 2 uncommitted or untracked, 1 unpushed commit',
        ]);
        expect(t.notify).toHaveBeenCalledTimes(1);
        expect(t.notify).toHaveBeenCalledWith({
            title: 'Hwip · worktree kept', body: 'app-wt-c — 2 uncommitted or untracked, 1 unpushed commit', reveal: '/w/app-wt-c',
        });
    });

    it('a banner that fails or a pass that throws is a log line, and the next change is still handled', async () => {
        const t = setup({
            report: { ...NO_REPORT, kept: [{ path: '/w/x', branch: 'x', reasons: ['1 ignored'], removeFailed: false }] },
            notify: async () => { throw new Error('no notifier'); },
        });
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        expect(t.logs).toContain('! banner failed — no notifier');
        t.reconcile.mockRejectedValueOnce(new Error('git exploded'));
        t.cleanup.observe([]);
        await t.settle();
        expect(t.logs).toContain('! worktree cleanup failed: git exploded');
        t.cleanup.observe(['hwip-z']);
        await t.settle();
        expect(t.reconcile).toHaveBeenCalledTimes(3);
    });

    it('runs one pass at a time, and a change that came during one is picked up by the next publish', async () => {
        let release: () => void = () => undefined;
        const t = setup();
        t.reconcile.mockImplementationOnce(() => new Promise<ReconcileReport>((done) => { release = () => done(NO_REPORT); }));
        t.cleanup.observe(['hwip-a']);
        await t.settle();
        t.cleanup.observe([]);
        await t.settle();
        expect(t.reconcile).toHaveBeenCalledTimes(1);
        release();
        await t.settle();
        t.cleanup.observe([]);
        await t.settle();
        expect(t.reconcile).toHaveBeenCalledTimes(2);
    });
});
