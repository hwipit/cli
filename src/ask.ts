/**
 * `hwip ask` — put a question on the user's phone and block until they answer.
 *
 * Why this lives in the CLI at all: hooks are shell scripts, and a shell script
 * cannot call an MCP tool. `hwip_ask` (mcp-server) already does this for the
 * model; a hook that needs to wait for a person — an approval gate in front of
 * a dangerous command — has no way to reach it. This is that path.
 *
 * It returns ONE shape for every outcome, including failure. A hook standing in
 * front of `rm -rf` cannot handle an exception, and an approval gate that
 * throws has stopped being a gate: unreachable server, bad key, and silence all
 * come back as `answered: false` so the caller makes the same decision it would
 * have made on a refusal. `reason` says which (`cancelled`, `timeout`, `error`)
 * for a caller that wants to tell them apart.
 *
 * No WebSocket fast path, unlike mcp-server's poll. A hook run is seconds long
 * and dies with the tool call, so a socket would cost a handshake it cannot
 * amortise; plain polling is the whole protocol here.
 */
import { randomUUID } from 'node:crypto';
import { keyIsFromFile, loadConfig, resolveBaseUrl, resolvedEnv, resolveHookId } from './config.js';
import { agentSessionContext } from './agent-session.js';
import { clearRemoteActive, stateDir, touchRemoteActive } from './gate.js';
import { AUTH_HINT, httpFailureMessage, isConfigFailure, isInvalidUrl, isRedirectRefusal, isUnsendableHeader, networkFailureMessage, neverConnected, readJsonBody } from './http-failure.js';
import { warnInsecureUrl } from './insecure-url.js';
import { flagOn } from './args.js';
import { apiFetch, apiUrl, fitsInHeader } from './api.js';
import { getDevicePublicKey, initDeviceCrypto, type SealedFileMeta } from './crypto.js';
import { saveAnswerFiles, type AnswerFileOpener, type SavedAnswerFiles } from './answer-files.js';
import { listenerDeviceId } from './listener-device-id.js';
import { TRUST_FILE } from './config.js';
import { registerOverApi } from './self-register.js';
import { openAnswer, prepareAsk, refusalMessage, type AskSealDeps, type OpenedAnswer, type PreparedAsk } from './ask-seal.js';
import { ID, pendingAsks, type PendingAsk, type PendingAsks, type PendingSlot } from './ask-pending.js';

/** Server-side hook trigger + event read. Kept narrow on purpose — this
 *  module needs two routes, not an API client. */
const TRIGGER_PATH = (hookId: string) => `/hooks/${encodeURIComponent(hookId)}/trigger`;
const EVENT_PATH = (hookId: string, eventId: string) => `/hooks/${encodeURIComponent(hookId)}/events/${encodeURIComponent(eventId)}`;

/** Poll cadence: every second for the first 30 s, when a tap is most likely
 *  and should feel immediate, then every 2.5 s — a 10-minute wait is about
 *  250 requests instead of 600. Exported for tests. */
export const pollIntervalMs = (waitedMs: number): number => (waitedMs < 30_000 ? 1_000 : 2_500);
/** Per-request bound, well under any sane overall deadline. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The least a try at sending is waited on, however little of the window is left: one with no time to be answered is not a try. */
const MIN_REQUEST_MS = 1_000;
/** Failed polls in a row before the wait ends early. At the poll cadence this
 *  is 5–13 s of outage — long enough to ride out a blip, short enough that a
 *  gate does not sit out its whole timeout against a dead server. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Pauses before the tries that follow a trigger failure that may pass: four tries in all. */
const TRIGGER_BACKOFF_MS = [1_000, 2_000, 4_000];
/**
 * A first request still running under the key answers a retry with 409 until it ends. One the server
 * lost to its own timeout never ends: the key stays taken for 30 s (hwip `server/src/entities/idempotency.ts`
 * STALE_CLAIM_MS, read 2026-10-14) and a retry after that is taken as a new request. So these tries are
 * counted apart from the ones above, and go on until that hold has passed: seven more, 35 s of
 * waiting from the first 409. The key was taken before that answer, so the last try comes after the
 * hold whatever the first request took to fail.
 */
const IN_PROGRESS_RETRY_MS = 5_000;
const IN_PROGRESS_RETRIES = 7;

/**
 * Said of a question a retry put up, unless the answer says the phone was notified. A repeat the
 * server had already taken is answered with the question's ids alone (hwip `server/src/functions/hooks.ts`,
 * `once.replayed`, read 2026-10-14): the push went out with the first request or not at all, and only
 * that request's answer said which.
 */
const UNCONFIRMED_NOTIFY = 'the question went up on a retry, and the server did not say the phone was notified: it is in the app either way';

/**
 * How a 2xx to the trigger ends when it holds no event id to read by — none, or one not written as an id
 * (`ID`), which would go into the path of every read and into the record the next run reads by. Nothing is
 * read and nothing kept, and the caller is told not to take it for a question that never went up: asked
 * again, it is a second card. "May": a 2xx with such a body can be a proxy's as well as the server's.
 */
const NOT_READ_HERE = 'the question may be on the phone, and no answer to it can be read here \u2014 check the phone first: asking again puts a second card next to it';

export interface AskAction {
    id: string;
    label: string;
}

export interface AskOptions {
    apiKey: string;
    baseUrl: string;
    hookId: string;
    title: string;
    body?: string;
    actions?: AskAction[];
    timeoutSeconds: number;
    /**
     * Stable agent-session key, when this ask was raised from a tmux agent
     * pane. Both fields or neither: the phone's deep link needs the pair to
     * open the agent chat — which is where the live terminal and the key row
     * live — and falls back to the plain push screen without it. Agents with
     * no MCP (pi, codex) reach the phone only through this command, so leaving
     * them off is what made their asks land outside the chat.
     */
    agentDeviceId?: string;
    agentSessionName?: string;
    /**
     * Lets the phone offer "send and exit" on this ask. Only an agent's own
     * `hwip_ask` stand-in sets it (pi's rules pass `--accepts-exit`); an
     * approval gate has no mode to end, so it never offers the button and a
     * stray `exitRemote` on its answer is dropped.
     */
    acceptsExit?: boolean;
    /**
     * Lets the phone attach files to a typed answer; they are saved to `~/.hwip/attachments/<eventId>/`
     * and their paths follow the text. Set with `acceptsExit`: only an agent's own ask reads a reply.
     */
    acceptsFiles?: boolean;
}

/** Injected so the poll loop is testable without a clock or a network. */
export interface AskDeps {
    fetchFn: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** How a question is sealed. There is no plain question: one that cannot be sealed is refused. */
    seal: AskSealDeps;
    /** Where a question that went up is kept, so one cut short can be taken up again. Without it, every ask is a new question. */
    pending?: PendingAsks;
    /** Saves the files a sealed answer names (answer-files.ts). Without it they are left on the server. */
    saveFiles?: (eventId: string, wire: unknown, metas: SealedFileMeta[], opener: AnswerFileOpener) => Promise<SavedAnswerFiles>;
}

/** Why an ask ended unanswered: the user cancelled it on the phone, nobody
 *  answered in time, or the server could not be reached or refused. */
export type UnansweredReason = 'cancelled' | 'timeout' | 'error';

export type AskOutcome = (
    | { readonly answered: true; readonly actionId: string }
    | {
        readonly answered: true;
        readonly value: string;
        readonly exitRemote?: true;
        /** Where the answer's files were saved; their paths also follow the text in `value`. */
        readonly files?: readonly string[];
        /** `<name>: <why>` for each attached file that was not saved. */
        readonly missingFiles?: readonly string[];
    }
    | { readonly answered: false; readonly reason: UnansweredReason; readonly error?: string }
) & {
    /** This is the end of a question an earlier run of the same command put up and did not see through: nothing was sent. */
    readonly resumed?: true;
    /** The question is over but its record could not be removed: the same command rerun in time would take up this answer again. Survives `2>/dev/null`. */
    readonly warn?: string;
};

/**
 * `id:Label` pairs, comma separated. The label may contain colons — only the
 * first one separates, so `go:Deploy: prod` keeps its punctuation. A bare
 * segment becomes its own label, which is what someone typing `--actions ok`
 * means.
 */
export const parseActions = (spec?: string): AskAction[] => {
    if (!spec) return [];
    return spec
        .split(',')
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0)
        .map((seg) => {
            const idx = seg.indexOf(':');
            if (idx === -1) return { id: seg, label: seg };
            const id = seg.slice(0, idx).trim();
            const label = seg.slice(idx + 1).trim();
            return { id, label: label || id };
        })
        .filter((a) => a.id.length > 0);
};

const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

interface ApiShape {
    data?: {
        /** Whatever the answer's JSON holds: checked against `ID` before it is used. */
        eventId?: unknown;
        pushId?: unknown;
        /** A trigger's first answer only: whether the native push was queued. */
        notified?: boolean;
        status?: string;
        response?: { actionId?: string; value?: string; exitRemote?: boolean; sealed?: unknown; respondedDeviceId?: string; files?: unknown } | null;
    };
    error?: { code?: string; message?: string };
}

/** A non-2xx reply, kept apart from a network failure so the caller can tell
 *  a refusal that will repeat from a blip that may not. */
class HttpError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
        super(message);
    }
}

/** A 4xx other than 408 / 429 is an answer about the request itself — bad key,
 *  hook gone — and asking again gets the same answer. */
const isFatal = (err: unknown): boolean =>
    err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

/**
 * Whether a failed trigger is sent again, and after which pause. The trigger goes under an
 * Idempotency-Key, so a second copy of one that landed opens nothing: the server answers it with the
 * first question's ids. That leaves only a refusal not worth repeating — a 4xx about the request
 * itself, or a redirect, which the server will answer the same way again — and an address `fetch`
 * cannot parse or a header it will not send, which no try will send.
 */
const resendAfter = (err: unknown): 'never' | 'backoff' | 'in-progress' => {
    if (err instanceof HttpError && err.status === 409 && err.code === 'IDEMPOTENCY_IN_PROGRESS') return 'in-progress';
    if (isFatal(err) || (err instanceof TypeError && (isRedirectRefusal(err) || isInvalidUrl(err) || isUnsendableHeader(err))) || isConfigFailure(err)) return 'never';
    return 'backoff';
};

const callApi = async (
    deps: AskDeps,
    opts: AskOptions,
    method: string,
    path: string,
    request: {
        /** A JSON body as the bytes to send, and the headers that go with it. */
        payload?: { body: string; headers?: Record<string, string> };
        /**
         * When the window this request is sent in ends: it is not waited on past that, by more than
         * `MIN_REQUEST_MS`. For a send, which is no use once nobody waits for the answer. A read of the
         * answer is given none: late is all it can be, and it may be the one that finds the answer there.
         */
        until?: number;
    } = {},
): Promise<ApiShape> => {
    const { payload, until } = request;
    const controller = new AbortController();
    const patience = until === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_MS, until - deps.now()));
    const timer = setTimeout(() => controller.abort(new DOMException(`the request timed out after ${Math.round(patience / 1000)} s`, 'TimeoutError')), patience);
    try {
        const headers: Record<string, string> = { 'X-API-Key': opts.apiKey };
        if (payload) Object.assign(headers, { 'Content-Type': 'application/json' }, payload.headers);
        const url = `${opts.baseUrl}${path}`;
        let res: Response;
        try {
            res = await deps.fetchFn(url, {
                method,
                headers,
                body: payload?.body,
                signal: controller.signal,
                // A redirect would carry the X-API-Key header to another host.
                redirect: 'error',
            });
        } catch (err) {
            // Still a TypeError, so resendAfter reads it as before — with
            // the cause a person can act on instead of "fetch failed". A refused redirect keeps its
            // original; an unsendable header's words quote the key whole, so its cause is dropped.
            if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error(err.message, { cause: err });
            // The cause is what `neverConnected` reads the connection from, so it is kept — except an
            // unsendable header's, whose words quote the key whole (the sanitized message still classifies).
            if (err instanceof TypeError && isUnsendableHeader(err)) throw new TypeError(networkFailureMessage(err, url));
            if (err instanceof TypeError) throw new TypeError(networkFailureMessage(err, url), { cause: err });
            throw err;
        }
        const json = (await readJsonBody(res)) as ApiShape | null;
        if (!res.ok) {
            const message = httpFailureMessage(res.status, json);
            throw new HttpError(res.status, res.status === 401 ? `${message} — ${AUTH_HINT}` : message, json?.error?.code);
        }
        // A 2xx that is not our JSON (a captive portal, a cut-off body) is a
        // failed call, not an empty answer.
        if (!json) throw new Error(`unreadable response (HTTP ${res.status})`);
        return json;
    } finally {
        clearTimeout(timer);
    }
};

type SealedAsk = Extract<PreparedAsk, { kind: 'sealed' }>;

/**
 * A failed trigger the server may have taken all the same: a slow answer, one that could not be read, a
 * 5xx (a gateway that gave up on a request already written), a first send still running. Not its own
 * "too many", and not a connection that was never made or a header `fetch` would not send — which is
 * not every `TypeError` of `fetch`: a socket reset after the request, or an answer that stops mid-body,
 * is one too.
 */
const mayHaveLanded = (err: unknown): boolean =>
    err instanceof HttpError ? err.status !== 429 : !neverConnected(err) && !isUnsendableHeader(err);

/**
 * Put the question on the phone, once. Every try carries the same key and the same bytes: the server
 * replays a retry only when its body is the first one's, and takes another body under the key as a
 * different request (422).
 *
 * What the key does not cover (hwip `server/SERVER-API.md`, the trigger's `Idempotency-Key`, read
 * 2026-10-14): a first request that wrote the question and died before it marked the key is taken
 * over after its 30 s hold, and that try opens a second question.
 */
const trigger = async (deps: AskDeps, opts: AskOptions, deadline: number, prepared: SealedAsk): Promise<{ answer: ApiShape; retried: boolean }> => {
    // The question carries its wording inside the envelope: the server gets each choice's id and nothing else of it.
    const body = JSON.stringify({
        isEncrypted: true,
        ...prepared.fields,
        actions: opts.actions?.map(({ id }) => ({ id })),
        ...(prepared.files ? { files: prepared.files } : {}),
        // What is left of the window, so the question ends on the phone when this wait does: sealing took
        // some of it, and so did a question taken up first that ended unanswered.
        timeout: Math.max(1, Math.ceil((deadline - deps.now()) / 1000)),
        hookType: 'combo',
        agentDeviceId: opts.agentDeviceId,
        agentSessionName: opts.agentSessionName,
        ...(opts.acceptsExit ? { acceptsExit: true } : {}),
        ...(opts.acceptsFiles ? { acceptsFiles: true } : {}),
    });
    const payload = { body, headers: { 'Idempotency-Key': randomUUID() } };
    let backoffs = 0;
    let inProgress = 0;
    /** Some try so far may have reached the server, whatever the last one says. */
    let unsure = false;
    for (;;) {
        try {
            return { answer: await callApi(deps, opts, 'POST', TRIGGER_PATH(opts.hookId), { payload, until: deadline }), retried: backoffs + inProgress > 0 };
        } catch (err) {
            const resend = resendAfter(err);
            if (resend !== 'never') unsure ||= mayHaveLanded(err);
            const wait = resend === 'never'
                ? undefined
                : resend === 'in-progress'
                    ? (inProgress++ < IN_PROGRESS_RETRIES ? IN_PROGRESS_RETRY_MS : undefined)
                    : TRIGGER_BACKOFF_MS[backoffs++];
            if (wait === undefined || deps.now() + wait >= deadline) {
                // The last failure alone would have its reader ask again, for a second card next to the first.
                throw unsure ? new Error(`${errorMessage(err)} — ${TRIGGER_MAY_BE_UP}`) : err;
            }
            await deps.sleep(wait);
        }
    }
};

/**
 * What an opened answer means to the caller: the choice, or the text (with the exit when this ask offers
 * it). Saved files' paths follow the text, so a reader of `value` alone still finds them.
 */
const sealedOutcome = (opened: OpenedAnswer, acceptsExit: boolean, saved?: SavedAnswerFiles): AskOutcome => {
    if (!opened.ok) return { answered: false, reason: 'error', error: refusalMessage(opened.cause) };
    if (opened.actionId !== undefined) return { answered: true, actionId: opened.actionId };
    const value = [opened.value ?? '', ...(saved?.paths ?? [])].filter(Boolean).join('\n');
    const files = {
        ...(saved?.paths.length ? { files: saved.paths } : {}),
        ...(saved?.missing.length ? { missingFiles: saved.missing } : {}),
    };
    if (opened.exit === true && acceptsExit) return { answered: true, value, exitRemote: true, ...files };
    if (value || saved) return { answered: true, value, ...files };
    return { answered: false, reason: 'error', error: refusalMessage('empty-answer') };
};

/** The answer's files, saved — when this ask took files, the answer names some, and this machine has its key. */
const saveFilesOf = async (
    deps: AskDeps,
    opts: AskOptions,
    eventId: string,
    response: { files?: unknown } | null | undefined,
    opened: OpenedAnswer,
): Promise<SavedAnswerFiles | undefined> => {
    if (!opened.ok || !opened.files || !opened.senderPublicKey) return undefined;
    // Not offered on this ask: said, not dropped.
    if (!opts.acceptsFiles || !deps.saveFiles) return { paths: [], missing: opened.files.map((m) => `${m.name}: this ask does not take files`) };
    const deviceId = deps.seal.self()?.deviceId;
    if (!deviceId) return { paths: [], missing: opened.files.map((m) => `${m.name}: this machine has no key`) };
    return deps.saveFiles(eventId, response?.files, opened.files, { deviceId, senderPublicKey: opened.senderPublicKey });
};

/** A question on the phone, as the wait needs it: where its answer is read and what opens it. */
interface Asked {
    eventId: string;
    askId: string;
    offered: string[] | undefined;
}

/**
 * How a wait ended, beside its outcome. `over`: the question is — answered, cancelled or timed out —
 * and nothing more will come of it. `open`: only the wait ended, and the question may still be on the
 * phone, or its answer on the server: a read that failed or was refused, an answer this machine could
 * not open for now, the clock.
 */
interface Waited {
    outcome: AskOutcome;
    end: 'over' | 'open';
}

/**
 * Read the question's answer until there is one, the question ends without, or `until` passes — once
 * at least, whatever the clock says: the answer may be there already.
 */
const awaitAnswer = async (
    deps: AskDeps,
    opts: AskOptions,
    asked: Asked,
    until: number,
    unconfirmed?: { error: string },
): Promise<Waited> => {
    const polling = deps.now();
    let failures = 0;
    let unusable = 0;
    let lastError: unknown;
    let seen = false;
    do {
        try {
            const event = await callApi(deps, opts, 'GET', EVENT_PATH(opts.hookId, asked.eventId));
            failures = 0;
            seen = true;
            // The plaintext fields of a response are never read: the server refuses them on a sealed
            // question, so any that are there were put there by something else.
            if (event.data?.status === 'responded') {
                const opened = await openAnswer(event.data.response ?? undefined, asked.askId, asked.offered, deps.seal);
                // The device list or the trust file failing to load may pass: read again, up to the
                // same run of failures as a failed poll (this read itself succeeded, so `failures` was reset).
                // When it keeps failing the answer is still there, to be opened by a later run.
                const mayPass = !opened.ok && opened.cause === 'peer-unusable';
                if (mayPass && (unusable += 1) < MAX_CONSECUTIVE_FAILURES) {
                    lastError = new Error(refusalMessage(opened.cause));
                } else {
                    const saved = await saveFilesOf(deps, opts, asked.eventId, event.data.response, opened);
                    return { outcome: sealedOutcome(opened, opts.acceptsExit === true, saved), end: mayPass ? 'open' : 'over' };
                }
            }
            if (event.data?.status === 'cancelled') return { outcome: { answered: false, reason: 'cancelled' }, end: 'over' };
            if (event.data?.status === 'timed_out') return { outcome: { answered: false, reason: 'timeout', ...unconfirmed }, end: 'over' };
        } catch (err) {
            // A refusal will repeat, so waiting on it only stalls the gate. A
            // blip may pass — one failed poll is not an answer and not a
            // refusal — but a run of them means the server is gone for now.
            // A 404 before the first good read is the server's eventually
            // consistent read missing the event it just wrote, not a refusal.
            // A refusal ends the wait and not the question: a key that was
            // rotated or mistyped is refused while the question sits on the phone.
            const unseen404 = !seen && err instanceof HttpError && err.status === 404;
            if (isFatal(err) && !unseen404) return { outcome: { answered: false, reason: 'error', error: errorMessage(err) }, end: 'open' };
            failures += 1;
            lastError = err;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                return { outcome: { answered: false, reason: 'error', error: errorMessage(err) }, end: 'open' };
            }
        }
        const now = deps.now();
        await deps.sleep(Math.min(pollIntervalMs(now - polling), Math.max(0, until - now)));
    } while (deps.now() < until);

    return {
        outcome: failures > 0 || unusable > 0
            ? { answered: false, reason: 'error', error: errorMessage(lastError) }
            : { answered: false, reason: 'timeout', ...unconfirmed },
        end: 'open',
    };
};

/** Ends the error of a trigger that failed after a try the server may have taken. */
const TRIGGER_MAY_BE_UP = 'the question may have gone up all the same';

/** Said when a question that is over stays on record: the next run would take it up, and its answer with it. */
const NOT_FORGOTTEN = 'this question is over but its record under the state directory could not be removed: '
    + 'the same command run again before its timeout would be given this answer again';

const forget = (slot: PendingSlot, deps: AskDeps): boolean => {
    if (!slot.settle()) {
        deps.seal.warn?.(NOT_FORGOTTEN);
        return false;
    }
    return true;
};

/**
 * Wait on the question an earlier run of the same command left. Null when it ended with nobody having
 * answered and some of this run's window is left: that is not this run's outcome, and it asks anew.
 */
const takeUp = async (deps: AskDeps, opts: AskOptions, slot: PendingSlot, kept: PendingAsk, deadline: number): Promise<AskOutcome | null> => {
    // A new question loads the keys as it is sealed; this one was sealed by the run that put it up.
    try {
        await deps.seal.loadKeys();
    } catch {
        // Kept: the question is still on the phone, and a later run may open its answer.
        return { answered: false, reason: 'error', error: refusalMessage('keystore'), resumed: true };
    }
    // The buttons are this run's own: the match says they are the ones the question went up with.
    const asked: Asked = { eventId: kept.eventId, askId: kept.askId, offered: opts.actions?.map((a) => a.id) };
    const waited = await awaitAnswer(deps, opts, asked, Math.min(deadline, kept.deadline));
    const ended = waited.end === 'over' || deps.now() >= kept.deadline;
    // Before the outcome is handed over: an answer is used once.
    const forgotten = ended ? forget(slot, deps) : true;
    // A question the user cancelled stays cancelled.
    const unanswered = !waited.outcome.answered && waited.outcome.reason === 'timeout';
    if (ended && unanswered && deps.now() < deadline) return null;
    return { ...waited.outcome, resumed: true, ...(!forgotten ? { warn: NOT_FORGOTTEN } : {}) };
};

/**
 * Ask, then wait. Resolves when the user answers, the question settles
 * without an answer, or the deadline passes — never rejects. An unanswered
 * outcome says why in `reason`, and carries the last error when there was one.
 *
 * A question an earlier run of the same command put up and did not see through is waited on first, and
 * nothing is sent: the user may have answered it already, and a second card would sit next to the first.
 */
export const requestApproval = async (opts: AskOptions, deps: AskDeps): Promise<AskOutcome> => {
    const deadline = deps.now() + opts.timeoutSeconds * 1000;
    const slot = deps.pending?.of(opts);

    const kept = slot?.claim();
    if (slot && kept) {
        const outcome = await takeUp(deps, opts, slot, kept, deadline);
        if (outcome) return outcome;
    }

    const prepared = await prepareAsk({ title: opts.title, body: opts.body, actions: opts.actions }, deps.seal);
    // No plaintext fallback: a question that cannot be sealed is not sent.
    if (prepared.kind === 'refused') {
        const error = refusalMessage(prepared.cause, prepared.why, prepared.detail);
        // On stderr too, as `hwip notify` and `hwip agent send` say it: the JSON goes to whatever parses it, not to a person.
        if (prepared.cause === 'self-unlisted') deps.seal.warn?.(error);
        return { answered: false, reason: 'error', error };
    }
    // The lookups behind `prepared` count against the window but each has only its own limit: when they used it up,
    // a question sent now would sit on the phone after this ask has ended.
    if (deps.now() >= deadline) return { answered: false, reason: 'timeout' };

    let eventId: string;
    /** Set when nobody may have been told of the question: said at once, and again if it ends unanswered. */
    let unconfirmed: { error: string } | undefined;
    try {
        const { answer, retried } = await trigger(deps, opts, deadline, prepared);
        const { eventId: id, pushId: push } = answer.data ?? {};
        if (typeof id !== 'string' || !ID.test(id)) {
            const missing = id === undefined || id === null || id === '';
            // The push id is the server's string as well: quoted only when it is written as an id.
            const named = typeof push === 'string' && ID.test(push) ? ` (push ${push})` : '';
            const what = missing ? `named no event for it${named}` : 'the id it gave for it cannot be used';
            return { answered: false, reason: 'error', error: `the server took the question, but ${what}: ${NOT_READ_HERE}` };
        }
        eventId = id;
        if (retried && answer.data?.notified !== true) {
            unconfirmed = { error: UNCONFIRMED_NOTIFY };
            deps.seal.warn?.(UNCONFIRMED_NOTIFY);
        }
    } catch (err) {
        // No event id to wait on. When a try may have landed, the error says so.
        return { answered: false, reason: 'error', error: errorMessage(err) };
    }

    const asked: Asked = { eventId, askId: prepared.askId, offered: prepared.offered };
    slot?.record({ eventId, askId: prepared.askId, deadline });
    const waited = await awaitAnswer(deps, opts, asked, deadline, unconfirmed);
    // Kept while the question may still be answered — the wait gave up on a server it could not read, or
    // this process dies — so that the same command run again takes it up.
    if (slot && waited.end === 'over') {
        const forgotten = forget(slot, deps);
        if (!forgotten) return { ...waited.outcome, warn: NOT_FORGOTTEN };
    }
    return waited.outcome;
};

/** Action ids that end a remote session, case-insensitive — mcp-server remote-state.ts SESSION_EXIT_IDS. */
const SESSION_EXIT_IDS = ['done', 'stop', 'exit'];

/**
 * What an ask outcome does to sticky REMOTE — mcp-server's
 * `remoteTransitionFor`, for the outcomes this command can produce. A
 * Done-like button or a send-and-exit answer ends it; any other answer enters
 * or refreshes it. An unanswered ask changes nothing: there is no fallback id
 * here to resolve to, and silence is not a user action.
 */
export const remoteTransition = (outcome: AskOutcome): 'enter' | 'exit' | 'keep' => {
    if (!outcome.answered) return 'keep';
    if ('actionId' in outcome) {
        return SESSION_EXIT_IDS.includes(outcome.actionId.trim().toLowerCase()) ? 'exit' : 'enter';
    }
    return outcome.exitRemote ? 'exit' : 'enter';
};

const settleRemote = (outcome: AskOutcome, dir: string): { hwipState?: 'REMOTE' | 'NORMAL' } => {
    switch (remoteTransition(outcome)) {
        case 'exit':
            clearRemoteActive(dir);
            return { hwipState: 'NORMAL' };
        case 'enter':
            touchRemoteActive(dir);
            return { hwipState: 'REMOTE' };
        case 'keep':
            return {};
    }
};

/** The seal's world for real use: the account API, this machine's keys, the listener's trust file. */
export const liveSealDeps = (apiKey: string, baseUrl: string, deadline?: number): AskSealDeps => ({
    loadKeys: async () => { await initDeviceCrypto(); },
    self: () => {
        const publicKey = getDevicePublicKey();
        return publicKey ? { deviceId: listenerDeviceId(), publicKey } : null;
    },
    listDevices: async () => {
        const res = await apiFetch(fetch, apiUrl(baseUrl, '/devices'), apiKey, REQUEST_TIMEOUT_MS);
        if (!res.ok) throw new Error(`devices ${res.status}`);
        const json = (await res.json()) as { data?: unknown };
        if (!Array.isArray(json.data)) throw new Error('devices: unexpected response');
        return json.data as { deviceId: string; publicKey?: string }[];
    },
    register: registerOverApi({ apiKey, baseUrl }),
    trustPath: TRUST_FILE,
    warn: (line) => console.error(`hwip: ${line}`),
    // Loaded only for a question with a window to carry context for.
    ...(deadline === undefined ? {} : {
        attach: async (recipients) => (await import('./ask-context-attach.js'))
            .liveAttach({ apiKey, baseUrl }, deadline, (line) => process.stderr.write(`hwip ask: ${line}\n`))(recipients),
    }),
});

/** Wall-clock deps for real use. `deadline` is when the question's window ends: with one, a sealed question carries its context. */
export const liveDeps = (account: { apiKey: string; baseUrl: string; deadline?: number }): AskDeps => ({
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    seal: liveSealDeps(account.apiKey, account.baseUrl, account.deadline),
    pending: pendingAsks(stateDir()),
    saveFiles: async (eventId, wire, metas, opener) => {
        // The listener's download, borrowed: its log is the daemon's stdout, and this command's stdout is one JSON line.
        const { downloadSealedEach } = await import('./listener.js');
        const { silenceListenerLog } = await import('./listener-log.js');
        silenceListenerLog();
        return saveAnswerFiles(eventId, wire, metas, opener, (dirId, files, sealed) =>
            downloadSealedEach(dirId, files, { apiKey: account.apiKey, baseUrl: account.baseUrl }, sealed));
    },
});

/**
 * `hwip ask --title … [--body …] [--actions id:Label,…] [--timeout 60] [--accepts-exit]`
 *
 * Prints one JSON object and nothing else, so a hook can pipe it straight into
 * `jq`. Exit code 0 means answered, 1 means not — a shell caller that only
 * wants approve/deny can read `$?` and skip the JSON entirely.
 */
export const handleAsk = async (args: Record<string, string | boolean>): Promise<number> => {
    const config = loadConfig();
    // `resolvedEnv`, not `process.env`: a hook environment can hand us a literal
    // unexpanded `${HWIP_API_KEY}`, which is truthy and would beat the config
    // file. Auth then fails, this returns `answered: false`, and the approval
    // hook maps that to DENY — a command blocked for a reason that has nothing
    // to do with the user. Every other command in cli.ts resolves env this way.
    // Key and base URL resolve as cli.ts createHook does for every other
    // command; `--api-key` is this command's older spelling of `--key`. A
    // bare flag parses as `true`, which is no key and no URL.
    const flag = (name: string): string | undefined => (typeof args[name] === 'string' ? args[name] : undefined);
    const apiKey = flag('key') || flag('api-key') || resolvedEnv('HWIP_API_KEY') || config.apiKey;
    let baseUrl: string;
    try {
        baseUrl = resolveBaseUrl(flag('base-url'), config, keyIsFromFile(flag('key') || flag('api-key'), config));
    } catch (err) {
        process.stdout.write(JSON.stringify({ answered: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }) + '\n');
        return 1;
    }
    warnInsecureUrl(baseUrl);
    const hookId = (args.hook as string) || resolveHookId();
    const title = (args.title as string) || '';

    if (!apiKey || !hookId || !title) {
        const missing = [!title && '--title', !apiKey && 'an API key', !hookId && 'a hook id']
            .filter((m): m is string => !!m);
        process.stdout.write(JSON.stringify({ answered: false, reason: 'error', error: `missing ${new Intl.ListFormat('en').format(missing)}` }) + '\n');
        return 1;
    }

    // A key `fetch` cannot send is said before anything is tried: the trigger would fail the same
    // way, and its error would quote the key. The message names no secret.
    if (!fitsInHeader(apiKey)) {
        process.stdout.write(JSON.stringify({ answered: false, reason: 'error', error: 'a header could not be sent — check the API key for stray characters' }) + '\n');
        return 1;
    }

    // A bare `--timeout` parses as `true`, which Number() reads as 1 second.
    const timeoutSeconds = typeof args.timeout === 'string' ? Number(args.timeout) : 60;
    const acceptsExit = flagOn(args, 'accepts-exit');
    const windowSeconds = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 60;
    const outcome = await requestApproval(
        {
            apiKey,
            baseUrl: baseUrl.replace(/\/+$/, ''),
            hookId,
            title,
            body: args.body as string | undefined,
            actions: parseActions(args.actions as string | undefined),
            timeoutSeconds: windowSeconds,
            ...(agentSessionContext() ?? {}),
            acceptsExit,
            acceptsFiles: acceptsExit,
        },
        liveDeps({ apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), deadline: Date.now() + windowSeconds * 1000 }),
    );

    // The agent's own ask settles REMOTE as mcp-server's hwip_ask does and
    // reports it in the same `hwipState` field; an approval gate leaves the
    // mode alone. Keyed by the cwd, the twin of the `ctx.cwd` the pi
    // extension hands `remote-hook pi` — pi's bash tool runs every command
    // there. Not detectProjectDir(): a CLAUDE_PROJECT_DIR leaked into a pi
    // launched from Claude Code would key another project's file.
    const settled = acceptsExit ? settleRemote(outcome, process.cwd()) : {};
    // `exitRemote` is the server's flag; the rules read `hwipState`.
    process.stdout.write(JSON.stringify({ ...outcome, exitRemote: undefined, ...settled }) + '\n');
    return outcome.answered ? 0 : 1;
};
