/**
 * Turns the dialog a blocked session shows into the sealed summary the session
 * report carries (`blockedPrompt`, hwip SERVER-API.md).
 *
 * `observe` is called once per session per report cycle, synchronously, with the
 * pane the state was read from. Sealing is async (key lookup, ECDH), so the first
 * cycle that sees a prompt starts the seal and `sealing()` says when it is done:
 * the listener holds that report for it a short while (`withSettledPrompts`), since
 * the server pushes the moment a session turns blocked and the phone reads the
 * prompt for the push's buttons right then. The sealed object is kept while the
 * prompt id is unchanged, so an unchanged prompt makes an unchanged report.
 *
 * An answer the listener typed spends the prompt id (`answered`). The id hashes the dialog, so an agent that asks
 * the same thing again right after (a retried command) would otherwise show a prompt with the same id and time: the
 * phone, holding its answer for that id, would keep saying "sent" over a new question, and a second tap on the old
 * card would approve the new one. The same dialog seen after an answer gets a new id and a new time instead, also when
 * the session left the prompt in between, and an input bound to the spent id is refused (`stillShown`). For a moment
 * after the keys go in (`PROMPT_REISSUE_GRACE_MS`) a look that still shows the answered dialog reports it unchanged.
 * An input is taken only for the prompt the sealer holds now: after a listener restart, or a look that missed the
 * dialog, a tap on the old card is refused until the next look reports the prompt again.
 *
 * A prompt that cannot be parsed, has no one to seal for, or fails to seal is left
 * out: the session reports the bare `blocked` state, as it did before. Nothing
 * here logs the dialog text, the plaintext or the ciphertext.
 */
import { createHash } from 'node:crypto';
import { parseBlockedDialog, promptPlaintext, showsPrompt } from './blocked-prompt.js';
import type { AgentState } from './agent-state.js';
import type { AgentKind } from './remote-agents.js';
import type { RecorderRecipient, SealedChunk } from './turn-recorder.js';

/** What the session report carries: the server stores it and never opens it. */
export interface BlockedPromptWire {
    /** The dialog's hash (`ParsedPrompt.id`); after an answer, the same dialog shown again gets one minted from it and `at`. */
    id: string;
    /**
     * When the listener first saw THIS prompt id, ISO 8601. Not the session's `stateChangedAt`: approvals that follow
     * one another inside one blocked run, or a highlight that moves, make a new id with a later `at` while
     * `stateChangedAt` stays. It never precedes the session's `stateChangedAt` (the state is confirmed before a prompt
     * is read); the app compares it with the session record's `blockedPrompt.at`.
     */
    at: string;
    sealed: SealedChunk;
}

/** After a failed seal or an empty recipient list, how long before the same prompt is tried again. */
export const PROMPT_SEAL_RETRY_MS = 30_000;
/**
 * How long an answered dialog may stay on screen before the same dialog counts as shown again: the pane redraws a
 * moment after the keys go in, and a sweep in that moment still sees the answered one.
 */
export const PROMPT_REISSUE_GRACE_MS = 1_500;
/** Dialog hashes remembered as answered per session: the phone keeps its answer per id, so a spent hash is not reused. */
const SPENT_PER_SESSION = 16;

export interface PromptSealerDeps {
    deviceId: () => string;
    recipients: () => Promise<RecorderRecipient[]>;
    seal: (plaintext: string, recipients: RecorderRecipient[]) => Promise<SealedChunk>;
    log?: (message: string) => void;
    now?: () => number;
}

interface Entry {
    /** What the report carries and an input binds to. */
    id: string;
    /** The dialog's hash, which a fresh capture is checked against. */
    contentId: string;
    at: string;
    /** When an input bound to `id` was typed; the same dialog seen after the grace gets a new entry. */
    spentAt?: number;
    wire?: BlockedPromptWire;
    /** Set while a seal is running, or after one failed (the time to try again). */
    busy: boolean;
    /** The running seal; settles, never rejects. */
    sealing?: Promise<void>;
    retryAt?: number;
}

export interface PromptSealer {
    /** The sealed prompt for this session's screen, or undefined (not blocked, not a known dialog, not sealed yet). */
    observe: (name: string, kind: AgentKind, state: AgentState | undefined, paneText: string | null) => BlockedPromptWire | undefined;
    /** Forget sessions that are gone. */
    prune: (live: ReadonlySet<string>) => void;
    /** Settles when the seals running now are done, or undefined when none is. */
    sealing: () => Promise<void> | undefined;
    /** An input bound to prompt `id` was typed into `name`: that id is spent. */
    answered: (name: string, id: string) => void;
    /** True when `id` is the unspent prompt of `name` and `paneText` (a fresh capture) still shows it. */
    stillShown: (name: string, id: string, paneText: string | null) => boolean;
}

/** The id of a dialog shown again after an answer: the dialog's hash and when this showing was first seen. */
const reissuedId = (contentId: string, at: string): string =>
    createHash('sha256').update(`${contentId}\n${at}`).digest('hex').slice(0, 16);

export const createPromptSealer = (deps: PromptSealerDeps): PromptSealer => {
    const now = deps.now ?? Date.now;
    const entries = new Map<string, Entry>();
    /** Session → dialog hashes an answer spent. Kept apart from `entries`: a look that misses the dialog drops its entry. */
    const spent = new Map<string, string[]>();
    const wasSpent = (name: string, contentId: string): boolean => spent.get(name)?.includes(contentId) ?? false;

    const start = (name: string, entry: Entry, plaintext: string): void => {
        entry.busy = true;
        entry.sealing = (async () => {
            try {
                const recipients = await deps.recipients();
                if (recipients.length === 0) {
                    entry.retryAt = now() + PROMPT_SEAL_RETRY_MS;
                    return;
                }
                const sealed = await deps.seal(plaintext, recipients);
                entry.wire = { id: entry.id, at: entry.at, sealed };
            } catch (err) {
                // The message of a crypto error names no content; the dialog text is never in it.
                deps.log?.(`blocked prompt for ${name}: seal failed (${err instanceof Error ? err.message : String(err)})`);
                entry.retryAt = now() + PROMPT_SEAL_RETRY_MS;
            } finally {
                entry.busy = false;
                entry.sealing = undefined;
            }
        })();
    };

    return {
        observe: (name, kind, state, paneText) => {
            const parsed = state === 'blocked' && paneText !== null ? parseBlockedDialog(paneText, kind) : undefined;
            if (!parsed) {
                entries.delete(name);
                return undefined;
            }
            let entry = entries.get(name);
            // The answered dialog, still drawn a moment after the keys went in: keep reporting it as it was.
            if (entry?.contentId === parsed.id && entry.spentAt !== undefined && now() - entry.spentAt < PROMPT_REISSUE_GRACE_MS) {
                return entry.wire;
            }
            if (entry?.contentId !== parsed.id || entry.spentAt !== undefined) {
                const at = new Date(now()).toISOString();
                const id = wasSpent(name, parsed.id) ? reissuedId(parsed.id, at) : parsed.id;
                entry = { id, contentId: parsed.id, at, busy: false };
                entries.set(name, entry);
            }
            if (entry.wire) return entry.wire;
            if (!entry.busy && (entry.retryAt === undefined || now() >= entry.retryAt)) {
                entry.retryAt = undefined;
                const plaintext = promptPlaintext({ ...parsed, id: entry.id }, { sessionName: name, deviceId: deps.deviceId(), at: entry.at });
                // A prompt too big for the cap is not retried: the screen would not shrink.
                if (plaintext === undefined) entry.retryAt = Number.POSITIVE_INFINITY;
                else start(name, entry, plaintext);
            }
            return undefined;
        },
        prune: (live) => {
            for (const name of entries.keys()) {
                if (!live.has(name)) entries.delete(name);
            }
            for (const name of spent.keys()) {
                if (!live.has(name)) spent.delete(name);
            }
        },
        sealing: () => {
            const running = [...entries.values()].flatMap((e) => (e.sealing ? [e.sealing] : []));
            return running.length > 0 ? Promise.all(running).then(() => undefined) : undefined;
        },
        answered: (name, id) => {
            const entry = entries.get(name);
            if (entry?.id !== id || entry.spentAt !== undefined) return;
            entry.spentAt = now();
            const list = (spent.get(name) ?? []).filter((c) => c !== entry.contentId);
            spent.set(name, [...list, entry.contentId].slice(-SPENT_PER_SESSION));
        },
        stillShown: (name, id, paneText) => {
            const entry = entries.get(name);
            return entry !== undefined && entry.spentAt === undefined && entry.id === id && promptStillShown(entry.contentId, paneText);
        },
    };
};

/**
 * True when the pane shows the prompt `id` right now (a fresh capture, not the one a report was made from). Capture it
 * the way `observe` was fed (`-e`): OpenCode's highlight is in the escapes, and the id with it.
 */
export const promptStillShown = (id: string, paneText: string | null): boolean =>
    paneText !== null && showsPrompt(id, paneText);
