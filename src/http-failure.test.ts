import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { HwipHook } from './hwip-hook.js';
import { AuthenticationError, HwipError } from './errors.js';
import { httpFailureMessage, isConfigFailure, networkFailureMessage, neverConnected, useProxyFromEnv } from './http-failure.js';

// C13: offline was "fetch failed", an outage page was "Unexpected token <",
// and a rejected key said nothing about `hwip login`. Real fetch against a
// local server, so the messages are what a person would actually see.
let server: Server;
let base: string;
let answer: { status: number; type: string; body: string };

beforeAll(async () => {
    server = createServer((_req, res) => {
        res.writeHead(answer.status, { 'content-type': answer.type });
        res.end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const listWith = async (baseUrl: string): Promise<unknown> => {
    try {
        await new HwipHook({ apiKey: 'zk_test', baseUrl, timeout: 2_000 }).list({});
        return null;
    } catch (err) {
        return err;
    }
};

describe('what a failed API call says', () => {
    it('names an outage page as one, not as a JSON parse error', async () => {
        answer = { status: 502, type: 'text/html', body: '<html><body>Bad Gateway</body></html>' };
        const err = await listWith(base);
        expect(err).toBeInstanceOf(HwipError);
        expect((err as Error).message).toBe("the server answered 502 with a page that is not the API's (an outage, or a proxy in the way)");
    });

    it('tells a rejected key to run hwip login', async () => {
        answer = { status: 401, type: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }) };
        const err = await listWith(base);
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as Error).message).toBe('Invalid API key — run `hwip login`, or check --key / HWIP_API_KEY');
    });

    it('says which host it could not reach, and why', async () => {
        // A port nothing listens on: the connection is refused at once.
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const err = await listWith(`http://127.0.0.1:${port}/v1`);
        expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
        expect((err as Error).message).toBe(`could not reach 127.0.0.1:${port} (ECONNREFUSED) — check the network`);
    });

    it('treats a 2xx page that is not JSON as a failed call', async () => {
        answer = { status: 200, type: 'text/html', body: '<html>Sign in to Wi-Fi</html>' };
        expect(await listWith(base)).toMatchObject({ code: 'INVALID_RESPONSE' });
    });
});

describe('whether a failed fetch was ever sent', () => {
    const cause = (code: string, syscall?: string): Error =>
        Object.assign(new Error(`${syscall ?? ''} ${code}`), { code, ...(syscall === undefined ? {} : { syscall }) });
    /** As `net` reports a host whose every address failed: the first failure's code on the whole. */
    const several = (code: string, ...errors: Error[]): Error => Object.assign(new AggregateError(errors), { code });
    const failed = (why: Error): TypeError => new TypeError('fetch failed', { cause: why });

    // The shapes are what Node 24.21 (undici 7.29) hands over, read 2026-10-14; the two tests after this table hold them to the real thing.
    it.each<[string, Error]>([
        ['a refused connection', cause('ECONNREFUSED', 'connect')],
        ['no network to connect over', cause('ENETUNREACH', 'connect')],
        ['no route to connect by', cause('EHOSTUNREACH', 'connect')],
        ['a name that does not resolve', cause('ENOTFOUND', 'getaddrinfo')],
        ['a resolver that did not answer', cause('EAI_AGAIN', 'getaddrinfo')],
        ['every address of the host refusing', several('ECONNREFUSED', cause('ECONNREFUSED', 'connect'), cause('ECONNREFUSED', 'connect'))],
        ['a connect that got no answer', cause('UND_ERR_CONNECT_TIMEOUT')],
        ['an address that is not one', Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' })],
        // C147: a connect that timed out never sent anything either — but only on `connect`.
        ['a connect that timed out', cause('ETIMEDOUT', 'connect')],
    ])('counts %s as never sent', (_, why) => {
        expect(neverConnected(failed(why))).toBe(true);
        // As `hwip ask` holds it: wrapped once more, under the line a person reads.
        expect(neverConnected(new TypeError('could not reach api.example', { cause: failed(why) }))).toBe(true);
    });

    it.each<[string, Error]>([
        ['a network that went away under a read', cause('ENETUNREACH', 'read')],
        // C147: the same errno on a read is a stall after connect — the request may have been written.
        ['a transfer that stalled after connect', cause('ETIMEDOUT', 'read')],
        ['a route that went away under a write', cause('EHOSTUNREACH', 'write')],
        ['a reset after the request', cause('ECONNRESET', 'read')],
        ['an errno that does not say which call met it', cause('ECONNREFUSED')],
        ['several failures, one of them not a connect', several('ECONNREFUSED', cause('ECONNREFUSED', 'connect'), cause('EHOSTUNREACH', 'read'))],
        ['several failures with none to read', several('ECONNREFUSED')],
        // A code outside the table has no call to match: a `syscall` that is there and empty must not match "none".
        ['a reset whose call is not given', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET', syscall: undefined })],
        ['a socket closed mid-answer', cause('UND_ERR_SOCKET')],
    ])('does not count %s as never sent', (_, why) => {
        expect(neverConnected(failed(why))).toBe(false);
    });

    it('reads a real refused connection as never sent', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port; // listening on a TCP port: an AddressInfo, never a pipe's string
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const err = await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', body: '{}' }).catch((e: unknown) => e);
        expect(neverConnected(err)).toBe(true);
    });

    it('reads a real connection dropped after the request as one that may have been taken', async () => {
        const dropping = createTcpServer((socket) => { socket.once('data', () => socket.resetAndDestroy()); });
        await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
        try {
            const port = (dropping.address() as AddressInfo).port; // listening on a TCP port: an AddressInfo, never a pipe's string
            const err = await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', body: '{}' }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(TypeError);
            expect(neverConnected(err)).toBe(false);
        } finally {
            await new Promise<void>((resolve) => dropping.close(() => resolve()));
        }
    });
});

describe('what a base URL that is not an address says', () => {
    const unparsed = (url: string): TypeError =>
        new TypeError(`Failed to parse URL from ${url}`, { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) });

    // Not "could not reach … check the network": nothing was tried, and the address is the thing to fix.
    it('names the setting to fix, and quotes none of the address', () => {
        const url = 'http://user:hunter2@bad host/v1/hooks/h/trigger';
        const message = networkFailureMessage(unparsed(url), url);
        // Every place the address can have come from: a flag, the environment, the config file.
        expect(message).toMatch(/base URL.*--base-url.*HWIP_BASE_URL.*"baseUrl" in ~\/\.hwip\/config\.json/);
        expect(message).not.toMatch(/hunter2|user|bad host|check the network/);
    });

    it('keeps the password out when the address cannot be read for any other failure', () => {
        const url = 'http://user:hunter2@bad host/v1';
        const message = networkFailureMessage(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), url);
        expect(message).not.toContain('hunter2');
        expect(message).toContain('ECONNREFUSED');
    });
});

// C152: `fetch` takes no address with a user name or password in it, and refuses by quoting the address as it was
// given — a password with a quote or a space in it is not one `redactSecrets` can find the end of.
describe('what a base URL with a user name or password in it says', () => {
    const SECRETS = /alice|s3|cr et|includes credentials/;

    it('names the setting to fix and quotes none of the address, for the refusal fetch itself makes', async () => {
        const err = await listWith(base.replace('://', '://alice:s3"cr et@'));

        expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
        const message = err instanceof Error ? err.message : '';
        expect(message).toMatch(/base URL has a user name or password in it.*--base-url.*HWIP_BASE_URL.*"baseUrl" in ~\/\.hwip\/config\.json/);
        expect(message).not.toMatch(SECRETS);
        expect(message).not.toContain('check the network');
    });

    it('says so for a user name alone', () => {
        const url = 'https://alice@api.example.com/v1/hooks/h/trigger';
        const message = networkFailureMessage(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`), url);

        expect(message).toMatch(/base URL has a user name or password in it/);
        expect(message).not.toMatch(SECRETS);
    });
});

// C146 ③: the server's own words go to a terminal and, through `hwip ask`, into an agent's context. A server
// that is not ours — a hijacked host, a mistaken base URL — could put a paragraph of instructions there.
describe('what a refusal in the server\'s words says', () => {
    it('keeps it to one line of what can be printed, cut at 300 characters', () => {
        const message = httpFailureMessage(400, { error: { message: `a\nb\u0000c\u001b[31m\u2028d\u200ee${'x'.repeat(400)}` } });
        expect(message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        expect(message.startsWith('a b c [31m d e')).toBe(true);
        expect(Array.from(message)).toHaveLength(300);
        expect(message.endsWith('…')).toBe(true);
    });

    // C151 1: U+200D ZWJ and U+200C ZWNJ are writing, not hiding — an emoji sequence and Persian stay whole.
    it.each([['ZWJ', 'a\u200db'], ['ZWNJ', 'می\u200cشود']])('keeps %s in a server message', (_name, kept) => {
        expect(httpFailureMessage(400, { error: { message: kept } })).toBe(kept);
    });

    // Every other format character still goes: the tag block spells text an agent reads and a terminal does not show.
    it.each([['a tag-block letter', 'a\u{E0041}b'], ['a zero-width space', 'a\u200Bb'], ['a BOM', 'a\uFEFFb'], ['a bidi override', 'a\u202Eb']])('drops %s from a server message', (_name, sent) => {
        expect(httpFailureMessage(400, { error: { message: sent } })).toBe('a b');
    });

    // C153: variation selectors (Mn, not Cf) are an emoji-smuggling channel — the first one on its base
    // character stays (text/emoji presentation), the rest of the run goes, and a selector with no base goes.
    it.each([['emoji presentation', '\u2764\uFE0F'], ['text presentation', '\u263A\uFE0E'], ['heart on fire', '\u2764\uFE0F\u200D\u{1F525}'], ['ZWJ emoji', '\u{1F469}\u200D\u{1F4BB}'], ['rainbow flag', '\u{1F3F3}\uFE0F\u200D\u{1F308}'], ['keycap', '1\uFE0F\u20E3'], ['ideograph with IVS', '\u6F22\u{E0100}']])('keeps %s whole', (_name, kept) => {
        expect(httpFailureMessage(400, { error: { message: kept } })).toBe(kept);
    });

    it.each([
        ['a selector off an emoji', 'a\uFE0Fb', 'ab'],
        ['a run of selectors', 'a\uFE0F\uFE00b', 'ab'],
        ['a run of supplementary selectors', 'a\u{E0100}\u{E0101}\u{E0102}b', 'ab'],
        ['selectors on latin letters', 'h\u{E0101}e\u{E0102}l\u{E0103}l\u{E0104}o\u{E0105}', 'hello'],
        ['a selector with no base', 'a \uFE0F b', 'a  b'],
        ['selectors spaced out with CGJ', 'a\uFE00\u034F\uFE01\u034Fb', 'a  b'],
        ['mongolian selectors', 'a\u180B\u180C\u180D\u180Fb', 'ab'],
        ['alternating selector and joiner', 'a\uFE0F\u200D\uFE01\u200Db', 'a\u200Db'],
    ])('collapses %s', (_name, sent, kept) => {
        expect(httpFailureMessage(400, { error: { message: sent } })).toBe(kept);
    });

    // C153: a run of joiners is a bit channel — one stays (Persian, emoji sequences), the rest goes.
    it.each([['five ZWJ', 'a\u200D\u200D\u200D\u200D\u200Db', 'a\u200Db'], ['mixed joiners', 'a\u200D\u200C\u200Db', 'a\u200Db']])('collapses %s', (_name, sent, kept) => {
        expect(httpFailureMessage(400, { error: { message: sent } })).toBe(kept);
    });

    it('says the status when the message is only variation selectors', () => {
        expect(httpFailureMessage(400, { error: { message: '\uFE0F\uFE00' } })).toBe('request failed with status 400');
    });

    it('says the status when selectors sit on a hangul filler base', () => {
        expect(httpFailureMessage(400, { error: { message: '\u3164\u{E0100}\u3164\u{E0101}' } })).toBe('request failed with status 400');
    });

    it('cuts between characters, never through one', () => {
        const message = httpFailureMessage(400, { error: { message: '😀'.repeat(400) } });
        expect(Array.from(message)).toHaveLength(300);
        expect(message).toBe(`${'😀'.repeat(299)}…`);
    });

    it('leaves a plain message as it is', () => {
        expect(httpFailureMessage(404, { error: { message: 'Hook not found' } })).toBe('Hook not found');
    });

    it.each(['', '   ', '\n\u0000\u200e'])('says the status when the message is %j', (message) => {
        expect(httpFailureMessage(400, { error: { message } })).toBe('request failed with status 400');
    });

    // C151 2: an empty message keeps the server's error code, so kinds of refusal stay tellable apart.
    it('names the error code when the message is empty', () => {
        expect(httpFailureMessage(400, { error: { code: 'HOOK_NOT_FOUND', message: '' } })).toBe(
            'request failed with status 400 (HOOK_NOT_FOUND)');
    });
});

// M38 ① from the cli's side: a key `fetch` cannot send as a header is quoted whole in its error.
describe('what a header that cannot be sent says', () => {
    /** What is said of the real error: `fetch` refuses the header, and the server of this file is never asked. */
    const said = async (key: string): Promise<string> =>
        fetch(`${base}/hooks`, { headers: { 'X-API-Key': key } })
            .then(() => { throw new Error('the header was sent'); }, (err: unknown) => networkFailureMessage(err, `${base}/hooks`));

    it.each([
        ['a line break', 'ak_live_abc\nSECRETTAIL'],
        ['a NUL', 'ak_live_abc\u0000SECRETTAIL'],
        ['a character no header can hold', 'ak_live_abc\u4e2dSECRETTAIL'],
        ['a bell', 'ak_live_abc\u0007SECRETTAIL'],
        ['a DEL', 'ak_live_abc\u007fSECRETTAIL'],
    ])('names the key as the thing to check, and quotes none of it, for %s', async (_, key) => {
        expect(await said(key)).toBe('a header could not be sent — check the API key for stray characters');
    });

    it('still says what could not be reached for a failure that is not a header\'s', () => {
        const message = networkFailureMessage(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), 'http://127.0.0.1:9/v1/hooks');
        expect(message).toBe('could not reach 127.0.0.1:9 (ECONNREFUSED) — check the network');
    });
});

describe('useProxyFromEnv', () => {
    it('does nothing without a proxy variable', async () => {
        await expect(useProxyFromEnv({})).resolves.toBeUndefined();
    });
});

// A server reply's message is the server's own text: a 5xx that happens to say "is unknown" is not a
// configuration problem, and is still retried.
describe('which failures are the configuration', () => {
    it('reads the words of a local failure, never those of a server reply', () => {
        expect(isConfigFailure(new Error('~/.hwip/config.json has a "baseUrl" that is not text, so where the key goes is unknown'))).toBe(true);
        expect(isConfigFailure(new HwipError('could not reach host: the base URL is not a valid address', 'NETWORK_ERROR', 0))).toBe(true);
        expect(isConfigFailure(new HwipError('the device state is unknown', 'INTERNAL', 503))).toBe(false);
        expect(isConfigFailure(Object.assign(new Error('this hook belongs to another account'), { status: 500 }))).toBe(false);
    });
});
