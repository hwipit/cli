import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { VERSION } from './config.js';
import { flagOn } from './args.js';

// Compares installed versions against the npm registry. Pure read-only —
// never installs anything; just tells the user if a newer release exists.

const PACKAGES = ['@hwip/cli', '@hwip/mcp-server'] as const;

/**
 * How to update. A global install is what `hwip` on PATH runs — `npx @hwip/cli
 * install` only re-ran setup from a fresh download and left it as it was —
 * and the daemon keeps the old build until it restarts.
 */
export const UPDATE_HINT = 'npm i -g @hwip/cli — the next `hwip cc` restarts the listener on it (or run: hwip listener --restart)';

/** Fetch the `latest` dist-tag version for a package from the npm registry. */
const fetchLatest = async (pkg: string, timeoutMs = 10_000): Promise<string | null> => {
    try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const json = await res.json() as { version?: string };
        return json.version ?? null;
    } catch {
        return null;
    }
};

/** Semver-ish compare: returns true when `latest` is strictly newer than `current`. */
export const isNewer = (latest: string, current: string): boolean => {
    const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [norm(latest), norm(current)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
        if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
    }
    return false;
};

/**
 * The mcp-server version this CLI will actually run. It ships as a dependency
 * (see mcp.ts), so it is pinned at install time — no longer "whatever npx
 * fetched last". Returns null on a broken install rather than throwing; the
 * report degrades to "latest is vX" the way it always did for this package.
 */
export const installedMcpServerVersion = (): string | null => {
    try {
        const pkg = JSON.parse(
            readFileSync(require.resolve('@hwip/mcp-server/package.json'), 'utf-8'),
        ) as { version?: string };
        return pkg.version ?? null;
    } catch {
        return null;
    }
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last registry answer for @hwip/cli, so the notice costs a request a day at most. */
type UpdateCache = { checkedAt: number; latest: string | null };

const updateCacheFile = (): string => join(homedir(), '.hwip', 'update-check.json');

const readUpdateCache = (file: string): UpdateCache | null => {
    try {
        const data = JSON.parse(readFileSync(file, 'utf-8')) as Partial<UpdateCache>;
        return typeof data.checkedAt === 'number' ? { checkedAt: data.checkedAt, latest: data.latest ?? null } : null;
    } catch {
        return null;
    }
};

const writeUpdateCache = (file: string, cache: UpdateCache): void => {
    try {
        mkdirHandedBack(dirname(file));
        writeFileSync(file, JSON.stringify(cache) + '\n');
        handBackToSudoUser(file);
    } catch { /* a notice is not worth failing over */ }
};

/**
 * One line for `hwip cc` when a newer CLI is out, or undefined. Asks npm at
 * most once a day, briefly, and remembers the answer; an offline day keeps
 * the last known version rather than asking again on every launch.
 */
export const cachedUpdateNotice = async (deps: {
    now?: () => number;
    latest?: () => Promise<string | null>;
    file?: string;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<string | undefined> => {
    const now = (deps.now ?? Date.now)();
    const file = deps.file ?? updateCacheFile();
    // CI and anyone who opts out never reach the registry from `hwip cc`.
    const env = deps.env ?? process.env;
    if (env.CI || env.HWIP_NO_UPDATE_CHECK) return undefined;
    let cache = readUpdateCache(file);
    // A checkedAt in the future (clock skew, a hand-edited file) counts as stale.
    if (!cache || now - cache.checkedAt >= DAY_MS || cache.checkedAt > now) {
        const latest = await (deps.latest ?? (() => fetchLatest('@hwip/cli', 1_500)))();
        cache = { checkedAt: now, latest: latest ?? cache?.latest ?? null };
        writeUpdateCache(file, cache);
    }
    if (!cache.latest || !isNewer(cache.latest, VERSION)) return undefined;
    return `hwip: v${cache.latest} is out (this is v${VERSION}). Update: ${UPDATE_HINT}`;
};

export const handleCheckUpdate = async (args: Record<string, string | boolean>): Promise<number> => {
    const isJson = flagOn(args, 'json');

    // Both installed versions are knowable: the CLI's from its own
    // package.json, and mcp-server's because `hwip mcp` runs it in-process,
    // which makes it a dependency rather than an npx download of unknown age.
    // Two unrelated registry round-trips — awaiting them one after the other
    // doubled the command's wall time for nothing.
    const latestVersions = await Promise.all(PACKAGES.map((pkg) => fetchLatest(pkg)));
    // A fresh answer is as good as the daily one `hwip cc` would fetch.
    if (latestVersions[0]) writeUpdateCache(updateCacheFile(), { checkedAt: Date.now(), latest: latestVersions[0] });

    const results = PACKAGES.map((pkg, i) => {
        const latest = latestVersions[i];
        const current = pkg === '@hwip/cli' ? VERSION : installedMcpServerVersion();
        return { pkg, current, latest, outdated: !!(latest && current && isNewer(latest, current)) };
    });

    if (isJson) {
        console.log(JSON.stringify({ results }, null, 2));
        return 0;
    }

    console.log('\n  Hwip — update check\n');
    let anyOutdated = false;
    for (const r of results) {
        if (!r.latest) {
            console.log(`    ?  ${r.pkg}: could not reach npm registry`);
            continue;
        }
        if (r.current === null) {
            console.log(`    •  ${r.pkg}: latest is v${r.latest}`);
        } else if (r.outdated) {
            anyOutdated = true;
            console.log(`    ⬆  ${r.pkg}: v${r.current} → v${r.latest} (update available)`);
        } else {
            console.log(`    ✓  ${r.pkg}: v${r.current} (up to date)`);
        }
    }

    if (anyOutdated) {
        console.log(`\n  Update with: ${UPDATE_HINT}\n`);
    } else {
        console.log('');
    }
    return 0;
};
