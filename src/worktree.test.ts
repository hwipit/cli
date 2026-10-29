import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sleep } from './listener-process.js';
import { withTmpStateDir } from './test-state-dir.js';
import { targetForAgent } from './wrapper.js';
import { commandRunner, ensureWorktree, inspectWorktree, readPaneCwds, readWorktreeRows, reconcileWorktrees, worktreeStatuses, type GitRun, type WorktreeRow } from './worktree.js';

const stateDirOf = withTmpStateDir('hwip-wt-state-');
const gitRunReal = commandRunner('git');
const tmuxInstalled = (): boolean => {
    try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

// Real repos: what git does to a worktree is the whole question, and a stub would only restate our assumption.
const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('ensureWorktree', () => {
    let tmp: string;
    let main: string;

    beforeEach(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-wt-repo-')));
        main = join(tmp, 'app');
        execFileSync('git', ['init', '-q', main]);
        git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    });

    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    it('makes a sibling worktree on a new branch from HEAD and records it', async () => {
        const out = await ensureWorktree({ dir: main, name: 'feat/x' });
        expect(out).toEqual({ ok: true, path: join(tmp, 'app-wt-feat-x'), branch: 'feat/x', created: true });
        expect(git(join(tmp, 'app-wt-feat-x'), 'branch', '--show-current').trim()).toBe('feat/x');
        const [row] = readWorktreeRows();
        expect(row).toMatchObject({
            path: join(tmp, 'app-wt-feat-x'), root: main, branch: 'feat/x', createdBranch: true,
            baseSha: git(main, 'rev-parse', 'HEAD').trim(),
        });
    });

    it('uses an existing branch as it is and does not claim it', async () => {
        git(main, 'branch', 'feat/old');
        const out = await ensureWorktree({ dir: main, name: 'feat/old' });
        expect(out).toMatchObject({ ok: true, created: true });
        expect(readWorktreeRows()[0]?.createdBranch).toBe(false);
    });

    it('reuses the worktree it made, without a second row', async () => {
        await ensureWorktree({ dir: main, name: 'feat/x' });
        const again = await ensureWorktree({ dir: main, name: 'feat/x' });
        expect(again).toEqual({ ok: true, path: join(tmp, 'app-wt-feat-x'), branch: 'feat/x', created: false });
        expect(readWorktreeRows()).toHaveLength(1);
    });

    it('makes the worktree next to the main checkout when typed inside another worktree', async () => {
        const first = await ensureWorktree({ dir: main, name: 'a' });
        if (!first.ok) throw new Error(first.error);
        const second = await ensureWorktree({ dir: first.path, name: 'b' });
        expect(second).toMatchObject({ ok: true, path: join(tmp, 'app-wt-b') });
    });

    // The phone groups by these two options; no server or app change is involved.
    it('a/b: the session is named for the directory and groups under the repo as wt-a-b', async () => {
        const out = await ensureWorktree({ dir: main, name: 'a/b' });
        if (!out.ok) throw new Error(out.error);
        const { session, args } = targetForAgent('claude', [], 'claude', { detach: true, projectDir: out.path });
        expect(session).toMatch(/^hwip-app-wt-a-b(-\d+)?$/);
        expect(args.slice(4, 6)).toEqual(['-c', out.path]);
        expect(args[args.indexOf('@hwip_project') + 1]).toBe('app');
        expect(args[args.indexOf('@hwip_session_label') + 1]).toBe('wt-a-b');
    });

    it('turns a / . : ; or space in the name into one -', async () => {
        const out = await ensureWorktree({ dir: main, name: 'a/b.c' });
        expect(out).toMatchObject({ ok: true, path: join(tmp, 'app-wt-a-b-c'), branch: 'a/b.c' });
    });

    it.each(['', '-x', 'a..b', 'a b', '@{-1}', 'x.lock', '--help'])('refuses %j as a usage error and makes nothing', async (name) => {
        const out = await ensureWorktree({ dir: main, name });
        expect(out).toMatchObject({ ok: false, usage: true });
        expect(git(main, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
        expect(readWorktreeRows()).toEqual([]);
    });

    it('refuses outside git', async () => {
        const out = await ensureWorktree({ dir: tmp, name: 'x' });
        expect(out).toEqual({ ok: false, usage: false, error: '--wt needs a git checkout with a main worktree' });
    });

    it('refuses a bare layout', async () => {
        const bare = join(tmp, 'repo.git');
        const bareWt = join(tmp, 'bare-wt');
        execFileSync('git', ['clone', '-q', '--bare', main, bare]);
        git(bare, 'worktree', 'add', '-q', bareWt, '-b', 'feat/z');
        expect(await ensureWorktree({ dir: bareWt, name: 'x' })).toMatchObject({ ok: false, usage: false });
        expect(existsSync(join(tmp, 'bare-wt-wt-x'))).toBe(false);
    });

    it('leaves a plain directory at the path alone', async () => {
        const dir = join(tmp, 'app-wt-x');
        mkdirSync(dir);
        writeFileSync(join(dir, 'mine.txt'), 'keep');
        const out = await ensureWorktree({ dir: main, name: 'x' });
        expect(out).toMatchObject({ ok: false, usage: false, error: expect.stringContaining('is not the worktree for x') });
        expect(existsSync(join(dir, 'mine.txt'))).toBe(true);
        expect(readWorktreeRows()).toEqual([]);
    });

    it('leaves a worktree of another branch at the path alone', async () => {
        git(main, 'worktree', 'add', '-q', join(tmp, 'app-wt-x'), '-b', 'other');
        const out = await ensureWorktree({ dir: main, name: 'x' });
        expect(out).toMatchObject({ ok: false, error: expect.stringContaining('is not the worktree for x') });
        expect(git(join(tmp, 'app-wt-x'), 'branch', '--show-current').trim()).toBe('other');
        expect(readWorktreeRows()).toEqual([]);
    });

    it('reports git\'s first line when git refuses (branch checked out elsewhere)', async () => {
        git(main, 'checkout', '-q', '-b', 'taken');
        const out = await ensureWorktree({ dir: main, name: 'taken' });
        expect(out).toMatchObject({ ok: false, usage: false, error: expect.stringContaining('taken') });
        expect(existsSync(join(tmp, 'app-wt-taken'))).toBe(false);
    });

    it('a registry it cannot write does not stop the worktree', async () => {
        // A directory where the file should be: every write fails.
        mkdirSync(join(stateDirOf(), 'hwip', 'worktrees.json'), { recursive: true });
        const out = await ensureWorktree({ dir: main, name: 'x' });
        expect(out).toMatchObject({ ok: true, created: true });
    });
});

// The safety line. Each case is a way to lose work that `git worktree remove` alone would allow or miss.
describe('inspectWorktree / reconcileWorktrees', () => {
    let tmp: string;
    let main: string;
    let remote: string;

    beforeEach(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-wt-rec-')));
        main = join(tmp, 'app');
        remote = join(tmp, 'origin.git');
        execFileSync('git', ['init', '-q', main]);
        writeFileSync(join(main, '.gitignore'), '*.env\n');
        git(main, 'add', '.gitignore');
        git(main, 'commit', '-q', '-m', 'init');
        execFileSync('git', ['init', '-q', '--bare', remote]);
        git(main, 'remote', 'add', 'origin', remote);
    });

    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    const made = async (name: string): Promise<WorktreeRow> => {
        const out = await ensureWorktree({ dir: main, name });
        if (!out.ok) throw new Error(out.error);
        const row = readWorktreeRows().find((r) => r.path === out.path);
        if (!row) throw new Error('no row');
        return row;
    };
    const failing = (error: string): GitRun => async () => ({ ok: false, error });

    describe('inspectWorktree', () => {
        it('a fresh worktree is removable', async () => {
            expect(await inspectWorktree(await made('a'))).toEqual({ removable: true });
        });

        it('a changed tracked file and an untracked file each keep it', async () => {
            const a = await made('a');
            writeFileSync(join(a.path, '.gitignore'), 'changed\n');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['1 uncommitted or untracked'] });
            writeFileSync(join(a.path, 'new.txt'), 'x');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['2 uncommitted or untracked'] });
        });

        // git removes this worktree without a word (measured), taking the .env with it.
        it('ignored files alone keep it', async () => {
            const a = await made('a');
            writeFileSync(join(a.path, 'secrets.env'), 'TOKEN=1');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['1 ignored'] });
        });

        // git removes this one too, and the branch is the only place the commit lives.
        it('a commit nobody has pushed keeps it; pushed, it does not', async () => {
            const a = await made('a');
            git(a.path, 'commit', '-q', '--allow-empty', '-m', 'work');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['1 unpushed commit'] });
            git(a.path, 'commit', '-q', '--allow-empty', '-m', 'more');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['2 unpushed commits'] });
            git(a.path, 'push', '-q', 'origin', 'a');
            expect(await inspectWorktree(a)).toEqual({ removable: true });
        });

        it('commits already on main before the worktree was made are not its own', async () => {
            git(main, 'commit', '-q', '--allow-empty', '-m', 'local main work');
            expect(await inspectWorktree(await made('a'))).toEqual({ removable: true });
        });

        it('lists every reason', async () => {
            const a = await made('a');
            writeFileSync(join(a.path, 'new.txt'), 'x');
            writeFileSync(join(a.path, 'secrets.env'), 'x');
            git(a.path, 'commit', '-q', '--allow-empty', '-m', 'work');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['1 uncommitted or untracked', '1 ignored', '1 unpushed commit'] });
        });

        // `status.showUntrackedFiles=no` makes a bare `git status` print nothing for a directory `worktree remove` then deletes.
        it('is not fooled by a user config that hides untracked files from git status', async () => {
            const a = await made('a');
            git(main, 'config', 'status.showUntrackedFiles', 'no');
            writeFileSync(join(a.path, 'new.txt'), 'x');
            writeFileSync(join(a.path, 'secrets.env'), 'x');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['1 uncommitted or untracked', '1 ignored'] });
        });

        it('keeps a worktree somebody else made at the path of one that was removed by hand', async () => {
            const a = await made('a');
            git(main, 'worktree', 'remove', a.path);
            git(main, 'worktree', 'add', '-q', a.path, '-b', 'theirs');
            expect(await inspectWorktree(a)).toEqual({ removable: false, reasons: ['no longer on branch a'] });
            const report = await reconcileWorktrees({ paneCwds: [], manual: true });
            expect(report.removed).toEqual([]);
            expect(existsSync(a.path)).toBe(true);
            expect(git(a.path, 'branch', '--show-current').trim()).toBe('theirs');
        });

        it('keeps it when git cannot answer, or answers with something that is not a count', async () => {
            const a = await made('a');
            expect(await inspectWorktree(a, failing('git timed out'))).toEqual({
                removable: false, reasons: ['could not check: worktrees not listed', 'could not check: git timed out'],
            });
            const garbled: GitRun = async (args) => (args.includes('rev-list') ? { ok: true, stdout: 'lots\n' } : gitRunReal(args));
            expect(await inspectWorktree(a, garbled)).toEqual({ removable: false, reasons: ['could not check: unreadable commit count'] });
        });
    });

    describe('reconcileWorktrees', () => {
        const NOW = new Date('2026-10-09T01:00:00Z');

        it('never touches a worktree it has no row for', async () => {
            const byHand = join(tmp, 'app-wt-hand');
            git(main, 'worktree', 'add', '-q', byHand, '-b', 'hand');
            const report = await reconcileWorktrees({ paneCwds: [], manual: true });
            expect(report).toEqual({ removed: [], kept: [], inUse: [], gone: [] });
            expect(existsSync(byHand)).toBe(true);
        });

        it('does not judge a worktree no session has been seen in', async () => {
            const a = await made('a');
            const calls: string[][] = [];
            const spy: GitRun = async (args) => { calls.push(args); return { ok: true, stdout: '' }; };
            expect(await reconcileWorktrees({ paneCwds: [] }, spy)).toEqual({ removed: [], kept: [], inUse: [], gone: [] });
            expect(calls).toEqual([]);
            expect(existsSync(a.path)).toBe(true);
        });

        it('a pane in it, or in a folder under it, is in use; a sibling with the same prefix is not', async () => {
            const a = await made('a');
            const ab = await made('ab');
            mkdirSync(join(a.path, 'src'));
            const report = await reconcileWorktrees({ paneCwds: [join(a.path, 'src')], now: NOW });
            expect(report.inUse).toEqual([a.path]);
            expect(readWorktreeRows().find((r) => r.path === a.path)?.sessionSeenAt).toBe(NOW.toISOString());
            expect(readWorktreeRows().find((r) => r.path === ab.path)?.sessionSeenAt).toBeUndefined();
        });

        it('takes back a clean worktree once its session is over, and the branch hwip made', async () => {
            const a = await made('a');
            await reconcileWorktrees({ paneCwds: [a.path] });
            const report = await reconcileWorktrees({ paneCwds: [] });
            expect(report.removed).toEqual([{ path: a.path, branch: 'a', branchDeleted: true }]);
            expect(existsSync(a.path)).toBe(false);
            expect(git(main, 'branch', '--list', 'a').trim()).toBe('');
            expect(readWorktreeRows()).toEqual([]);
        });

        it('leaves a branch it did not make', async () => {
            git(main, 'branch', 'old');
            const a = await made('old');
            await reconcileWorktrees({ paneCwds: [a.path] });
            const report = await reconcileWorktrees({ paneCwds: [] });
            expect(report.removed).toEqual([{ path: a.path, branch: 'old', branchDeleted: false }]);
            expect(git(main, 'branch', '--list', 'old').trim()).toBe('old');
        });

        it('leaves a branch git says is not merged', async () => {
            const a = await made('a');
            await reconcileWorktrees({ paneCwds: [a.path] });
            git(a.path, 'commit', '-q', '--allow-empty', '-m', 'work');
            git(a.path, 'push', '-q', 'origin', 'a');
            const report = await reconcileWorktrees({ paneCwds: [] });
            expect(report.removed).toEqual([{ path: a.path, branch: 'a', branchDeleted: false }]);
            expect(git(main, 'branch', '--list', 'a').trim()).toContain('a');
        });

        it.each([
            ['an uncommitted change', (p: string) => writeFileSync(join(p, '.gitignore'), 'x\n')],
            ['an untracked file', (p: string) => writeFileSync(join(p, 'new.txt'), 'x')],
            ['an ignored file', (p: string) => writeFileSync(join(p, 'secrets.env'), 'x')],
            ['an unpushed commit', (p: string) => git(p, 'commit', '-q', '--allow-empty', '-m', 'w')],
        ])('keeps a worktree with %s, says so once, and keeps it kept', async (_what, dirty) => {
            const a = await made('a');
            await reconcileWorktrees({ paneCwds: [a.path] });
            dirty(a.path);
            const first = await reconcileWorktrees({ paneCwds: [], now: NOW });
            expect(first.kept).toHaveLength(1);
            expect(first.kept[0]).toMatchObject({ path: a.path, removeFailed: false });
            expect(existsSync(a.path)).toBe(true);
            expect(readWorktreeRows()[0]).toMatchObject({ keptAt: NOW.toISOString(), reasons: first.kept[0]?.reasons });
            // Said once: the next pass does not look again, even if it is clean by now.
            expect((await reconcileWorktrees({ paneCwds: [] })).kept).toEqual([]);
            // A session using it again is the one thing that re-arms it.
            await reconcileWorktrees({ paneCwds: [a.path] });
            expect(readWorktreeRows()[0]?.keptAt).toBeUndefined();
            expect((await reconcileWorktrees({ paneCwds: [] })).kept).toHaveLength(1);
        });

        it('`manual` judges a kept or never-used worktree and removes what is clean now', async () => {
            const a = await made('a');
            const b = await made('b');
            writeFileSync(join(b.path, 'new.txt'), 'x');
            const report = await reconcileWorktrees({ paneCwds: [], manual: true });
            expect(report.removed.map((r) => r.path)).toEqual([a.path]);
            expect(report.kept.map((k) => k.path)).toEqual([b.path]);
            expect(existsSync(b.path)).toBe(true);
            // A manual pass does not mark anything as announced.
            expect(readWorktreeRows()[0]?.keptAt).toBeUndefined();
        });

        it('`dryRun` removes and records nothing', async () => {
            const a = await made('a');
            const before = JSON.stringify(readWorktreeRows());
            const report = await reconcileWorktrees({ paneCwds: [a.path], manual: true, dryRun: true });
            expect(report.inUse).toEqual([a.path]);
            const later = await reconcileWorktrees({ paneCwds: [], manual: true, dryRun: true });
            expect(later.removed).toEqual([{ path: a.path, branch: 'a', branchDeleted: false }]);
            expect(existsSync(a.path)).toBe(true);
            expect(JSON.stringify(readWorktreeRows())).toBe(before);
        });

        it('keeps it, and says why, when git refuses the removal after the check passed', async () => {
            const a = await made('a');
            const refusing: GitRun = async (args) => (args.includes('remove')
                ? { ok: false, error: "fatal: '" + a.path + "' contains modified or untracked files" }
                : gitRunReal(args));
            const report = await reconcileWorktrees({ paneCwds: [], manual: true }, refusing);
            expect(report.kept).toEqual([{ path: a.path, branch: 'a', reasons: [expect.stringContaining('contains modified')], removeFailed: true }]);
            expect(report.removed).toEqual([]);
            expect(existsSync(a.path)).toBe(true);
            expect(readWorktreeRows()).toHaveLength(1);
        });

        it('judges nothing it cannot ask git about', async () => {
            const a = await made('a');
            const report = await reconcileWorktrees({ paneCwds: [], manual: true }, failing('git timed out'));
            expect(report.removed).toEqual([]);
            expect(report.kept[0]?.reasons).toContain('could not check: git timed out');
            expect(existsSync(a.path)).toBe(true);
        });

        it('forgets a row whose directory the user removed', async () => {
            const a = await made('a');
            git(main, 'worktree', 'remove', a.path);
            const report = await reconcileWorktrees({ paneCwds: [] });
            expect(report.gone).toEqual([a.path]);
            expect(readWorktreeRows()).toEqual([]);
        });

        it('keeps a row the wrapper wrote while the passes were asking git', async () => {
            const a = await made('a');
            await reconcileWorktrees({ paneCwds: [a.path] });
            let added = false;
            const racing: GitRun = async (args) => {
                if (!added) {
                    added = true;
                    const b = await made('b');
                    expect(b.branch).toBe('b');
                }
                return gitRunReal(args);
            };
            await reconcileWorktrees({ paneCwds: [] }, racing);
            expect(readWorktreeRows().map((r) => r.branch)).toEqual(['b']);
        });
    });

    describe('worktreeStatuses', () => {
        it('names each state without changing anything', async () => {
            const used = await made('used');
            const never = await made('never');
            const dirty = await made('dirty');
            writeFileSync(join(dirty.path, 'x.txt'), 'x');
            await reconcileWorktrees({ paneCwds: [used.path] });
            const before = JSON.stringify(readWorktreeRows());
            const states = Object.fromEntries((await worktreeStatuses([used.path])).map((s) => [s.row.branch, s.state]));
            expect(states).toEqual({ used: 'in use', never: 'never used', dirty: '1 uncommitted or untracked' });
            expect((await worktreeStatuses([])).find((s) => s.row.branch === 'used')?.state).toBe('clean');
            expect(JSON.stringify(readWorktreeRows())).toBe(before);
            void never;
        });
    });
});

describe('readPaneCwds', () => {
    const says = (error: string): GitRun => async () => ({ ok: false, error });

    it('is the cwd of every pane', async () => {
        expect(await readPaneCwds(async () => ({ ok: true, stdout: '\t/a\n\t/b\n' }))).toEqual(['/a', '/b']);
    });

    // The tmux 3.6 case `readPaneCwds` documents: the current path is still the server's cwd.
    it('counts a pane by where it started while its current path is not yet its own', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-pane-'));
        try {
            const tmux: GitRun = async () => ({ ok: true, stdout: `${dir}\t/home/runner/work/cli/cli\n` });
            expect(await readPaneCwds(tmux)).toEqual([realpathSync(dir), '/home/runner/work/cli/cli']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // tmux 3.5a's own words, measured: a server that is not there has no panes.
    it.each([
        'no server running on /private/tmp/tmux-501/default',
        'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    ])('reads %j as no panes', async (error) => {
        expect(await readPaneCwds(says(error))).toEqual([]);
    });

    // Not knowing is not the same as none: read as none, every live session's worktree would look abandoned.
    it.each([
        'error connecting to /private/tmp/tmux-501/default (Permission denied)',
        'tmux timed out',
        'tmux not found',
        'something else entirely',
    ])('reads %j as not knowing', async (error) => {
        expect(await readPaneCwds(says(error))).toBeNull();
    });

    // The fixtures above are what tmux said when this was written; this asks the tmux that is installed.
    it.skipIf(!tmuxInstalled())('agrees with the installed tmux about a socket nothing listens on', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-tmux-'));
        try {
            const tmux: GitRun = (args) => commandRunner('tmux')(['-S', join(dir, 'sock'), ...args]);
            expect(await readPaneCwds(tmux)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// The whole path against a tmux server of its own (a socket in a temp dir, never the user's): a session in the
// worktree keeps it, and the end of that session is what lets the next pass take it back.
describe.skipIf(!tmuxInstalled())('a session in a worktree (real tmux)', () => {
    let tmp: string;
    let sock: string;
    const tmux: GitRun = (args) => commandRunner('tmux')(['-S', sock, ...args]);

    // `kill-server` returns while the server is still closing its socket. Asked in that window tmux says
    // `server exited unexpectedly`, which `readPaneCwds` reads as "could not ask" (null) and not "no server" ([]) -
    // the right call for a pane list that must not be taken for empty. So wait for the plain answer, bounded.
    const untilNoServer = async () => {
        for (let i = 0; i < 100; i++) {
            const asked = await tmux(['has-session']);
            if (!asked.ok && asked.error.startsWith('no server running on ')) return;
            await sleep(20);
        }
        throw new Error('the tmux server did not go away after kill-server');
    };

    beforeEach(() => {
        tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-wt-tmux-')));
        sock = join(tmp, 'sock');
        execFileSync('git', ['init', '-q', join(tmp, 'app')]);
        git(join(tmp, 'app'), 'commit', '-q', '--allow-empty', '-m', 'init');
    });

    afterEach(() => {
        try {
            execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' });
        } catch { /* already gone */ }
        rmSync(tmp, { recursive: true, force: true });
    });

    it('is in use while the session runs and taken back after it ends', async () => {
        const made = await ensureWorktree({ dir: join(tmp, 'app'), name: 'feat/x' });
        if (!made.ok) throw new Error(made.error);
        execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'hwip-app-wt-feat-x', '-c', made.path, 'sleep 60']);

        const during = await readPaneCwds(tmux);
        expect(during).toContain(made.path);
        expect((await reconcileWorktrees({ paneCwds: during ?? [] })).inUse).toEqual([made.path]);

        execFileSync('tmux', ['-S', sock, 'kill-server']);
        await untilNoServer();
        const after = await readPaneCwds(tmux);
        expect(after).toEqual([]);
        expect((await reconcileWorktrees({ paneCwds: after ?? [] })).removed.map((r) => r.path)).toEqual([made.path]);
        expect(existsSync(made.path)).toBe(false);
    });
});

