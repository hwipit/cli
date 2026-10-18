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
 * A prompt that cannot be parsed, has no one to seal for, or fails to seal is left
 * out: the session reports the bare `blocked` state, as it did before. Nothing
 * here logs the dialog text, the plaintext or the ciphertext.
 */
import { parseBlockedDialog, promptPlaintext, showsPrompt } from './blocked-prompt.js';
import type { AgentState } from './agent-state.js';
import type { AgentKind } from './remote-agents.js';
import type { RecorderRecipient, SealedChunk } from './turn-recorder.js';

/** What the session report carries: the server stores it and never opens it. */
export interface BlockedPromptWire {
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

export interface PromptSealerDeps {
    deviceId: () => string;
    recipients: () => Promise<RecorderRecipient[]>;
    seal: (plaintext: string, recipients: RecorderRecipient[]) => Promise<SealedChunk>;
    log?: (message: string) => void;
    now?: () => number;
}

interface Entry {
    id: string;
    at: string;
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
}

export const createPromptSealer = (deps: PromptSealerDeps): PromptSealer => {
    const now = deps.now ?? Date.now;
    const entries = new Map<string, Entry>();

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
            if (entry?.id !== parsed.id) {
                entry = { id: parsed.id, at: new Date(now()).toISOString(), busy: false };
                entries.set(name, entry);
            }
            if (entry.wire) return entry.wire;
            if (!entry.busy && (entry.retryAt === undefined || now() >= entry.retryAt)) {
                entry.retryAt = undefined;
                const plaintext = promptPlaintext(parsed, { sessionName: name, deviceId: deps.deviceId(), at: entry.at });
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
        },
        sealing: () => {
            const running = [...entries.values()].flatMap((e) => (e.sealing ? [e.sealing] : []));
            return running.length > 0 ? Promise.all(running).then(() => undefined) : undefined;
        },
    };
};

/**
 * True when the pane shows the prompt `id` right now (a fresh capture, not the one a report was made from). Capture it
 * the way `observe` was fed (`-e`): OpenCode's highlight is in the escapes, and the id with it.
 */
export const promptStillShown = (id: string, paneText: string | null): boolean =>
    paneText !== null && showsPrompt(id, paneText);
