/**
 * The two things every call to the account API from this daemon repeats:
 * where the endpoint is, and that the request carries this machine's key
 * and cannot outlive its budget. The callers keep their own error
 * handling — a publish logs and returns false, a directory refresh throws
 * — because what a failure means differs; only the convention lives here.
 */

import { isInvalidUrl, isRedirectRefusal, isUnsendableHeader, networkFailureMessage } from './http-failure.js';
import { carriesCredentials } from './ws-url.js';

/** `baseUrl` with its trailing slashes trimmed, plus `path`. */
export const apiUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}${path}`;

/**
 * Can this API key travel in a header? It must fit the server's header limit and pass mcp-server's
 * `fitsInHeader` rule — `fetch` drops white space at either end, and what is left must be a tab,
 * printable ASCII or U+0080–U+00FF — so a key saved with a trailing newline still works. Checked
 * before any `fetch`, so the key is never handed to an error that quotes it whole (C150).
 */
export const fitsInHeader = (key: string): boolean =>
    Buffer.byteLength(key, 'utf-8') <= 8192
    && !/[^\t -~\u0080-ÿ]/.test(key.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ''));

/**
 * Authenticated request with a hard deadline. A JSON body sets its own content type.
 * It never follows a redirect: undici drops `authorization` across origins but not
 * `X-API-Key`, so a redirect would hand the key to whatever host it names. A refused
 * redirect is rethrown in the words `hwip ask` and `HwipHook` use (still a `TypeError`),
 * for callers that log what it throws — and so is a header `fetch` would not send, whose
 * own words quote the key, and an address it would not take (not one at all, or one with a
 * user name or password in it), whose own words quote the address; any other failure is left
 * as `fetch` threw it.
 */
export const apiFetch = async (
    fetchFn: typeof fetch,
    url: string,
    apiKey: string,
    timeoutMs: number,
    init: RequestInit = {},
): Promise<Response> => {
    // Permanent configuration problems, said before anything is tried: no `cause` is kept, as
    // `fetch`'s own words for these quote the key or the address whole. Outside the `try`, so
    // the `catch` below cannot rewrap them.
    if (!fitsInHeader(apiKey)) throw new TypeError('a header could not be sent — check the API key for stray characters');
    if (carriesCredentials(url)) throw new TypeError(networkFailureMessage(new TypeError('not used'), url));
    try {
        void new URL(url);
    } catch {
        throw new TypeError('the base URL is not a valid address — check --base-url, HWIP_BASE_URL or "baseUrl" in ~/.hwip/config.json');
    }
    try {
        return await fetchFn(url, {
            ...init,
            headers: {
                'X-API-Key': apiKey,
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...init.headers,
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'error',
        });
    } catch (err) {
        // No cause kept for these: what `fetch` said is the address itself, password and all, and callers log what they catch.
        // An address that does not parse may be one whose password has a `/`, `?` or `#` in it.
        const quotesAddress = carriesCredentials(url) || isInvalidUrl(err);
        if (err instanceof TypeError && quotesAddress) throw new TypeError(networkFailureMessage(err, url));
        // A refused redirect keeps its original: its words name no secret. An unsendable header's
        // words quote the key whole, so its cause is dropped — the message already says what to fix.
        if (err instanceof TypeError && isRedirectRefusal(err)) throw new TypeError(networkFailureMessage(err, url), { cause: err });
        if (err instanceof TypeError && isUnsendableHeader(err)) throw new TypeError(networkFailureMessage(err, url));
        throw err;
    }
};
