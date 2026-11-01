/**
 * Claude Code's other numbered dialogs: AskUserQuestion (a question, a multi-select, the review of several answers)
 * and ExitPlanMode (the plan to approve). They come out as the same `permission`-shaped prompt the approval dialogs
 * do, so a phone that reads those reads these too; only the title tells them apart.
 *
 * Rows that need typed text (`Type something`, `Chat about this`, `Tell Claude what to change`) are not options: an
 * option has to be one answer a single press gives (in a multi-select a press toggles a box, and the screen it
 * draws next is a new prompt). A dialog whose highlight sits on such a row is not read at all, as
 * is one the user is typing into: the keys of the other options would land in the text.
 */
import { assemble, type ParsedPrompt } from './blocked-prompt.js';

const FULL_RULE = /^\s*─{20,}$/;
const DASHED_RULE = /^\s*╌{20,}$/;
const OPTION = /^\s*([❯>])?\s*(\d{1,2})\.\s+(\S.*)$/;
const TAB_LINE = /^\s*(?:←\s+)?[☐☒]\s/;
const TAB_CHIP = /([☐☒✔])\s+(\S+)/g;
const SUBMIT_ROW = /^\s*(❯)?\s+Submit\s*$/;
const ASK_FOOTER = /Enter to select/;
const PLAN_FOOTER = /^\s*ctrl\+g to edit/;
const MULTI_LABEL = /^\[[ ✔]\]\s/;
const OTHER_LABEL = /^(?:\[[ ✔]\]\s+)?Type something\.?$/;
const CHAT_LABEL = /^Chat about this$/;
const PLAN_TITLE = 'Ready to code?';
const OWN_ANSWER = /^Tell Claude what to change$/;
/** The hint under a plan option: it belongs to the row above, not to its label. */
const PLAN_HINT = /^shift\+tab to /;
/** The marker the viewport draws at a plan's last visible row when more is below (or above). */
const SCROLL_MARK = /\s{2,}[↓↑]$/;

const blank = (l: string): boolean => l.trim() === '';

const lastIndex = (lines: readonly string[], test: (l: string, i: number) => boolean): number => {
    for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i]!, i)) return i;
    return -1;
};

const dedent = (lines: readonly string[]): string[] => {
    const indent = Math.min(...lines.filter((l) => !blank(l)).map((l) => l.length - l.trimStart().length));
    return Number.isFinite(indent) ? lines.map((l) => l.slice(indent)) : [...lines];
};

interface Row {
    n: number;
    label: string;
    selected: boolean;
    /** The description printed under the option, when it adds anything to the label. */
    note: string[];
}

/** The numbered rows of `lines`; a more indented line under a row describes it. Undefined for any other line. */
const readRows = (lines: readonly string[]): Row[] | undefined => {
    const rows: Row[] = [];
    for (const line of lines) {
        if (blank(line)) continue;
        const m = OPTION.exec(line);
        if (m) {
            rows.push({ n: Number(m[2]), label: m[3]!.trim(), selected: m[1] === '❯', note: [] });
        } else if (rows.length > 0 && /^\s{3,}\S/.test(line)) {
            rows[rows.length - 1]!.note.push(line.trim());
        } else {
            return undefined;
        }
    }
    return rows.length > 0 ? rows : undefined;
};

/** `label — description`, or the label alone when the description only repeats it. */
const withNote = (row: Row): string => {
    const text = row.note.join(' ');
    const bare = row.label.replace(/^\[[ ✔]\]\s+/, '');
    return text === '' || text === bare ? row.label : `${row.label} — ${text}`;
};

/** An AskUserQuestion dialog at the bottom of `pane`, or undefined. */
export const parseClaudeQuestion = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    let end = lines.length;
    while (end > 0 && blank(lines[end - 1]!)) end--;
    const live = lines.slice(0, end);

    const tabAt = lastIndex(live, (l, i) => i > 0 && TAB_LINE.test(l) && FULL_RULE.test(live[i - 1]!));
    if (tabAt < 0) return undefined;
    const tabs = live[tabAt]!;

    // Below the options the dialog may draw its own rule, the "Chat about this" row and a footer; nothing else.
    const rest = live.slice(tabAt + 1);
    const ruleAt = rest.findIndex((l) => FULL_RULE.test(l));
    const body = ruleAt < 0 ? rest : rest.slice(0, ruleAt);
    if (ruleAt >= 0) {
        for (const l of rest.slice(ruleAt + 1)) {
            if (blank(l) || ASK_FOOTER.test(l)) continue;
            if (CHAT_LABEL.test(OPTION.exec(l)?.[3]?.trim() ?? '')) continue;
            return undefined;
        }
        if (!rest.slice(ruleAt + 1).some((l) => ASK_FOOTER.test(l))) return undefined;
    }

    // Text above the first row: paragraphs, the last one the question.
    const firstRow = body.findIndex((l) => OPTION.test(l));
    if (firstRow < 0) return undefined;
    const paragraphs: string[][] = [];
    for (const l of body.slice(0, firstRow)) {
        if (blank(l)) paragraphs.push([]);
        else (paragraphs.length === 0 || paragraphs[paragraphs.length - 1]!.length === 0 ? paragraphs.push([l]) : paragraphs[paragraphs.length - 1]!.push(l));
    }
    const texts = paragraphs.filter((p) => p.length > 0);
    const questionLines = texts.pop();
    if (!questionLines) return undefined;
    // AskUserQuestion takes any text as the question; a "?" is not guaranteed.
    const question = questionLines.map((l) => l.trim()).join(' ');

    // Under the question: the numbered rows, then in a multi-select an unnumbered Submit row.
    let rowLines = body.slice(firstRow);
    let submit: { selected: boolean } | undefined;
    const submitAt = rowLines.findIndex((l) => SUBMIT_ROW.test(l));
    if (submitAt >= 0) {
        submit = { selected: SUBMIT_ROW.exec(rowLines[submitAt]!)![1] === '❯' };
        if (rowLines.slice(submitAt + 1).some((l) => !blank(l))) return undefined;
        rowLines = rowLines.slice(0, submitAt);
    }
    const rows = readRows(rowLines);
    if (!rows) return undefined;

    // A question with a free-text row ends in it; the review of the answers has none. On that row the user either has
    // not typed yet or is typing: either way the other rows' keys would hit the text.
    if (ruleAt >= 0) {
        const other = rows[rows.length - 1]!;
        if (other.selected || !OTHER_LABEL.test(other.label)) return undefined;
        rows.pop();
    }
    if (rows.some((r) => OTHER_LABEL.test(r.label) || CHAT_LABEL.test(r.label))) return undefined;

    const multi = rows.length > 0 && rows.every((r) => MULTI_LABEL.test(r.label));
    // Submit sits after the free-text row, which the key positions count: no such row, no known layout.
    if (submit && (!multi || ruleAt < 0)) return undefined;
    const options = rows.map((r) => ({ n: r.n, label: withNote(r), selected: r.selected }));
    if (submit) options.push({ n: rows.length + 1, label: 'Submit', selected: submit.selected });

    const chips = [...tabs.matchAll(TAB_CHIP)].filter((m) => m[1] !== '✔').map((m) => `${m[1]} ${m[2]}`);
    const heading = texts.length > 0 ? texts[0]!.map((l) => l.trim()).join(' ') : undefined;
    const summary = texts.length > 1 ? texts.slice(1).flat() : [];
    // The review screen heads itself; a question is known by the header chips of its tab line.
    const review = heading !== undefined && /^Review your answers$/i.test(heading);

    return assemble({
        region: live.slice(tabAt),
        title: review ? heading : 'Claude is asking',
        subtitle: chips.join(' · '),
        detail: review ? summary.map((l) => l.replace(/^ /, '')) : [],
        question,
        options,
        // The numbered rows, then a free-text row the options skip, then Submit.
        keys: (from, to) => {
            const pos = (i: number): number => (submit && i === options.length - 1 && multi ? i + 1 : i);
            const steps = pos(to) - pos(from);
            return [...Array(Math.abs(steps)).fill(steps > 0 ? 'down' : 'up'), 'enter'];
        },
    });
};

/** An ExitPlanMode dialog at the bottom of `pane`, or undefined. */
export const parseClaudePlan = (pane: string): ParsedPrompt | undefined => {
    const lines = pane.split('\n').map((l) => l.trimEnd());
    let end = lines.length;
    while (end > 0 && blank(lines[end - 1]!)) end--;
    const live = lines.slice(0, end);

    // The footer names the plan file, and wraps when the pane is narrow: `ctrl+g to edit in Nvim · ~/.claude/…md`.
    const footerAt = lastIndex(live, (l) => PLAN_FOOTER.test(l));
    if (footerAt < 0) return undefined;
    const footerText = live.slice(footerAt).map((l) => l.trim());
    const afterDot = footerText[0]!.split('·').slice(1).join('·').trim();
    const path = [afterDot, ...footerText.slice(1)].join('').trim();
    const note = path.startsWith('~/') || path.startsWith('/') ? path : undefined;

    // The question sits under the last full rule above the footer; a numbered plan above it is not the options.
    const lastQ = lastIndex(live.slice(0, footerAt), (l) => FULL_RULE.test(l));
    if (lastQ < 0) return undefined;
    const optionAt = live.findIndex((l, i) => i > lastQ && i < footerAt && OPTION.exec(l)?.[2] === '1');
    if (optionAt < 0) return undefined;
    const question = live.slice(lastQ + 1, optionAt).filter((l) => !blank(l)).map((l) => l.trim()).join(' ');
    if (!question.endsWith('?')) return undefined;

    const rows: Row[] = [];
    for (const line of live.slice(optionAt, footerAt)) {
        if (blank(line) || PLAN_HINT.test(line.trim())) continue;
        const m = OPTION.exec(line);
        if (m) rows.push({ n: Number(m[2]), label: m[3]!.trim(), selected: m[1] === '❯', note: [] });
        else if (rows.length > 0 && /^\s{3,}\S/.test(line)) rows[rows.length - 1]!.label += ` ${line.trim()}`;
        else return undefined;
    }
    const options = rows.filter((r) => !OWN_ANSWER.test(r.label)).map((r) => ({ n: r.n, label: r.label, selected: r.selected }));

    // Above the question: rule, plan between two dashed rules, and above them the title and subtitle.
    // The title opens the dialog, under a rule; the plan sits between two dashed rules. The closing one is missing
    // when the viewport cut the plan: the rule above the question ends it then.
    const titleAt = lastIndex(live.slice(0, lastQ), (l) => l.trim() === PLAN_TITLE);
    if (titleAt < 1 || !FULL_RULE.test(live[titleAt - 1]!)) return undefined;
    const topRule = titleAt - 1;
    const dashedStart = live.findIndex((l, i) => i > titleAt && i < lastQ && DASHED_RULE.test(l));
    if (dashedStart < 0) return undefined;
    const closing = live.findIndex((l, i) => i > dashedStart && i < lastQ && DASHED_RULE.test(l));
    const dashedEnd = closing < 0 ? lastQ : closing;
    const head = live.slice(titleAt + 1, dashedStart).filter((l) => !blank(l)).map((l) => l.trim());

    let plan = live.slice(dashedStart + 1, dashedEnd);
    while (plan.length > 0 && blank(plan[plan.length - 1]!)) plan.pop();
    let more = false;
    plan = plan.map((l) => {
        if (SCROLL_MARK.test(l)) more = true;
        return l.replace(SCROLL_MARK, '');
    });

    const prompt = assemble({
        region: live.slice(topRule + 1),
        title: PLAN_TITLE,
        subtitle: head.join(' '),
        detail: dedent(plan),
        ...(note ? { note } : {}),
        question,
        options,
    });
    return prompt && more ? { ...prompt, detailTruncated: true } : prompt;
};
