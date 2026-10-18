/**
 * The attachment a sealed question carries (F3): the original of its context — the masked diff and screen of
 * `ask-context.ts` — sealed for the devices the question is sealed for.
 *
 * What the server sees of it is the same for every sealed question: one attachment, named `file`, of type
 * `application/octet-stream`, 64 KiB long. A question with nothing to carry (the switch is off, no change and
 * no screen, git did not answer) gets the same attachment with nothing in it, so neither whether a question has
 * context nor how much the session changed shows. The real name, type and length are in the sealed body.
 */

import { apiFetch, apiUrl } from './api.js';
import { ASK_CONTEXT_MAX_BYTES, gatherAskContext, type AskContext } from './ask-context.js';
import { captureAskScreen, liveScreenDeps } from './ask-context-screen.js';
import { askContextOffBy, askContextProjectDir, type AskContextOffBy } from './ask-context-switch.js';
import type { AskAttachment } from './ask-seal.js';
import { encryptFileForDevices, type DeviceRecipient, type SealedAskContext } from './crypto.js';

/** Every attachment is this long before it is sealed: the longest original, so none needs more. */
export const ASK_ATTACHMENT_BYTES = ASK_CONTEXT_MAX_BYTES;
/** What the server is told the attachment is. */
const WIRE_NAME = 'file';
const WIRE_TYPE = 'application/octet-stream';
/** What the sealed body says it is; a reader finds the original by this type. */
const SEALED_NAME = 'ask-context.json';
const SEALED_TYPE = 'application/vnd.hwip.ask-context+json';
/** With less of the question's window left than this, nothing is gathered: git and tmux are asked synchronously and may take most of it. */
export const ASK_CONTEXT_MIN_WINDOW_MS = 20_000;
/** What attaching leaves of the question's window, for the question itself to be sent and answered. */
export const ASK_ATTACH_RESERVE_MS = 10_000;
/** A window this short is a choice (a quick gate), not a failure: it is not warned about. */
const NO_ROOM = 'too little of the window left to attach the context';
const UPLOAD_TIMEOUT_MS = 10_000;

/**
 * The original as JSON (`{ diff, screen }`, UTF-8) followed by zero bytes up to `ASK_ATTACHMENT_BYTES`; `size`
 * is where the JSON ends. No context, or an original that does not fit, is all zeros and `size` 0 — and no summary.
 */
export const padAskOriginal = (ctx: AskContext | null): { bytes: Buffer; size: number; context?: SealedAskContext } => {
    const bytes = Buffer.alloc(ASK_ATTACHMENT_BYTES);
    if (!ctx) return { bytes, size: 0 };
    const text = Buffer.from(JSON.stringify(ctx.original), 'utf-8');
    if (text.length > ASK_ATTACHMENT_BYTES) return { bytes, size: 0 };
    text.copy(bytes);
    return { bytes, size: text.length, context: ctx.summary };
};

export interface AttachDeps {
    /** The context to carry, or `null`; a throw counts as `null`. */
    context: () => Promise<AskContext | null>;
    encrypt: typeof encryptFileForDevices;
    /** Stores the sealed bytes and returns their `fileKey`. */
    upload: (sealed: Buffer) => Promise<string>;
}

/** Seals and uploads the attachment for `recipients`. Throws when sealing or the upload fails. */
export const attachAskContext = async (recipients: DeviceRecipient[], deps: AttachDeps): Promise<AskAttachment> => {
    // No context and a context that failed look the same to the server on purpose; `liveAttach` says which on stderr.
    const padded = padAskOriginal(await deps.context().catch(() => null));
    const sealed = await deps.encrypt(padded.bytes, recipients);
    const fileKey = await deps.upload(sealed.ciphertext);
    return {
        ...(padded.context ? { context: padded.context } : {}),
        meta: { iv: sealed.iv, name: SEALED_NAME, type: SEALED_TYPE, size: padded.size },
        file: { fileKey, fileName: WIRE_NAME, fileType: WIRE_TYPE, fileSize: ASK_ATTACHMENT_BYTES, iv: sealed.iv, deviceKeyMap: sealed.deviceKeyMap },
    };
};

/**
 * `attachAskContext`, given up (it rejects, and the question goes without it) once it would eat into the last
 * `ASK_ATTACH_RESERVE_MS` of a window of `windowMs`: storing the attachment must never hold the question back.
 * The race cannot cut the synchronous git and tmux reads short; `ASK_CONTEXT_MIN_WINDOW_MS` bounds those.
 */
export const attachWithinWindow = (recipients: DeviceRecipient[], deps: AttachDeps, windowMs: number): Promise<AskAttachment> => {
    const room = windowMs - ASK_ATTACH_RESERVE_MS;
    if (room <= 0) return Promise.reject(new Error(NO_ROOM));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`attaching the context took over ${room} ms`)), room);
    });
    return Promise.race([attachAskContext(recipients, deps), late]).finally(() => clearTimeout(timer));
};

export interface CollectDeps {
    offBy: (projectDir: string, env: NodeJS.ProcessEnv) => AskContextOffBy | null;
    /** The screen of a tmux pane, by pane id. */
    capture: (pane: string) => Promise<string | null>;
    gather: (cwd: string, screen: string | null) => AskContext | null;
}

const LIVE_COLLECT: CollectDeps = {
    offBy: (dir, env) => askContextOffBy(askContextProjectDir(dir), env),
    // The id is the target as it is: a session name would be matched by prefix and could name another session's pane.
    capture: async (pane) => captureAskScreen(pane, { ...(await liveScreenDeps()), targetOf: (id) => id }),
    gather: gatherAskContext,
};

/** A tmux pane id, as tmux sets it in `TMUX_PANE` for what runs in the pane. */
const PANE_ID = /^%\d+$/;

/**
 * The context of the session asking from `cwd`: its changes, and the screen of the pane this process runs in
 * (`TMUX_PANE`; none outside tmux). `off` says why the switch kept it from being read. `windowMs` is what is
 * left of the question's window.
 */
export const collectAskContext = async (
    cwd: string,
    env: NodeJS.ProcessEnv,
    deps: CollectDeps = LIVE_COLLECT,
    windowMs: number = Infinity,
): Promise<{ context: AskContext | null; off?: AskContextOffBy }> => {
    const off = deps.offBy(cwd, env);
    if (off !== null) return { context: null, off };
    if (windowMs < ASK_CONTEXT_MIN_WINDOW_MS) return { context: null };
    const pane = env.TMUX_PANE;
    const screen = pane !== undefined && PANE_ID.test(pane) ? await deps.capture(pane) : null;
    return { context: deps.gather(cwd, screen) };
};

/** Stores sealed attachment bytes with the account and returns their `fileKey`. Throws on any failure. */
export const uploadAskAttachment = async (
    sealed: Buffer,
    account: { apiKey: string; baseUrl: string },
    fetchFn: typeof fetch = fetch,
): Promise<string> => {
    const res = await apiFetch(fetchFn, apiUrl(account.baseUrl, '/files/upload-request'), account.apiKey, UPLOAD_TIMEOUT_MS, {
        method: 'POST',
        body: JSON.stringify({ fileName: WIRE_NAME, fileType: WIRE_TYPE, fileSize: sealed.length }),
    });
    if (!res.ok) throw new Error(`upload-request ${res.status}`);
    const json = (await res.json()) as { data?: { uploadUrl?: unknown; fileKey?: unknown } };
    const { uploadUrl, fileKey } = json.data ?? {};
    if (typeof uploadUrl !== 'string' || typeof fileKey !== 'string') throw new Error('upload-request: unexpected response');
    // The address is signed for this content type and authenticates itself: no API key goes to the store.
    const put = await fetchFn(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': WIRE_TYPE },
        body: new Uint8Array(sealed),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        redirect: 'error',
    });
    if (!put.ok) throw new Error(`upload ${put.status}`);
    return fileKey;
};

/**
 * `AskSealDeps.attach` for real use: this directory's context, sealed with this machine's keys, stored with the
 * account, within what is left before `deadline`. What goes wrong is said on stderr (stdout is the answer's): a
 * context that could not be gathered goes as the empty attachment, one that could not be stored not at all.
 */
export const liveAttach = (account: { apiKey: string; baseUrl: string }, deadline: number, warn: (line: string) => void) =>
    (recipients: DeviceRecipient[]): Promise<AskAttachment> => {
        const windowMs = deadline - Date.now();
        return attachWithinWindow(recipients, {
            context: async () => {
                try {
                    return (await collectAskContext(process.cwd(), process.env, LIVE_COLLECT, windowMs)).context;
                } catch (err) {
                    warn(`the context could not be gathered (${(err as Error).message}); the question carries none`);
                    return null;
                }
            },
            encrypt: encryptFileForDevices,
            upload: (sealed) => uploadAskAttachment(sealed, account),
        }, windowMs).catch((err: unknown) => {
            if ((err as Error).message !== NO_ROOM) warn(`the context was not attached (${(err as Error).message}); the question goes without it`);
            throw err;
        });
    };
