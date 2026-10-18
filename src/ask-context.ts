/**
 * The context a sealed question could carry: what the session changed (git diff against HEAD) and what its
 * terminal shows, masked and held to one size. Nothing here sends anything or touches a wire; a caller that
 * seals the result owns that. The git half reuses `session-diff.ts` (which keeps `.gitignore`d files, filtered
 * files and oversized trees out) and the masking half reuses `secret-mask.ts` — there is no git or mask logic
 * of its own.
 *
 * Two parts, because they travel differently: `summary` is small and rides in a sealed body, `original` is the
 * text itself and is sized for one sealed attachment.
 */

import {
    collectDiffFiles,
    collectFilePatch,
    repoRootOf,
    type DiffFileEntry,
    type DiffResult,
} from './session-diff.js';
import { maskText } from './secret-mask.js';

/** What `original` may weigh once serialized as JSON, in bytes. */
export const ASK_CONTEXT_MAX_BYTES = 64 * 1024;
/** Lines of the terminal screen that are kept (the last ones). */
export const ASK_CONTEXT_SCREEN_LINES = 60;
/** What the screen may weigh once serialized as JSON, in bytes. */
export const ASK_CONTEXT_SCREEN_MAX_BYTES = 8 * 1024;
/** Files the summary lists by name. */
export const ASK_CONTEXT_SUMMARY_FILES = 20;
/** What `summary` may weigh once serialized as JSON, in bytes; listed files past it are counted in `moreFiles` instead. */
export const ASK_CONTEXT_SUMMARY_MAX_BYTES = 4 * 1024;
/** Longest path the summary shows, in bytes; a longer one is cut (the summary rides in a size-capped body). */
const SUMMARY_PATH_MAX_BYTES = 128;
/** Lines of the screen that are read and masked before the last ones are picked, so a key block that began above the picked lines still hides. */
export const ASK_CONTEXT_SCREEN_WINDOW_LINES = 500;
/** How long gathering may spend asking git for patches. */
const GATHER_BUDGET_MS = 5_000;
const CUT_MARKER = '[hwip: cut]\n';

export interface AskContextSummary {
    /** `ok` the diff half is there; `no_repo` the directory is in no repository; `failed` git could not answer. */
    diff: 'ok' | 'no_repo' | 'failed';
    files: number;
    added: number;
    removed: number;
    listed: Array<Pick<DiffFileEntry, 'path' | 'status' | 'added' | 'removed' | 'binary'>>;
    /** Files changed that are not in `listed`. */
    moreFiles: number;
    screenLines: number;
    /** Secret-looking spots masked in the text that was read (a spot in a cut-off part counts too). */
    masked: number;
    /** Whether the diff / the screen holds less than there was (files left out, a patch cut, screen rows scrolled off or dropped). */
    cut: { diff: boolean; screen: boolean };
}

export interface AskContext {
    summary: AskContextSummary;
    original: { diff: string; screen: string };
}

export interface AskContextInput {
    files: DiffFileEntry[];
    /** Git had more changed files than `files` holds. */
    truncated?: boolean;
    /** One file's masked patch; `null` when it could not be read. An empty text is a file with no patch (binary, filtered). */
    patchOf: (path: string) => { text: string; masked: number } | null;
    /** The terminal screen as captured, not yet masked. */
    screen: string | null;
    diff?: AskContextSummary['diff'];
}

/** Bytes `text` takes inside a JSON string (quotes not counted): newlines, quotes and control characters cost more than one. */
const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

/** What `original` weighs once serialized. */
export const askContextBytes = (ctx: Pick<AskContext, 'original'>): number => Buffer.byteLength(JSON.stringify(ctx.original));

/** The last lines of a screen, masked and held to the screen budget. Blank rows under the last text are not lines. */
const composeScreen = (screen: string | null): { text: string; lines: number; masked: number; cut: boolean } => {
    const rows = (screen ?? '').split('\n').map((row) => row.replace(/\r$/, ''));
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
    // Mask the window as a whole before picking its last lines: the BEGIN of a key block may sit above them.
    const masked = maskText(rows.slice(-ASK_CONTEXT_SCREEN_WINDOW_LINES).join('\n'));
    const kept = masked.text === '' ? [] : masked.text.split('\n').slice(-ASK_CONTEXT_SCREEN_LINES);
    let bytes = kept.reduce((sum, row) => sum + jsonBytes(row) + 2, -2);
    let cut = masked.text !== '' && masked.text.split('\n').length > kept.length;
    while (kept.length > 1 && bytes > ASK_CONTEXT_SCREEN_MAX_BYTES) {
        bytes -= jsonBytes(kept.shift() as string) + 2;
        cut = true;
    }
    // One line that is over the budget on its own: its start stays (it is masked already, so a cut leaves no secret's head).
    if (kept.length === 1 && jsonBytes(kept[0]) > ASK_CONTEXT_SCREEN_MAX_BYTES) {
        while (jsonBytes(kept[0]) > ASK_CONTEXT_SCREEN_MAX_BYTES) kept[0] = kept[0].slice(0, Math.floor(kept[0].length * 0.9));
        cut = true;
    }
    return { text: kept.join('\n'), lines: kept.length, masked: masked.masked, cut };
};

/** `text` up to the last whole line that fits `room` JSON bytes. */
const wholeLinesWithin = (text: string, room: number): string => {
    let used = 0;
    let end = 0;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        used += jsonBytes(line);
        if (used > room) break;
        end += line.length;
    }
    return text.slice(0, end);
};

/** The patches of the files, in order, up to `budget` JSON bytes; a patch that does not fit is cut at a line and the rest is not asked for. */
const composeDiff = (
    input: Pick<AskContextInput, 'files' | 'patchOf'>,
    budget: number,
): { text: string; masked: number; cut: boolean } => {
    let text = '';
    let masked = 0;
    let unread = false;
    let room = budget - jsonBytes(CUT_MARKER);
    for (const entry of input.files) {
        if (room <= 0) return { text: text + CUT_MARKER, masked, cut: true };
        const patch = input.patchOf(entry.path);
        if (!patch) {
            unread = true;
            continue;
        }
        if (patch.text === '') continue;
        masked += patch.masked;
        const whole = patch.text.endsWith('\n') ? patch.text : `${patch.text}\n`;
        if (jsonBytes(whole) <= room) {
            text += whole;
            room -= jsonBytes(whole);
            continue;
        }
        return { text: text + wholeLinesWithin(whole, room) + CUT_MARKER, masked, cut: true };
    }
    return { text, masked, cut: unread };
};

/** A path over the limit is cut between characters and marked with `…`; the mark counts, so what is shown never passes `SUMMARY_PATH_MAX_BYTES` (the reader of the summary refuses a longer one). */
const summaryPath = (path: string): string => {
    if (Buffer.byteLength(path) <= SUMMARY_PATH_MAX_BYTES) return path;
    const room = SUMMARY_PATH_MAX_BYTES - Buffer.byteLength('…');
    let kept = '';
    let bytes = 0;
    for (const char of path) {
        bytes += Buffer.byteLength(char);
        if (bytes > room) break;
        kept += char;
    }
    return `${kept}…`;
};

/** The context for the files changed and the screen shown. Pure: same input, same value, nothing is read or sent. */
export const composeAskContext = (input: AskContextInput): AskContext => {
    const screen = composeScreen(input.screen);
    const room = ASK_CONTEXT_MAX_BYTES - askContextBytes({ original: { diff: '', screen: screen.text } });
    const diff = composeDiff(input, room);
    const listed = input.files.slice(0, ASK_CONTEXT_SUMMARY_FILES).map((f) => ({
        path: summaryPath(f.path),
        status: f.status,
        added: f.added,
        removed: f.removed,
        ...(f.binary ? { binary: true as const } : {}),
    }));
    const added = input.files.reduce((sum, f) => sum + f.added, 0);
    const removed = input.files.reduce((sum, f) => sum + f.removed, 0);
    const summaryWith = (count: number): AskContextSummary => ({
        diff: input.diff ?? 'ok',
        files: input.files.length,
        added,
        removed,
        listed: listed.slice(0, count),
        moreFiles: input.files.length - count,
        screenLines: screen.lines,
        masked: diff.masked + screen.masked,
        cut: { diff: diff.cut || input.truncated === true, screen: screen.cut },
    });
    // A path of escapes (control characters cost six bytes each in JSON) can take the list far past its budget.
    let count = listed.length;
    while (count > 0 && Buffer.byteLength(JSON.stringify(summaryWith(count))) > ASK_CONTEXT_SUMMARY_MAX_BYTES) count -= 1;
    return { summary: summaryWith(count), original: { diff: diff.text, screen: screen.text } };
};

export interface GatherDeps {
    repoRootOf: (cwd: string) => string | null;
    collectDiffFiles: (root: string, base: 'head') => DiffResult<{ files: DiffFileEntry[]; truncated: boolean }>;
    collectFilePatch: (root: string, base: 'head', path: string) => DiffResult<{ text: string; masked: number }>;
    now: () => number;
}

const LIVE_DEPS: GatherDeps = { repoRootOf, collectDiffFiles, collectFilePatch, now: Date.now };

/**
 * The context of the session at `cwd`: the changes against HEAD (new files included) and `screen`. `null` when
 * there is neither a change nor a screen — nothing to carry. A directory outside a repository, or a git that
 * cannot answer, leaves the screen alone and says so in `summary.diff`.
 */
export const gatherAskContext = (cwd: string, screen: string | null, overrides: Partial<GatherDeps> = {}): AskContext | null => {
    const deps: GatherDeps = { ...LIVE_DEPS, ...overrides };
    const root = deps.repoRootOf(cwd);
    const listing = root ? deps.collectDiffFiles(root, 'head') : null;
    const diff: AskContextSummary['diff'] = !root ? 'no_repo' : listing?.ok ? 'ok' : 'failed';
    const gaveUp = deps.now() + GATHER_BUDGET_MS;
    const ctx = composeAskContext({
        files: listing?.ok ? listing.files : [],
        truncated: listing?.ok ? listing.truncated : false,
        patchOf: (path) => {
            if (!root || deps.now() > gaveUp) return null;
            const patch = deps.collectFilePatch(root, 'head', path);
            return patch.ok ? { text: patch.text, masked: patch.masked } : null;
        },
        screen,
        diff,
    });
    return ctx.summary.files === 0 && ctx.original.screen === '' ? null : ctx;
};
