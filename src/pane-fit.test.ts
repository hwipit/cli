import { describe, expect, it } from 'vitest';
import { clampViewerCols, createPaneFitter, macosLastKeyAt, releaseStaleFits, type TmuxRun } from './pane-fit.js';

const SEP = '␟';

/**
 * A tmux with one window per target, answering display-message from state.
 * `activity` is each attached client's `#{client_activity}`, in seconds.
 */
const fakeTmux = (win: { attached: number; panes: number; width: number; activity?: number[]; clients?: string[] }) => {
    const calls: string[][] = [];
    const run: TmuxRun = (args) => {
        calls.push(args);
        if (args[0] === 'display-message') {
            return { status: 0, stdout: `${win.attached}${SEP}${win.panes}${SEP}${win.width}\n` };
        }
        if (args[0] === 'list-clients') {
            return { status: 0, stdout: (win.clients ?? (win.activity ?? []).map(String)).map((c) => `${c}\n`).join('') };
        }
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
    describe('with the desktop key clock', () => {
        /** A desktop whose client attached at 800 and was last active (mouse, focus or key) at `activity`. */
        const setup = (activity: number, keyAt: number) => {
            const t = fakeTmux({ attached: 1, panes: 1, width: 120, clients: [`900${SEP}800`] });
            const clock = fakeClock(1000);
            const key = { at: keyAt as number | null };
            const fitter = createPaneFitter(t.run, clock.now, () => key.at);
            fitter.claim('s');
            fitter.fit('s', 's', 45);
            clock.seconds = 1010;
            t.win.clients = [`${activity}${SEP}800`];
            return { t, clock, key, fitter };
        };

        it('keeps the phone width when the desktop only moved the mouse or focus since the phone typed', () => {
            const { t, fitter } = setup(1005, 950);
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(true);
            expect(t.calls).not.toContainEqual(['set-option', '-w', '-u', '-t', 's', 'window-size']);
        });

        it('hands the window back once a key is pressed on the desktop after the phone typed', () => {
            const { fitter, key } = setup(1006, 950);
            key.at = 1006;
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(false);
        });

        it('counts a key pressed just before the mouse moved over the window', () => {
            const { fitter, key } = setup(1007, 950);
            key.at = 1005;
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(false);
        });

        it('hands the window back to a client that attached after the phone typed, key or not', () => {
            const { t, fitter } = setup(1005, 950);
            t.win.clients = [`1005${SEP}1005`];
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(false);
        });

        it('a client attached over SSH reclaims the window by typing, which the Mac key clock cannot see', () => {
            const { t, fitter } = setup(1005, 950);
            t.win.clients = [`1005${SEP}800${SEP}77`];
            const remote = createPaneFitter(t.run, () => 1_010_000, (pid) => (pid === 77 ? null : 950));
            remote.claim('s');
            t.win.clients = [`900${SEP}800${SEP}77`];
            remote.fit('s', 's', 45);
            t.win.clients = [`1011${SEP}800${SEP}77`];
            remote.fit('s', 's', 45);

            expect(remote.fitted('s')).toBe(false);
            expect(fitter.fitted('s')).toBe(true);
        });

        it('does not read the key clock while no desktop client moved since the phone typed', () => {
            const t = fakeTmux({ attached: 1, panes: 1, width: 120, clients: [`900${SEP}800`] });
            let reads = 0;
            const fitter = createPaneFitter(t.run, fakeClock(1000).now, () => { reads++; return 950; });
            fitter.claim('s');
            fitter.fit('s', 's', 45);
            fitter.recheck('s');

            expect(fitter.fitted('s')).toBe(true);
            expect(reads).toBe(0);
        });

        it('rechecks every fitted window at once, handing back only the one the desktop typed in', () => {
            const t = fakeTmux({ attached: 1, panes: 1, width: 120 });
            const activity: Record<string, number> = { a: 900, b: 900 };
            const run: TmuxRun = (args) => (args[0] === 'list-clients'
                ? { status: 0, stdout: `${activity[args[args.indexOf('-t') + 1]]}${SEP}800\n` }
                : t.run(args));
            const clock = fakeClock(1000);
            const key = { at: 950 };
            const fitter = createPaneFitter(run, clock.now, () => key.at);
            for (const s of ['a', 'b']) {
                fitter.claim(s);
                fitter.fit(s, s, 45);
            }
            clock.seconds = 1003;
            key.at = 1002;
            activity.a = 1002;
            fitter.recheckAll();

            expect(fitter.fitted('a')).toBe(false);
            expect(fitter.fitted('b')).toBe(true);
        });

        it('opening takes a window whose desktop only moved the mouse within the last minute', () => {
            const t = fakeTmux({ attached: 1, panes: 1, width: 120, clients: [`995${SEP}800`] });
            const fitter = createPaneFitter(t.run, fakeClock(1000).now, () => 900);
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(true);
        });

        it('opening still leaves a desktop that typed within the last minute alone', () => {
            const t = fakeTmux({ attached: 1, panes: 1, width: 120, clients: [`995${SEP}800`] });
            const fitter = createPaneFitter(t.run, fakeClock(1000).now, () => 990);
            fitter.fit('s', 's', 45);

            expect(fitter.fitted('s')).toBe(false);
        });
    });

    it('fits a detached single-pane window to the viewer and marks its old width', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const fitter = createPaneFitter(t.run);
        fitter.fit('hwip-hwip-sh', 'hwip-hwip-sh', 45);

        expect(t.resizes()).toEqual(['45']);
        expect(t.calls).toContainEqual(['set-option', '-w', '-t', 'hwip-hwip-sh', '@hwip_fit_width', '120']);
        expect(fitter.fitted('hwip-hwip-sh')).toBe(true);
    });

    it('fits an attached window whose clients have been idle since the phone claimed it', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900, 930] });
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

    it('opening leaves a desktop used within the last minute alone, and takes the window once it has been idle a minute', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [990] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.open('s');
        fitter.fit('s', 's', 45);
        expect(t.resizes()).toEqual([]);

        clock.seconds = 1049;
        fitter.fit('s', 's', 45);
        expect(t.resizes()).toEqual([]);

        clock.seconds = 1050;
        fitter.fit('s', 's', 45);
        expect(t.resizes()).toEqual(['45']);
    });

    it('phone input takes the window even from a desktop used seconds ago', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [990] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.open('s');
        fitter.fit('s', 's', 45);
        fitter.claim('s');
        fitter.fit('s', 's', 45);

        expect(t.resizes()).toEqual(['45']);
    });

    it('keeps a typed claim when the mirror is opened again', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [1002] });
        const clock = fakeClock(1010);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.claim('s');
        fitter.fit('s', 's', 45);
        clock.seconds = 1015;
        fitter.open('s');
        fitter.fit('s', 's', 45);

        expect(fitter.fitted('s')).toBe(true);
        expect(t.calls.filter((c) => c.includes('window-size'))).toEqual([]);
    });

    it('opening takes the window from a desktop idle a minute even after the phone once typed', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.claim('s');
        fitter.fit('s', 's', 45);
        t.win.activity = [1010];
        clock.seconds = 1011;
        fitter.fit('s', 's', 45);
        expect(fitter.fitted('s')).toBe(false);

        t.win.width = 120;
        clock.seconds = 1200;
        fitter.open('s');
        fitter.fit('s', 's', 45);
        expect(t.resizes()).toEqual(['45', '45']);
    });

    it('tells a fit at another width apart', () => {
        const t = fakeTmux({ attached: 0, panes: 1, width: 120 });
        const fitter = createPaneFitter(t.run);
        fitter.fit('s', 's', 45);

        expect(fitter.fitted('s', 45)).toBe(true);
        expect(fitter.fitted('s', 80)).toBe(false);
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

    it('a phone that typed, left and came back takes the width again while the desktop stayed unused', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [995] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.claim('s');
        fitter.fit('s', 's', 45);
        clock.seconds = 1010;
        fitter.release('s');
        expect(fitter.fitted('s')).toBe(false);

        // Back 10 s later: the desktop was used 25 s ago, before the phone typed, so the phone is still its latest user.
        clock.seconds = 1020;
        fitter.open('s');
        fitter.fit('s', 's', 45);
        expect(fitter.fitted('s')).toBe(true);
    });

    it('a phone that comes back after the desktop typed waits for the desktop to go idle', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [995] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.claim('s');
        fitter.fit('s', 's', 45);
        fitter.release('s');
        t.win.activity = [1005];
        clock.seconds = 1020;
        fitter.open('s');
        fitter.fit('s', 's', 45);

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

    it('rechecks a held window, handing it back to a client used since without resizing', () => {
        const t = fakeTmux({ attached: 1, panes: 1, width: 120, activity: [900] });
        const clock = fakeClock(1000);
        const fitter = createPaneFitter(t.run, clock.now);
        fitter.fit('s', 's', 45);
        fitter.recheck('s');
        expect(t.resizes()).toEqual(['45']);
        expect(fitter.fitted('s')).toBe(true);

        t.win.activity = [1005];
        clock.seconds = 1006;
        fitter.recheck('s');
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

describe('macosLastKeyAt', () => {
    type Spawn = NonNullable<Parameters<typeof macosLastKeyAt>[1]>;
    /** `ps` answers from `tree` (pid → [ppid, command]); `osascript` from `idle`. */
    const fakeSpawn = (idle: { status: number | null; stdout: string }, tree: Record<number, [number, string]> = {}) => {
        const calls: string[] = [];
        const spawn = ((cmd: string, args: readonly string[]) => {
            calls.push(cmd);
            if (cmd === 'ps') {
                const node = tree[Number(args[args.length - 1])];
                return node ? { status: 0, stdout: `${node[0]} ${node[1]}\n` } : { status: 1, stdout: '' };
            }
            return idle;
        }) as unknown as Spawn;
        return { spawn, calls };
    };
    const clock = { ms: 1_000_000 };
    const now = () => clock.ms;

    it('reads when a key was last pressed, once a second', () => {
        clock.ms = 1_000_000;
        const s = fakeSpawn({ status: 0, stdout: '3.5\n' }, { 10: [1, 'login'] });
        const keyAt = macosLastKeyAt(now, s.spawn, 'darwin');

        expect(keyAt(10)).toBe(996);
        clock.ms += 500;
        expect(keyAt(10)).toBe(996);
        expect(s.calls.filter((c) => c === 'osascript')).toHaveLength(1);
        clock.ms += 1000;
        keyAt(10);
        expect(s.calls.filter((c) => c === 'osascript')).toHaveLength(2);
    });

    it('knows nothing off macOS', () => {
        const s = fakeSpawn({ status: 0, stdout: '1\n' });
        expect(macosLastKeyAt(now, s.spawn, 'linux')(10)).toBeNull();
        expect(s.calls).toEqual([]);
    });

    it('knows nothing for a client that came in over SSH, and asks the process tree once per client', () => {
        const s = fakeSpawn({ status: 0, stdout: '1\n' }, { 20: [19, 'tmux'], 19: [18, '-zsh'], 18: [1, '/usr/sbin/sshd']});
        const keyAt = macosLastKeyAt(now, s.spawn, 'darwin');

        expect(keyAt(20)).toBeNull();
        const asked = s.calls.length;
        expect(keyAt(20)).toBeNull();
        expect(s.calls).toHaveLength(asked);
    });

    it('backs off for half a minute after osascript fails or says nothing', () => {
        clock.ms = 1_000_000;
        for (const idle of [{ status: null, stdout: '' }, { status: 0, stdout: '' }, { status: 0, stdout: 'x' }]) {
            const s = fakeSpawn(idle, { 10: [1, 'login'] });
            const keyAt = macosLastKeyAt(now, s.spawn, 'darwin');
            expect(keyAt(10)).toBeNull();
            clock.ms += 20_000;
            keyAt(10);
            expect(s.calls.filter((c) => c === 'osascript')).toHaveLength(1);
            clock.ms += 20_000;
        }
    });
});
