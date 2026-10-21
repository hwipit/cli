/**
 * What a blocked agent session is waiting for, read off its screen.
 *
 * The state detector (`agent-state.ts`) only says "blocked". The app wants to
 * draw the question: which tool, which command, which answers. This module
 * reads the approval dialog at the bottom of the pane into that summary, with a
 * reader per agent kind (`parseBlockedDialog`). Pure: the listener owns tmux,
 * sealing and timing (`blocked-prompt-seal.ts`).
 *
 * The pane may carry terminal escapes (`tmux capture-pane -e`): OpenCode marks its
 * chosen button with a background colour only. Every other reader works on the
 * text with them stripped, so its ids are those of a plain capture.
 *
 * Claude Code layout (captured from a live session; see the fixtures in
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
 *
 * Gemini CLI layout (v0.46.0, `blocked-prompt-gemini.test.ts`): one rounded box,
 * a `? <Tool>  <summary>` header (a right-aligned `N of M` when approvals queue),
 * the command or diff in a nested box, the question, then `●`-highlighted
 * numbered answers. No footer.
 *
 * pi has no approval dialog of its own; extensions that gate tools ask through
 * `ctx.ui.select` (`parsePiSelect`, `blocked-prompt-pi.test.ts`). The `ask_user_question` extension draws its own
 * picker (`parsePiQuestion`).
 *
 * OpenCode (v2.0.29, `blocked-prompt-opencode.test.ts`): a `┃` panel, `△ Permission required`, the request, and a
 * row of buttons whose chosen one is told apart by background colour only (`parseOpencodePermission`). Its question
 * tool (v2.1.2) draws a `Questions` panel whose highlighted answer differs by the colour of its number
 * (`parseOpencodeQuestion`).
 */
import { createHash } from 'node:crypto';
import type { AgentKind } from './remote-agents.js';

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

/** Claude Code's dialog at the bottom of `pane`, or undefined when it is not one this module reads. */
const parseClaudeDialog = (pane: string): ParsedPrompt | undefined => {
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

    return assemble({
        region,
        title,
        subtitle: before.join(' '),
        detail: detailLines,
        note: after.join(' '),
        question: region[q]!.trim(),
        options,
    });
};

// CSI sequences (colours and the rest) and OSC ones (OSC 8 hyperlinks, ended by BEL or ST): what `-e` adds.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** `pane` without terminal escapes: what `capture-pane` without `-e` gives. */
export const stripEscapes = (pane: string): string => pane.replace(ESCAPES, '');

/** The inside of a line drawn as `│ … │`, without its one-space padding; undefined for any other line. */
const boxed = (line: string): string | undefined => {
    const t = line.trim();
    if (t.length < 2 || !t.startsWith('│') || !t.endsWith('│')) return undefined;
    return t.slice(1, -1).replace(/^ /, '').trimEnd();
};

/** `lines` without blank lines at either end. */
const trimBlank = (lines: readonly string[]): string[] => {
    let from = 0;
    let to = lines.length;
    while (from < to && lines[from]!.trim() === '') from++;
    while (to > from && lines[to - 1]!.trim() === '') to--;
    return lines.slice(from, to);
};

/** `lines` without the indent they all share. */
const dedent = (lines: readonly string[]): string[] => {
    const indent = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length));
    return Number.isFinite(indent) ? lines.map((l) => l.slice(indent)) : [...lines];
};

const GEMINI_OPTION = /^([●\s])\s*(\d{1,2})\.\s+(\S.*)$/;
const GEMINI_HEADER = /^\?\s+(\S.*)$/;
const GEMINI_QUEUE = /\s{2,}\d+ of \d+$/;

/** Gemini CLI's tool approval box, or undefined. */
const parseGeminiDialog = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    // The question is the last boxed "…?" line whose next non-blank boxed line is option 1.
    let qAt = -1;
    for (let i = lines.length - 2; i >= 0 && qAt < 0; i--) {
        const q = boxed(lines[i]!);
        if (q === undefined || !q.endsWith('?') || q.startsWith('│')) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const next = boxed(lines[j]!);
            if (next === undefined) break;
            if (next === '') continue;
            if (GEMINI_OPTION.exec(next)?.[2] === '1') qAt = i;
            break;
        }
    }
    if (qAt < 0) return undefined;

    // Up to the box's top border, down to its bottom one.
    let top = qAt - 1;
    while (top >= 0 && boxed(lines[top]!) !== undefined) top--;
    if (top < 0 || !lines[top]!.trim().startsWith('╭')) return undefined;
    let end = qAt + 1;
    while (end < lines.length && boxed(lines[end]!) !== undefined) end++;
    if (end >= lines.length || !lines[end]!.trim().startsWith('╰')) return undefined;
    // Gemini hides its input box while it asks: only blank lines and other boxes (a notice) may follow. The same box
    // drawn in the agent's own text sits above the input box, and is not a dialog.
    for (const line of lines.slice(end + 1)) {
        const t = line.trim();
        if (t !== '' && !t.startsWith('╭') && !t.startsWith('╰') && boxed(line) === undefined) return undefined;
    }

    const header = GEMINI_HEADER.exec(boxed(lines[top + 1]!)!.replace(GEMINI_QUEUE, ''));
    if (!header) return undefined;
    const [title, ...rest] = header[1]!.split(/\s{2,}/);
    const subtitle = rest.join(' ').trim();

    const options: { n: number; label: string; selected: boolean }[] = [];
    for (const line of lines.slice(qAt + 1, end)) {
        const text = boxed(line)!;
        if (text === '') continue;
        const m = GEMINI_OPTION.exec(text);
        if (m) {
            options.push({ n: Number(m[2]), label: m[3]!.trim(), selected: m[1] === '●' });
        } else if (options.length > 0 && /^\s{4,}\S/.test(text)) {
            const last = options[options.length - 1]!;
            last.label = `${last.label} ${text.trim()}`;
        } else {
            return undefined;
        }
    }

    // Between header and question: the nested box holds the command or diff; any other text is a note.
    const detailLines: string[] = [];
    const noteLines: string[] = [];
    for (const line of lines.slice(top + 2, qAt)) {
        const text = boxed(line)!;
        if (text.startsWith('╭') || text.startsWith('╰')) continue;
        const inner = boxed(text);
        if (inner !== undefined) detailLines.push(inner);
        else if (text.trim() !== '') noteLines.push(text.trim());
    }
    const detail = dedent(trimBlank(detailLines));

    return assemble({
        region: lines.slice(top, end + 1),
        title: title!.trim(),
        subtitle,
        detail,
        note: noteLines.join(' '),
        question: boxed(lines[qAt]!)!.trim(),
        options,
    });
};

const PI_FOOTER = /^ ↑↓ navigate {2}\S.* select {2}\S.* cancel$/;
const PI_OPTION = /^ (→| ) (\S.*)$/;
const PI_COUNTDOWN = / \(\d+s\)$/;

/**
 * pi's `ctx.ui.select` dialog (`ExtensionSelectorComponent`), which approval extensions draw: a free title between
 * full-width rules, unnumbered answers with `→` on the highlighted one, a `↑↓ navigate  … select  … cancel` footer.
 * Title, question and detail come from the title's lines: first, last, and what is between.
 */
const parsePiSelect = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    let footer = -1;
    for (let i = lines.length - 1; i >= 0 && footer < 0; i--) if (PI_FOOTER.test(lines[i]!)) footer = i;
    if (footer < 0) return undefined;
    let top = -1;
    for (let i = footer - 1; i >= 0 && top < 0; i--) if (FULL_RULE.test(lines[i]!)) top = i;
    if (top < 0) return undefined;
    // The select takes the editor's place, so one rule follows it. The same text in the agent's own output sits
    // above the editor, which brings its two rules.
    if (lines.slice(footer + 1).filter((l) => FULL_RULE.test(l)).length > 1) return undefined;

    // The answers sit right above the footer's gap, with a gap above them too.
    let last = footer - 1;
    while (last > top && lines[last] === '') last--;
    let first = last;
    while (first - 1 > top && PI_OPTION.test(lines[first - 1]!)) first--;
    if (first - 1 <= top || lines[first - 1] !== '') return undefined;
    const options: { n: number; label: string; selected: boolean }[] = [];
    for (const line of lines.slice(first, last + 1)) {
        const m = PI_OPTION.exec(line);
        if (!m) return undefined;
        options.push({ n: options.length + 1, label: m[2]!.trim(), selected: m[1] === '→' });
    }

    // A select with a timeout redraws its title's end as ` (12s)` every second: not part of the prompt or its id.
    for (let i = first - 1; i > top; i--) {
        if (lines[i] === '') continue;
        lines[i] = lines[i]!.replace(PI_COUNTDOWN, '');
        break;
    }
    const text = trimBlank(lines.slice(top + 1, first).map((l) => l.replace(/^ /, '')));
    if (text.length === 0) return undefined;

    return assemble({
        region: lines.slice(top, footer + 1),
        title: text[0]!.trim(),
        detail: dedent(trimBlank(text.slice(1, -1))),
        question: text[text.length - 1]!.trim(),
        options,
    });
};

/** An answer as a question reader collects it: the note is the indented line(s) drawn under it. */
type QuestionOption = { n: number; label: string; selected: boolean; note?: string };
/** A line indented under an answer, as both question pickers draw a note. */
const QUESTION_NOTE = /^ {5}(\S.*)$/;
const appendNote = (option: QuestionOption, text: string): void => {
    option.note = option.note === undefined ? text.trim() : `${option.note} ${text.trim()}`;
};

const PI_QUESTION_FOOTER = /^ ↑↓ navigate • Enter select • Esc cancel$/;
const PI_QUESTION_OPTION = /^(> | {2})(?:(\d{1,2})\. )?(\S.*)$/;

/**
 * The `ask_user_question` extension's single-answer picker (pi 0.85.1, `pi-blocked.txt`): a full-width rule, the
 * question, an optional context, numbered answers with `> ` on the highlighted one and an indented note under any,
 * an unnumbered last answer that opens a text field (left out: keys cannot fill it), then the
 * `↑↓ navigate • Enter select • Esc cancel` footer and a closing rule.
 */
const parsePiQuestion = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    let footer = -1;
    for (let i = lines.length - 1; i >= 0 && footer < 0; i--) if (PI_QUESTION_FOOTER.test(lines[i]!)) footer = i;
    if (footer < 0 || !FULL_RULE.test(lines[footer + 1] ?? '')) return undefined;
    let top = -1;
    for (let i = footer - 1; i >= 0 && top < 0; i--) if (FULL_RULE.test(lines[i]!)) top = i;
    if (top < 0) return undefined;
    // The picker takes the editor's place, so one rule follows it; the same text in the agent's output sits above
    // the editor and its two rules.
    if (lines.slice(footer + 1).filter((l) => FULL_RULE.test(l)).length > 1) return undefined;

    // Answers run up to the footer's gap; the question and context sit above the first one's gap.
    let first = top + 1;
    while (first < footer && !/^(> | {2})1\. /.test(lines[first]!)) first++;
    if (first >= footer || lines[first - 1] !== '') return undefined;
    const options: QuestionOption[] = [];
    let own: number | undefined;
    for (const line of lines.slice(first, footer)) {
        if (line === '') continue;
        const note = QUESTION_NOTE.exec(line);
        if (note && options.length > 0) {
            appendNote(options[options.length - 1]!, note[1]!);
            continue;
        }
        const m = PI_QUESTION_OPTION.exec(line);
        if (!m || own !== undefined) return undefined;
        const n = m[2] === undefined ? options.length + 1 : Number(m[2]);
        if (m[2] === undefined) own = n;
        options.push({ n, label: m[3]!.trim(), selected: m[1] === '> ' });
    }
    if (own === undefined) return undefined;

    const text = lines.slice(top + 1, first).map((l) => l.replace(/^ /, ''));
    const gap = text.indexOf('');
    const asked = (gap < 0 ? text : text.slice(0, gap)).join(' ').trim();
    if (asked === '') return undefined;
    const context = gap < 0 ? [] : trimBlank(text.slice(gap + 1)).map((l) => l.trim()).filter((l) => l !== '');

    const prompt = assemble({
        region: lines.slice(top, footer + 1),
        title: asked,
        detail: [...context, ...options.filter((o) => o.note !== undefined && o.n !== own).map((o) => `${o.label}: ${o.note}`)],
        question: asked,
        options,
    });
    return prompt && { ...prompt, options: prompt.options.filter((o) => o.n !== own) };
};

// One SGR sequence and its parameters; any other escape is dropped without changing the background.
const SGR = /^\u001b\[([0-9;:]*)m/;
const ANY_ESCAPE = new RegExp(`^(?:${ESCAPES.source})`);

/**
 * `line` without escapes, and the background ('7' = reverse video) and foreground each of its UTF-16 units is drawn
 * in ('' = the default).
 */
const withColours = (line: string): { text: string; bg: string[]; fg: string[] } => {
    let text = '';
    const bg: string[] = [];
    const fg: string[] = [];
    let current = '';
    let ink = '';
    let reverse = false;
    for (let i = 0; i < line.length;) {
        const sgr = SGR.exec(line.slice(i));
        if (sgr) {
            const p = sgr[1] === '' ? ['0'] : sgr[1]!.split(/[;:]/);
            for (let j = 0; j < p.length; j++) {
                const code = Number(p[j]);
                if (code === 0) { current = ''; ink = ''; reverse = false; }
                else if (code === 7) reverse = true;
                else if (code === 27) reverse = false;
                else if (code === 49) current = '';
                else if (code === 39) ink = '';
                else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) current = String(code);
                else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) ink = String(code);
                else if (code === 38 || code === 48 || code === 58) {
                    const span = p[j + 1] === '2' ? 3 : p[j + 1] === '5' ? 1 : 0;
                    if (code === 48) current = p.slice(j, j + 2 + span).join(';');
                    if (code === 38) ink = p.slice(j, j + 2 + span).join(';');
                    j += 1 + span;
                }
            }
            i += sgr[0].length;
            continue;
        }
        const other = ANY_ESCAPE.exec(line.slice(i));
        if (other) { i += other[0].length; continue; }
        text += line[i];
        bg.push(reverse ? '7' : current);
        fg.push(ink);
        i++;
    }
    return { text, bg, fg };
};

const OPENCODE_BAR = '┃';
const OPENCODE_HEADER = /^\s*△ Permission required$/;
const OPENCODE_HINTS = /ctrl\+|⇆|enter confirm/;
const OPENCODE_SUBTITLE = /^→ (\S.*)$/;

type ColouredRow = ReturnType<typeof withColours>;
/** The column after the panel bar on a row drawn in the panel; -1 for any other row. */
const inPanel = (row: { text: string }): number => {
    const at = row.text.indexOf(OPENCODE_BAR);
    return at >= 0 && row.text.slice(0, at).trim() === '' ? at + 1 : -1;
};

/**
 * OpenCode's permission request: `△ Permission required` in a `┃` panel, the request (a `$ command`, or `→ Edit file`
 * over its diff), then a row of buttons `Allow once   Always allow   Reject` beside `… enter confirm`. The chosen
 * button differs from the others only by its background, so this reads the pane with its escapes: a plain capture
 * yields nothing. Left/right move the choice; the dialog draws no question, so the question is a fixed one.
 */
const parseOpencodePermission = (rows: readonly ColouredRow[]): ParsedPrompt | undefined => {
    let head = -1;
    for (let i = rows.length - 1; i >= 0 && head < 0; i--) {
        const at = inPanel(rows[i]!);
        if (at >= 0 && OPENCODE_HEADER.test(rows[i]!.text.slice(at).trimEnd())) head = i;
    }
    if (head < 0) return undefined;
    // The panel's last row with the key hints is the button row: a request that prints the hint text sits above it.
    let end = head + 1;
    while (end < rows.length && inPanel(rows[end]!) >= 0) end++;
    let bar = -1;
    for (let i = end - 1; i > head && bar < 0; i--) {
        if (/⇆ select +enter confirm/.test(rows[i]!.text)) bar = i;
    }
    if (bar < 0) return undefined;

    // The buttons: runs of text split by two or more spaces, up to the first key hint.
    const row = rows[bar]!;
    const from = inPanel(row);
    const options: { n: number; label: string; selected: boolean }[] = [];
    const lit: string[] = [];
    for (const m of row.text.slice(from).matchAll(/\S+(?: \S+)*/g)) {
        if (OPENCODE_HINTS.test(m[0])) break;
        options.push({ n: options.length + 1, label: m[0], selected: false });
        lit.push(row.bg[from + m.index!]!);
    }
    // The chosen button: the one background no other button shares, the rest all alike. A theme drawing it in
    // reverse video (or anything else) is not a captured layout.
    if (lit.includes('7')) return undefined;
    const odd = lit.filter((bg) => lit.filter((other) => other === bg).length === 1);
    if (odd.length !== 1 || new Set(lit).size !== 2) return undefined;
    const selected = lit.indexOf(odd[0]!);
    options[selected]!.selected = true;

    const body = rows.slice(head + 1, bar).map((r) => r.text.slice(inPanel(r)).trimEnd());
    const first = body.findIndex((l) => l.trim() !== '');
    const sub = first < 0 ? null : OPENCODE_SUBTITLE.exec(body[first]!.trim());
    const detail = dedent(trimBlank(sub ? body.slice(first + 1) : body));

    return assemble({
        region: rows.slice(head, bar + 1).map((r) => r.text.trimEnd()),
        title: 'Permission required',
        ...(sub ? { subtitle: sub[1]!.trim() } : {}),
        detail,
        question: 'Allow this request?',
        options,
        keys: (at, to) => [...Array(Math.abs(to - at)).fill(to > at ? 'right' : 'left'), 'enter'],
        idSalt: `opencode:selected=${selected}`,
    });
};

const OPENCODE_QUESTION_HEADER = /^\s*Questions$/;
/** The one footer captured: a single question, single answer. Several questions add `tab`, several answers a toggle. */
const OPENCODE_QUESTION_FOOTER = /^\s*↑↓ select {2}enter submit {2}esc dismiss$/;
const OPENCODE_QUESTION_OPTION = /^ {2}(\d{1,2})\. (\S.*)$/;
/** The answer OpenCode adds to every question: it opens a text field, which keys cannot fill. */
const OPENCODE_OWN_ANSWER = 'Type your own answer';

/**
 * OpenCode's question tool (v2.1.2): `Questions` in a `┃` panel, the question, numbered answers each over an
 * optional indented note, and a `↑↓ select  enter submit  esc dismiss` footer. The highlighted answer differs only by
 * the colour of its number, so this too reads the pane with its escapes. Up/down move the highlight.
 */
const parseOpencodeQuestion = (rows: readonly ColouredRow[]): ParsedPrompt | undefined => {
    const textOf = (i: number): string => rows[i]!.text.slice(inPanel(rows[i]!)).trimEnd();
    let footer = -1;
    for (let i = rows.length - 1; i >= 0 && footer < 0; i--) {
        if (inPanel(rows[i]!) >= 0 && OPENCODE_QUESTION_FOOTER.test(textOf(i))) footer = i;
    }
    if (footer < 0) return undefined;
    let head = footer - 1;
    while (head >= 0 && inPanel(rows[head]!) >= 0 && !OPENCODE_QUESTION_HEADER.test(textOf(head))) head--;
    if (head < 0 || inPanel(rows[head]!) < 0) return undefined;

    const question: string[] = [];
    const options: QuestionOption[] = [];
    const numberInk: string[] = [];
    for (let i = head + 1; i < footer; i++) {
        const text = textOf(i);
        const option = OPENCODE_QUESTION_OPTION.exec(text);
        if (option) {
            options.push({ n: Number(option[1]), label: option[2]!.trim(), selected: false });
            numberInk.push(rows[i]!.fg[inPanel(rows[i]!) + 2]!);
            continue;
        }
        const note = QUESTION_NOTE.exec(text);
        if (options.length > 0 && note) {
            appendNote(options[options.length - 1]!, note[1]!);
        } else if (options.length > 0 && text.trim() !== '') {
            return undefined;
        } else if (options.length === 0) {
            question.push(text.trim());
        }
    }
    // The highlighted answer: the one number ink no other answer shares, the rest all alike.
    const odd = numberInk.filter((ink) => numberInk.filter((other) => other === ink).length === 1);
    if (odd.length !== 1 || new Set(numberInk).size !== 2) return undefined;
    options[numberInk.indexOf(odd[0]!)]!.selected = true;

    const asked = trimBlank(question).join(' ').trim();
    if (asked === '') return undefined;
    const prompt = assemble({
        region: rows.slice(head, footer + 1).map((r) => r.text.trimEnd()),
        title: 'Question',
        detail: options.filter((o) => o.note !== undefined && o.label !== OPENCODE_OWN_ANSWER).map((o) => `${o.label}: ${o.note}`),
        question: asked,
        options,
        idSalt: `opencode-question:selected=${options.findIndex((o) => o.selected)}`,
    });
    return prompt && { ...prompt, options: prompt.options.filter((o) => o.label !== OPENCODE_OWN_ANSWER) };
};

/** The checks and caps every reader shares: numbering 1..n, one highlight, label and detail limits. */
const assemble = (d: {
    region: readonly string[];
    title: string;
    subtitle?: string;
    detail: readonly string[];
    note?: string;
    question: string;
    options: readonly { n: number; label: string; selected: boolean }[];
    /** Keys from the highlighted option to option `to`; up/down by default. */
    keys?: (from: number, to: number) => string[];
    /** Folded into the id when the highlight is not in the region's text. */
    idSalt?: string;
}): ParsedPrompt | undefined => {
    const { options } = d;
    if (!d.title || options.length < 2 || options.length > MAX_OPTIONS) return undefined;
    if (!options.every((o, i) => o.n === i + 1)) return undefined;
    const selected = options.findIndex((o) => o.selected);
    if (selected < 0 || options.filter((o) => o.selected).length !== 1) return undefined;
    const keys = d.keys ?? keysFor;
    const prompt: ParsedPrompt = {
        id: idOf(d.idSalt === undefined ? d.region : [...d.region, d.idSalt]),
        title: cut(d.title, MAX_LABEL_CHARS),
        detail: d.detail.slice(0, MAX_DETAIL_LINES).map((l) => cut(l, MAX_DETAIL_LINE_CHARS)),
        question: cut(d.question, MAX_LABEL_CHARS),
        options: options.map((o, i) => ({
            n: o.n,
            label: cut(o.label, MAX_LABEL_CHARS),
            keys: keys(selected, i),
            ...(PERSISTENT.test(o.label) ? { persistent: true as const } : {}),
        })),
    };
    if (d.subtitle) prompt.subtitle = cut(d.subtitle, MAX_LABEL_CHARS);
    if (d.note) prompt.note = cut(d.note, MAX_LABEL_CHARS);
    if (d.detail.length > MAX_DETAIL_LINES || d.detail.some((l) => l.length > MAX_DETAIL_LINE_CHARS)) {
        prompt.detailTruncated = true;
    }
    return prompt;
};

/** One reader per agent kind whose approval dialog was captured. Each takes the pane as captured, escapes and all. */
const READERS: Partial<Record<AgentKind, (pane: string) => ParsedPrompt | undefined>> = {
    claude: (pane) => parseClaudeDialog(stripEscapes(pane)),
    gemini: (pane) => parseGeminiDialog(stripEscapes(pane)),
    pi: (pane) => {
        const plain = stripEscapes(pane);
        return parsePiSelect(plain) ?? parsePiQuestion(plain);
    },
    opencode: (pane) => {
        const rows = pane.split('\n').map(withColours);
        return parseOpencodePermission(rows) ?? parseOpencodeQuestion(rows);
    },
};

/** The approval dialog at the bottom of `pane`, read the way `kind` draws it; undefined when it is not one of those. */
export const parseBlockedDialog = (pane: string, kind: AgentKind): ParsedPrompt | undefined => READERS[kind]?.(pane);

/** True when some reader finds the prompt `id` on `pane`: an id hashes the exact dialog, so the kind need not be known. */
export const showsPrompt = (id: string, pane: string): boolean =>
    Object.values(READERS).some((read) => read(pane)?.id === id);

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
