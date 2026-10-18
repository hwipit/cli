import { spawnSync } from 'child_process';
import { existsSync, readdirSync, realpathSync } from 'fs';
import { userInfo } from 'os';
import { log } from './listener-log.js';

// ─── tmux socket discovery ──────────────────────────────────────────

/**
 * macOS sets a per-user `TMPDIR` like `/var/folders/xz/.../T/`, and tmux
 * (started from a regular shell there) lays its socket at
 * `<TMPDIR>/tmux-<uid>/default`. When the listener is spawned from a
 * shell with a different TMPDIR — or no TMPDIR at all (cron, launchd,
 * IDE-managed terminals) — tmux defaults to `/tmp/tmux-<uid>/default`
 * and the user's real server is invisible. We probe a small list of
 * common locations and use `-S <path>` for every subsequent tmux call
 * once a live server is found.
 *
 * Caching is one-way: a successful discovery sticks for the process
 * lifetime, but failure does NOT — we re-probe every cycle so the
 * listener picks up a tmux server that gets started AFTER the listener
 * itself (very common: the user opens `hwip cc` after starting the
 * daemon). If tmux dies and respawns under a different path the user
 * has to restart the listener (rare).
 */
let cachedSocketPath: string | null = null;
/** True once we've confirmed a working socket. `cachedSocketPath` of
 *  `null` is ambiguous on its own — it can mean either "use default
 *  (we verified it works)" or "we haven't checked yet". This flag
 *  removes the ambiguity so we don't re-probe every collectSessions
 *  cycle (which was spamming the log with "tmux: default socket OK"). */
let cacheValid = false;

/**
 * Mark the cached socket as no longer trustworthy — call this when a
 * tmux command fails against the cached path. The next findTmuxSocket()
 * will redo full discovery (default probe → /var/folders walk → lsof
 * fallback) instead of returning a stale answer. Without this the
 * listener wedged at "reported 0 session(s)" forever after a tmux
 * server restart, even when a new server was live and discoverable.
 */
export const invalidateTmuxSocketCache = (): void => {
    cacheValid = false;
    cachedSocketPath = null;
};

interface ProbeResult {
    ok: boolean;
    stderr?: string;
}

const probeTmuxSocketDetail = (socketPath: string | null): ProbeResult => {
    const args = socketPath ? ['-S', socketPath, 'list-sessions'] : ['list-sessions'];
    const r = spawnSync('tmux', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return { ok: true };
    const err = ((r.stderr ?? '') as string).trim();
    return { ok: false, stderr: err || undefined };
};

const probeTmuxSocket = (socketPath: string | null): boolean =>
    probeTmuxSocketDetail(socketPath).ok;

/**
 * List every socket file inside a `tmux-<uid>/` directory. tmux's
 * default socket name is `default`, but users can change it with
 * `tmux -L <name>` or via .tmux.conf — so we probe every file we find,
 * not just `default`. Returns absolute socket paths.
 */
const listSocketsIn = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir).map((name) => `${dir}/${name}`); }
    catch { return []; }
};

/**
 * One name per socket file: the path with its symlinks resolved, or the path
 * as given when nothing is there to resolve. macOS reaches the same directory
 * as `/tmp/…` and `/private/tmp/…`, and as `/var/folders/…` and
 * `/private/var/folders/…`; without this each dead socket there is probed
 * once per spelling.
 */
export const socketKey = (path: string): string => {
    try { return realpathSync(path); } catch { return path; }
};

/**
 * Final-fallback socket discovery: find tmux server processes via `ps`
 * and ask `lsof` what unix socket each is bound to. Handles the cases
 * filesystem walking can't:
 *   - macOS auto-cleanup deleted the socket file while the server kept
 *     running (the most likely cause of "no server running" errors when
 *     a tmux session is clearly alive in another iTerm/Warp pane)
 *   - The user runs tmux with `-L <name>` or `-S <unusual-path>` that we
 *     never thought to enumerate
 *
 * `lsof` on macOS may report sockets as `(deleted)`. Even then, if the
 * server still has the inode open we can still tmux-attach by recreating
 * the path — but for now we only return paths that still exist on disk
 * so tmux's connect logic isn't confused. If the path is gone, the user
 * has to `tmux kill-server` + restart anyway.
 *
 * Returns the first path `isLive` accepts, and stops there: every tmux
 * process — each `tmux new -A` client, not only the server — costs one
 * `lsof`, seconds apiece on a loaded daemon.
 */
const findTmuxViaProcess = (isLive: (path: string) => boolean): string | undefined => {
    const username = userInfo().username;
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,user=,command='], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ps.status !== 0) return undefined;

    const tmuxPids: string[] = [];
    for (const line of (ps.stdout ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const [, pid, user, cmd] = m;
        if (user !== username) continue;
        // Server processes show up as `tmux: server` (with the colon) on
        // some versions; client/wrapper invocations show up as `tmux new`
        // / `tmux attach` etc. lsof works on either.
        if (!/(^|[^\w-])tmux($|[:\s])/.test(cmd)) continue;
        tmuxPids.push(pid);
    }
    for (const pid of tmuxPids) {
        const lsof = spawnSync('lsof', ['-p', pid, '-Fn'], {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (lsof.status !== 0) continue;
        // `-Fn` prints names prefixed with `n`; one per line. Filter for
        // tmux-shaped socket paths.
        for (const lline of (lsof.stdout ?? '').split('\n')) {
            if (!lline.startsWith('n')) continue;
            const path = lline.slice(1);
            if (!/\/tmux-\d+\//.test(path)) continue;
            if (path.includes('(deleted)')) continue;
            if (isLive(path)) return path;
        }
    }
    return undefined;
};

/** Walk `/var/folders` for user-owned `tmux-<uid>/*` socket files. Each
 * subdir is wrapped in its own try/catch — entries that belong to other
 * users (or that we otherwise can't read) must skip cleanly, not abort
 * the whole walk. */
const walkVarFolders = (uid: number): string[] => {
    const found: string[] = [];
    const root = '/var/folders';
    if (!existsSync(root)) return found;
    let topEntries: string[];
    try { topEntries = readdirSync(root); } catch { return found; }
    for (const a of topEntries) {
        const aPath = `${root}/${a}`;
        let subEntries: string[];
        try { subEntries = readdirSync(aPath); } catch { continue; }
        for (const b of subEntries) {
            found.push(...listSocketsIn(`${aPath}/${b}/T/tmux-${uid}`));
        }
    }
    return found;
};

/**
 * Track whether the "no server anywhere" diagnostic was already logged
 * this run. We want the user to see the path list *once* on first
 * failure, then go quiet until we either find a server or notice a new
 * candidate file appearing — otherwise every 30-s cycle would spam the
 * full probe report.
 */
let warnedNoServer = false;

const findTmuxSocket = (): string | null => {
    // Successful discovery sticks. Failure does NOT — we want to pick
    // up a tmux server that the user launches *after* `hwip listener`.
    if (cacheValid) return cachedSocketPath;

    // Explicit override — for users with `tmux -L <name>` setups or
    // unusual socket locations. Skip discovery entirely if set and
    // probeable.
    const override = process.env.HWIP_TMUX_SOCKET;
    if (override) {
        if (probeTmuxSocket(override)) {
            cachedSocketPath = override;
            cacheValid = true;
            log(`tmux socket → ${override} (from HWIP_TMUX_SOCKET)`);
            warnedNoServer = false;
            return override;
        }
        // Fall through to standard discovery if override fails — better
        // than failing silently. We re-log this every cycle (no
        // `warnedNoServer`) because it's a user-supplied setting we want
        // to keep nagging about.
        log(`tmux: HWIP_TMUX_SOCKET=${override} probe failed, falling back to auto-discovery`);
    }

    // Default first — succeeds when the shell that launched us shares
    // tmux's view, and costs one tmux call. It must run before the scans
    // below: `findTmuxViaProcess` runs up to one `lsof` per tmux process (every
    // `tmux new -A` client, not just the server), which took 11–19s+ with 14
    // sessions on a loaded daemon — longer than a fresh inventory worker's
    // whole 20s budget.
    if (probeTmuxSocket(null)) {
        cachedSocketPath = null; // null means "use default"
        cacheValid = true;
        if (!warnedNoServer) log('tmux: default socket OK');
        warnedNoServer = false;
        return null;
    }

    const uid = userInfo().uid;
    const probed = new Set<string>();
    const isLive = (path: string): boolean => {
        const key = socketKey(path);
        if (probed.has(key)) return false;
        probed.add(key);
        return existsSync(path) && probeTmuxSocket(path);
    };

    // Every socket file in any `tmux-<uid>/` dir next — `tmux -L <name>`
    // puts its socket beside `default`, so one probe per file finds it.
    const envDir = process.env.TMUX_TMPDIR || process.env.TMPDIR;
    const files = [
        ...(envDir ? listSocketsIn(`${envDir.replace(/\/+$/, '')}/tmux-${uid}`) : []),
        ...walkVarFolders(uid),
        ...listSocketsIn(`/tmp/tmux-${uid}`),
        ...listSocketsIn(`/private/tmp/tmux-${uid}`),
    ];

    // Process-based discovery last — it is the only path that finds a `-S`
    // path the walks never look in, but it is also the one that costs seconds.
    const live = files.find(isLive) ?? findTmuxViaProcess(isLive);
    if (live) {
        cachedSocketPath = live;
        cacheValid = true;
        log(`tmux socket → ${live}`);
        warnedNoServer = false;
        return live;
    }
    const unique = [...probed];

    // No live tmux yet. Log the full probe report once, then stay quiet
    // until something works — otherwise the user gets a 4-line dump
    // every 30 seconds while they're still bringing tmux up. Include the
    // tmux binary identification + stderr for failed probes so the user
    // can spot version mismatches (homebrew on /usr/local vs /opt/homebrew)
    // or stale socket files.
    if (!warnedNoServer) {
        const which = spawnSync('which', ['tmux'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxPath = (which.stdout ?? '').trim() || '(not on PATH)';
        const ver = spawnSync('tmux', ['-V'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxVer = (ver.stdout ?? '').trim() || '?';
        log(`tmux: no live server yet — using ${tmuxPath} (${tmuxVer})`);
        log(`tmux: probed ${unique.length} candidate(s):`);
        for (const path of unique) {
            if (!existsSync(path)) {
                log(`  - ${path}  (no socket file)`);
                continue;
            }
            const detail = probeTmuxSocketDetail(path);
            log(`  ✗ ${path}  (${detail.stderr ?? 'probe failed without stderr'})`);
        }
        log(`tmux: will retry each cycle. If your tmux uses a custom socket,`);
        log(`     run \`tmux info | head -1\` in the same shell as 'hwip cc'`);
        log(`     and pass it via:  HWIP_TMUX_SOCKET=<path> hwip listener`);
        warnedNoServer = true;
    }
    return null;
};

/** Prepend `-S <socket>` when we've discovered a non-default tmux server. */
export const tmuxArgs = (args: string[]): string[] => {
    const sock = findTmuxSocket();
    return sock ? ['-S', sock, ...args] : args;
};
