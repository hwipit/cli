import { describe, expect, it } from 'vitest';
import { clampViewerCols, createPaneFitter, releaseStaleFits, type TmuxRun } from './pane-fit.js';

const SEP = '␟';

/**
 * A tmux with one window per target, answering display-message from state.
 * `activity` is each attached client's `#{client_activity}`, in seconds.
 */
const fakeTmux = (win: { attached: number; panes: number; width: number; activity?: number[] }) => {
    const calls: string[][] = [];
    const run: TmuxRun = (args) => {
        calls.push(args);
        if (args[0] === 'display-message') {
            return { status: 0, stdout: `${win.attached}${SEP}${win.panes}${SEP}${win.width}\n` };
        }
        if (args[0] === 'list-clients') return { status: 0, stdout: (win.activity ?? []).map((a) => `${a}\n`).join('') };
        if (args[0] === 'resize-window') win.width = Number(args[args.indexOf('-x') + 1]);
        return { status: 0, stdout: '' };
    };
    const resizes = () => calls.filter((c) => c[0] === 'resize-window').map((c) => c[c.indexOf('-x') + 1]);
    return { run, calls, win, resizes };
};

/** A clock the fitter reads, in ms, that a test moves by whole seconds. */
const fakeClock = (seconds: number) => {
    const clock = { seconds, now: () => clock.seconds * 1000 };
    return clock;
};

describe('clampViewerCols', () => {
    it('floors and bounds a viewer width, and refuses anything that is not a number', () => {
        expect(clampViewerCols(44.7)).toBe(44);
        expect(clampViewerCols(3)).toBe(20);
        expect(clampViewerCols(10_000)).toBe(400);
        expect(clampViewerCols(undefined)).toBeNull();
        expect(clampViewerCols('45')).toBeNull();
        expect(clampViewerCols(Number.NaN)).toBeNull();
    });
});

describe('createPaneFitter', () => {
    it('fits a detached single-pane window to the viewer and marks its old width', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const fitter = createPaneFitter(t.run);
        fitter.fit('hwip-hwip-sh', 'hwip-hwip-sh', 45);

        expect(t.resizes()).toEqual(['45']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-t', 'hwip-hwip-sh', '@hwip_fit_width', '120']);
        expect(fitter.fitted('hwip-hwip-sh')).toBe(true);
    });

    it('fits an attached window whose clients have been idle since the phone claimed it', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900, 990] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.fit('hwip-hwip', 'hwip-hwip', 45);

        expect(t.resizes()).toEqual(['45']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-t', 'hwip-hwip', '@hwip_fit_width', '120']);
        expect(fitter.fitted('hwip-hwip')).toBe(true);
    });

    it('hands an attached window back once a desktop client is used after the phone', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.fit('s', 's', 45);
        clock.seconds = 1010;
        t.win.activity = [1005];
        fitter.fit('s', 's', 45);

        // No resize back: dropping the manual size lets tmux size it to the client.
        expect(t.resizes()).toEqual(['45']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-u', '-t', 's', 'window-size']);
        expect(fitter.fitted('s')).toBe(false);

        // The desktop stays the latest user on later renews.
        fitter.fit('s', 's', 45);
        expect(t.resizes()).toEqual(['45']);
    });

    it('fits again when the phone claims the window after the desktop used it', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.fit('s', 's', 45);
        t.win.activity = [1005];
        clock.seconds = 1006;
        fitter.fit('s', 's', 45);
        t.win.width = 120;
        clock.seconds = 1020;
        fitter.claim('s');
        fitter.fit('s', 's', 45);

        expect(t.resizes()).toEqual(['45', '45']);
        expect(fitter.fitted('s')).toBe(true);
    });

    it('gives a tie in the same second to the desktop', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [1000] });
        const fitter = createPaneFitter(t.run, fakeClock(1000).now);
        fitter.fit('s', 's', 45);

        expect(t.resizes()).toEqual([]);
    });

    it('releases an attached window without resizing it back — tmux sizes it to the client', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900] });
        const fitter = createPaneFitter(t.run, fakeClock(1000).now);
        fitter.fit('s', 's', 45);
        fitter.release('s');

        expect(t.resizes()).toEqual(['45']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-u', '-t', 's', 'window-size']);
        expect(fitter.fitted('s')).toBe(false);
    });

    it('leaves an attached window to a client that attached after the phone claimed it', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [1001] });
        const fitter = createPaneFitter(t.run, fakeClock(1000).now);
        fitter.fit('s', 's', 45);

        expect(t.resizes()).toEqual([]);
        expect(fitter.fitted('s')).toBe(false);
    });

    it('leaves a split window alone — the window width is no pane\'s width', () => {
        const t = fakeTmux({ attached: 0, panes: 2, width: 120 });
        createPaneFitter(t.run).fit('s', 's', 45);
        expect(t.resizes()).toEqual([]);
    });

    it('does nothing for a viewer that sent no width', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        createPaneFitter(t.run).fit('s', 's', undefined);
        expect(t.calls).toEqual([]);
    });

    it('does not resize again for an unchanged width, and follows a rotated phone', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const fitter = createPaneFitter(t.run);
        fitter.fit('s', 's', 45);
        fitter.fit('s', 's', 45);
        fitter.fit('s', 's', 90);

        expect(t.resizes()).toEqual(['45', '90']);
    });

    it('restores the original width, not the last fitted one, on release', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const fitter = createPaneFitter(t.run);
        fitter.fit('s', 's', 45);
        fitter.fit('s', 's', 90);
        fitter.release('s');

        expect(t.resizes()).toEqual(['45', '90', '120']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-u', '-t', 's', 'window-size']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-u', '-t', 's', '@hwip_fit_width']);
        expect(fitter.fitted('s')).toBe(false);
    });

    it('hands the window to a client that attached while the phone watched', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.fit('s', 's', 45);
        clock.seconds = 1010;
        t.win.attached = 1;
        t.win.activity = [1009];
        fitter.fit('s', 's', 45);

        // No resize back: dropping the manual size lets tmux size it to the client.
        expect(t.resizes()).toEqual(['45']);
        expect(t.calls.at(-2)).toEqual(['set-option', '-w', '-u', '-t', 's', 'window-size']);
        expect(fitter.fitted('s')).toBe(false);
    });

    it('releases nothing it never fitted', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        createPaneFitter(t.run).release('s');
        expect(t.calls).toEqual([]);
    });
});

describe('releaseStaleFits', () => {
    it('gives back every marked window a dead listener left fitted', () => {
        const calls: string[][] = [];
        const run: TmuxRun = (args) => {
            calls.push(args);
            if (args[0] === 'list-windows') {
                return {
                    status: 0,
                    stdout: [`@1${SEP}120${SEP}0`, `@2${SEP}${SEP}0`, `@3${SEP}100${SEP}1`, ''].join('\n'),
                };
            }
            return { status: 0, stdout: '' };
        };

        expect(releaseStaleFits(run)).toBe(2);
        expect(calls).toContainEqual(['resize-window', '-t', '@1', '-x', '120']);
        // Attached: its client sizes it once the manual size is gone.
        expect(calls.some((c) => c[0] === 'resize-window' && c[2] === '@3')).toBe(false);
        expect(calls).toContainEqual(['set-option', '-w', '-u', '-t', '@3', 'window-size']);
        // Never fitted: untouched.
        expect(calls.some((c) => c[2] === '@2' || c[4] === '@2')).toBe(false);
    });

    it('does nothing without a tmux server', () => {
        expect(releaseStaleFits(() => ({ status: 1, stdout: '' }))).toBe(0);
    });
});
