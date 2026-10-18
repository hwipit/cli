import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * Where a file push addressed to this machine lands (ADR-0013): a flat
 * `~/Downloads/Hwip/`, never garbage-collected — it is the user's folder,
 * not the daemon's cache. `~/.hwip/attachments/` stays what it is: the
 * `agent.command` scratch space with the hourly sweep.
 */

export const downloadsDir = (): string => join(homedir(), 'Downloads', 'Hwip');

/** The temp name `saveStream` (file-crypto.ts) streams a download into. */
const PART_FILE = /^\.hwip-[0-9a-f]{12}\.part$/;

/**
 * A `.part` untouched this long has no download behind it: a live one is
 * written to at least every minute (DOWNLOAD_IDLE_MS) or aborted.
 */
const STALE_PART_MS = 60 * 60 * 1000;

/**
 * Remove the `.part` files a daemon that died mid-download left in the
 * downloads folder — up to 1 GiB each, hidden, and nothing else ever
 * removes them. Only our own temp names, only plain files, only stale ones;
 * the user's files in the folder are never looked at. Returns how many went.
 */
export const sweepStaleParts = (dir: string = downloadsDir(), now: number = Date.now()): number => {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return 0; // no downloads yet
    }
    let removed = 0;
    for (const name of entries) {
        if (!PART_FILE.test(name)) continue;
        const path = join(dir, name);
        try {
            const st = lstatSync(path);
            if (!st.isFile() || now - st.mtimeMs < STALE_PART_MS) continue;
            unlinkSync(path);
            removed++;
        } catch { /* gone already, or not ours to remove */ }
    }
    return removed;
};

/** Longest name most filesystems take; the suffix has to fit inside it too. */
const MAX_NAME_BYTES = 255;
/** `.tar.gz`-class extensions are ~8 bytes; nothing real is near this. */
const MAX_EXT_BYTES = 32;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Trim `stem` until `stem + tail` fits MAX_NAME_BYTES, never splitting a code point. */
const fitStem = (stem: string, tail: string): string => {
    let out = stem;
    while (out.length > 0 && byteLength(out) + byteLength(tail) > MAX_NAME_BYTES) {
        out = Array.from(out).slice(0, -1).join('');
    }
    return out;
};

/**
 * Reduce whatever the sender called the file to one safe path segment:
 * basename (so `../../x` and absolute paths lose their directories),
 * no control characters or separators, no leading dots (a hidden file
 * is not what the user asked to receive), `file` when nothing is left.
 */
export const safeFileName = (raw: string): string => {
    const cleaned = basename(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return cleaned || 'file';
};

/**
 * Absolute path to write `fileName` under `dir`, never overwriting: an
 * existing `a.png` yields `a (2).png`, then `a (3).png`. The counter starts
 * at 2 because the first copy has no suffix — that is the convention macOS
 * and the browsers use, and the one users already read.
 */
export const resolveDownloadPath = (
    fileName: string,
    dir: string = downloadsDir(),
    exists: (path: string) => boolean = existsSync,
): string => {
    const safe = safeFileName(fileName);
    // An "extension" longer than any real one is a sender playing with the
    // trimming rule: treat it as part of the stem so it gets cut like the rest.
    const rawExt = extname(safe);
    const ext = byteLength(rawExt) <= MAX_EXT_BYTES ? rawExt : '';
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    // The trim can empty the stem and leave `.ext` — a hidden file — so the
    // name rules run once more on what is actually written.
    const nameFor = (tail: string): string => safeFileName(fitStem(stem, tail) + tail);
    const first = join(dir, nameFor(ext));
    if (!exists(first)) return first;
    for (let n = 2; ; n++) {
        const candidate = join(dir, nameFor(` (${n})${ext}`));
        if (!exists(candidate)) return candidate;
    }
};
