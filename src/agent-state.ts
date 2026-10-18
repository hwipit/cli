/**
 * Agent state detection engine — classifies a tmux pane's visible text
 * into `working | blocked | idle | unknown` using declarative rules.
 *
 * Design constraints:
 * - Rules are DATA, not code: they ship bundled but are replaceable
 *   over the air (§S7), so agent UI changes never require a daemon
 *   release. Everything here must therefore survive hostile or
 *   malformed manifests: pattern-length caps, input-size caps, and
 *   per-rule isolation of regex compile failures.
 * - Pure functions only. The listener owns timing, tmux, and I/O;
 *   this module owns classification and flap suppression so both are
 *   unit-testable without a terminal.
 * - `done` is deliberately NOT a wire state: "finished but unseen" is
 *   per-user view state, derived client-side. The daemon reports only
 *   what it can observe.
 */
import { RE2JS } from 're2js';

import type { AgentKind } from './remote-agents.js';

export type AgentState = 'working' | 'blocked' | 'idle' | 'unknown';

export interface RuleCondition {
    /** All strings must appear (case-insensitive). */
    contains?: string[];
    /** All patterns must match. */
    regex?: string[];
}

export interface DetectionRule {
    id: string;
    state: AgentState;
    /** Higher wins; first match ends evaluation. */
    priority: number;
    /** 'tail' = last N non-empty lines (default), 'whole' = full capture. */
    region?: 'tail' | 'whole';
    /** Lines for region 'tail'. Default 10. */
    tailLines?: number;
    contains?: string[];
    regex?: string[];
    /** At least one condition group must match (OR). */
    any?: RuleCondition[];
    /** No condition group may match (exclusion). */
    not?: RuleCondition[];
    /**
     * On match, keep the previous state instead of this rule's state.
     * For overlay screens (transcript viewer, menus) that would
     * otherwise pollute the state while the agent is still working.
     */
    skipStateUpdate?: boolean;
}

export interface DetectionManifest {
    engineVersion: number;
    /** Date.revision, e.g. "2026.07.04.1" — for OTA freshness compare. */
    version: string;
    /** Kill-switch: rule ids to ignore without shipping a new manifest shape. */
    disabledRuleIds?: string[];
    agents: Partial<Record<AgentKind, DetectionRule[]>>;
}

export const ENGINE_VERSION = 1;

// OTA manifests are semi-trusted (schema-validated, authored by humans,
// fetched over the network) and watch patterns come from the phone. Both run
// synchronously on the daemon's one thread, where a backtracking engine is a
// freeze waiting to happen: `(a+)+$` hangs V8 on 29 characters and
// `.*.*.*x` takes seconds on 300. So patterns run on RE2 (re2js, pure JS),
// whose time is the input length times the compiled program's size. Counted
// repeats grow that program (`\w{1,1000}\w{1,1000}z` takes seconds on 8 KiB),
// so a program past MAX_PROGRAM_SIZE is refused too. RE2 has no lookaround or
// backreferences — a pattern using them does not compile and its rule or
// watch stays inert — its `\s`, `\w`, `\d` are ASCII-only, and `$` does not
// match before `\r`.
// hwip server/src/lib/watch-pattern.ts applies the same limits and flags to a
// watch pattern before storing it (C75) — keep the two in step.
const MAX_PATTERN_LENGTH = 200;
/**
 * Bundled and pi rules compile to 6–37 steps. At 200, a match search over
 * 8 KiB measured 100–300 ms; at 64 it stays under about 40 ms.
 */
const MAX_PROGRAM_SIZE = 64;
const MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_TAIL_LINES = 10;

/** The last MAX_INPUT_BYTES of the pane as UTF-8 — the bottom is the signal. */
const tailBytes = (text: string): string => {
    if (Buffer.byteLength(text, 'utf-8') <= MAX_INPUT_BYTES) return text;
    const bytes = Buffer.from(text, 'utf-8');
    // Drop what is left of a character the cut went through.
    return bytes.subarray(-MAX_INPUT_BYTES).toString('utf-8').replace(/^\uFFFD+/, '');
};

export interface EvaluationResult {
    state: AgentState;
    /** Rule that decided the state — for verbose logs and rule debugging. */
    ruleId?: string;
}

// Compiled-regex cache. Rules are static between manifest swaps, so
// compiling once per (pattern) is enough; a failed compile is cached as
// its reason so a bad OTA pattern logs once, not every 5-second cycle.
const regexCache = new Map<string, RE2JS | string>();

const compilePattern = (pattern: string): RE2JS | string => {
    const cached = regexCache.get(pattern);
    if (cached !== undefined) return cached;
    let compiled: RE2JS | string;
    if (pattern.length > MAX_PATTERN_LENGTH) {
        compiled = `longer than ${MAX_PATTERN_LENGTH} characters`;
    } else {
        try {
            compiled = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE | RE2JS.MULTILINE);
            if (compiled.programSize() > MAX_PROGRAM_SIZE) compiled = `compiles to more than ${MAX_PROGRAM_SIZE} steps`;
        } catch (err) {
            compiled = err instanceof Error ? err.message : String(err);
        }
    }
    regexCache.set(pattern, compiled);
    return compiled;
};

/** Why a rule or watch pattern will never match, or null when it compiles. */
export const patternError = (pattern: string): string | null => {
    const compiled = compilePattern(pattern);
    return typeof compiled === 'string' ? compiled : null;
};

/** Test hook: manifest swaps call this so stale patterns don't pin memory. */
export const clearRegexCache = (): void => {
    regexCache.clear();
};

const conditionMatches = (cond: RuleCondition, text: string, lowerText: string): boolean => {
    for (const needle of cond.contains ?? []) {
        if (!lowerText.includes(needle.toLowerCase())) return false;
    }
    for (const pattern of cond.regex ?? []) {
        const compiled = compilePattern(pattern);
        // A pattern that failed to compile can never be satisfied —
        // fail the condition rather than silently passing it, so a
        // broken OTA rule becomes inert instead of over-matching.
        if (typeof compiled === 'string' || !compiled.test(text)) return false;
    }
    return true;
};

const ruleMatches = (rule: DetectionRule, text: string, lowerText: string): boolean => {
    if (!conditionMatches({ contains: rule.contains, regex: rule.regex }, text, lowerText)) return false;
    if (rule.any && rule.any.length > 0) {
        if (!rule.any.some((c) => conditionMatches(c, text, lowerText))) return false;
    }
    for (const excluded of rule.not ?? []) {
        if (conditionMatches(excluded, text, lowerText)) return false;
    }
    return true;
};

const tailOf = (lines: string[], count: number): string =>
    lines.filter((l) => l.trim().length > 0).slice(-count).join('\n');

/**
 * Classify one pane capture. `prev` feeds skipStateUpdate rules — an
 * overlay match returns the previous confirmed state unchanged.
 */
export const evaluateState = (
    paneText: string,
    agentKind: AgentKind,
    manifest: DetectionManifest,
    prev: AgentState = 'unknown',
): EvaluationResult => {
    // Truncate from the FRONT: the bottom of the pane is where every
    // agent renders its live status, so the tail is the signal.
    const text = tailBytes(paneText);
    const lines = text.split('\n');
    const disabled = new Set(manifest.disabledRuleIds ?? []);
    const rules = (manifest.agents[agentKind] ?? [])
        .filter((r) => !disabled.has(r.id))
        .sort((a, b) => b.priority - a.priority);

    for (const rule of rules) {
        const scope = rule.region === 'whole'
            ? text
            : tailOf(lines, rule.tailLines ?? DEFAULT_TAIL_LINES);
        if (ruleMatches(rule, scope, scope.toLowerCase())) {
            if (rule.skipStateUpdate) return { state: prev, ruleId: rule.id };
            return { state: rule.state, ruleId: rule.id };
        }
    }
    return { state: 'unknown' };
};

/**
 * Safe one-pattern probe for output-match watches (§S5 v2). Same caps
 * as rule evaluation — user-authored watch patterns are exactly as
 * untrusted as OTA rules. Returns the matched line for the push body.
 */
export const findPatternMatch = (pattern: string, paneText: string): { line: string } | null => {
    const text = tailBytes(paneText);
    const compiled = compilePattern(pattern);
    // `test` is the fast path; only a pane that matches pays for `find`.
    if (typeof compiled === 'string' || !compiled.test(text)) return null;
    const matcher = compiled.matcher(text);
    if (!matcher.find()) return null;
    const at = matcher.start();
    const start = text.lastIndexOf('\n', at) + 1;
    const endIdx = text.indexOf('\n', at);
    const line = text.slice(start, endIdx === -1 ? undefined : endIdx).trim();
    return { line };
};

// ── Flap suppression ─────────────────────────────────────────────

export interface StateTracker {
    /** Last CONFIRMED state — what gets reported to the server. */
    confirmed: AgentState;
    confirmedAt: number;
    ruleId?: string;
    /** Pending different observation awaiting its second sighting. */
    candidate?: AgentState;
    candidateRuleId?: string;
    /** Hash of the pane text behind the last evaluation (skip re-eval). */
    contentHash?: string;
}

/**
 * Consecutive-confirmation debounce: a NEW state must be observed on
 * two consecutive cycles (~10 s at the 5 s report interval) before it
 * replaces the confirmed one. Menus flashed open, mid-render frames,
 * and scroll artifacts all last one cycle and die as candidates.
 *
 * The very first observation confirms immediately — a fresh tracker
 * has no baseline to protect, and the server treats a session's first
 * reported state as baseline, not as a transition (§S2).
 */
export const advanceState = (
    tracker: StateTracker | undefined,
    observed: EvaluationResult,
    now: number,
): StateTracker => {
    if (!tracker) {
        return { confirmed: observed.state, confirmedAt: now, ruleId: observed.ruleId };
    }
    if (observed.state === tracker.confirmed) {
        // Re-confirmation clears any pending candidate.
        return { ...tracker, candidate: undefined, candidateRuleId: undefined, ruleId: observed.ruleId ?? tracker.ruleId };
    }
    if (observed.state === tracker.candidate) {
        // Second consecutive sighting — promote.
        return { confirmed: observed.state, confirmedAt: now, ruleId: observed.ruleId };
    }
    return { ...tracker, candidate: observed.state, candidateRuleId: observed.ruleId };
};
