/**
 * Reading a session's repository for the phone's file view (F5): the one place
 * the working tree is opened for it. Design: hwip `docs/file-view.md` (V1~V14,
 * D1~D13); this module is V6, V7, V9, V10, V11, D4 and D5.
 *
 * What a path may be and what the phone may see of the tree is decided here and
 * nowhere else. Nothing here knows about sealing, the wire or who asked — the
 * listener decides that; this decides what is read and what is never opened.
 *
 * git is run only through `gitIn`, with constant arguments. What this module adds
 * is `ls-files` (twice) for the visible set and `check-attr` (through `filteredPaths`)
 * for `filter=`; `resolveBase` and `filteredPaths` bring their own `rev-parse` and
 * `hash-object`. None of them runs a filter. One caller path goes to git, after `--`.
 */

import { Buffer } from 'buffer';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, type BigIntStats } from 'fs';
import { join } from 'path';
import { maskText } from './secret-mask.js';
import { type DiffResult, filteredPaths, gitIn, newDeadline, resolveBase, UNTRACKED_COUNT_MAX_BYTES } from './session-diff.js';

/** The longest path, in UTF-8 bytes, the phone may name. */
const PATH_MAX_BYTES = 1024;
/** Most entries in one page of a directory listing. */
export const TREE_PAGE_MAX_ENTRIES = 500;
/** A file past this is not read. Same value as an untracked file's line count limit in the diff. */
export const FILE_VIEW_MAX_BYTES = UNTRACKED_COUNT_MAX_BYTES;
/** A NUL in this many leading bytes makes a file binary — the length git itself looks at. */
const BINARY_PROBE_BYTES = 8000;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * V7 ①, the string rules. A path is repo-relative and names one thing: not empty
 * (a directory request's `""` for the root is the tree handler's to allow), no NUL
 * or other control character, not absolute, at most 1,024 UTF-8 bytes, and no
 * segment that is empty, `.`, `..` or — at any depth, in any case — `.git` (a
 * case-insensitive file system opens `.GIT` as `.git`, D11). A leading `-` is fine:
 * the path only ever follows `--`.
 */
export const isViewablePath = (path: string): boolean => {
    if (path === '' || path.startsWith('/') || CONTROL_CHARACTER.test(path)) return false;
    if (Buffer.byteLength(path, 'utf-8') > PATH_MAX_BYTES) return false;
    return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
};

/** What kind of thing git lists at a path. `nested` is an untracked repository (`ls-files --others` prints it as `dir/`). */
export interface VisibleEntry {
    /** The tracked mode (`100644`, `120000`, `160000`, …); absent for an untracked path. */
    mode?: string;
    /** The tracked object id (a gitlink's commit); absent for an untracked path. */
    oid?: string;
    nested?: true;
}

/** U+FFFD is what `gitIn` makes of a byte that is not UTF-8 (O1): such a name cannot be matched byte for byte. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * V6, the visible set: what git lists as tracked (`ls-files --stage`) plus what it lists as
 * untracked and not ignored (`ls-files --others --exclude-standard`), under `scope` (the
 * whole repository when absent). An ignored path is simply not there, so asking for it by
 * name answers like a path that does not exist. The caller matches a path against the keys
 * exactly; the pathspec only narrows what git has to print. A path the phone could never
 * ask for (`isViewablePath`) or whose bytes are not UTF-8 is left out, so a listing never
 * shows a name that cannot be opened.
 */
export const visibleSet = (root: string, scope: string | undefined, deadline: number = newDeadline()): DiffResult<{ entries: Map<string, VisibleEntry> }> => {
    const pathspec = scope === undefined ? [] : ['--', scope];
    const tracked = gitIn(root, ['ls-files', '-z', '--stage', ...pathspec], deadline);
    if (tracked.status !== 0) return { ok: false, error: tracked.tooLarge ? 'too_large' : 'git_failed' };
    const untracked = gitIn(root, ['ls-files', '-z', '--others', '--exclude-standard', ...pathspec], deadline);
    if (untracked.status !== 0) return { ok: false, error: untracked.tooLarge ? 'too_large' : 'git_failed' };

    const entries = new Map<string, VisibleEntry>();
    const admit = (path: string, entry: VisibleEntry): void => {
        if (path.includes(REPLACEMENT_CHARACTER) || !isViewablePath(path)) return;
        // A path in conflict is listed once per stage; the first row stands.
        if (!entries.has(path)) entries.set(path, entry);
    };
    for (const record of tracked.stdout.split('\0')) {
        // `<mode> <oid> <stage>\t<path>`
        if (!record) continue;
        const tab = record.indexOf('\t');
        // A row of another shape means git's output is not what this reads: say so, not "nothing is visible".
        if (tab < 0) return { ok: false, error: 'git_failed' };
        const [mode, oid] = record.slice(0, tab).split(' ');
        admit(record.slice(tab + 1), { mode, oid });
    }
    for (const record of untracked.stdout.split('\0')) {
        if (!record) continue;
        if (record.endsWith('/')) admit(record.slice(0, -1), { nested: true });
        else admit(record, {});
    }
    return { ok: true, entries };
};

/** The errno of a file-system call that failed because nothing is there, or what is there cannot be followed. */
const isGone = (e: unknown): boolean => e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ELOOP');

/**
 * V7 ③: no directory of `dir` (a repo-relative path, `""` for none) is a symlink, and each is a directory. git does
 * not track through a symlink, but a tracked directory can be replaced by one after the
 * index was written. Walked a segment at a time with `lstat`, so a root that itself sits
 * under a symlink (`/tmp` → `/private/tmp`) and a case-insensitive file system make no
 * difference. A segment that does not exist ends the walk with a yes: there is nothing
 * to follow there (a deleted file stays in the index until it is committed). null when the
 * file system failed in some other way (permissions, I/O): that is not an answer about symlinks.
 */
const reachesWithoutSymlink = (root: string, dir: string): boolean | null => {
    let at = root;
    for (const segment of dir === '' ? [] : dir.split('/')) {
        at = join(at, segment);
        try {
            if (!lstatSync(at).isDirectory()) return false;
        } catch (e) {
            return isGone(e) ? true : null;
        }
    }
    return true;
};

/** `a/b/c` → `a/b`; `c` → `""`. */
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export type TreeEntryType = 'file' | 'dir' | 'symlink' | 'submodule';

export interface TreeEntry {
    name: string;
    type: TreeEntryType;
}

/** `absent` is a path outside the visible set, ignored, or not a directory — the three look the same (V6). */
export type TreeResult = DiffResult<{ body: 'entries'; entries: TreeEntry[]; truncated: boolean; cursor?: string } | { body: 'absent' }>;

const entryTypeOf = (entry: VisibleEntry): TreeEntryType => {
    if (entry.nested || entry.mode === '160000') return 'submodule';
    return entry.mode === '120000' ? 'symlink' : 'file';
};

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf-8');

/**
 * One page of the entries directly under `dir` (`""` is the repository root), by
 * name in UTF-8 byte order. `cursor` is the last name of the page before; the page is
 * at most `TREE_PAGE_MAX_ENTRIES` and `truncated` says there is more. A directory is
 * only a name some visible path continues under, so an empty one, an ignored one and
 * one that is not there are all `absent`.
 */
export const listTree = (root: string, dir: string, cursor?: string, deadline: number = newDeadline()): TreeResult => {
    if (dir !== '' && !isViewablePath(dir)) return { ok: false, error: 'bad_path' };
    const set = visibleSet(root, dir === '' ? undefined : dir, deadline);
    if (!set.ok) return set;

    const prefix = dir === '' ? '' : `${dir}/`;
    const found = new Map<string, TreeEntryType>();
    for (const [path, entry] of set.entries) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) found.set(rest, entryTypeOf(entry));
        else found.set(rest.slice(0, slash), 'dir');
    }
    if (dir !== '' && found.size === 0) return { ok: true, body: 'absent' };
    const clear = reachesWithoutSymlink(root, dir);
    if (clear === null) return { ok: false, error: 'git_failed' };
    if (!clear) return { ok: true, body: 'absent' };

    // Each name's bytes are made once: the sort would otherwise make two buffers per comparison.
    const cursorBytes = cursor === undefined ? undefined : utf8(cursor);
    const after = [...found]
        .map(([name, type]) => ({ name, type, bytes: utf8(name) }))
        .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
        .filter((entry) => cursorBytes === undefined || Buffer.compare(entry.bytes, cursorBytes) > 0);
    const page = after.slice(0, TREE_PAGE_MAX_ENTRIES).map(({ name, type }) => ({ name, type }));
    const truncated = after.length > page.length;
    return {
        ok: true,
        body: 'entries',
        entries: page,
        truncated,
        ...(truncated ? { cursor: page[page.length - 1].name } : {}),
    };
};

export type BlobBody =
    | { body: 'text'; text: string; masked: number }
    | { body: 'binary'; size: number }
    | { body: 'symlink'; target: string }
    | { body: 'filtered' }
    | { body: 'submodule'; commit?: string }
    | { body: 'absent' };

export type BlobResult = DiffResult<BlobBody>;

/** Test seams: where an agent could swap the file — after the symlink walk (V7 ③) and before the `lstat` that judges it, and between that `lstat` and the `open` that reads it. */
export interface ReadBlobOptions {
    deadline?: number;
    beforeLstat?: () => void;
    beforeOpen?: () => void;
}

/**
 * D4: names that stay unread even when a repository tracks them. The list is code, not
 * configuration. Compared on the last segment, ignoring case (the file systems that
 * open `.GIT` as `.git` open `.ENV` as `.env`).
 */
const BLOCKED_NAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore)|id_rsa.*|id_ed25519.*|credentials.*)$/;
const ALLOWED_ENV_NAMES = new Set(['.env.example', '.env.sample']);

const isBlockedName = (path: string): boolean => {
    const name = (path.split('/').pop() ?? '').toLowerCase();
    return !ALLOWED_ENV_NAMES.has(name) && BLOCKED_NAME.test(name);
};

const ABSENT: BlobResult = { ok: true, body: 'absent' };
const FILTERED: BlobResult = { ok: true, body: 'filtered' };

/** Is `path` still, right now, a regular file with the identity of `opened`? */
const sameFile = (path: string, opened: BigIntStats): boolean => {
    try {
        const now = lstatSync(path, { bigint: true });
        return now.isFile() && now.dev === opened.dev && now.ino === opened.ino;
    } catch (e) {
        // Gone is a swap (false); anything else is the file system failing, which the caller's catch reports.
        if (isGone(e)) return false;
        throw e;
    }
};

/** Read up to `limit` bytes from the start of `fd`; fewer when the file ends first. */
const readUpTo = (fd: number, limit: number): Buffer => {
    const buffer = Buffer.alloc(limit);
    let filled = 0;
    while (filled < limit) {
        const n = readSync(fd, buffer, filled, limit - filled, filled);
        if (n === 0) break;
        filled += n;
    }
    return buffer.subarray(0, filled);
};

/**
 * What a file looks like to the phone. The order is the design's V7: ① the string rules
 * (`bad_path`) · ② the visible set, exact match · ③ no symlink on the way · ④ `lstat`: a
 * symlink is shown as its target string and never followed, a gitlink or nested repository
 * is shown as a submodule and never entered, anything but a regular file is `absent` ·
 * D4 and V9 (`filter=`) say `filtered` · ⑤ open with `O_NOFOLLOW | O_NONBLOCK`, `fstat`
 * the descriptor and compare it with ④ — a different file is `absent`, a hard link is
 * `filtered` (D5) · V11: past 1 MiB is `too_large`, a NUL in the first 8,000 bytes is
 * `binary` · V10: the whole text is masked before the caller pages it. A path outside the
 * set, ignored, deleted or swapped is `absent`, never an error: the phone cannot tell them apart.
 */
export const readBlob = (root: string, path: string, options: ReadBlobOptions = {}): BlobResult => {
    if (!isViewablePath(path)) return { ok: false, error: 'bad_path' };
    const deadline = options.deadline ?? newDeadline();
    const set = visibleSet(root, path, deadline);
    if (!set.ok) return set;
    const entry = set.entries.get(path);
    if (!entry) return ABSENT;
    const parent = parentOf(path);
    const clear = reachesWithoutSymlink(root, parent);
    if (clear === null) return { ok: false, error: 'git_failed' };
    if (!clear) return ABSENT;
    if (entry.nested) return { ok: true, body: 'submodule' };
    if (entry.mode === '160000') return { ok: true, body: 'submodule', commit: entry.oid };

    const full = join(root, path);
    options.beforeLstat?.();
    let seen: BigIntStats;
    try {
        // bigint: an inode past 2^53 (FUSE, NFS) would otherwise compare equal to its neighbour.
        seen = lstatSync(full, { bigint: true });
    } catch (e) {
        return isGone(e) ? ABSENT : { ok: false, error: 'git_failed' };
    }
    if (seen.isSymbolicLink()) {
        try {
            return { ok: true, body: 'symlink', target: readlinkSync(full) };
        } catch (e) {
            // EINVAL: it stopped being a symlink since the lstat — a swap, like a vanished file.
            const swapped = isGone(e) || (e instanceof Error && 'code' in e && e.code === 'EINVAL');
            return swapped ? ABSENT : { ok: false, error: 'git_failed' };
        }
    }
    if (!seen.isFile()) return ABSENT;

    if (isBlockedName(path)) return FILTERED;
    const base = resolveBase(root, 'head', deadline);
    if (!base.ok) return base;
    const filtered = filteredPaths(root, [path], base.rev, deadline);
    if (!filtered) return { ok: false, error: 'git_failed' };
    if (filtered.size > 0) return FILTERED;

    options.beforeOpen?.();
    let fd: number;
    try {
        fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
        // ELOOP is `O_NOFOLLOW` catching a symlink put there since the lstat; running out of descriptors is not "absent".
        return isGone(e) ? ABSENT : { ok: false, error: 'git_failed' };
    }
    let bytes: Buffer;
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) return ABSENT;
        // The walk and the `lstat` ran before the open; a directory swapped for a symlink in between would
        // have made `seen` the outside file's. The descriptor is the one fixed thing: ask again, and the
        // swap has to be undone and redone inside this window to pass.
        const stillClear = reachesWithoutSymlink(root, parent);
        if (stillClear === null) return { ok: false, error: 'git_failed' };
        if (!stillClear || !sameFile(full, opened)) return ABSENT;
        if (opened.nlink !== 1n) return FILTERED;
        if (opened.size > BigInt(FILE_VIEW_MAX_BYTES)) return { ok: false, error: 'too_large' };
        // One byte past the limit: a file that grew after `fstat` is still caught.
        bytes = readUpTo(fd, FILE_VIEW_MAX_BYTES + 1);
    } catch {
        // The file system failed under an open descriptor (EIO and the like): nothing was read.
        return { ok: false, error: 'git_failed' };
    } finally {
        try {
            closeSync(fd);
        } catch {
            // intentionally ignored: the bytes (or the answer) are already in hand; a failed close of a read-only descriptor loses nothing.
        }
    }
    if (bytes.length > FILE_VIEW_MAX_BYTES) return { ok: false, error: 'too_large' };
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { ok: true, body: 'binary', size: bytes.length };
    return { ok: true, body: 'text', ...maskText(bytes.toString('utf-8')) };
};
