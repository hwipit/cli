/**
 * Reading what a session changed in its repository: the one place git is run
 * for the phone's diff review.
 *
 * The arguments are constant. The only values that reach git are an object id
 * this module read back from git and checked (`OBJECT_ID`), a ref name git
 * printed that matched `REMOTE_REF` (it only ever goes to `rev-parse`), and one
 * caller path passed after `--` (with `--literal-pathspecs`, so it can only
 * name itself). Nothing here knows about sealing, trust or the wire — the
 * listener decides who may ask; this decides what git is asked.
 *
 * The repository's own configuration is not constant, and git can run commands
 * it names. What this module switches off: `core.fsmonitor` (on every run),
 * external diff drivers, textconv filters and the nesting of submodules (flags
 * on the patch commands), the lazy fetch of a partial clone
 * (`GIT_NO_LAZY_FETCH`), the listener's own `GIT_DIR` and the like (not passed
 * on), and the `clean` / `process` side of every `filter.<name>` the config
 * defines. That last one is a limit, not a guarantee: the names are listed by
 * one git run and used by the next, so a config changed in between can still
 * run a filter. A file a `filter=` attribute names (in the working tree's attributes
 * or the base revision's) is therefore not diffed at all (it is listed like a binary
 * file): without its filter the working tree would read as plaintext added lines. A
 * patch is asked for one file, never a directory. The README lists what is not closed.
 */

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { lstatSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { maskSecrets } from './secret-mask.js';

/** Which two trees a diff compares: HEAD against the working tree, or the point
 *  this branch left the repo's default branch against the working tree. */
export type DiffBase = 'head' | 'default';

export type DiffFailure = 'git_failed' | 'too_large' | 'no_default_branch' | 'bad_path' | 'bad_range';

export type DiffResult<T> = ({ ok: true } & T) | { ok: false; error: DiffFailure };

export interface DiffFileEntry {
    path: string;
    /** `M` modified (type changes included) · `A` added · `D` deleted · `?` untracked. */
    status: 'M' | 'A' | 'D' | '?';
    added: number;
    removed: number;
    binary?: true;
}

/** One page of a patch is at most this many bytes; the listener narrows it when
 *  the sealed frame would not fit. */
export const DIFF_PAGE_MAX_BYTES = 16 * 1024;
/** Most changed files worth listing. A tree past this is not something anyone
 *  reviews on a phone; `truncated` says so instead of the list pretending. */
export const DIFF_MAX_FILES = 200;
/** A git that runs longer than this is hung, not slow: the listener's event loop
 *  waits on it (spawnSync). */
const GIT_TIMEOUT_MS = 10_000;
/** The largest output read from one git run. Node's default is 1 MiB and a
 *  lockfile patch passes it; past this the answer is "too large", not a cut. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** An untracked file past this is listed without a line count. */
export const UNTRACKED_COUNT_MAX_BYTES = 1024 * 1024;

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The one ref name taken from git's output: under refs/remotes/, so it cannot read as a flag. */
const REMOTE_REF = /^refs\/remotes\/[\w./-]+$/;

interface GitRun {
    status: number | null;
    stdout: string;
    stderr: string;
    /** The output outgrew the buffer — `status` is null and `stdout` is cut. */
    tooLarge: boolean;
}

/** When a whole request must be done by: its git runs share one budget, so a
 *  slow repository costs the listener's event loop `GIT_TIMEOUT_MS` once. */
export const newDeadline = (): number => Date.now() + GIT_TIMEOUT_MS;

/** What the listener's own environment must not hand to git: it names the repository, the index, the
 *  diff program or extra config, and would send another repository's diff. */
const INHERITED_GIT_VARIABLE =
    /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|EXTERNAL_DIFF|DIFF_OPTS|ATTR_SOURCE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

/** The environment git runs in: the listener's, without the variables above, and a partial clone
 *  asked for a missing object fails instead of running its `remote.<name>.uploadpack`. */
const gitEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
    for (const key of Object.keys(env)) if (INHERITED_GIT_VARIABLE.test(key)) delete env[key];
    return env;
};

/** Run git in `repo`. No network, no optional index refresh, no file-system
 *  monitor (the repo's `core.fsmonitor` is a command git would run), and
 *  pathspecs are taken literally. Past `deadline` it does not start. */
export const gitIn = (repo: string, args: string[], deadline: number = newDeadline()): GitRun => {
    const left = deadline - Date.now();
    if (left <= 0) return { status: null, stdout: '', stderr: 'deadline passed', tooLarge: false };
    const r = spawnSync('git', ['-C', repo, '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitEnvironment(),
        timeout: left,
        maxBuffer: GIT_MAX_BUFFER,
    });
    return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        tooLarge: r.error !== undefined && 'code' in r.error && r.error.code === 'ENOBUFS',
    };
};

const failure = (run: GitRun): { ok: false; error: DiffFailure } => ({
    ok: false,
    error: run.tooLarge ? 'too_large' : 'git_failed',
});

/**
 * `-c` options that blank the commands a repository's `filter.<name>.clean` and
 * `.process` name (and drop `.required`, which would turn the blank into an error): `git diff` runs them to read a working-tree file as it would
 * be committed. The names come from the config itself (`git config` only reads),
 * and each goes to git as one argument, never through a shell.
 */
export const filterOverrides = (repo: string, deadline: number = newDeadline()): string[] | null => {
    const listed = gitIn(repo, ['config', '--name-only', '--get-regexp', '^filter\\.'], deadline);
    // Status 1 is "no such key": nothing to blank. Anything else is git not answering.
    if (listed.status === 1) return [];
    if (listed.status !== 0) return null;
    const names = new Set<string>();
    for (const key of listed.stdout.split('\n')) {
        const match = /^filter\.(.+)\.[^.]+$/.exec(key.trim());
        // `-c name=value` splits at the first `=`: a driver named with one cannot be blanked.
        if (match && match[1].includes('=')) return null;
        // `check-attr` prints a driver's name where it prints `set`, `unset` or `unspecified`: such a name cannot be told from the state.
        if (match && ['set', 'unset', 'unspecified'].includes(match[1])) return null;
        if (match) names.add(match[1]);
    }
    return [...names].flatMap((name) => [
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.process=`,
        // A required filter that does nothing is an error for git, not a pass.
        '-c',
        `filter.${name}.required=false`,
    ]);
};

/**
 * `$GIT_DIR/info/attributes` outranks every `.gitattributes`, the base revision's included (`check-attr --source`
 * still reads it), so a line there that unsets `filter` hides the filter on both sides. That is not something to
 * guess around: the request is refused. null-safe: a file that is not there or cannot be read says nothing.
 */
const infoAttributesUnsetFilter = (repo: string, deadline: number): boolean => {
    const where = gitIn(repo, ['rev-parse', '--git-path', 'info/attributes'], deadline).stdout.trim();
    if (!where) return false;
    try {
        const file = isAbsolute(where) ? where : join(repo, where);
        if (lstatSync(file).size > UNTRACKED_COUNT_MAX_BYTES) return true;
        return /(?:^|\s)[-!]filter(?:\s|$)/m.test(readFileSync(file, 'utf-8'));
    } catch {
        return false;
    }
};

/**
 * The paths among `paths` that a `filter=` attribute names, read two ways: from the working tree (what git would
 * run on the file now) and from the base revision (what the stored side was made with). Either one naming a
 * filter is enough: a `.gitattributes` edited, appended to or deleted since the base would otherwise show the
 * working tree's plaintext against the base's ciphertext as all added lines. A filter turns the working-tree file
 * into what the repository stores (ciphertext, an LFS pointer), so these files get no patch. null when git does
 * not answer — a git too old for `check-attr --source` (before 2.40) included.
 */
export const filteredPaths = (repo: string, paths: string[], rev: string, deadline: number = newDeadline()): Set<string> | null => {
    const filtered = new Set<string>();
    if (paths.length === 0) return filtered;
    if (infoAttributesUnsetFilter(repo, deadline)) return null;
    for (const source of [[], [`--source=${rev}`]]) {
        const r = gitIn(repo, ['check-attr', ...source, '-z', 'filter', '--', ...paths], deadline);
        if (r.status !== 0) return null;
        // `<path> NUL filter NUL <value> NUL`; the value is the driver's name, or `set`, `unset`, `unspecified`.
        const parts = r.stdout.split('\0');
        for (let i = 0; i + 2 < parts.length; i += 3) {
            if (parts[i + 2] !== 'unspecified' && parts[i + 2] !== 'unset') filtered.add(parts[i]);
        }
    }
    return filtered;
};

/** The repository the directory belongs to, or null when it is not in one. Asked
 *  of git rather than guessed from the path. */
export const repoRootOf = (cwd: string): string | null => {
    const r = gitIn(cwd, ['rev-parse', '--show-toplevel']);
    const root = r.stdout.trim();
    return r.status === 0 && root ? root : null;
};

/** An object id git printed, or null when what it printed is anything else. */
const objectId = (run: GitRun): string | null => {
    const id = run.stdout.trim();
    return run.status === 0 && OBJECT_ID.test(id) ? id : null;
};

/** `refs/remotes/origin/main` → `main`, `refs/heads/main` → `main`. */
const shortRefName = (ref: string): string => ref.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^refs\/heads\//, '');

/**
 * The object id a base compares against, plus its display name.
 *
 * `head` is HEAD, or the empty tree in a repository with no commit yet (every
 * file is then new). `default` is the merge-base of HEAD and the repo's default
 * branch — `origin/HEAD` when the clone has one, else a local `main` / `master`.
 * Nothing is fetched, so a stale remote means a stale base.
 */
export const resolveBase = (root: string, base: DiffBase, deadline: number = newDeadline()): DiffResult<{ rev: string; baseName?: string }> => {
    if (base === 'head') {
        const head = objectId(gitIn(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], deadline));
        if (head) return { ok: true, rev: head };
        const empty = gitIn(root, ['hash-object', '-t', 'tree', '/dev/null'], deadline);
        const tree = objectId(empty);
        return tree ? { ok: true, rev: tree } : failure(empty);
    }

    const candidates: string[] = [];
    const symbolic = gitIn(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], deadline).stdout.trim();
    // Only a ref under refs/remotes/ is taken from this output; anything else is
    // not a thing we would hand back to git as an argument.
    if (REMOTE_REF.test(symbolic)) candidates.push(symbolic);
    candidates.push('refs/heads/main', 'refs/heads/master');

    for (const ref of candidates) {
        const tip = objectId(gitIn(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], deadline));
        if (!tip) continue;
        const mergeBase = objectId(gitIn(root, ['merge-base', tip, 'HEAD'], deadline));
        if (mergeBase) return { ok: true, rev: mergeBase, baseName: shortRefName(ref) };
    }
    // A git that ran out of time answered nothing; that is not "no default branch".
    if (Date.now() >= deadline) return { ok: false, error: 'git_failed' };
    return { ok: false, error: 'no_default_branch' };
};

/** On every `git diff`: no external diff program, no textconv filter, and a repository nested in this one is not entered. */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];

const STATUS_LETTERS: Record<string, DiffFileEntry['status']> = { M: 'M', A: 'A', D: 'D' };

/** `git diff --name-status -z` → path → status. A type change reads as modified. */
const parseNameStatus = (out: string): Array<{ path: string; status: DiffFileEntry['status'] }> => {
    const parts = out.split('\0');
    const rows: Array<{ path: string; status: DiffFileEntry['status'] }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        if (!parts[i + 1]) continue;
        rows.push({ path: parts[i + 1], status: STATUS_LETTERS[parts[i][0]] ?? 'M' });
    }
    return rows;
};

/** `git diff --numstat -z` → path → counts. A binary file reports `-` twice. */
const parseNumstat = (out: string): Map<string, { added: number; removed: number; binary: boolean }> => {
    const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
    for (const record of out.split('\0')) {
        const first = record.indexOf('\t');
        const second = record.indexOf('\t', first + 1);
        if (first < 0 || second < 0) continue;
        const added = record.slice(0, first);
        const removed = record.slice(first + 1, second);
        const path = record.slice(second + 1);
        if (!path) continue;
        counts.set(path, {
            added: Number.isInteger(Number(added)) ? Number(added) : 0,
            removed: Number.isInteger(Number(removed)) ? Number(removed) : 0,
            binary: added === '-' && removed === '-',
        });
    }
    return counts;
};

/** Line count and binary-ness of an untracked file, without a git per file. A
 *  symlink or an oversized file is listed with no count rather than followed. */
const untrackedCounts = (root: string, path: string): Pick<DiffFileEntry, 'added' | 'removed' | 'binary'> => {
    try {
        const full = join(root, path);
        const stat = lstatSync(full);
        if (!stat.isFile() || stat.size > UNTRACKED_COUNT_MAX_BYTES) return { added: 0, removed: 0 };
        const data = readFileSync(full);
        if (data.includes(0)) return { added: 0, removed: 0, binary: true };
        let lines = 0;
        for (const b of data) if (b === 0x0a) lines++;
        if (data.length > 0 && data[data.length - 1] !== 0x0a) lines++;
        return { added: lines, removed: 0 };
    } catch {
        return { added: 0, removed: 0 };
    }
};

/** Where the repository's HEAD stands, as far as git answered: detached, or a branch that may follow an
 *  upstream, and only then how far apart the two are. The wire carries the fields flat. */
export type BranchState =
    | { detached: true }
    | { head: string }
    | { head: string; upstream: string }
    | { head: string; upstream: string; ahead: number; behind: number };

/**
 * The branch HEAD is on and, when it follows an upstream, how many commits it is ahead of and behind it.
 * Best effort: `undefined` when HEAD cannot be named (git failed, the deadline passed, or the repository has no
 * commit yet), and a step that fails leaves out its field and the ones after it.
 */
export const branchState = (root: string, deadline: number): BranchState | undefined => {
    const head = gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD'], deadline);
    const name = head.stdout.trim();
    if (head.status !== 0 || !name) return undefined;
    if (name === 'HEAD') return { detached: true };
    const upstream = gitIn(root, ['rev-parse', '--abbrev-ref', '@{upstream}'], deadline);
    const upstreamName = upstream.stdout.trim();
    if (upstream.status !== 0 || !upstreamName) return { head: name };
    const counts = gitIn(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], deadline);
    const match = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
    if (counts.status !== 0 || !match) return { head: name, upstream: upstreamName };
    return { head: name, upstream: upstreamName, ahead: Number(match[1]), behind: Number(match[2]) };
};

/**
 * The files changed against `base`: tracked changes (working tree against the
 * base revision, renames reported as a delete plus an add) and new files that
 * git would add — `.gitignore`d ones are not listed.
 */
export const collectDiffFiles = (
    root: string,
    base: DiffBase,
): DiffResult<{ files: DiffFileEntry[]; truncated: boolean; baseName?: string; branch?: BranchState }> => {
    const deadline = newDeadline();
    const resolved = resolveBase(root, base, deadline);
    if (!resolved.ok) return resolved;

    const safe = filterOverrides(root, deadline);
    if (!safe) return { ok: false, error: 'git_failed' };
    const names = gitIn(root, [...safe, 'diff', '--name-status', '-z', '--no-renames', ...DIFF_FLAGS, resolved.rev], deadline);
    if (names.status !== 0) return failure(names);
    const nums = gitIn(root, [...safe, 'diff', '--numstat', '-z', '--no-renames', ...DIFF_FLAGS, resolved.rev], deadline);
    if (nums.status !== 0) return failure(nums);
    const others = gitIn(root, ['ls-files', '--others', '--exclude-standard', '-z'], deadline);
    if (others.status !== 0) return failure(others);

    const counts = parseNumstat(nums.stdout);
    const entries: DiffFileEntry[] = parseNameStatus(names.stdout).map(({ path, status }) => {
        const c = counts.get(path);
        return { path, status, added: c?.added ?? 0, removed: c?.removed ?? 0, ...(c?.binary ? { binary: true as const } : {}) };
    });
    const tracked = new Set(entries.map((e) => e.path));
    const untracked = others.stdout.split('\0').filter((p) => p && !tracked.has(p));
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Untracked paths are counted only for the ones that survive the cap: a tree
    // with thousands of new files would otherwise read thousands of them.
    const room = Math.max(0, DIFF_MAX_FILES - entries.length);
    for (const path of untracked.slice(0, room)) entries.push({ path, status: '?', ...untrackedCounts(root, path) });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const total = parseNameStatus(names.stdout).length + untracked.length;
    const shown = entries.slice(0, DIFF_MAX_FILES);
    const filtered = filteredPaths(
        root,
        shown.map((e) => e.path),
        resolved.rev,
        deadline,
    );
    if (!filtered) return { ok: false, error: 'git_failed' };
    // Last, on what is left of the same budget: a slow `rev-list` costs the band, never the list.
    const branch = branchState(root, deadline);
    return {
        ok: true,
        // A file under a filter has no patch to show, which is what a binary file looks like on the wire.
        files: shown.map((e) => (filtered.has(e.path) ? { path: e.path, status: e.status, added: 0, removed: 0, binary: true as const } : e)),
        truncated: total > DIFF_MAX_FILES,
        ...(resolved.baseName ? { baseName: resolved.baseName } : {}),
        ...(branch ? { branch } : {}),
    };
};

/** A path git can be handed after `--`: non-empty, no NUL, repo-relative. A
 *  leading `-` is fine there — after `--` git reads it as a name. */
const isPlainRelativePath = (path: string): boolean => path !== '' && !path.includes('\0') && !path.startsWith('/');

/**
 * One file's patch against `base`, as unified-diff text with secret-looking
 * strings masked (`masked` says how many). The whole patch is masked before it
 * is paged, so a key block that straddles a page boundary does not leak and the
 * byte offsets are the same on every page. A tracked file's
 * patch comes from `git diff`; a file git calls new (untracked and not ignored)
 * is shown as an addition. An ignored file, or one that is neither, is an empty
 * patch — the existence of an ignored file is not revealed.
 */
export const collectFilePatch = (root: string, base: DiffBase, path: string): DiffResult<{ text: string; masked: number }> => {
    if (!isPlainRelativePath(path)) return { ok: false, error: 'bad_path' };
    const deadline = newDeadline();
    const resolved = resolveBase(root, base, deadline);
    if (!resolved.ok) return resolved;

    const safe = filterOverrides(root, deadline);
    if (!safe) return { ok: false, error: 'git_failed' };
    // One file: a path git would diff as a directory, a pattern or a spelling of another path names files whose
    // filters nobody asked about. What git would diff for it must be that one path, or nothing.
    const named = gitIn(root, [...safe, 'diff', '--name-only', '-z', '--no-renames', ...DIFF_FLAGS, resolved.rev, '--', path], deadline);
    if (named.status !== 0) return failure(named);
    const names = named.stdout.split('\0').filter(Boolean);
    if (names.length > 0 && !(names.length === 1 && names[0] === path)) return { ok: false, error: 'bad_path' };

    const filtered = filteredPaths(root, [path], resolved.rev, deadline);
    if (!filtered) return { ok: false, error: 'git_failed' };
    if (filtered.size > 0) return { ok: true, text: '', masked: 0 };
    const flags = ['--no-color', ...DIFF_FLAGS];
    const tracked = gitIn(root, [...safe, 'diff', ...flags, '--no-renames', resolved.rev, '--', path], deadline);
    if (tracked.status !== 0) return failure(tracked);
    if (tracked.stdout) return { ok: true, ...maskSecrets(tracked.stdout) };

    const listed = gitIn(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path], deadline);
    if (listed.status !== 0) return failure(listed);
    if (listed.stdout.split('\0').filter(Boolean).join('\0') !== path) return { ok: true, text: '', masked: 0 };

    // `--no-index` exits 1 when the files differ, which is the normal case here.
    const added = gitIn(root, [...safe, 'diff', ...flags, '--no-index', '--', '/dev/null', path], deadline);
    if (added.status !== 0 && added.status !== 1) return failure(added);
    return { ok: true, ...maskSecrets(added.stdout) };
};

export interface PatchPage {
    chunk: string;
    offset: number;
    /** Bytes in `chunk`. */
    length: number;
    hasMore: boolean;
    /** Bytes in the whole patch. */
    total: number;
    /** Identifies the whole patch: a reader paging through it sees the tree
     *  change underneath it as a different etag. */
    etag: string;
}

/**
 * Cut a page out of `text` by byte offset, ending on a character boundary.
 * Offsets are bytes so they stay stable across pages; a UTF-8 character that
 * would straddle the cut moves whole to the next page, and an offset that
 * lands inside a character is refused.
 */
export const pagePatch = (text: string, offset: number, maxBytes: number = DIFF_PAGE_MAX_BYTES): DiffResult<PatchPage> => {
    const buf = Buffer.from(text, 'utf-8');
    const total = buf.length;
    if (!Number.isInteger(offset) || offset < 0 || offset > total) return { ok: false, error: 'bad_range' };
    const isContinuation = (i: number): boolean => (buf[i] & 0xc0) === 0x80;
    if (offset < total && isContinuation(offset)) return { ok: false, error: 'bad_range' };

    let end = Math.min(offset + maxBytes, total);
    while (end > offset && end < total && isContinuation(end)) end--;
    // A page too small to hold one character would never advance.
    if (end === offset && offset < total) return { ok: false, error: 'bad_range' };

    return {
        ok: true,
        chunk: buf.subarray(offset, end).toString('utf-8'),
        offset,
        length: end - offset,
        hasMore: end < total,
        total,
        etag: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    };
};
