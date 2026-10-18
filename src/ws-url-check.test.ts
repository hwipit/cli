/**
 * C101: a socket URL with no scheme used to pass unchecked and fail inside
 * `new WebSocket`, whose error quotes the URL — and the URL carries `?apiKey=…` —
 * into ~/.hwip/listener.log through the top-level catch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { redactSecrets } from './redact.js';
import { socketUrlWith, wsUrlProblem } from './ws-url.js';

describe('wsUrlProblem', () => {
    it.each([
        ['wss://ws.hwip.app'],
        ['wss://ws-dev.hwip.app/'],
        ['ws://127.0.0.1:8080'],
    ])('accepts %s', (url) => {
        expect(wsUrlProblem(url)).toBeNull();
    });

    it('asks a bare host for a scheme and shows the way to write it', () => {
        expect(wsUrlProblem('ws.hwip.app')).toBe('the WebSocket URL "ws.hwip.app" is not a URL — it needs a scheme, like wss://ws.hwip.app');
    });

    it.each([
        ['https://ws.hwip.app', /must start with ws:\/\/ or wss:\/\//],
        ['ftp://ws.hwip.app', /must start with ws:\/\/ or wss:\/\//],
        ['wss://', /not a URL/],
        ['', /not a URL/],
    ])('refuses %j', (url, why) => {
        expect(wsUrlProblem(url)).toMatch(why);
    });

    it('refuses what is not a string, a space in the URL and a fragment — the listener adds ?apiKey=… to it', () => {
        expect(wsUrlProblem(443)).toMatch(/has to be a string/);
        expect(wsUrlProblem(['wss://ws.hwip.app'])).toMatch(/has to be a string/);
        expect(wsUrlProblem(undefined)).toMatch(/has to be a string/);
        expect(wsUrlProblem('wss://ws.hwip.app ')).toMatch(/has a space/);
        expect(wsUrlProblem('wss://h/#x')).toMatch(/#fragment/);
        expect(wsUrlProblem('wss://h/stage?x=1')).toBeNull();
    });

    it('never shows the userinfo, the query or the fragment of what it refuses', () => {
        const problem = wsUrlProblem('https://user:hunter2@ws.hwip.app/p?apiKey=ak_SECRET#frag') ?? '';

        expect(problem).toContain('https://ws.hwip.app/p');
        expect(problem).not.toMatch(/hunter2|ak_SECRET|frag|user:/);
    });
});

describe('socketUrlWith', () => {
    it('puts each parameter in its own value, after a query the URL already has', () => {
        const url = new URL(socketUrlWith('wss://h.example/stage?x=1', { apiKey: 'ak_K', deviceId: 'dev_1' }));

        expect(url.searchParams.get('x')).toBe('1');
        expect(url.searchParams.get('apiKey')).toBe('ak_K');
        expect(url.searchParams.get('deviceId')).toBe('dev_1');
        expect(url.pathname).toBe('/stage');
    });

    it('sends one key: a parameter the configured URL already has is replaced, not doubled', () => {
        const url = new URL(socketUrlWith('wss://h.example/?apiKey=ak_OLD', { apiKey: 'ak_NEW' }));

        expect(url.searchParams.getAll('apiKey')).toEqual(['ak_NEW']);
    });

    it('encodes what needs it', () => {
        expect(socketUrlWith('wss://ws.hwip.app', { listenerNickname: 'my mac&co' })).toBe('wss://ws.hwip.app/?listenerNickname=my+mac%26co');
    });
});

describe('redactSecrets', () => {
    it('hides the key in a socket URL and in the error the ws library throws for it', () => {
        const url = `ws.hwip.app?${new URLSearchParams({ apiKey: 'ak_REAL_KEY_1234', deviceId: 'dev_1' })}`;
        let message = '';
        try {
            new WebSocket(url);
        } catch (err) {
            message = (err as Error).message;
        }

        expect(message).toContain('ak_REAL_KEY_1234');
        const clean = redactSecrets(message);
        expect(clean).not.toContain('ak_REAL_KEY_1234');
        expect(clean).toContain('apiKey=***');
        expect(clean).toContain('deviceId=dev_1');
    });

    it('hides a key in a JSON body and one with a dot or tilde in it', () => {
        expect(redactSecrets('{"apiKey": "whatever-it-is", "deviceId": "d"}')).toBe('{"apiKey": "***", "deviceId": "d"}');
        expect(redactSecrets('wss://h/?apiKey=ak_abc.def~g&deviceId=d')).toBe('wss://h/?apiKey=***&deviceId=d');
        expect(redactSecrets('rejected ak_abc.def~g now')).toBe('rejected ak_*** now');
    });

    it('hides a bare key, and leaves text without one as it is', () => {
        expect(redactSecrets('key ak_abcd1234 rejected')).toBe('key ak_*** rejected');
        expect(redactSecrets('could not reach ws.hwip.app (ENOTFOUND)')).toBe('could not reach ws.hwip.app (ENOTFOUND)');
    });

    // C152: up to the last `@` before the host — the first one left the rest of the password in the text.
    it('hides the whole of a password in an address when it has an @ of its own', () => {
        const text = 'Request cannot be constructed from a URL that includes credentials: https://user:hun@ter2@api.example/v1/x';

        expect(redactSecrets(text)).toBe('Request cannot be constructed from a URL that includes credentials: https://***@api.example/v1/x');
    });
});

// A new call that carries the key has to say how it treats a redirect.
describe('every file that sends X-API-Key', () => {
    const sources = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // Code only: a comment that names the header is not a request.
    const codeOf = (file: string): string =>
        readFileSync(join(__dirname, file), 'utf-8').replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('refuses to follow a redirect, once per place that sets the header', () => {
        const senders = sources.filter((f) => /x-api-key/i.test(codeOf(f)));

        expect(senders.length).toBeGreaterThan(0);
        for (const file of senders) {
            const code = codeOf(file);
            const sets = (code.match(/x-api-key/gi) ?? []).length;
            const refusals = (code.match(/redirect:\s*'error'/g) ?? []).length;
            expect(refusals, `${file}: ${sets} place(s) set X-API-Key, ${refusals} refuse redirects`).toBeGreaterThanOrEqual(sets);
        }
    });
});

describe('hwip listener with a socket URL it cannot use', () => {
    it('refuses to start, says why, and prints no key', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const { handleListener } = await import('./listener.js');

        const code = await handleListener({ key: 'ak_testkey_1234', 'ws-url': 'ws.hwip.app' });

        expect(code).toBe(1);
        expect(lines.join('\n')).toContain('needs a scheme');
        expect(lines.join('\n')).not.toContain('ak_testkey_1234');
        vi.restoreAllMocks();
    });
});
