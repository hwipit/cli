/**
 * Gemini CLI's transcript format, projected into the events the timeline draws.
 *
 * Gemini's vocabulary belongs to this file alone — the formats share none, so
 * nothing here is borrowed from the Claude, pi or Codex projectors beyond the
 * `transcript-tail` helpers that are about `TurnEvent` itself.
 *
 * Shape measured 2026-10-08 against `~/.gemini/tmp/<project>/chats/session-*.jsonl`
 * (8 sessions, structure only — no conversation text was opened) and the writer
 * that produces it: `@google/gemini-cli` 0.46.0, `bundle/chunk-6ZHP2EJW.js`
 * (line types at 281975-281983, `pushMessage`/`$set` handling at 282072-282074,
 * append at 282289-282291). The version that wrote each of the 8 files is not
 * knowable; 0.46.0's reader and writer agree on the shape below.
 *
 * Three kinds of line, one per `JSON.parse`:
 *
 *  - a header `{sessionId, projectHash, startTime, …}` — no `id`;
 *  - `{ $set: {…} }` — a patch to the session record;
 *  - a message `{id, timestamp, type, content, …}`.
 *
 * The writer also emits `{ $rewindTo: id }` (282532) when the user rewinds. It
 * has no `id`, so it is skipped with the header, and the messages it rewinds
 * past still project: the timeline records what was said, not what the session
 * later forgot.
 *
 * Nothing here refuses to read another version: an unknown record type is
 * named through `onUnknown` and skipped, so the timeline is thinner by one row
 * rather than stopped.
 */

import {
    clamp,
    finiteNumber,
    MAX_EVENT_TEXT_CHARS,
    oneLine,
    resultLinesOf,
    sliceSinceLastPrompt,
    targetFrom,
    type ProjectorOptions,
    type TranscriptProjector,
    type TurnEvent,
} from './transcript-tail.js';

/**
 * Which tool argument reads as "what this call is about", first match wins.
 *
 * The names are Gemini's built-in tool parameters, read out of the bundle
 * (`PARAM_*` constants, 276613-276684) rather than guessed. `description` and
 * `title` lead because they are the sentence the model wrote for a person
 * (`run_shell_command` carries one); the rest are the target of the file and
 * search tools, in the order of how directly they name a thing.
 *
 * `command` is absent for the reason it is absent from every other list — a
 * command line is the argument most likely to carry a secret. `prompt`
 * (`web_fetch`, which embeds URLs) and `instruction` (`replace`) are absent for
 * the same reason of not knowing what a person pasted into them.
 */
const GEMINI_TARGET_KEYS = ['description', 'title', 'file_path', 'dir_path', 'path', 'pattern', 'query', 'name'] as const;

/** Text out of a message's `content`: a string, or parts of which only `text` is prose. */
const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
            text += (part as Record<string, unknown>).text;
        }
    }
    return text;
};

/**
 * What the person typed, out of a `user` message.
 *
 * `content` is what went to the model, and for a prompt with `@path` references
 * that includes the referenced files' bodies after a
 * `--- Content from referenced files ---` line (`REFERENCE_CONTENT_START`,
 * `bundle:250454`). The message may also carry `displayContent`, the version the
 * UI shows (`bundle:330220-330232`: recorded only when it differs from
 * `content`). Either way the file bodies must not reach the phone as a prompt:
 * prefer `displayContent`, and cut `content` at the marker when it is all there
 * is. Read from the vendor source; no message on this machine carried either.
 */
const REFERENCE_CONTENT_MARKER = '--- Content from referenced files ---';

const typedText = (entry: Record<string, unknown>): string => {
    const shown = textOf(entry.displayContent);
    const text = shown.trim() ? shown : textOf(entry.content);
    const cut = text.indexOf(REFERENCE_CONTENT_MARKER);
    return cut === -1 ? text : text.slice(0, cut);
};

/** `toolCalls[].status` values that mean the call is over; the rest are still in flight. */
const SETTLED = new Set(['success', 'error', 'cancelled']);

export const projectGeminiEntries: TranscriptProjector = (lines, opts: ProjectorOptions = {}): TurnEvent[] => {
    const events: TurnEvent[] = [];

    for (const raw of lines) {
        let entry: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            entry = parsed as Record<string, unknown>;
        } catch {
            continue;
        }

        // `$set.messages` replaces the whole message list, so reading it would
        // repeat everything already written above it; and the one a session
        // opens with is the context Gemini injects, not anything a person said.
        // The other keys (`lastUpdated`, `summary`, …) are bookkeeping.
        if ('$set' in entry) continue;

        // The header is the only line without an `id`.
        if (typeof entry.id !== 'string') continue;

        const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
        const stamp = at ? { at } : {};

        if (entry.type === 'user') {
            // A `user` message is either typed text or the answers to tool
            // calls (`functionResponse` parts, no `text`) — the latter joins to
            // nothing and is skipped. No wrapper filter on the text: of the
            // typed messages measured, none opened with `<`, and a guess at an
            // injection wrapper nobody has seen deletes real sentences.
            const text = typedText(entry).trim();
            if (text) events.push({ kind: 'prompt', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            continue;
        }

        if (entry.type === 'info' || entry.type === 'error') continue;

        if (entry.type !== 'gemini') {
            opts.onUnknown?.(`gemini record type ${typeof entry.type === 'string' ? entry.type : '(none)'}`);
            continue;
        }

        const tokens = entry.tokens;
        if (tokens && typeof tokens === 'object') {
            const t = tokens as Record<string, unknown>;
            const thinking = Array.isArray(entry.thoughts) ? entry.thoughts.length : 0;
            events.push({
                kind: 'msg',
                mid: clamp(entry.id),
                ...(typeof entry.model === 'string' ? { model: clamp(entry.model) } : {}),
                out: finiteNumber(t.output),
                // `input` is the prompt token count and already includes the
                // cached share (measured: cached <= input in 9 of 9), so adding
                // `cached` would count it twice.
                ctx: finiteNumber(t.input),
                ...(thinking ? { thinking } : {}),
                ...stamp,
            });
        }

        // Gemini rewrites a whole message as a new line whenever it changes, so
        // a reply that called tools is on disk twice: first with its `content`,
        // then again with the same `content` and `toolCalls`. The prose already
        // went out with the first line, so a line with `toolCalls` sends none.
        // That loses text only for a reply first written together with its
        // `toolCalls`, which the writer does not do: a message it creates for a
        // tool call starts with `content: ""` (`recordToolCalls`, 282401-282451).
        // The opposite miss is accepted: `recordMessageTokens` (282374) rewrites
        // a reply once its `tokens` arrive late, and that second line repeats
        // the same text (measured 0 of 12) — a doubled row beats a lost one.
        const toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : undefined;
        if (!toolCalls) {
            const text = textOf(entry.content);
            if (text.trim()) events.push({ kind: 'text', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            continue;
        }

        for (const item of toolCalls) {
            if (!item || typeof item !== 'object') continue;
            const call = item as Record<string, unknown>;
            if (typeof call.id !== 'string' || typeof call.name !== 'string') continue;

            const target = oneLine(targetFrom(call.args, GEMINI_TARGET_KEYS));
            events.push({
                kind: 'tool',
                id: clamp(call.id),
                name: clamp(call.name),
                ...(target ? { target } : {}),
                ...stamp,
            });

            // Settled calls carry their outcome on the same line as the call.
            // Only the line count of the display text leaves, never the text.
            if (typeof call.status === 'string' && SETTLED.has(call.status)) {
                const resultLines = typeof call.resultDisplay === 'string' ? resultLinesOf(call.resultDisplay) : 0;
                events.push({
                    kind: 'tool_result',
                    id: clamp(call.id),
                    ok: call.status === 'success',
                    ...(resultLines ? { lines: resultLines } : {}),
                    ...stamp,
                });
            }
        }
    }

    return sliceSinceLastPrompt(events, opts);
};
