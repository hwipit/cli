import { basename, extname } from 'path';

/**
 * Longest attachment name, in UTF-8 bytes. A filesystem takes 255 bytes of
 * name, not 255 characters, and `attachmentPath` may still add `-N` before the
 * extension: 200 leaves that room.
 */
export const MAX_ATTACHMENT_NAME_BYTES = 200;
/** An "extension" longer than any real one is part of the stem, so it is cut like the rest. */
const MAX_EXT_BYTES = 32;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Make a filesystem-safe single path segment from a name a phone sent: take
 * the basename (drops any `../` prefix), strip control chars and embedded
 * separators, remove leading dots, and fit the name to
 * `MAX_ATTACHMENT_NAME_BYTES` bytes — by code point, keeping the extension.
 * Empty/dot-only names use the fallback.
 */
export const fitAttachmentName = (raw: string, fallback: string): string => {
    const cleaned = basename(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    const name = cleaned || fallback;
    if (byteLength(name) <= MAX_ATTACHMENT_NAME_BYTES) return name;
    const rawExt = extname(name);
    const ext = byteLength(rawExt) <= MAX_EXT_BYTES ? rawExt : '';
    // One pass over the stem's code points, stopping at the budget: a name of any length costs no more than the cut.
    const budget = MAX_ATTACHMENT_NAME_BYTES - byteLength(ext);
    let stem = '';
    let used = 0;
    for (const point of ext ? name.slice(0, -ext.length) : name) {
        used += byteLength(point);
        if (used > budget) break;
        stem += point;
    }
    // The cut can leave a dot, a space or nothing: the rules above run once more on what is kept.
    const kept = stem.replace(/^\.+/, '').trim();
    return kept ? kept + ext : fallback;
};
