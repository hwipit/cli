/**
 * The world the recorder (`turn-recorder.ts`) talks to: the account API that
 * stores chunks, the push-v1 envelope that seals them, and the list of devices
 * the account has signed in. Kept apart so the recorder's tests need none of it.
 */

import { apiFetch, apiUrl } from './api.js';
import { carriesCredentials } from './ws-url.js';
import { isConfigFailure, isInvalidUrl, isRedirectRefusal, isUnsendableHeader } from './http-failure.js';
import { encryptPushBodyForDevices, getDevicePublicKey, initDeviceCrypto, selectRecipients } from './crypto.js';
import { readTrustState } from './subscriber-trust.js';
import { observeDevices } from './trust-pins.js';
import {
    RECORDER_BACKOFF_BASE_MS,
    RECORDER_PAUSE_MS,
    chooseRecipients,
    type OutboxChunk,
    type RecorderRecipient,
    type SealedChunk,
    type UploadOutcome,
} from './turn-recorder.js';

const UPLOAD_TIMEOUT_MS = 15_000;
/** The turns route has its own per-minute allowance on the server (240); chunks keep to 30, well inside it. */
export const RECORDER_UPLOADS_PER_MINUTE = 30;
/** How long a session waits after a 403 before the same chunk is tried again. */
const RECORDER_KEY_RETRY_MS = 5 * 60_000;
/** After this many 403s in a row the chunk is dropped: the key it was sealed with is not the one on file, and will not be. */
const RECORDER_KEY_REFUSALS = 5;

/** Seal one plaintext body (`{sessionKey, seq, events}`) as a push-v1 envelope for the recipients. */
export const sealChunk = async (plaintext: string, recipients: RecorderRecipient[]): Promise<SealedChunk> => {
    await initDeviceCrypto();
    const sealed = await encryptPushBodyForDevices({ body: plaintext }, recipients);
    return { body: sealed.body, deviceKeyMap: sealed.deviceKeyMap, senderPublicKey: sealed.senderPublicKey };
};

export interface AccountRecipientsDeps {
    /** The listener's state file (`~/.hwip/trusted-devices.json`). */
    trustFile: string;
    deviceId: string;
    /** The account's device list; rejects when it cannot be had. */
    devices: () => Promise<{ deviceId: string; publicKey?: string }[]>;
    log: (message: string) => void;
}

/**
 * This machine plus the devices the account lists with a key, the newest pins first and
 * within the server's slot limit. The list decides who a chunk is sealed for: a device
 * that signed in reads its history once the directory refreshes its list (a minute at most). Each listed device is pinned on
 * the way (`observeDevices`) — the pin is what `hwip trust` shows and what the listener
 * holds a request against, and its date orders who is cut when the list is longer than
 * the slots. The directory keeps the last list it fetched, so a blip does not stop the
 * history; a list never had means no
 * recipients, and pins from an earlier run do not stand in for it. A machine with no other
 * device has no one who could read a chunk.
 */
export const accountRecipients = (deps: AccountRecipientsDeps): (() => Promise<RecorderRecipient[]>) =>
    async () => {
        try {
            const publicKey = await initDeviceCrypto();
            const self = { deviceId: deps.deviceId, publicKey: getDevicePublicKey() ?? publicKey };
            const listed = selectRecipients(await deps.devices()).filter((d) => d.deviceId !== deps.deviceId);
            observeDevices(deps.trustFile, listed, { selfId: deps.deviceId, warn: (line) => deps.log(line) });
            const loaded = readTrustState(deps.trustFile);
            const pins = 'broken' in loaded ? undefined : loaded.state.devices;
            return chooseRecipients(self, listed.map((d) => ({ ...d, pinnedAt: pins?.get(d.deviceId)?.pinnedAt })));
        } catch (err) {
            deps.log(`turn history: recipients unavailable (${err instanceof Error ? err.message : String(err)})`);
            return [];
        }
    };

interface ErrorBody { error?: { code?: unknown; details?: { resetAt?: unknown; retryAfter?: unknown } } }

const readError = async (res: Response): Promise<ErrorBody['error']> => {
    try {
        return ((await res.json()) as ErrorBody).error;
    } catch {
        return undefined;
    }
};

/**
 * `POST /sessions/{key}/turns` for one stored chunk. The same bytes go out on
 * every try, so a chunk the server already holds comes back 200 (stored) rather
 * than 409 (a different body under the same `seq`).
 *
 *   201 / 200          stored.
 *   429 RATE_LIMIT     a minute-long limit: try again after what the server says.
 *   429 TURN_DAILY     the day's cap: leave the session alone until its reset.
 *   408, 5xx, network  try again with the recorder's backoff.
 *   redirect refused   the base URL sends the request elsewhere on every try (a permanent
 *                      answer, like a wrong key): pause the session for an hour and say why.
 *                      The chunk is kept, so a corrected base URL (a restart) sends it.
 *   400, 409           the server will never take these bytes (a bad body, a `seq`
 *                      that holds another): drop the chunk, or it blocks the session;
 *                      after a 409 the next `seq` moves past what the server holds.
 *   403                the key may only just have been registered: pause the session 5 min;
 *                      the fifth in a row on one chunk drops it.
 *   any other 4xx      wrong key, device or session (401, 404): pause the
 *                      session for an hour and say why in the log.
 */
export const createChunkUploader = (opts: {
    baseUrl: string;
    apiKey: string;
    fetchFn?: typeof fetch;
    now?: () => number;
    perMinute?: number;
}): ((sessionKey: string, chunk: OutboxChunk) => Promise<UploadOutcome>) => {
    const fetchFn = opts.fetchFn ?? fetch;
    const now = opts.now ?? Date.now;
    const perMinute = opts.perMinute ?? RECORDER_UPLOADS_PER_MINUTE;
    let sent: number[] = [];

    return async (sessionKey, chunk) => {
        const at = now();
        sent = sent.filter((t) => at - t < 60_000);
        if (sent.length >= perMinute) {
            return { kind: 'retry', why: 'own upload budget for this minute is spent', afterMs: Math.max(1_000, 60_000 - (at - sent[0]!)) };
        }
        sent.push(at);
        let res: Response;
        try {
            res = await apiFetch(fetchFn, apiUrl(opts.baseUrl, `/sessions/${encodeURIComponent(sessionKey)}/turns`), opts.apiKey, UPLOAD_TIMEOUT_MS, {
                method: 'POST',
                body: JSON.stringify({ seq: chunk.seq, firstAt: chunk.firstAt, lastAt: chunk.lastAt, sealed: chunk.sealed }),
            });
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            // `apiFetch` refuses a redirect (it would carry the key to another host). It is a TypeError like a
            // dropped connection, but it happens on every try: backing off and retrying only repeats it.
            // The same holds for a configuration failure (bad key, bad base URL): retry with backoff only
            // repeats it, so the chunk waits for a corrected configuration instead.
            if (isRedirectRefusal(err) || isConfigFailure(err) || isInvalidUrl(err) || isUnsendableHeader(err) || carriesCredentials(opts.baseUrl)) return { kind: 'pause', why };
            return { kind: 'retry', why };
        }
        if (res.status === 200 || res.status === 201) return { kind: 'ok' };
        const error = await readError(res);
        const code = typeof error?.code === 'string' ? ` ${error.code}` : '';
        const why = `HTTP ${res.status}${code}`;
        if (res.status === 429) {
            if (error?.code === 'TURN_DAILY_LIMIT') {
                const reset = typeof error.details?.resetAt === 'string' ? Date.parse(error.details.resetAt) : NaN;
                return { kind: 'pause', why, untilMs: Number.isFinite(reset) && reset > at ? reset : at + RECORDER_PAUSE_MS };
            }
            const header = Number(res.headers.get('retry-after'));
            const detail = typeof error?.details?.retryAfter === 'number' ? error.details.retryAfter : NaN;
            const seconds = Number.isFinite(header) && header > 0 ? header : detail;
            return { kind: 'retry', why, afterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RECORDER_BACKOFF_BASE_MS * 8 };
        }
        if (res.status === 408 || res.status >= 500) {
            const header = Number(res.headers.get('retry-after'));
            return { kind: 'retry', why, ...(Number.isFinite(header) && header > 0 ? { afterMs: header * 1000 } : {}) };
        }
        if (res.status === 400) return { kind: 'drop', why };
        // The same `seq` already holds another body: this chunk is lost, and the numbering must move on.
        if (res.status === 409) return { kind: 'drop', why, conflict: true };
        // The key frame and the first chunk can cross: a 403 just after the first registration passes by itself.
        if (res.status === 403) return { kind: 'pause', why, untilMs: at + RECORDER_KEY_RETRY_MS, giveUpAfter: RECORDER_KEY_REFUSALS };
        return { kind: 'pause', why };
    };
};

/**
 * The newest `seq` the server holds for a session (`GET .../turns?limit=1`, newest
 * first), or null when it cannot say. Used only after a 409, to number past it.
 */
export const createLatestSeqReader = (opts: {
    baseUrl: string;
    apiKey: string;
    fetchFn?: typeof fetch;
}): ((sessionKey: string) => Promise<number | null>) => {
    const fetchFn = opts.fetchFn ?? fetch;
    return async (sessionKey) => {
        try {
            const res = await apiFetch(fetchFn, apiUrl(opts.baseUrl, `/sessions/${encodeURIComponent(sessionKey)}/turns?limit=1`), opts.apiKey, UPLOAD_TIMEOUT_MS);
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { seq?: unknown }[] };
            const seq = body.data?.[0]?.seq;
            return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null;
        } catch {
            return null;
        }
    };
};
