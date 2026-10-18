/**
 * The API key goes wherever the base URL and the socket URL point. Over `https`
 * and `wss` it is encrypted on the way; over plain `http` and `ws` anyone on the
 * path reads it. Nothing forbids that — a dev server on the LAN is a real use —
 * but a machine that does it unknowingly (a base URL typed without the `s`)
 * should hear about it once.
 */
// `localhost.` (a trailing dot), the unspecified address and its IPv4-mapped loopback form are this machine too.
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i;

/** Whether `hostname` (from `URL.hostname`) is this machine. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.test(hostname.replace(/\.$/, ''));

/** One line of warning for a URL that sends the key in the clear to a non-loopback host, else null. */
export const insecureUrlWarning = (url: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (isLoopbackHost(parsed.hostname)) return null;
    if (parsed.protocol === 'http:') {
        return `hwip: ${parsed.host} is reached over plain http:// — your API key travels in the clear. Use an https:// base URL.`;
    }
    if (parsed.protocol === 'ws:') {
        return `hwip: the WebSocket at ${parsed.host} is reached over plain ws:// — your API key travels in the clear. Use a wss:// URL.`;
    }
    return null;
};

const warned = new Set<string>();

/** `insecureUrlWarning` to stderr, once per URL per process (a command may build several clients). */
export const warnInsecureUrl = (url: string): void => {
    const warning = insecureUrlWarning(url);
    if (!warning || warned.has(warning)) return;
    warned.add(warning);
    console.error(warning);
};

/**
 * Why the client will not fetch `url` as a file download, or null when it may.
 * The URL comes from the API (`GET /files/<key>`), so a relay that rewrites
 * the answer picks where this machine sends a GET: its own loopback services,
 * the cloud metadata address, the LAN. Only S3 over `https` is a download
 * address; a loopback one only when the API is loopback too (the local server
 * hands out its LocalStack endpoint).
 */
export const downloadUrlProblem = (url: string, baseUrl: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return 'not a URL';
    }
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    if (parsed.protocol === 'https:' && (host === 'amazonaws.com' || host.endsWith('.amazonaws.com'))) return null;
    let apiHost = '';
    try {
        apiHost = new URL(baseUrl).hostname;
    } catch {
        // An unreadable base URL is not a loopback one.
    }
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(host) && isLoopbackHost(apiHost)) return null;
    return `${parsed.protocol}//${parsed.host} is not an S3 download address`;
};
