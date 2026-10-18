/**
 * The listener's side of `--wt`: when a session has ended, take back the
 * worktree it ran in if nothing in it would be lost, and say so when something
 * would (`worktree.ts` holds the judgement; this holds the timing).
 *
 * A pass runs when the set of session names changed since the last one — a
 * session ending is a name leaving — and once at startup, for sessions that
 * ended while no listener ran. An unchanged inventory costs nothing: no tmux,
 * no git, and with no worktree on record not even a call for the panes.
 */

import { basename } from 'path';
import type { DesktopNotification } from './desktop-notify.js';
import { readPaneCwds, readWorktreeRows, reconcileWorktrees, type GitRun } from './worktree.js';

export interface WorktreeCleanupDeps {
    log: (message: string) => void;
    /** The desktop banner. A rejection is logged, never thrown. */
    notify: (note: DesktopNotification) => Promise<unknown>;
    /** tmux as the listener talks to it (its socket, async, with a timeout). */
    tmux: GitRun;
    /** Swappable in tests. */
    hasRows?: () => boolean;
    readPanes?: typeof readPaneCwds;
    reconcile?: typeof reconcileWorktrees;
}

export const createWorktreeCleanup = (deps: WorktreeCleanupDeps): { observe: (sessionNames: readonly string[]) => void } => {
    const { log, notify, tmux } = deps;
    const hasRows = deps.hasRows ?? ((): boolean => readWorktreeRows().length > 0);
    const readPanes = deps.readPanes ?? readPaneCwds;
    const reconcile = deps.reconcile ?? reconcileWorktrees;
    let lastNames: string | null = null;
    let inFlight = false;

    const pass = async (): Promise<void> => {
        if (!hasRows()) return;
        const panes = await readPanes(tmux);
        // An unreadable list read as an empty one would make every live session's worktree look abandoned.
        // Not retried until the names change again: retrying each 5 s sweep would log the same failure all day.
        // The worktree stays, and `hwip worktree clean` takes it later.
        if (!panes) {
            log('! worktree cleanup skipped: could not read the tmux panes');
            return;
        }
        const report = await reconcile({ paneCwds: panes });
        for (const r of report.removed) log(`worktree removed: ${r.path}${r.branchDeleted ? ` (branch ${r.branch} deleted)` : ''}`);
        for (const path of report.gone) log(`worktree forgotten, its directory is gone: ${path}`);
        for (const k of report.kept) {
            const why = k.reasons.join(', ');
            log(`worktree kept: ${k.path} — ${why}`);
            void notify({ title: 'Hwip · worktree kept', body: `${basename(k.path)} — ${why}`, reveal: k.path })
                .catch((err: unknown) => log(`! banner failed — ${err instanceof Error ? err.message : String(err)}`));
        }
    };

    return {
        observe: (sessionNames) => {
            const names = [...sessionNames].sort().join('\n');
            if (names === lastNames) return;
            // One pass at a time. The names are not recorded for a pass that did not start, so the next publish asks again.
            if (inFlight) return;
            lastNames = names;
            inFlight = true;
            void pass()
                .catch((err: unknown) => log(`! worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`))
                .finally(() => { inFlight = false; });
        },
    };
};
