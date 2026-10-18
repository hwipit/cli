/**
 * `hwip <agent> --wt <name>`: a git worktree made for a session, and taken back
 * when the session is over and nothing in it would be lost.
 *
 * hwip only ever removes a worktree it made itself — the rows in
 * `<stateDir>/worktrees.json` are the whole list. A worktree the user made by
 * hand, or one `--wt` merely found at the path, has no row and no code path
 * here that removes it. Every doubt about a worktree (a git call that fails or
 * times out, a count that does not parse) reads as "keep it": the cost of a
 * leftover directory is a line in `hwip worktree`, the cost of a wrong removal
 * is somebody's work. `--force`, `rm -rf` and `branch -D` are not used anywhere.
 */

import { execFile } from 'child_process';
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join, sep } from 'path';
import { checkoutOf } from './config.js';
import { stateDir } from './gate.js';
import { handBackToSudoUser } from './private-files.js';
import { readTextIfExists, replaceFile } from './replace-file.js';

/** A git call's outcome: its stdout, or the first line of what it said when it failed. */
export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Runs `git <args>` (or tmux's); `timeoutMs` 0 means no timeout. Swappable in tests. */
export type GitRun = (args: string[], timeoutMs?: number) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 10_000;

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** `execFile` of one command with argv (no shell: branch names and paths are user input), as a `GitRun`. */
export const commandRunner = (cmd: string): GitRun => (args, timeoutMs = GIT_TIMEOUT_MS) =>
    new Promise((resolve) => {
        execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout, stderr) => {
            if (!err) return resolve({ ok: true, stdout });
            if ('code' in err && err.code === 'ENOENT') return resolve({ ok: false, error: `${cmd} not found` });
            const timedOut = 'killed' in err && err.killed;
            resolve({ ok: false, error: timedOut ? `${cmd} timed out` : firstLine(stderr) || err.message });
        });
    });

export const gitRun = commandRunner('git');
export const tmuxRun = commandRunner('tmux');

/** One worktree hwip made. The lifecycle fields are written by `reconcileWorktrees`. */
export interface WorktreeRow {
    /** realpath of the worktree directory. */
    path: string;
    /** The main checkout it hangs off — where `git worktree remove` runs from. */
    root: string;
    branch: string;
    /** HEAD when the worktree was made: commits after it are this worktree's own work. */
    baseSha: string;
    /** hwip made the branch too, so hwip may delete it (`branch -d`) with the worktree. */
    createdBranch: boolean;
    createdAt: string;
    /** Last time a pane was seen inside it. A worktree no session has used yet is not "over". */
    sessionSeenAt?: string;
    /** When it was judged not removable, and why — the automatic pass says so once. */
    keptAt?: string;
    reasons?: string[];
}

const registryPath = (): string => join(stateDir(), 'worktrees.json');

const isRow = (e: unknown): e is WorktreeRow => {
    if (!e || typeof e !== 'object') return false;
    const row = e as Record<string, unknown>; // shape-checked field by field below
    return ['path', 'root', 'branch', 'baseSha', 'createdAt'].every((k) => typeof row[k] === 'string')
        && typeof row.createdBranch === 'boolean'
        && (row.reasons === undefined || (Array.isArray(row.reasons) && row.reasons.every((r) => typeof r === 'string')));
};

/** Rows that still make sense: a half-written or hand-edited file must not stop a launch. */
const parseRows = (text: string | null): WorktreeRow[] => {
    if (!text) return [];
    try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.filter(isRow) : [];
    } catch {
        return [];
    }
};

export const readWorktreeRows = (): WorktreeRow[] => {
    try {
        return parseRows(readFileSync(registryPath(), 'utf-8'));
    } catch {
        return [];
    }
};

/**
 * Read, change, write. A row that cannot be written is a worktree that is not
 * cleaned up automatically — the launch goes on. `expected` turns a write by
 * the other process (wrapper vs listener) since the read into an error, which
 * lands here too: a lost row only ever means "kept".
 */
export const updateWorktreeRows = (change: (rows: WorktreeRow[]) => WorktreeRow[]): void => {
    const path = registryPath();
    try {
        const text = readTextIfExists(path);
        replaceFile(path, JSON.stringify(change(parseRows(text)), null, 2), text, 0o600);
        handBackToSudoUser(path);
    } catch {
        /* the registry is a convenience, not a gate */
    }
};

export type EnsureResult =
    | { ok: true; path: string; branch: string; created: boolean }
    | { ok: false; error: string; usage: boolean };

const refuse = (error: string, usage = false): EnsureResult => ({ ok: false, error, usage });

/** The worktrees `git worktree list --porcelain` knows: realpath → branch ref (null when detached). */
const listWorktrees = async (root: string, run: GitRun): Promise<Map<string, string | null> | null> => {
    const out = await run(['-C', root, 'worktree', 'list', '--porcelain']);
    if (!out.ok) return null;
    const found = new Map<string, string | null>();
    for (const block of out.stdout.split('\n\n')) {
        const lines = block.split('\n');
        const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
        if (!path) continue;
        found.set(path, lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null);
    }
    return found;
};

const realOrSelf = (path: string): string => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/**
 * The directory name of the worktree for branch `name` of the repo at `root`: `<repo>-wt-<name with separators as dashes>`.
 * Null when nothing but separators is left. `hwip schedule add` names its session from this, so the two cannot drift.
 */
export const worktreeDirName = (root: string, name: string): string | null => {
    const slug = name.replace(/[/.:;\s]+/g, '-');
    return slug.replace(/-/g, '') ? `${basename(root)}-wt-${slug}` : null;
};

/** Whether `name` is a branch name git accepts as it stands (`--branch` also expands `@{-1}`-style names; one that changes is not what was typed). */
export const isValidBranchName = async (root: string, name: string, run: GitRun = gitRun): Promise<boolean> => {
    const checked = await run(['-C', root, 'check-ref-format', '--branch', name]);
    return checked.ok && checked.stdout.trim() === name;
};

/**
 * The worktree for branch `name` next to the main checkout of the repo `dir` is
 * in — made, or found already made by this same command. Anything else at the
 * path is refused and left alone.
 */
export const ensureWorktree = async ({ dir, name }: { dir: string; name: string }, run: GitRun = gitRun): Promise<EnsureResult> => {
    const root = checkoutOf(dir)?.root;
    if (!root) return refuse('--wt needs a git checkout with a main worktree');
    if (!name || name.startsWith('-')) return refuse(`--wt needs a branch name (got '${name}')`, true);
    if (!(await isValidBranchName(root, name, run))) return refuse(`'${name}' is not a valid branch name`, true);
    const dirName = worktreeDirName(root, name);
    if (!dirName) return refuse(`'${name}' is not a usable worktree name`, true);
    const path = join(dirname(root), dirName);

    const known = await listWorktrees(root, run);
    if (!known) return refuse(`could not list worktrees of ${root}`);
    const there = [...known].find(([listed]) => realOrSelf(listed) === realOrSelf(path));
    const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    if (present && there?.[1] === `refs/heads/${name}`) return { ok: true, path: realOrSelf(path), branch: name, created: false };
    // Registered but gone, a plain directory, a file, a worktree of another branch: none of them is ours to touch.
    if (present || there) return refuse(`${path} exists and is not the worktree for ${name}`);

    const branchExists = (await run(['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`])).ok;
    // A new branch starts where the command was typed; one that exists is checked out as it is.
    const added = branchExists
        ? await run(['-C', root, 'worktree', 'add', path, name], 0)
        : await run(['-C', dir, 'worktree', 'add', '-b', name, path], 0);
    if (!added.ok) return refuse(added.error);

    const made = realOrSelf(path);
    const head = await run(['-C', made, 'rev-parse', 'HEAD']);
    if (head.ok) {
        const row: WorktreeRow = {
            path: made, root, branch: name, baseSha: head.stdout.trim(),
            createdBranch: !branchExists, createdAt: new Date().toISOString(),
        };
        updateWorktreeRows((rows) => [...rows.filter((r) => r.path !== made), row]);
    }
    return { ok: true, path: made, branch: name, created: true };
};

export type Inspection = { removable: true } | { removable: false; reasons: string[] };

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Whether this worktree can go without losing anything. Asked in git's own
 * terms rather than left to `git worktree remove`, which deletes a worktree
 * holding only ignored files (a hand-written `.env`) and one whose commits
 * were never pushed (measured, git 2.47.0). Both checks always run, so the
 * reasons are the whole list; a check that cannot be answered is a reason too.
 */
export const inspectWorktree = async (row: WorktreeRow, run: GitRun = gitRun): Promise<Inspection> => {
    const reasons: string[] = [];
    // A row ties a worktree to its path only. If the user removed this one and made their own at the same path, it is theirs.
    const known = await listWorktrees(row.root, run);
    const listed = known ? [...known].find(([path]) => realOrSelf(path) === realOrSelf(row.path)) : undefined;
    if (!known) reasons.push('could not check: worktrees not listed');
    else if (!listed) reasons.push('not a worktree git knows any more');
    else if (listed[1] !== `refs/heads/${row.branch}`) reasons.push(`no longer on branch ${row.branch}`);
    // Explicit, because `status.showUntrackedFiles=no` and `diff.ignoreSubmodules` would otherwise hide what `worktree remove` deletes.
    const status = await run(['-C', row.path, 'status', '--porcelain', '--ignored', '--untracked-files=normal', '--ignore-submodules=none']);
    if (!status.ok) {
        reasons.push(`could not check: ${status.error}`);
    } else {
        const lines = status.stdout.split('\n').filter(Boolean);
        const ignored = lines.filter((l) => l.startsWith('!!')).length;
        if (lines.length > ignored) reasons.push(`${lines.length - ignored} uncommitted or untracked`);
        if (ignored) reasons.push(`${ignored} ignored`);
    }
    // Not `--all`: that includes this worktree's own HEAD and always counts it.
    const ahead = await run(['-C', row.path, 'rev-list', '--count', 'HEAD', '--not', row.baseSha, '--remotes']);
    const count = ahead.ok ? Number(ahead.stdout.trim()) : NaN;
    if (!ahead.ok) reasons.push(`could not check: ${ahead.error}`);
    else if (!Number.isInteger(count)) reasons.push('could not check: unreadable commit count');
    else if (count > 0) reasons.push(`${plural(count, 'unpushed commit')}`);
    const distinct = [...new Set(reasons)];
    return distinct.length ? { removable: false, reasons: distinct } : { removable: true };
};

export interface ReconcileInput {
    /** `pane_current_path` of every live tmux pane. The caller must have read them all: an empty list means "none". */
    paneCwds: string[];
    /** `hwip worktree clean`: judge every worktree not in use, not only the ones a session has just left. */
    manual?: boolean;
    /** Judge and report, change nothing (disk and registry alike). */
    dryRun?: boolean;
    now?: Date;
}

export interface ReconcileReport {
    /** Gone (or, under `dryRun`, would be). */
    removed: Array<{ path: string; branch: string; branchDeleted: boolean }>;
    kept: Array<{ path: string; branch: string; reasons: string[]; removeFailed: boolean }>;
    inUse: string[];
    /** Rows whose directory is no longer there — the user removed it. */
    gone: string[];
}

const within = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(path + sep);

/**
 * Which of the worktrees hwip made to take back, and which to keep and say why.
 *
 * Automatic (`manual` off): a worktree is judged once, after a pane was last
 * seen inside it and none is now. Judging again later would delete a directory
 * somebody went back into and pushed from, so a worktree that was kept stays
 * kept until `hwip worktree clean`, or until a session uses it again.
 *
 * Rows are re-read when written, so a row the wrapper added while git was
 * being asked about is not lost.
 */
export const reconcileWorktrees = async (input: ReconcileInput, run: GitRun = gitRun): Promise<ReconcileReport> => {
    const { manual = false, dryRun = false } = input;
    const now = (input.now ?? new Date()).toISOString();
    const panes = input.paneCwds.map(realOrSelf);
    const report: ReconcileReport = { removed: [], kept: [], inUse: [], gone: [] };
    const drop = new Set<string>();
    const patch = new Map<string, Partial<WorktreeRow>>();

    for (const row of readWorktreeRows()) {
        if (lstatSync(row.path, { throwIfNoEntry: false }) === undefined) {
            report.gone.push(row.path);
            drop.add(row.path);
            continue;
        }
        if (panes.some((cwd) => within(cwd, row.path))) {
            report.inUse.push(row.path);
            patch.set(row.path, { sessionSeenAt: now, keptAt: undefined, reasons: undefined });
            continue;
        }
        if (!manual && (!row.sessionSeenAt || row.keptAt)) continue;

        const verdict = await inspectWorktree(row, run);
        if (!verdict.removable) {
            report.kept.push({ path: row.path, branch: row.branch, reasons: verdict.reasons, removeFailed: false });
            if (!manual) patch.set(row.path, { keptAt: now, reasons: verdict.reasons });
            continue;
        }
        if (dryRun) {
            report.removed.push({ path: row.path, branch: row.branch, branchDeleted: false });
            continue;
        }
        // No `--force`: git refuses a worktree that gained a change since the check.
        const removed = await run(['-C', row.root, 'worktree', 'remove', row.path]);
        if (!removed.ok) {
            report.kept.push({ path: row.path, branch: row.branch, reasons: [removed.error], removeFailed: true });
            if (!manual) patch.set(row.path, { keptAt: now, reasons: [removed.error] });
            continue;
        }
        // `-d`, never `-D`: git refuses a branch that is not merged, and that branch stays.
        const branchDeleted = row.createdBranch && (await run(['-C', row.root, 'branch', '-d', row.branch])).ok;
        report.removed.push({ path: row.path, branch: row.branch, branchDeleted });
        drop.add(row.path);
    }

    if (!dryRun && (drop.size || patch.size)) {
        updateWorktreeRows((rows) => rows
            .filter((r) => !drop.has(r.path))
            .map((r) => (patch.has(r.path) ? { ...r, ...patch.get(r.path) } : r)));
    }
    return report;
};

export interface WorktreeStatus {
    row: WorktreeRow;
    /** `in use`, `never used` (clean, and no session ever started in it), `clean`, or what keeps it. */
    state: string;
}

/** What `hwip worktree` shows: every row with its state now. Read-only. */
export const worktreeStatuses = async (paneCwds: string[], run: GitRun = gitRun): Promise<WorktreeStatus[]> => {
    const panes = paneCwds.map(realOrSelf);
    return Promise.all(readWorktreeRows().map(async (row): Promise<WorktreeStatus> => {
        if (lstatSync(row.path, { throwIfNoEntry: false }) === undefined) return { row, state: 'directory gone' };
        if (panes.some((cwd) => within(cwd, row.path))) return { row, state: 'in use' };
        const verdict = await inspectWorktree(row, run);
        if (!verdict.removable) return { row, state: verdict.reasons.join(', ') };
        return { row, state: row.sessionSeenAt ? 'clean' : 'never used' };
    }));
};

// Measured on tmux 3.5a: a server that is not there says `no server running on <socket>` (stale socket file) or
// `error connecting to <socket> (No such file or directory)`; `(Permission denied)` and the rest are not "no panes".
const NO_TMUX_SERVER = /^(no server running on |error connecting to .+ \(No such file or directory\)$)/;

/**
 * The cwd of every live tmux pane, `[]` when there is no tmux server, null when
 * tmux could not be asked. The difference matters: an unreadable list read as
 * empty would make every worktree in use look abandoned.
 */
export const readPaneCwds = async (tmux: GitRun = tmuxRun): Promise<string[] | null> => {
    const out = await tmux(['list-panes', '-a', '-F', '#{pane_current_path}']);
    if (out.ok) return out.stdout.split('\n').filter(Boolean);
    return NO_TMUX_SERVER.test(out.error) ? [] : null;
};
