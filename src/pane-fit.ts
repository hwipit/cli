/**
 * Fit a tmux window to the phone that is watching it.
 *
 * A pane is as wide as the terminal that last drew it, usually a desktop's
 * 120-odd columns. The phone mirror shows about 45, so every full-width row a
 * prompt or TUI draws (a rule, a right-aligned clock, a status line) folds into
 * two. So while a phone watches a window it is resized to the phone's width
 * and the program redraws to fit; when the phone leaves, the old width comes
 * back.
 *
 * A window with a desktop client attached is shared, and whoever used it last
 * decides its width — the rule tmux's own `window-size latest` follows. The
 * phone uses a window when it starts watching or types into it ({@link claim});
 * a client uses it when it attaches or a key is pressed in it, which is what
 * `#{client_activity}` records. While the phone is the later of the two, the
 * window is the phone's width (the desktop terminal shows it narrower); once a
 * client is newer, the next check hands the window back to tmux, which sizes
 * it to that client. A window split into panes is left alone, since the
 * window width is not any one pane's width.
 *
 * A fitted window carries its old width in `@hwip_fit_width`. A listener that
 * died without releasing (a crash, a SIGKILL) leaves that mark behind, and
 * the next one to start gives those windows back ({@link releaseStaleFits}).
 */

/** Runs one tmux command (socket-aware) and returns what it printed. */
export type TmuxRun = (args: string[]) => { status: number | null; stdout: string };

export const PANE_FIT_MIN_COLS = 20;
export const PANE_FIT_MAX_COLS = 400;

/** A viewer's column count, or null when it did not send a usable one. */
export const clampViewerCols = (cols: unknown): number | null => {
    if (typeof cols !== 'number' || !Number.isFinite(cols)) return null;
    return Math.min(PANE_FIT_MAX_COLS, Math.max(PANE_FIT_MIN_COLS, Math.floor(cols)));
};

interface Fit {
    target: string;
    /** Width the window had before the first fit — what release restores. */
    width: number;
    cols: number;
}

const SEP = '\u241f';
const FIT_MARK = '@hwip_fit_width';

/**
 * Hand back every window a previous listener fitted and never released:
 * restore its width when detached, then drop the manual size and the mark.
 */
export const releaseStaleFits = (run: TmuxRun): number => {
    const r = run(['list-windows', '-a', '-F', `#{window_id}${SEP}#{${FIT_MARK}}${SEP}#{session_attached}`]);
    if (r.status !== 0) return 0;
    let released = 0;
    for (const line of r.stdout.split('\n')) {
        const [id, mark, attached] = line.split(SEP);
        const width = Number(mark);
        if (!id || !mark || !Number.isFinite(width)) continue;
        if (attached === '0') run(['resize-window', '-t', id, '-x', String(width)]);
        run(['set-option', '-w', '-u', '-t', id, 'window-size']);
        run(['set-option', '-w', '-u', '-t', id, FIT_MARK]);
        released++;
    }
    return released;
};

/** The newest `#{client_activity}` (seconds) among the clients on `target`'s session, or null when unknown. */
const latestClientUse = (run: TmuxRun, target: string): number | null => {
    const r = run(['list-clients', '-t', target, '-F', '#{client_activity}']);
    if (r.status !== 0) return null;
    const uses = r.stdout.split('\n').filter(Boolean).map(Number).filter(Number.isFinite);
    return uses.length > 0 ? Math.max(...uses) : null;
};

const readWindow = (run: TmuxRun, target: string): { attached: number; panes: number; width: number } | null => {
    const r = run(['display-message', '-p', '-t', target,
        `#{session_attached}${SEP}#{window_panes}${SEP}#{window_width}`]);
    if (r.status !== 0) return null;
    const [attached, panes, width] = r.stdout.trim().split(SEP).map(Number);
    if (![attached, panes, width].every(Number.isFinite)) return null;
    return { attached, panes, width };
};

/** `now` is in ms, as `Date.now`; tmux reports client use in whole seconds. */
export const createPaneFitter = (run: TmuxRun, now: () => number = Date.now) => {
    const fits = new Map<string, Fit>();
    /** When the phone last used each session, in tmux's seconds. */
    const claims = new Map<string, number>();
    const seconds = (): number => Math.floor(now() / 1000);

    /** The phone used `session` just now: it is the latest user until a client is used after it. */
    const claim = (session: string): void => {
        claims.set(session, seconds());
    };

    /**
     * Give the window back: restore its width if nobody is attached, then drop
     * the manual size `resize-window` set, so the next client to attach sizes
     * it again. With a client attached, dropping the option alone resizes it to
     * that client.
     */
    const unfit = (session: string): void => {
        const fit = fits.get(session);
        if (!fit) return;
        fits.delete(session);
        const win = readWindow(run, fit.target);
        if (win && win.attached === 0) run(['resize-window', '-t', fit.target, '-x', String(fit.width)]);
        run(['set-option', '-w', '-u', '-t', fit.target, 'window-size']);
        run(['set-option', '-w', '-u', '-t', fit.target, FIT_MARK]);
    };

    /** The phone left: give the window back and forget its claim. */
    const release = (session: string): void => {
        claims.delete(session);
        unfit(session);
    };

    /**
     * Size `session`'s window to `cols` if it is unsplit and the phone used it
     * after every attached client. Safe to call on every renew: an unchanged
     * width costs one display-message (and one list-clients when attached), and
     * a window a client used since is handed back. The first call for a session
     * counts as the phone's use when nothing claimed it yet.
     */
    const fit = (session: string, target: string, cols: unknown): void => {
        const want = clampViewerCols(cols);
        if (want === null) return;
        const win = readWindow(run, target);
        if (!win) return;
        const held = fits.get(session);
        if (!claims.has(session)) claim(session);
        const clientUse = win.attached > 0 ? latestClientUse(run, target) : null;
        // A tie goes to the desktop: tmux counts in whole seconds, and shrinking a terminal in use is the worse mistake.
        const clientIsLatest = win.attached > 0 && (clientUse === null || clientUse >= (claims.get(session) ?? 0));
        if (clientIsLatest || win.panes !== 1) {
            // Only the fit goes: the claim stays, so the desktop keeps the window until the phone uses it again.
            if (held) unfit(session);
            return;
        }
        if (held && held.cols === want && win.width === want) return;
        const width = held?.width ?? win.width;
        // Mark first: a crash between the two must still be recoverable.
        run(['set-option', '-w', '-t', target, FIT_MARK, String(width)]);
        if (run(['resize-window', '-t', target, '-x', String(want)]).status !== 0) {
            if (!held) run(['set-option', '-w', '-u', '-t', target, FIT_MARK]);
            return;
        }
        fits.set(session, { target, width, cols: want });
    };

    return { fit, claim, release, fitted: (session: string): boolean => fits.has(session) };
};
