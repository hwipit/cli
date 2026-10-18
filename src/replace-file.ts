import {
    accessSync,
    chmodSync,
    chownSync,
    closeSync,
    constants,
    fchmodSync,
    fchownSync,
    ftruncateSync,
    lstatSync,
    openSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { dirname, resolve } from 'path';
import { mkdirHandedBack, sudoOwner } from './private-files.js';

/** A file hwip is about to rewrite is not valid UTF-8: reading it as text would turn its bytes into U+FFFD and the write would keep that. */
export class NotUtf8Error extends Error {
    constructor(filePath: string) {
        super(`${filePath} is not valid UTF-8 text, left it unchanged`);
        this.name = 'NotUtf8Error';
    }
}

/** The file changed between hwip reading it and writing it: the write would drop the other writer's change. */
export class FileChangedError extends Error {
    constructor(filePath: string) {
        super(`${filePath} changed while hwip was editing it, left it as it is (run the command again)`);
        this.name = 'FileChangedError';
    }
}

/** hwip may not write the file, or may not create the temp file it writes beside it: it is left as it is, and the user is told which. */
export class NotWritableError extends Error {
    constructor(filePath: string, why: string) {
        super(`${filePath} ${why}, left it unchanged`);
        this.name = 'NotWritableError';
    }
}

/** A file's text, exactly: throws `NotUtf8Error` instead of decoding bad bytes to U+FFFD. A byte order mark is kept. */
export const readText = (filePath: string): string => {
    const bytes = readFileSync(filePath);
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new NotUtf8Error(filePath);
    }
};

/** `readText`, or null for a file that is not there (any other failure — no permission — still throws). */
export const readTextIfExists = (filePath: string): string | null => {
    try {
        return readText(filePath);
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
    }
};

/**
 * Delete a file hwip owned whole, unless it changed since it was read: a delete is a write too, and
 * a line the user added in between would go with it. `expected` is what was read.
 */
export const removeFile = (filePath: string, expected: string): void => {
    let now: string | null;
    try {
        now = readTextIfExists(filePath);
    } catch {
        throw new FileChangedError(filePath);
    }
    if (now !== expected) throw new FileChangedError(filePath);
    rmSync(filePath, { force: true });
};

/** The kernel follows at most 40 links in a path (Linux `ELOOP`; macOS stops at 32): so does this. */
const MAX_LINK_HOPS = 40;

/** The file a write to `filePath` lands in: the end of a symlink chain, even
 *  one that does not exist yet (a plain write creates it there). */
const writeTarget = (filePath: string): string => {
    try {
        return realpathSync(filePath);
    } catch {
        /* missing, or a link (chain) to a missing file */
    }
    // `realpath` cannot say where a chain that ends in nothing ends: walk it a link at a time.
    // One step only would stop at the middle link, and the rename would replace it with a file.
    let at = filePath;
    for (let hops = 0; lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink(); hops++) {
        if (hops === MAX_LINK_HOPS) throw new Error(`${filePath} links to itself, or through too many links, so it was left unchanged`);
        // A relative link is read from the directory the link is really in, which `..` makes a difference for
        // when that directory is itself reached through a symlink (`~/.cursor` into a dotfiles repo).
        let base = dirname(at);
        try {
            base = realpathSync(base);
        } catch {
            /* the directory is not there either: the lexical one is all there is */
        }
        at = resolve(base, readlinkSync(at));
    }
    return at;
};

const lacksPermission = (err: unknown): boolean =>
    err instanceof Error && 'code' in err && (err.code === 'EACCES' || err.code === 'EPERM');

/**
 * Whether someone else already wrote exactly `content` since `expected` was read (nothing left to do).
 * Throws `FileChangedError` when the file holds anything but `expected` or `content`.
 */
const alreadyWritten = (target: string, filePath: string, expected: string | null | undefined, content: string): boolean => {
    if (expected === undefined) return false;
    let now: string | null;
    try {
        now = readTextIfExists(target);
    } catch {
        throw new FileChangedError(filePath); // unreadable, or no longer text: not what was read either
    }
    if (now === expected) return false;
    if (now === content) return true;
    throw new FileChangedError(filePath);
};

/**
 * Write over the file itself, for a directory that takes no new entries (a temp file cannot be made
 * there). Not atomic: a kill in between leaves a cut-off file, so the old bytes are put back if the
 * write fails, and the asked-for mode is set first so a secret is never in a wider file.
 */
const writeInPlace = (target: string, content: string, mode: number | undefined): void => {
    const { O_RDWR, O_NOFOLLOW } = constants;
    // Without `O_NOFOLLOW` (Windows, which has no such modes either) the old by-name path stays.
    if (O_NOFOLLOW === undefined) {
        const old = readFileSync(target);
        if (mode !== undefined) chmodSync(target, mode);
        try {
            writeFileSync(target, content);
        } catch (err) {
            try {
                writeFileSync(target, old);
            } catch {
                throw new Error(`${target} could not be written and its old content could not be put back, so it may be cut off`, { cause: err });
            }
            throw err;
        }
        return;
    }
    // Opened without following a link at its end, and read through what was opened: a link
    // planted after `writeTarget` resolved it fails closed here (ELOOP) instead of redirecting
    // the read, the mode change and the write onto another file.
    let fd: number;
    try {
        fd = openSync(target, O_RDWR | O_NOFOLLOW);
    } catch {
        throw new FileChangedError(target);
    }
    try {
        const old = readFileSync(fd);
        if (mode !== undefined) fchmodSync(fd, mode);
        // An fd write starts where the last one stopped (a truncate does not move the offset):
        // cut and write at 0, so a retry and the put-back below both start at the beginning.
        ftruncateSync(fd, 0);
        try {
            writeSync(fd, content, 0, 'utf8');
        } catch (err) {
            try {
                ftruncateSync(fd, 0);
                writeSync(fd, old, 0, null, 0);
            } catch {
                throw new Error(`${target} could not be written and its old content could not be put back, so it may be cut off`, { cause: err });
            }
            throw err;
        }
    } finally {
        closeSync(fd);
    }
};

/**
 * Write a user's file so it is either the old content or the new one, never a
 * cut-off mix: a plain write empties the file first, and a full disk or a kill
 * in between leaves the agent's settings truncated. The new content goes to a
 * temp file beside the real one and is renamed over it.
 *
 * A symlink is followed, not replaced (dotfile managers link these files into
 * a repo), and an existing file keeps its mode. The rename makes a new inode,
 * so a hard link to the old file keeps the old content (not when it is written in place).
 *
 * `expected` is what the caller read before it built `content` (null: the file
 * was not there). Just before the rename the file is read again, and a write
 * that would drop what someone else wrote in between throws `FileChangedError`
 * instead. Left out, nothing is checked (a file hwip owns whole). The window
 * between that read and the rename is not closed, only made very small.
 *
 * `mode` is the mode the new file has when it appears under its name, new file
 * or old: a file with a secret in it must not be wider than that for a moment.
 * Left out, a new file is 0644 and an old one keeps its mode.
 *
 * A file the user cannot write is not replaced: the rename needs no permission on it, but the
 * user made it read-only on purpose, so `NotWritableError` (root can write any file, so for root
 * nothing is read-only). A writable file in a directory that
 * takes no new entries is written in place (what a plain write did before this function): the
 * user can change the file, so changing it is not a bypass. A file that is not there, in such a
 * directory, cannot be made: `NotWritableError`.
 */
export const replaceFile = (filePath: string, content: string, expected?: string | null, mode?: number): void => {
    mkdirHandedBack(dirname(filePath));
    const target = writeTarget(filePath);
    mkdirHandedBack(dirname(target));
    const existing = statSync(target, { throwIfNoEntry: false });
    if (existing) {
        try {
            accessSync(target, constants.W_OK);
        } catch {
            throw new NotWritableError(filePath, 'is read-only');
        }
    }
    // Random name, exclusive create: a predictable name is one another process
    // could pre-create as a symlink for this write to follow.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    let created = false;
    try {
        // Created without following a link at its end (C149 ④): `writeFileSync` with `wx`
        // opens what a pre-placed link points at. The fd below fails closed (ELOOP) instead,
        // and mode/owner go onto the fd, never by name onto whatever `tmp` became after.
        if (constants.O_NOFOLLOW === undefined) {
            try {
                writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
            } catch (err) {
                // The exclusive create may have made the file and then failed writing it (a full disk): that file is ours.
                // EEXIST means the name was taken before, by someone else.
                if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
                    try {
                        rmSync(tmp, { force: true });
                    } catch {
                        /* the write's own error is the one to report */
                    }
                }
                if (!lacksPermission(err)) throw err;
                if (!existing) throw new NotWritableError(filePath, `cannot be created: ${dirname(target)} takes no new files`);
                if (alreadyWritten(target, filePath, expected, content)) return;
                writeInPlace(target, content, mode);
                return;
            }
            created = true;
            // After the write: the create mode is cut by the umask.
            chmodSync(tmp, mode ?? (existing ? existing.mode & 0o777 : 0o644));
            // The rename makes a new inode owned by whoever runs this: root (sudo, HOME kept) must not take a user's file.
            if (existing && process.getuid?.() === 0 && existing.uid !== 0) chownSync(tmp, existing.uid, existing.gid);
        } else {
            const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
            let tmpFd: number;
            try {
                tmpFd = openSync(tmp, flags, 0o600);
            } catch (err) {
                if (!lacksPermission(err)) throw err;
                if (!existing) throw new NotWritableError(filePath, `cannot be created: ${dirname(target)} takes no new files`);
                if (alreadyWritten(target, filePath, expected, content)) return;
                writeInPlace(target, content, mode);
                return;
            }
            created = true;
            try {
                writeFileSync(tmpFd, content);
                // After the write: the create mode is cut by the umask.
                fchmodSync(tmpFd, mode ?? (existing ? existing.mode & 0o777 : 0o644));
                // A file root creates (a first login: no config.json yet) goes to the person who ran sudo, as its folder does.
                // The rename-over-an-existing-file case is the existing-owner line below.
                if (!existing) {
                    const owner = sudoOwner(tmp);
                    if (owner) {
                        try {
                            fchownSync(tmpFd, owner.uid, owner.gid);
                        } catch { /* not ours to change */ }
                    }
                }
                // The rename makes a new inode owned by whoever runs this: root (sudo, HOME kept) must not take a user's file.
                if (existing && process.getuid?.() === 0 && existing.uid !== 0) fchownSync(tmpFd, existing.uid, existing.gid);
            } finally {
                closeSync(tmpFd);
            }
        }
        // Narrow the rename-by-name window (no `renameat` in Node): refuse a `tmp` that
        // became a link or gained a second name since the exclusive create.
        const tmpSeen = lstatSync(tmp, { throwIfNoEntry: false });
        if (!tmpSeen?.isFile() || tmpSeen.nlink !== 1) {
            throw new FileChangedError(filePath);
        }
        if (alreadyWritten(target, filePath, expected, content)) {
            // Someone else (a second `hwip install` at the same time) already wrote exactly this: nothing left to do.
            unlinkSync(tmp);
            return;
        }
        renameSync(tmp, target);
    } catch (err) {
        if (created) {
            try {
                unlinkSync(tmp);
            } catch {
                /* already renamed or removed */
            }
        }
        throw err;
    }
};
