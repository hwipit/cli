/**
 * What a blocked Claude Code session is waiting for, read off its screen.
 *
 * The state detector (`agent-state.ts`) only says "blocked". The app wants to
 * draw the question: which tool, which command, which answers. This module
 * reads the approval dialog at the bottom of the pane into that summary. Pure:
 * the listener owns tmux, sealing and timing (`blocked-prompt-seal.ts`).
 *
 * Layout read (Claude Code, captured from a live session; see the fixtures in
 * `blocked-prompt.test.ts`):
 *
 *     ─────────────  full-width rule: the dialog starts below the last one
 *      Bash command  title
 *      Run shell command  subtitle (optional)
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌  dashed rule
 *      rtk ls -la .  detail (the command, or the diff of an edit)
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌
 *      This command requires approval  note (optional)
 *
 *      Do you want to proceed?  question
 *      ❯ 1. Yes  options, `❯` marks the highlighted one
 *        2. Yes, and don’t ask again for: rtk ls *
 *        3. No
 *
 *      Esc to cancel · Tab to amend  footer
 *
 * Only the titles in `KNOWN_TITLES` are read. Another dialog (a plan, a
 * question to the user, an MCP tool) has no captured layout, so it yields
 * nothing and the session keeps reporting the bare `blocked` state.
 */
import { createHash } from 'node:crypto';

/** Dialog titles whose layout was captured and is read. */
export const KNOWN_TITLES: readonly string[] = ['Bash command', 'Edit file', 'Create file'];

export const MAX_DETAIL_LINES = 12;
export const MAX_DETAIL_LINE_CHARS = 300;
export const MAX_LABEL_CHARS = 200;
export const MAX_OPTIONS = 9;
/** The plaintext a prompt is sealed from stays under this; the server's cap on the sealed body is 8 KiB. */
export const MAX_PROMPT_BYTES = 2 * 1024;

export interface PromptOption {
    /** The number the dialog shows. */
    n: number;
    label: string;
    /** Named keys (`ALLOWED_KEYS` in listener.ts) that pick this option from the highlight the pane shows now. */
    keys: string[];
    /** Choosing it grants more than this one request ("don't ask again", "always", "for this session"). */
    persistent?: true;
}

export interface ParsedPrompt {
    /** Hash of the dialog as shown, highlight included: moving the highlight is a different prompt. */
    id: string;
    title: string;
    subtitle?: string;
    detail: string[];
    detailTruncated?: true;
    note?: string;
    question: string;
    options: PromptOption[];
}

/** The shape of a prompt id on the wire: what `ifPrompt` may carry (the server checks the same). */
const PROMPT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isPromptId = (value: unknown): value is string => typeof value === 'string' && PROMPT_ID.test(value);

const FULL_RULE = /^─{20,}$/;
const DASHED_RULE = /^╌{20,}$/;
const OPTION = /^\s*([❯>])?\s*(\d{1,2})\.\s+(\S.*)$/;
const FOOTER = /^\s*(esc to cancel|enter to select)/i;
// A choice that grants more than this one request: "don't ask again", "always allow", "allow all edits during this
// session", "… for this session". Wider on purpose — a miss lets the app skip its extra confirmation.
const PERSISTENT = /don.?t ask again|never ask|always|allow all|this session|from now on/i;

/** The character the highlight is drawn with. A pane without it is not a dialog this module can answer. */
const HIGHLIGHT = '❯';

const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    const head = text.slice(0, max);
    const last = head.charCodeAt(head.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
};

const idOf = (region: readonly string[]): string => createHash('sha256').update(region.join('\n')).digest('hex').slice(0, 16);

/** `down`×k or `up`×k to reach option `to` from option `from`, then `enter`. */
const keysFor = (from: number, to: number): string[] =>
    [...Array(Math.abs(to - from)).fill(to > from ? 'down' : 'up'), 'enter'];

/** The dialog at the bottom of `pane`, or undefined when it is not one this module reads. */
export const parseBlockedDialog = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    // The question is the last "…?" line whose next non-blank line is option 1.
    let qAt = -1;
    for (let i = lines.length - 2; i >= 0; i--) {
        if (!lines[i]!.endsWith('?')) continue;
        const next = lines.slice(i + 1).find((l) => l !== '');
        if (next !== undefined && OPTION.exec(next)?.[2] === '1') { qAt = i; break; }
    }
    if (qAt < 0) return undefined;

    // The dialog starts below the last full-width rule above the question and ends at its footer;
    // whatever the terminal draws below (a status line, its own rule) is not part of it.
    let top = -1;
    for (let i = qAt - 1; i >= 0; i--) {
        if (FULL_RULE.test(lines[i]!)) { top = i; break; }
    }
    if (top < 0) return undefined;
    let end = lines.length;
    while (end > qAt + 1 && lines[end - 1] === '') end--;
    for (let i = qAt + 1; i < end; i++) {
        if (FOOTER.test(lines[i]!)) { end = i + 1; break; }
    }
    const region = lines.slice(top + 1, end);
    const q = qAt - (top + 1);

    const options: { n: number; label: string; selected: boolean }[] = [];
    for (const line of region.slice(q + 1)) {
        if (line === '' || FOOTER.test(line)) continue;
        const m = OPTION.exec(line);
        if (m) {
            options.push({ n: Number(m[2]), label: m[3]!.trim(), selected: m[1] === HIGHLIGHT });
        } else if (options.length > 0 && /^\s{3,}\S/.test(line)) {
            // A long label wraps onto an indented line.
            const last = options[options.length - 1]!;
            last.label = `${last.label} ${line.trim()}`;
        } else {
            return undefined;
        }
    }
    if (options.length < 2 || options.length > MAX_OPTIONS) return undefined;
    if (!options.every((o, i) => o.n === i + 1)) return undefined;
    const selected = options.findIndex((o) => o.selected);
    if (selected < 0 || options.filter((o) => o.selected).length !== 1) return undefined;

    // Above the question: title, subtitle, dashed rule, detail, dashed rule, note.
    const head = region.slice(0, q);
    const title = head.find((l) => l.trim() !== '')?.trim();
    if (!title || !KNOWN_TITLES.includes(title)) return undefined;
    const body = head.slice(head.findIndex((l) => l.trim() !== '') + 1);
    const firstDash = body.findIndex((l) => DASHED_RULE.test(l));
    const before = (firstDash < 0 ? body : body.slice(0, firstDash)).map((l) => l.trim()).filter(Boolean);
    const rest = firstDash < 0 ? [] : body.slice(firstDash + 1);
    const secondDash = rest.findIndex((l) => DASHED_RULE.test(l));
    const detailLines = (secondDash < 0 ? rest : rest.slice(0, secondDash)).map((l) => l.replace(/^ /, ''));
    while (detailLines.length > 0 && detailLines[detailLines.length - 1]!.trim() === '') detailLines.pop();
    const after = secondDash < 0 ? [] : rest.slice(secondDash + 1).map((l) => l.trim()).filter(Boolean);

    const prompt: ParsedPrompt = {
        id: idOf(region),
        title,
        detail: detailLines.slice(0, MAX_DETAIL_LINES).map((l) => cut(l, MAX_DETAIL_LINE_CHARS)),
        question: cut(region[q]!.trim(), MAX_LABEL_CHARS),
        options: options.map((o, i) => ({
            n: o.n,
            label: cut(o.label, MAX_LABEL_CHARS),
            keys: keysFor(selected, i),
            ...(PERSISTENT.test(o.label) ? { persistent: true as const } : {}),
        })),
    };
    if (before.length > 0) prompt.subtitle = cut(before.join(' '), MAX_LABEL_CHARS);
    if (after.length > 0) prompt.note = cut(after.join(' '), MAX_LABEL_CHARS);
    if (detailLines.length > MAX_DETAIL_LINES || detailLines.some((l) => l.length > MAX_DETAIL_LINE_CHARS)) {
        prompt.detailTruncated = true;
    }
    return prompt;
};

/** What the app opens: the prompt plus which session and listener it belongs to, and when it was first seen. */
export interface PromptPlaintext {
    v: 1;
    sessionName: string;
    deviceId: string;
    at: string;
    id: string;
    kind: 'permission';
    title: string;
    subtitle?: string;
    detail: string[];
    detailTruncated?: true;
    note?: string;
    question: string;
    options: PromptOption[];
}

/**
 * The JSON to seal, within MAX_PROMPT_BYTES: detail lines go from the end until it fits.
 * Undefined when even a prompt without detail does not fit.
 */
export const promptPlaintext = (
    prompt: ParsedPrompt,
    ctx: { sessionName: string; deviceId: string; at: string },
): string | undefined => {
    const { id, ...fields } = prompt;
    const base: PromptPlaintext = { v: 1, ...ctx, id, kind: 'permission', ...fields };
    let json = JSON.stringify(base);
    while (Buffer.byteLength(json) > MAX_PROMPT_BYTES) {
        if (base.detail.length === 0) return undefined;
        base.detail = base.detail.slice(0, -1);
        base.detailTruncated = true;
        json = JSON.stringify(base);
    }
    return json;
};
