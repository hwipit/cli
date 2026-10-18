/**
 * Bundled default detection rules — the fallback when no OTA manifest
 * has been fetched (or the fetched one fails validation, §S7).
 *
 * Rule content is authored HERE, from observation of each agent's UI.
 * Do not import or transcribe rules from third-party projects: the
 * bundled set is original work under this repo's license.
 *
 * Claude Code observations behind these rules (UI as of mid-2026):
 * - While running, the status line shows an "esc to interrupt" hint
 *   next to the spinner/progress text.
 * - Blocking dialogs (permission requests, plan approval, question
 *   forms) render a numbered/arrow-key option list with "esc" as the
 *   cancel affordance and Enter as the confirm affordance.
 * - At rest, the input box renders a `❯` prompt and the footer offers
 *   "? for shortcuts".
 * - The transcript viewer (ctrl+o) overlays the pane; the agent may
 *   still be working underneath, so it must not change the state.
 *
 * Every agent here carries the same rules the server manifest publishes
 * (hwip server/src/agent-rules/manifest.json, version 2026.10.18.1 — hwip#532, merged and deployed before this cli ships),
 * so a listener that never reaches the endpoint classifies them too. A fetched
 * manifest replaces this bundle whole for state reports; schedules read only
 * this bundle. An agent without rules here
 * reports `unknown`: honest ignorance beats guessed state, and
 * harness-bench.test.ts fails the moment a rule set is half-filled.
 */
import { ENGINE_VERSION, type DetectionManifest } from './agent-state.js';

export const DEFAULT_MANIFEST: DetectionManifest = {
    engineVersion: ENGINE_VERSION,
    version: '2026.10.18.1',
    agents: {
        claude: [
            {
                // Transcript / verbose-output overlay: freeze state.
                id: 'claude-transcript-overlay',
                state: 'unknown',
                priority: 1000,
                skipStateUpdate: true,
                any: [
                    { contains: ['showing detailed transcript'] },
                    { contains: ['ctrl+o to toggle'] },
                ],
            },
            {
                // Blocking dialog: an option list waiting on the user.
                // "esc" alone is ambiguous (working shows "esc to
                // interrupt"), so require a selection affordance too.
                id: 'claude-blocked-dialog',
                state: 'blocked',
                priority: 900,
                contains: ['esc'],
                any: [
                    { contains: ['do you want'] },
                    { contains: ['enter to select'] },
                    { contains: ['enter to confirm'] },
                    { contains: ['to navigate'] },
                ],
                not: [{ contains: ['esc to interrupt'] }],
            },
            {
                id: 'claude-working-interrupt-hint',
                state: 'working',
                priority: 800,
                contains: ['esc to interrupt'],
            },
            {
                // Newer CC skins drop the "esc to interrupt" hint; the
                // live token counter on the spinner line
                // ("✶ Churning… (1m 2s · ↓ 1.2k tokens)") only renders
                // while the agent is actually running.
                id: 'claude-working-token-counter',
                state: 'working',
                priority: 790,
                regex: ['[↓↑]\\s?[\\d.,]+k? tokens'],
            },
            {
                // Elapsed-time spinner suffix ("(12s · ..." / "(1m 2s ·")
                // — second fallback for skins that hide the token counter
                // early in a turn.
                id: 'claude-working-elapsed-spinner',
                state: 'working',
                priority: 780,
                regex: ['…\\s*\\((?:\\d+m )?\\d+s ·'],
            },
            {
                // Compact pass ("✱ Compacting conversation… (51s)")
                // renders neither the interrupt hint nor a token
                // counter, but the session is busy and can't take
                // input — without this it reads as idle.
                id: 'claude-working-compacting',
                state: 'working',
                priority: 770,
                contains: ['compacting conversation'],
            },
            {
                // Idle prompt: `❯` at line start in the tail, with no
                // dialog affordances around it.
                id: 'claude-idle-prompt',
                state: 'idle',
                priority: 600,
                regex: ['^\\s*❯'],
                not: [
                    { contains: ['do you want'] },
                    { contains: ['enter to select'] },
                ],
            },
            {
                // Fallback idle signal when the prompt glyph is themed
                // away: the shortcuts footer only renders at rest.
                id: 'claude-idle-shortcuts-footer',
                state: 'idle',
                priority: 500,
                contains: ['? for shortcuts'],
            },
        ],
        codex: [
            // Codex CLI v0.160.1, captured 2026-10-08 and 2026-10-15 (see
            // harness-bench.test.ts). Its dialogs replace the composer and its
            // footer with a `› 1.` option list over an `enter <verb> · esc …`
            // line. At rest the composer sits over a `? for shortcuts` footer;
            // while a turn runs both stay drawn under a `• Working (… • esc to
            // interrupt)` line, so working must outrank idle.
            //
            // KNOWN GAP — no tool ever ran (the workspace was out of credits),
            // so the tool-approval dialog was never drawn and has no rule. The
            // idle rule refuses a tail holding the markers those dialogs and
            // older Codex approval prompts draw — a `› 1.` option list, a
            // `(y)`/`(n)` key hint, a `· esc …` footer, `enter to confirm` or
            // `esc to cancel` — so an approval dialog that kept the footer
            // reads `unknown` as long as it draws one of them. One that draws
            // none would read `idle`; capture it before trusting this rule
            // further.
            {
                id: 'codex-blocked-hooks-review',
                state: 'blocked',
                priority: 900,
                contains: ['hooks need review', 'enter confirm'],
            },
            {
                id: 'codex-blocked-usage-limit',
                state: 'blocked',
                priority: 900,
                contains: ['usage limit reached', 'enter select'],
            },
            {
                id: 'codex-blocked-update',
                state: 'blocked',
                priority: 900,
                contains: ['update available', 'enter continue'],
            },
            {
                id: 'codex-blocked-trust-dialog',
                state: 'blocked',
                priority: 900,
                contains: ['trust this folder', 'enter continue'],
            },
            {
                id: 'codex-working-interrupt-hint',
                state: 'working',
                priority: 800,
                contains: ['esc to interrupt'],
            },
            {
                // The footer is gone while a draft is typed, so a pane with
                // unsent text reads `unknown` — the safe side for a schedule.
                // 30 lines, not the default 10: a dialog marker drawn high
                // above a kept footer must still be in view of `not`.
                id: 'codex-idle-shortcuts-footer',
                state: 'idle',
                priority: 600,
                tailLines: 30,
                contains: ['? for shortcuts'],
                not: [
                    { regex: ['^\\s*›\\s*\\d+\\.'] },
                    { regex: ['·\\s*esc '] },
                    { regex: ['enter (?:to )?(?:confirm|select|continue)'] },
                    { regex: ['esc to (?:cancel|deny)'] },
                    { regex: ['\\([yn]\\)\\s*$'] },
                ],
            },
        ],
        gemini: [
            {
                // Tool approval (Shell, Edit, WriteFile), captured 2026-10-18 on
                // Gemini CLI v0.46.0: a rounded box whose answers start with
                // `│ ● 1. Allow once` under a boxed question line. Keyed on
                // both, not the bare phrase, so agent text or a tool output box
                // printing the answer row is not a dialog. The
                // dialog draws no footer and hides the input box; 30 lines
                // because a long diff sits between the header and the answers
                // and a later notice box can be drawn below it.
                id: 'gemini-blocked-tool-approval',
                state: 'blocked',
                priority: 900,
                tailLines: 30,
                regex: ['^\\s*│\\s+(?:●\\s+)?1\\.\\s+allow once'],
                any: [
                    { regex: ['^\\s*│ allow execution of .*\\?\\s*│$'] },
                    { regex: ['^\\s*│ apply this change\\?\\s*│$'] },
                ],
                // The input box is hidden while Gemini asks; with it on screen the box is the agent's own text.
                not: [{ contains: ['type your message'] }],
            },
            {
                // Observed on Gemini CLI v0.46.0.
                id: 'gemini-blocked-trust-dialog',
                state: 'blocked',
                priority: 900,
                tailLines: 30,
                contains: ['do you trust the files in this folder?'],
            },
            {
                id: 'gemini-working-cancel-hint',
                state: 'working',
                priority: 800,
                contains: ['esc to cancel'],
            },
            {
                id: 'gemini-idle-input-placeholder',
                state: 'idle',
                priority: 600,
                contains: ['type your message'],
                not: [{ contains: ['esc to cancel'] }],
            },
        ],
        opencode: [
            // Written from the screen strings recorded in the C136 backlog
            // row (opencode 1.18.35) and a user's permission screen, then
            // checked against panes captured 2026-10-18 on opencode 2.0.29
            // (harness bench: bash and edit requests). The button wording
            // differs between versions (`Allow always` vs `Always allow`),
            // hence the rule keys on the `Permission required` title line,
            // guarded by any button or footer string so the phrase in tool
            // output or agent text alone is not a dialog. tailLines 30
            // because an edit request draws its diff between that line and
            // the buttons. Other prompts (the agent asking a question) are
            // not captured and report `unknown`.
            // No idle rule: at rest the footer is only `ctrl+p commands`,
            // which says nothing the absence of `esc interrupt` does not.
            {
                id: 'opencode-blocked-permission',
                state: 'blocked',
                priority: 900,
                tailLines: 30,
                contains: ['permission required'],
                any: [
                    { contains: ['allow once'] },
                    { contains: ['reject'] },
                    { contains: ['enter confirm'] },
                ],
            },
            {
                id: 'opencode-working-interrupt-hint',
                state: 'working',
                priority: 800,
                contains: ['esc interrupt'],
            },
        ],
        pi: [
            {
                // Observed on pi v0.85.1. `blocked` was captured on a picker
                // drawn through ctx.ui.custom by an ask_user_question
                // extension (hint `↑↓ navigate • Enter select • Esc cancel`).
                // pi core's own extension dialogs end their hint with
                // `escape/ctrl+c cancel` under the default keybindings —
                // matched by the same pattern but read from the vendor file,
                // not captured. A user who rebinds tui.select.cancel changes
                // that text and falls back to `working` or `idle`.
                id: 'pi-blocked-dialog',
                state: 'blocked',
                priority: 900,
                any: [
                    { regex: ['enter\\b.*\\besc(?:ape)?(?:/ctrl\\+c)?\\s+cancel\\s*$'] },
                    { regex: ['enter to \\w+ • esc to go back\\s*$'] },
                ],
            },
            {
                // pi's default Loader frames at the start of a line, bare or
                // inside the editor's top border — anchored so a braille glyph
                // mid-line in tool output does not count. An extension that
                // swaps the indicator frames reports `idle` while working.
                id: 'pi-working-spinner',
                state: 'working',
                priority: 800,
                regex: ['^\\s*(?:─+\\s*)?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] +[a-z]'],
            },
            {
                // Keys on the footer's context-usage figure (`5.0%/1.0M`, or
                // `?/1.0M` right after a compaction), which renders from the
                // first frame, before any token count exists. The footer
                // truncates its stats line with `...` when wider than the
                // pane and this figure is its last item, so a pane too narrow
                // for the stats reports `unknown` rather than `idle`.
                id: 'pi-idle-context-footer',
                state: 'idle',
                priority: 600,
                regex: ['(?:^|\\s)(?:\\d+(?:\\.\\d+)?%|\\?)/\\d+(?:\\.\\d+)?[km]?\\b'],
            },
        ],
    },
};
