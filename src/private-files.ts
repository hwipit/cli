import { chmodSync, closeSync, constants, existsSync, fchmodSync, fchownSync, lchownSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';

/**
 * Where the API key lives (`~/.hwip`) is for its owner alone. `mkdir` and
 * `open` apply their mode only on creation, so an older install — or a login
 * under a loose umask — left the folder and the listener log readable by every
 * local user. These make the mode what it should be whether the path is new or
 * not. Best effort: a path owned by someone else cannot be changed here, and
 * Windows has no such modes.
 */

const SUDO_ID = /^[1-9]\d{0,9}$/;

/**
 * Who a file hwip creates under the home folder belongs to when root runs it by `sudo` with HOME
 * kept (macOS does): the person who typed `sudo`, so the next plain `hwip` can read what this
 * one wrote. Null unless every sign agrees: root, `SUDO_UID`/`SUDO_GID` set to real ids, the path
 * under the home folder, and the home folder owned by that same `SUDO_UID`. The last one is what
 * stops a root whose HOME is `/root` (sudo resets it there on Linux) from handing root's folder
 * to whoever ran `sudo`.
 */
export const sudoOwner = (path: string): { uid: number; gid: number } | null => {
    if (process.getuid?.() !== 0) return null;
    const { SUDO_UID, SUDO_GID } = process.env;
    if (!SUDO_UID || !SUDO_GID || !SUDO_ID.test(SUDO_UID) || !SUDO_ID.test(SUDO_GID)) return null;
    try {
        const home = homedir();
        let realHome = home;
        try {
            realHome = realpathSync(home);
        } catch {
            /* lexical home is all there is */
        }
        let realDir = dirname(path);
        try {
            realDir = realpathSync(realDir);
        } catch {
            /* not there yet: lexical parent is all there is */
        }
        if (!(realDir === realHome || realDir.startsWith(realHome + sep))) return null;
        if (statSync(home).uid !== Number(SUDO_UID)) return null;
    } catch {
        return null;
    }
    return { uid: Number(SUDO_UID), gid: Number(SUDO_GID) };
};

/**
 * Give a path root just created to the person who ran `sudo` (see `sudoOwner`). Best effort. The path
 * itself, never what a link points at: whoever owns the folder can put a link where the new file was,
 * and root following it would hand them a file of anyone's.
 */
export const handBackToSudoUser = (path: string): void => {
    const owner = sudoOwner(path);
    if (!owner) return;
    try {
        lchownSync(path, owner.uid, owner.gid);
    } catch { /* not ours to change */ }
};

/**
 * `mkdir -p`: every folder it makes, not only the last, goes to the person who ran `sudo` when root
 * makes it — a root-owned `~/.hwip` is one the next plain `hwip` cannot write in.
 */
export const mkdirHandedBack = (dir: string, mode?: number): void => {
    const made: string[] = [];
    for (let at = dir; !existsSync(at) && dirname(at) !== at; at = dirname(at)) made.push(at);
    mkdirSync(dir, { recursive: true, ...(mode === undefined ? {} : { mode }) });
    for (const path of made) handBackToSudoUser(path);
};

/**
 * Create `path` without following a link at its end, handing the new file back
 * when root made it (fd, never by name: a hardlink put there before shares the
 * inode, and `lchown` by name would hand that inode over too). EEXIST (taken
 * before, by anyone) and ELOOP (a link at the end) create nothing and hand
 * nothing back — fail closed.
 */
const createExclusiveHandedBack = (path: string, mode: number): 'created' | 'not-created' => {
    const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = constants;
    if (O_EXCL === undefined || O_NOFOLLOW === undefined) return 'not-created';
    let fd: number;
    try {
        fd = openSync(path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, mode);
    } catch {
        return 'not-created';
    }
    try {
        const owner = sudoOwner(path);
        if (owner) {
            try {
                fchownSync(fd, owner.uid, owner.gid);
            } catch { /* not ours to change */ }
        }
    } finally {
        closeSync(fd);
    }
    return 'created';
};

/**
 * Make sure `path` exists before a plain write fills it, handing it back when root made it. For a
 * caller whose write line is better left alone (it sits next to code others are changing); the
 * write that follows keeps the owner, since it opens the same file.
 */
export const createdHandedBack = (path: string): void => {
    if (existsSync(path)) return;
    createExclusiveHandedBack(path, 0o600);
};

/** `mkdir` without `-p`: fails with EEXIST when it is there, so the caller can tell who made it first. */
export const mkdirExclusiveHandedBack = (dir: string): void => {
    mkdirSync(dir, { recursive: false });
    handBackToSudoUser(dir);
};

/**
 * The directory exists and only its owner can enter it (0700). A symlink is left
 * as it is: it points at a folder that may be shared on purpose (dotfiles), and
 * what it points at is not ours to lock.
 *
 * Opened without following a link and changed through what was opened, so the folder looked at is the
 * one changed: by name, a link put there after the look got its target locked instead. Where the
 * platform has no such open (Windows, which has no such modes either), by name as before.
 *
 * A folder its owner cannot read (0377) cannot be opened, yet others may still write into it, so that one
 * too is changed by name — when it is a folder of the caller's own, and unless root runs this (by either of
 * its ids): root is who could lock a file of someone else's through a link put there after the look. A person
 * can only lock their own.
 */
export const ensurePrivateDir = (dir: string): void => {
    mkdirHandedBack(dir, 0o700);
    try {
        const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = constants;
        if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined) {
            if (!lstatSync(dir).isSymbolicLink()) chmodSync(dir, 0o700);
            return;
        }
        // A link here fails the open (ENOTDIR on macOS, seen 2026-10-14), which is the "left as it is" above.
        let fd: number;
        try {
            fd = openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (err) {
            const unreadable = err instanceof Error && 'code' in err && err.code === 'EACCES';
            const asRoot = process.geteuid?.() === 0 || process.getuid?.() === 0;
            if (!unreadable || asRoot) throw err;
            const seen = lstatSync(dir);
            const ownFolder = seen.isDirectory() && seen.uid === process.geteuid?.();
            if (ownFolder) chmodSync(dir, 0o700);
            return;
        }
        try {
            fchmodSync(fd, 0o700);
        } finally {
            closeSync(fd);
        }
    } catch { /* not ours to change */ }
};

/** The file exists and only its owner can read it (0600); its content is untouched. A link at the
 *  end is left as it is: creating its target and then fixing only the link would leave a file of
 *  someone's behind (C149 ②). An existing file is changed through an fd for the same reason. */
export const ensurePrivateFile = (path: string): void => {
    const existed = existsSync(path);
    if (!existed) {
        if (createExclusiveHandedBack(path, 0o600) === 'created') return;
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    } else if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return;
    }
    const { O_WRONLY, O_NOFOLLOW } = constants;
    if (O_NOFOLLOW === undefined) {
        // No link-safe primitives on this platform: the legacy by-name path stays.
        try {
            closeSync(openSync(path, 'a', 0o600));
            chmodSync(path, 0o600);
        } catch { /* not ours to change */ }
        return;
    }
    try {
        const fd = openSync(path, O_WRONLY | O_NOFOLLOW);
        try {
            fchmodSync(fd, 0o600);
        } finally {
            closeSync(fd);
        }
    } catch { /* link swapped in after the look, or not ours to change */ }
};
