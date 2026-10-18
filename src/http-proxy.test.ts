import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { Agent, setGlobalDispatcher } from 'undici';
import { proxyForUrl, useProxyFromEnv, webSocketProxyOptions } from './http-failure.js';

// C13 / C77: HTTPS_PROXY has to reach `fetch` and the listener's `ws` socket on
// every Node the CLI runs on, so neither relies on the Node version (the
// built-in `http.setGlobalProxyFromEnv` is only in 24.14+ / 25.4+). `ws` opens
// its own connection and never reaches fetch's dispatcher — it is handed an
// agent of its own. Its own file: setting the global dispatcher is process-wide.

// A CONNECT proxy that really tunnels, so a request through it gets an answer,
// and records what it was asked — `invalid` hosts are refused the way a proxy
// refuses a name it cannot reach.
const seen: string[] = [];
const authSeen: string[] = [];
const proxy = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
});
proxy.on('connect', (req: IncomingMessage, client: Duplex) => {
    seen.push(`CONNECT ${req.url}`);
    const auth = req.headers['proxy-authorization'];
    if (typeof auth === 'string') authSeen.push(auth);
    const [host, port] = (req.url ?? '').split(':');
    if (!host || host.endsWith('.invalid')) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
    }
    const upstream: Socket = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => upstream.destroy());
});

// What the proxied traffic is for: a plain HTTP server and a ws server, both local.
const target = createServer((_req, res) => res.end('reached the target'));
const wss = new WebSocketServer({ noServer: true });
target.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${String(m)}`))));

let proxyUrl = '';
let targetPort = 0;
beforeAll(async () => {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    targetPort = (target.address() as AddressInfo).port;
});
beforeEach(() => {
    seen.length = 0;
    authSeen.length = 0;
});
afterAll(async () => {
    // Back to a dispatcher that goes direct, so nothing later in this worker is proxied.
    setGlobalDispatcher(new Agent());
    await useProxyFromEnv({});
    wss.close();
    await Promise.all([proxy, target].map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); })));
});

const open = (url: string): Promise<string> => new Promise((resolve) => {
    const ws = new WebSocket(url, webSocketProxyOptions(url));
    ws.on('open', () => ws.send('hello'));
    ws.on('message', (m) => { ws.close(); resolve(String(m)); });
    ws.on('error', (err) => resolve(`error:${err.message}`));
    ws.on('close', () => resolve('closed'));
});

describe('a proxy from the environment', () => {
    // undici announces its env-proxy agent as experimental on stderr; every
    // `hwip` run behind a proxy would print that line. First in the file: it
    // warns once per process, so a later test would see nothing either way.
    it('does not print the experimental-feature warning', async () => {
        const warnings: string[] = [];
        const on = (w: Error & { code?: string }) => warnings.push(w.code ?? w.name);
        process.on('warning', on);
        try {
            await useProxyFromEnv({ HTTP_PROXY: proxyUrl });
            await new Promise((resolve) => setImmediate(resolve));
        } finally {
            process.off('warning', on);
        }

        expect(warnings).not.toContain('UNDICI-EHPA');
    });

    it('sends fetch through it, and the request is answered', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });

        const res = await fetch(`http://127.0.0.1:${targetPort}/v1/x`);

        expect(await res.text()).toBe('reached the target');
        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
    });

    it('carries the listener socket as well as fetch, and the messages get through', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });

        expect(await open(`ws://127.0.0.1:${targetPort}/socket`)).toBe('echo:hello');
        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
    });

    it('tunnels the listener socket for wss the way it does for any https request', async () => {
        await useProxyFromEnv({ HTTPS_PROXY: proxyUrl });

        await open('wss://hwip-socket.invalid/socket');

        expect(seen).toContain('CONNECT hwip-socket.invalid:443');
    });

    it('sends the proxy its credentials, on fetch and on the socket', async () => {
        const at = proxyUrl.replace('http://', 'http://user:p%40ss@');
        await useProxyFromEnv({ HTTP_PROXY: at, HTTPS_PROXY: at });
        const expected = `Basic ${Buffer.from('user:p@ss').toString('base64')}`;

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());
        await open(`ws://127.0.0.1:${targetPort}/socket`);

        expect(authSeen).toEqual([expected, expected]);
    });

    it('uses HTTP_PROXY for https targets when HTTPS_PROXY is not set, as fetch does', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl });

        await open('wss://hwip-socket.invalid/socket');

        expect(seen).toContain('CONNECT hwip-socket.invalid:443');
    });

    it('goes direct where NO_PROXY names the host — fetch and socket alike', async () => {
        // The control: NO_PROXY set, but naming something else, still proxies.
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: 'unrelated.example' });
        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());
        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
        seen.length = 0;

        await useProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' });

        const res = await fetch(`http://127.0.0.1:${targetPort}/`);
        expect(await res.text()).toBe('reached the target');
        expect(await open(`ws://127.0.0.1:${targetPort}/socket`)).toBe('echo:hello');

        expect(seen).toEqual([]);
    });

    // The way to switch the proxy off for one run, and what fetch itself does.
    it('treats an empty lower-case variable as set, so it wins over the upper-case one', async () => {
        await useProxyFromEnv({ http_proxy: '', HTTP_PROXY: proxyUrl });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());

        expect(seen).toEqual([]);
        expect(webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`)).toEqual({});
    });

    it('does not pick up a proxy from the real environment for a scheme it was not given', async () => {
        const before = process.env.HTTPS_PROXY;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
        try {
            await useProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: '' });
            await open('wss://hwip-socket.invalid/socket');
            // https falls back to the given http proxy — not to the one in process.env.
            expect(seen).toContain('CONNECT hwip-socket.invalid:443');
        } finally {
            if (before === undefined) delete process.env.HTTPS_PROXY;
            else process.env.HTTPS_PROXY = before;
        }
    });

    it('keeps the proxy it had when a later call fails, instead of half switching it off', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl });
        await expect(useProxyFromEnv({ HTTP_PROXY: 'not a url' })).rejects.toThrow(/HTTP_PROXY/);

        expect(webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`).agent).toBeDefined();
    });

    // The agent logs the URL it was built from when DEBUG matches, so the
    // credentials are not in it; they travel as the header.
    it('keeps the proxy password out of the agent it hands the socket', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl.replace('http://', 'http://user:p%40ss@') });

        const agent = webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`).agent as unknown as { proxy: URL };

        expect(agent.proxy.href).not.toMatch(/user|p%40ss|p@ss/);
    });

    it('sends the same thing on both routes for a username without a password: no credentials', async () => {
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl.replace('http://', 'http://user@') });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());
        await open(`ws://127.0.0.1:${targetPort}/socket`);

        expect(authSeen).toEqual([]);
    });

    it('reads the lower-case variables too, and lets them win as undici does', async () => {
        await useProxyFromEnv({ http_proxy: proxyUrl, HTTP_PROXY: 'http://127.0.0.1:1' });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());

        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
    });

    it('does nothing, and leaves the socket on its own connection, when no proxy is set', async () => {
        await useProxyFromEnv({});

        expect(webSocketProxyOptions('wss://x.invalid/')).toEqual({});
    });

    it('says which variable is wrong instead of connecting around a proxy it could not use', async () => {
        await expect(useProxyFromEnv({ HTTPS_PROXY: 'not a url' })).rejects.toThrow(/HTTPS_PROXY/);
        await expect(useProxyFromEnv({ HTTP_PROXY: 'http://' })).rejects.toThrow(/HTTP_PROXY/);
    });
});

// C79: a launchd service never sees the shell's variables, and the plist must not hold a proxy
// password, so the settings come from config.json. The environment wins where it sets a name.
describe('a proxy from config.json', () => {
    it('carries fetch and the listener socket when the environment has none', async () => {
        await useProxyFromEnv({}, { httpsProxy: proxyUrl, httpProxy: proxyUrl });

        const res = await fetch(`http://127.0.0.1:${targetPort}/v1/x`);
        expect(await res.text()).toBe('reached the target');
        expect(await open(`ws://127.0.0.1:${targetPort}/socket`)).toBe('echo:hello');

        expect(seen.filter((line) => line === `CONNECT 127.0.0.1:${targetPort}`)).toHaveLength(2);
    });

    it('sends the proxy the credentials in the file URL', async () => {
        const at = proxyUrl.replace('http://', 'http://user:p%40ss@');
        await useProxyFromEnv({}, { httpProxy: at });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());

        expect(authSeen).toEqual([`Basic ${Buffer.from('user:p@ss').toString('base64')}`]);
    });

    it('is overridden by the environment, setting by setting', async () => {
        // The file points at a port nothing listens on: reaching the target proves the environment's proxy was used.
        await useProxyFromEnv({ HTTP_PROXY: proxyUrl }, { httpProxy: 'http://127.0.0.1:9', httpsProxy: proxyUrl });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());
        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
        // A name the environment leaves unset still comes from the file.
        seen.length = 0;
        await open('wss://hwip-socket.invalid/socket');
        expect(seen).toContain('CONNECT hwip-socket.invalid:443');
    });

    it('is switched off by an empty variable in the environment', async () => {
        await useProxyFromEnv({ http_proxy: '' }, { httpProxy: proxyUrl });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());

        expect(seen).toEqual([]);
        expect(webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`)).toEqual({});
    });

    it('takes noProxy from the file, for fetch and the socket alike', async () => {
        await useProxyFromEnv({}, { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '127.0.0.1' });

        expect(await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text())).toBe('reached the target');
        expect(await open(`ws://127.0.0.1:${targetPort}/socket`)).toBe('echo:hello');

        expect(seen).toEqual([]);
    });

    it('lets the environment replace noProxy', async () => {
        await useProxyFromEnv({ NO_PROXY: 'unrelated.example' }, { httpProxy: proxyUrl, noProxy: '127.0.0.1' });

        await fetch(`http://127.0.0.1:${targetPort}/`).then((r) => r.text());

        expect(seen).toContain(`CONNECT 127.0.0.1:${targetPort}`);
    });

    it('names the key, not the value, when the address is unusable', async () => {
        const rejected = await useProxyFromEnv({}, { httpsProxy: 'user:hunter2@proxy.example:3128' }).then(() => null, (err: Error) => err);

        expect(rejected?.message).toMatch(/"httpsProxy" in config\.json/);
        expect(rejected?.message).not.toContain('hunter2');
    });

    it.each([['httpProxy', 3128], ['httpsProxy', ['http://a:1']], ['noProxy', ['a.example', 'b.example']]])('refuses %s when it is not text', async (key, value) => {
        await expect(useProxyFromEnv({}, { httpProxy: proxyUrl, [key]: value })).rejects.toThrow(new RegExp(`"${key}" in config\\.json is not text`));
    });

    it('does not read a value the environment replaces, or a noProxy with no proxy to apply it to', async () => {
        await useProxyFromEnv({ HTTPS_PROXY: proxyUrl, NO_PROXY: 'unrelated.example' }, { httpsProxy: 3128, noProxy: ['a.example'] });
        await useProxyFromEnv({}, { noProxy: ['a.example'] });

        expect(webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`)).toEqual({});
    });

    it('does nothing when the file holds only noProxy', async () => {
        await useProxyFromEnv({}, { noProxy: '127.0.0.1' });

        expect(webSocketProxyOptions(`ws://127.0.0.1:${targetPort}/`)).toEqual({});
    });
});

describe('which proxy a URL uses', () => {
    const env = { HTTP_PROXY: 'http://proxy-a:1', HTTPS_PROXY: 'http://proxy-b:2' };

    it('picks by scheme, with ws and wss following http and https', () => {
        expect(proxyForUrl('http://x.example/', env)).toBe('http://proxy-a:1');
        expect(proxyForUrl('ws://x.example/', env)).toBe('http://proxy-a:1');
        expect(proxyForUrl('https://x.example/', env)).toBe('http://proxy-b:2');
        expect(proxyForUrl('wss://x.example/', env)).toBe('http://proxy-b:2');
    });

    it('falls back from https to the http proxy, and does not proxy http with only an https one', () => {
        expect(proxyForUrl('https://x.example/', { HTTP_PROXY: 'http://proxy-a:1' })).toBe('http://proxy-a:1');
        expect(proxyForUrl('http://x.example/', { HTTPS_PROXY: 'http://proxy-b:2' })).toBeNull();
    });

    // The same rules undici's EnvHttpProxyAgent applies to fetch, read from its
    // source (6.29): the socket and fetch must agree on what goes direct.
    it.each([
        ['an exact host', 'x.example', 'https://x.example/', true],
        ['a different host', 'x.example', 'https://y.example/', false],
        ['a suffix with a leading dot', '.example', 'https://a.b.example/', true],
        ['a leading wildcard', '*.example', 'https://a.example/', true],
        ['a host that merely ends the same way, without a dot', 'example', 'https://notexample/', false],
        ['the right port', 'x.example:443', 'https://x.example/', true],
        ['the wrong port', 'x.example:8443', 'https://x.example/', false],
        ['a list separated by commas and spaces', 'a.example, x.example', 'https://x.example/', true],
        ['everything', '*', 'https://x.example/', true],
        ['an upper-case entry', 'X.EXAMPLE', 'https://x.example/', true],
    ])('NO_PROXY matches %s', (_name, noProxy, url, direct) => {
        expect(proxyForUrl(url, { ...env, NO_PROXY: noProxy })).toBe(direct ? null : 'http://proxy-b:2');
    });

    it('reads no_proxy before NO_PROXY', () => {
        expect(proxyForUrl('https://x.example/', { ...env, no_proxy: 'x.example', NO_PROXY: '' })).toBeNull();
    });
});
