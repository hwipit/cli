import type http from 'node:http';
import { redactSecrets } from './redact.js';
import { carriesCredentials } from './ws-url.js';

/**
 * What a failed call to the account API says to a person (C13). `fetch`
 * reports every network problem as "fetch failed" with the real cause one
 * level down, and an outage or proxy page is HTML, which `response.json()`
 * turns into "Unexpected token <" — both said nothing about what to do.
 */

/** Is any error of `err`'s cause chain one that `says` so? `fetch` wraps the reason one or two levels down, and its callers once more. */
const somewhereInCauses = (err: unknown, says: (e: Error) => boolean): boolean => {
    for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
        if (says(e)) return true;
    }
    return false;
};

/**
 * Did `fetch` reject because the answer was a redirect (every call that carries
 * the API key passes `redirect: 'error'`)? The reason sits in the error's cause
 * chain, one or two levels down depending on who wrapped it.
 */
export const isRedirectRefusal = (err: unknown): boolean => somewhereInCauses(err, (e) => /unexpected redirect/i.test(e.message));

/**
 * The errnos of a connection that could not be made, each with the call that says so. Under any other
 * call the socket had been connected, and the request may have been written to it: a reset is reported
 * under `read` (seen on Node 24.21), and "no route" is taken to come the same way (not reproduced).
 */
const BEFORE_CONNECTING = new Map([
    ['ENOTFOUND', 'getaddrinfo'],
    ['EAI_AGAIN', 'getaddrinfo'],
    ['ECONNREFUSED', 'connect'],
    ['ENETUNREACH', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ETIMEDOUT', 'connect'],
]);
/** undici's own "the connect got no answer", and `fetch` handed an address it could not parse: neither has a call to go by, or needs one. */
const NEVER_STARTED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);

const codeOf = (err: Error): string | undefined =>
    'code' in err && typeof err.code === 'string' ? err.code : undefined;

/** One error of the chain: a connect or a lookup that failed, or — a host with several addresses — every one of them failing so. */
const failedBeforeConnecting = (err: Error): boolean => {
    const code = codeOf(err);
    if (code === undefined) return false;
    if (NEVER_STARTED.has(code)) return true;
    if (err instanceof AggregateError) return err.errors.length > 0 && err.errors.every((e) => e instanceof Error && failedBeforeConnecting(e));
    const call = BEFORE_CONNECTING.get(code);
    return call !== undefined && 'syscall' in err && err.syscall === call;
};

/**
 * Did `fetch` reject before the request could be sent? Any other rejection — a socket reset, a body
 * that stops halfway — is also a `TypeError`, and may be of a request the server took. The code sits
 * in the cause chain, as for a refused redirect. The shapes are Node 24.21's (undici 7.29), read
 * 2026-10-14: `{ code, syscall }` on the cause, and an `AggregateError` of them for a host with two addresses.
 */
export const neverConnected = (err: unknown): boolean => somewhereInCauses(err, failedBeforeConnecting);

/** Did `fetch` reject because the address is not one? It will say so again however often it is asked. */
export const isInvalidUrl = (err: unknown): boolean => somewhereInCauses(err, (e) =>
    codeOf(e) === 'ERR_INVALID_URL' || /not a valid address/.test(e.message));

/**
 * Is this failure a permanent configuration problem (bad base URL, unsendable API key) rather than a
 * network blip? Such errors say so in fixed words — `apiFetch` throws them before any `fetch`, and
 * `resolveBaseUrl` throws them before any request — so swallowing them as "could not fetch" or
 * retrying them with backoff only repeats them. Matched by message, as the throwers sanitize it — so
 * never on an error that carries an HTTP status (`HttpError`, a `HwipError` from a reply): its message
 * is the server's own text, and a 5xx that happens to say "is unknown" is still worth another try.
 */
export const isConfigFailure = (err: unknown): boolean => somewhereInCauses(err, (e) =>
    !isHttpReply(e)
    && /not a valid address|user name or password|header could not be sent|stray characters|is not text|is unknown|belongs to/i.test(e.message));

const isHttpReply = (e: Error): boolean => {
    const status = (e as { status?: unknown }).status;
    return typeof status === 'number' && status >= 100;
};

/**
 * Did `fetch` reject for a header value it cannot send? It does so before it opens a connection, and the
 * same way however often it is asked. Two shapes (Node 24.21, read 2026-10-14 — held to a real `fetch`
 * in http-failure.test.ts): a `TypeError` with no cause that says which value — whole for a line break
 * or a NUL, by place for a character past U+00FF — and, for any other control character, undici's
 * `UND_ERR_INVALID_ARG` ("invalid X-API-Key header") under "fetch failed". Looked for down the cause
 * chain, as the callers hand on what `fetch` threw inside an error in their own words.
 */
export const isUnsendableHeader = (err: unknown): boolean => somewhereInCauses(err, (e) => {
    const refusedByHeaders = e instanceof TypeError && e.cause === undefined && /is an invalid header value|to a ByteString/.test(e.message);
    const refusedByUndici = codeOf(e) === 'UND_ERR_INVALID_ARG' && /^invalid .+ header$/.test(e.message);
    // The sanitized rethrow (`apiFetch`, `callApi`): no cause is kept, as the original quotes the key.
    const sanitized = /a header could not be sent/.test(e.message);
    return refusedByHeaders || refusedByUndici || sanitized;
});

/** "could not reach api.hwip.app (ENOTFOUND)" from a rejected `fetch`. */
export const networkFailureMessage = (err: unknown, url: string): string => {
    // Nothing was tried, and the address is the thing to fix. Not quoted: it may carry a password.
    if (isInvalidUrl(err)) return 'the base URL is not a valid address — check --base-url, HWIP_BASE_URL or "baseUrl" in ~/.hwip/config.json';
    // The one header whose value is not ours is the API key, and the error's own words quote it.
    if (isUnsendableHeader(err)) return 'a header could not be sent — check the API key for stray characters';
    // `fetch` refuses such an address before it tries anything, in words that are the address as it was given: a
    // password with a quote or a space in it is not one `redactSecrets` can find the end of (C152).
    if (carriesCredentials(url)) {
        return 'the base URL has a user name or password in it, and no request can be made to such an address — take it out of --base-url, HWIP_BASE_URL or "baseUrl" in ~/.hwip/config.json';
    }
    let host: string;
    try {
        host = new URL(url).host;
    } catch {
        // The raw url, less what it may carry: `https://user:password@host`.
        host = redactSecrets(url);
    }
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
    const code = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
    // `redirect: 'error'` on every call that carries the key: say so, not "unexpected redirect".
    if (isRedirectRefusal(err)) {
        return `${host} answered with a redirect, and hwip does not follow one with your API key — check the base URL (${host})`;
    }
    // The cause can quote the whole URL: `https://user:password@host` when the base URL carries credentials.
    const why = redactSecrets(code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)));
    return `could not reach ${host} (${why}) — check the network${process.env.HTTPS_PROXY || process.env.https_proxy ? ' and HTTPS_PROXY' : ''}`;
};

/** The body as JSON when it is JSON, else null. A read that fails (an abort
 *  mid-body) still throws: that is a timeout or a dropped connection, not a
 *  page that is not ours. */
export const readJsonBody = async (response: Response): Promise<unknown> => {
    try {
        return (await response.json()) as unknown;
    } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
    }
};

/**
 * What one line of a message is not made of: controls, line and paragraph breaks, the invisible format
 * characters (Cf — bidi marks and overrides, zero-width space, the BOM, and the Unicode tag block, which can
 * hide text from a reader but not from an agent reading `hwip ask`), the grapheme-join blocker U+034F, and
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0 — blank letters an attacker would use as an invisible
 * base character). U+200C ZWNJ and U+200D ZWJ are writing, not hiding (Persian, Hindi, emoji sequences), so
 * a lone one stays — but a run of them is a bit channel, so a run collapses to its first character (C153).
 * Selectors go by allowlist, not by run: U+FE0E/U+FE0F stay only after an emoji base (text/emoji
 * presentation: ❤️ ☺︎ 1️⃣), U+E0100–E01EF only after a unified ideograph (IVS); every other selector —
 * including the Mongolian FVS (U+180B–U+180D, U+180F) — goes, so spacing a run out with an invisible
 * character no longer smuggles it past the rule. The same rule as mcp-server's `UNPRINTABLE` block
 * (src/api-client.ts): the lines below from `const UNPRINTABLE` through `sanitizeSmuggled` are
 * character-identical there.
 */
const UNPRINTABLE = /(?:[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}|[\u034F\u115F\u1160\u3164\uFFA0])+/gu;
// Written with \u{...}: \uE0100 would read as U+E010 plus "0", turning 0-\uE01E into a range over ASCII (C153).
const SELECTOR_ALLOW = /(\p{Emoji}|[0-9#*])([\uFE0E\uFE0F])|(\p{Unified_Ideograph})([\u{E0100}-\u{E01EF}])|[\uFE00-\uFE0F\u180B-\u180D\u180F\u{E0100}-\u{E01EF}]/gu;
const JOINER_RUN = /([\u200C\u200D])[\u200C\u200D]+/gu;
// '$1$2$3$4' rebuilds an allowed base + selector and erases anything else (groups that did not match are empty).
const sanitizeSmuggled = (text: string): string => text.replace(SELECTOR_ALLOW, '$1$2$3$4').replace(JOINER_RUN, '$1');
const MAX_SERVER_MESSAGE_CHARS = 300;

/**
 * A server's own words as one line of bounded length: they go to a terminal and, through `hwip ask`, into
 * an agent's context, and a host that is not ours could otherwise put a paragraph of instructions there.
 * The rule is mcp-server's `serverMessage` (src/api-client.ts) — keep them in step.
 */
const serverWords = (sent: string): string => {
    const clean = sanitizeSmuggled(sent.replace(UNPRINTABLE, ' ')).trim();
    // By code point: a cut through a surrogate pair would leave half an emoji.
    const points = Array.from(clean);
    return points.length > MAX_SERVER_MESSAGE_CHARS ? `${points.slice(0, MAX_SERVER_MESSAGE_CHARS - 1).join('')}…` : clean;
};

/** The line for a non-2xx answer whose body may not be ours at all. */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const httpFailureMessage = (status: number, body: unknown): string => {
    const sent = body && typeof body === 'object' ? (body as { error?: { message?: unknown } }).error?.message : undefined; // a JSON body of any shape: read by the one path the API's errors have
    const code = body && typeof body === 'object' ? (body as { error?: { code?: unknown } }).error?.code : undefined;
    const tag = typeof code === 'string' && ERROR_CODE_SHAPE.test(code) ? ` (${code})` : '';
    const message = typeof sent === 'string' ? serverWords(sent) : '';
    if (message) return message;
    return body === null
        ? `the server answered ${status} with a page that is not the API's (an outage, or a proxy in the way)${tag}`
        : `request failed with status ${status}${tag}`;
};

/** What to do about a rejected key, appended to its message. */
export const AUTH_HINT = 'run `hwip login`, or check --key / HWIP_API_KEY';

/**
 * The proxy variables, read the way undici's `EnvHttpProxyAgent` reads them
 * (6.29): lower case before upper case, an https target falls back to the http
 * proxy, and `NO_PROXY` is a list of hosts, `.suffix`es and `host:port`s. The
 * listener's socket is not `fetch` and never reaches its dispatcher, so it asks
 * the same question here and the two cannot disagree about what goes direct.
 */
export interface ProxyEnv {
    http_proxy?: string;
    HTTP_PROXY?: string;
    https_proxy?: string;
    HTTPS_PROXY?: string;
    no_proxy?: string;
    NO_PROXY?: string;
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

const noProxyEntries = (value: string): { hostname: string; port: number }[] =>
    value.split(/[,\s]/).filter(Boolean).map((entry) => {
        const parsed = entry.match(/^(.+):(\d+)$/);
        return { hostname: (parsed ? parsed[1]! : entry).toLowerCase(), port: parsed ? Number.parseInt(parsed[2]!, 10) : 0 };
    });

const bypassesProxy = (url: URL, noProxy: string): boolean => {
    const entries = noProxyEntries(noProxy);
    if (entries.length === 0) return false;
    if (noProxy === '*') return true;
    // Not `url.hostname`: it drops the brackets round an IPv6 address.
    const hostname = url.host.replace(/:\d*$/, '').toLowerCase();
    const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
    return entries.some((entry) => {
        if (entry.port && entry.port !== port) return false;
        return /^[.*]/.test(entry.hostname)
            ? hostname.endsWith(entry.hostname.replace(/^\*/, ''))
            : hostname === entry.hostname;
    });
};

/** The proxy a request to `rawUrl` goes through, or null for a direct connection. `ws` / `wss` follow `http` / `https`. */
export const proxyForUrl = (rawUrl: string, env: ProxyEnv = process.env): string | null => {
    const url = new URL(rawUrl);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const http = env.http_proxy ?? env.HTTP_PROXY;
    const https = env.https_proxy ?? env.HTTPS_PROXY;
    const proxy = (secure ? https || http : http) || null;
    if (!proxy || bypassesProxy(url, env.no_proxy ?? env.NO_PROXY ?? '')) return null;
    return proxy;
};

interface ActiveProxy {
    readonly env: ProxyEnv;
    readonly agentFor: (proxy: string) => http.Agent;
}
let active: ActiveProxy | null = null;

/** undici says "experimental" once, on stderr, the first time it builds the env-proxy agent. */
const withoutExperimentalWarning = <T>(build: () => T): T => {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        const options = rest[0];
        if (typeof options === 'object' && options !== null && (options as { code?: string }).code === 'UNDICI-EHPA') return;
        return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
        return build();
    } finally {
        process.emitWarning = emit;
    }
};

const checkProxyUrl = (name: string, value: string | undefined): void => {
    if (!value) return;
    let ok = false;
    try {
        const url = new URL(value);
        ok = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
    } catch { /* not a URL */ }
    // The name only: the value may carry the proxy's password.
    if (!ok) throw new Error(`${name} is not a usable proxy address — use http://host:port or https://host:port`);
};

/** The proxy settings `~/.hwip/config.json` can hold: what a launchd service, which never sees the shell's variables, reads instead. */
export interface ProxyConfig {
    httpProxy?: unknown;
    httpsProxy?: unknown;
    noProxy?: unknown;
}

/** `config` is a parsed JSON file: a value that is not text is a mistake to name, not a setting to coerce. */
const configProxyValue = (key: keyof ProxyConfig, config: ProxyConfig): string | undefined => {
    const value = config[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`"${key}" in config.json is not text — use "${key}": "http://host:port"`);
    return value;
};

/**
 * Route `fetch` and the listener's socket through HTTPS_PROXY / HTTP_PROXY,
 * honouring NO_PROXY, when the variables are set; a no-op otherwise.
 *
 * `config` (`httpProxy`, `httpsProxy`, `noProxy` of ~/.hwip/config.json) fills
 * in what the environment leaves unset, one setting at a time: a launchd
 * service starts with its own environment and the plist must not hold a proxy
 * password, so the file is where it finds them. The environment wins when it
 * sets a name at all, empty included.
 *
 * Not through Node's own `http.setGlobalProxyFromEnv`: it exists only from 24.14
 * and 25.4, and the CLI runs on older Nodes. `fetch` gets undici's
 * `EnvHttpProxyAgent` as the global dispatcher (undici 6, Node >= 18.17); `ws`
 * opens its own connection, so it gets a CONNECT-tunnelling agent from
 * `https-proxy-agent` (`webSocketProxyOptions`). Both libraries load only here,
 * so a run with no proxy pays nothing for them.
 *
 * A proxy that cannot be set up is an error, not a direct connection: going
 * around a proxy someone configured is the wrong way to fail. The error names
 * the setting and never quotes it: the value may carry the proxy's password.
 */
export const useProxyFromEnv = async (env: ProxyEnv = process.env, config: ProxyConfig = {}): Promise<void> => {
    // Only a value that will be used is read: the environment's setting makes the file's moot, wrong or not.
    const envHttp = env.http_proxy ?? env.HTTP_PROXY;
    const envHttps = env.https_proxy ?? env.HTTPS_PROXY;
    const httpProxy = envHttp ?? configProxyValue('httpProxy', config);
    const httpsProxy = envHttps ?? configProxyValue('httpsProxy', config);
    // An empty lower-case variable counts as set, and wins over the upper-case
    // one, because that is how fetch (undici) reads them — the socket has to
    // agree with it. It is also the way to switch the proxy off for one run:
    // `http_proxy= hwip …`.
    if (!httpProxy && !httpsProxy) {
        active = null;
        return;
    }
    checkProxyUrl(envHttp === undefined ? '"httpProxy" in config.json' : env.http_proxy !== undefined ? 'http_proxy' : 'HTTP_PROXY', httpProxy);
    checkProxyUrl(envHttps === undefined ? '"httpsProxy" in config.json' : env.https_proxy !== undefined ? 'https_proxy' : 'HTTPS_PROXY', httpsProxy);
    const noProxy = env.no_proxy ?? env.NO_PROXY ?? configProxyValue('noProxy', config) ?? '';

    const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { HttpsProxyAgent }] = await Promise.all([
        import('undici'),
        import('https-proxy-agent'),
    ]);
    // Always strings, so undici never falls back to reading `process.env` itself.
    setGlobalDispatcher(withoutExperimentalWarning(() => new EnvHttpProxyAgent({
        httpProxy: httpProxy ?? '',
        httpsProxy: httpsProxy ?? '',
        noProxy,
    })));
    const agents = new Map<string, http.Agent>();
    active = {
        env: { http_proxy: httpProxy, https_proxy: httpsProxy, no_proxy: noProxy },
        agentFor: (proxy) => {
            let agent = agents.get(proxy);
            if (!agent) {
                // The credentials go in a header, not in the URL the agent holds:
                // `https-proxy-agent` logs that URL under `DEBUG`. Sent only with
                // both parts, as undici's proxy agent does, so a username alone
                // gets the same (no) header on fetch and on the socket.
                const url = new URL(proxy);
                const headers: Record<string, string> = {};
                if (url.username && url.password) {
                    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
                    headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
                }
                url.username = '';
                url.password = '';
                agents.set(proxy, (agent = new HttpsProxyAgent(url, { headers })));
            }
            return agent;
        },
    };
};

/**
 * Options for the listener's `new WebSocket`: `ws` opens its own connection
 * and never reaches fetch's dispatcher, so with a proxy set it is handed an
 * agent that tunnels through it (CONNECT, for `ws:` as well as `wss:`) — unless
 * NO_PROXY says that host goes direct.
 */
export const webSocketProxyOptions = (url: string): { agent?: http.Agent } => {
    if (!active) return {};
    const proxy = proxyForUrl(url, active.env);
    return proxy ? { agent: active.agentFor(proxy) } : {};
};
