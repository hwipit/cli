/**
 * Text that may go to stderr, a log file or a crash line is cleaned of the API
 * key first. The listener's socket URL carries it (`?apiKey=…`), and an error
 * that quotes the URL — `Invalid URL: ws.hwip.app?apiKey=ak_…` — used to land,
 * key and all, in `~/.hwip/listener.log`.
 */
export const redactSecrets = (text: string): string =>
    text
        // `https://user:password@host` — a base URL with credentials in it, quoted by a fetch error. Up to the last
        // `@` before the host, since a password can have one of its own; a quote, a comma or a space ends the
        // address, so one after another in unrelated text is not run together.
        .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#"'<>,]*@/gi, '$1***@')
        .replace(/([?&]apiKey=)[^&\s"'<>]*/gi, '$1***')
        .replace(/("apiKey"\s*:\s*")[^"]*"/gi, '$1***"')
        .replace(/\bak_[A-Za-z0-9_.~-]{4,}/g, 'ak_***');

/** A key for a line that shows which one is in use: the prefix and no more (`ak_…`), never enough to guess from. */
export const maskKey = (key: string): string => `${key.length > 4 ? key.slice(0, 3) : ''}…`;
