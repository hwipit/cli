import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// login.ts is the `hwip login` loopback-bridge command. These tests pin the
// pure pieces — URL building, config merge (deviceId must survive), and the
// callback validator (state mismatch must be rejected). The HTTP server and
// browser-open paths are exercised manually (see PLAN E2E step).

const ENV_KEYS = ['HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-login-test-'));
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

describe('stripUndefined', () => {
    it('drops undefined-valued keys, keeps the rest', async () => {
        const { stripUndefined } = await import('./login.js');
        expect(stripUndefined({ a: 'x', b: undefined, c: 0 })).toEqual({ a: 'x', c: 0 });
    });
});

describe('buildBridgeUrl', () => {
    it('builds the cli-bridge URL with encoded host', async () => {
        const { buildBridgeUrl } = await import('./login.js');
        const url = buildBridgeUrl('https://console.hwip.app', 51234, 'abc123', "Tak's Mac");
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://console.hwip.app/auth/cli-bridge');
        expect(parsed.searchParams.get('port')).toBe('51234');
        expect(parsed.searchParams.get('state')).toBe('abc123');
        expect(parsed.searchParams.get('host')).toBe("Tak's Mac");
    });

    // C102: the console finishes with a POST only when told this listener reads one.
    it('says the callback takes a POST', async () => {
        const { buildBridgeUrl } = await import('./login.js');
        expect(new URL(buildBridgeUrl('https://console.hwip.app', 1, 's', 'h')).searchParams.get('post')).toBe('1');
    });

    it('strips a trailing slash on webUrl', async () => {
        const { buildBridgeUrl } = await import('./login.js');
        const url = buildBridgeUrl('https://console.hwip.app/', 1, 's', 'h');
        expect(url.startsWith('https://console.hwip.app/auth/cli-bridge?')).toBe(true);
    });
});

describe('persistConfig', () => {
    it('merges into existing config, preserving deviceId', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(
            join(TMP, '.hwip', 'config.json'),
            JSON.stringify({ deviceId: 'dev_keepme', apiKey: 'ak_old' }),
        );

        const { persistConfig } = await import('./login.js');
        persistConfig({ apiKey: 'ak_new', hookId: 'hook_x', baseUrl: 'https://api', wsUrl: 'wss://api' });

        const saved = JSON.parse(readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8'));
        expect(saved).toEqual({
            deviceId: 'dev_keepme',
            apiKey: 'ak_new',
            hookId: 'hook_x',
            baseUrl: 'https://api',
            wsUrl: 'wss://api',
        });
    });

    it('does not erase existing keys when next-value is undefined', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(
            join(TMP, '.hwip', 'config.json'),
            JSON.stringify({ hookId: 'hook_keep', apiKey: 'ak_old' }),
        );

        const { persistConfig } = await import('./login.js');
        persistConfig({ apiKey: 'ak_new', hookId: undefined, baseUrl: undefined, wsUrl: undefined });

        const saved = JSON.parse(readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8'));
        expect(saved.apiKey).toBe('ak_new');
        expect(saved.hookId).toBe('hook_keep');
    });
});

describe('resolveTimeoutSec', () => {
    it('falls back to default for a non-numeric value (no instant setTimeout)', async () => {
        const { resolveTimeoutSec } = await import('./login.js');
        expect(resolveTimeoutSec('abc')).toBe(300);
        expect(resolveTimeoutSec('0')).toBe(300);
        expect(resolveTimeoutSec(true)).toBe(300);
        expect(resolveTimeoutSec('45')).toBe(45);
    });
});

describe('runLoginFlow', () => {
    let errors: string[];
    let logs: string[];
    const OPEN = { kind: 'open' } as const;

    beforeEach(() => {
        errors = [];
        logs = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
        vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // C103: the confirmation line showed twelve characters of the key (`ak_` and nine secret ones).
    it('handleLogin shows the prefix of the saved key and no more', async () => {
        const { handleLogin } = await import('./login.js');
        const open = async (bridge: string): Promise<undefined> => {
            const { port, state } = Object.fromEntries(new URL(bridge).searchParams) as { port: string; state: string };
            void fetch(`http://127.0.0.1:${port}/cb`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, key: 'ak_0123456789abcdef' }).toString() });
            return undefined;
        };

        const code = await handleLogin({ timeout: '30' }, { plan: OPEN, open });

        expect(code).toBe(0);
        expect(logs.join('\n')).toContain('API key: ak_…');
        expect(logs.join('\n')).not.toContain('0123');
    });

    // C132: a bad --allow-host is no list of none: it stops the login before a browser opens.
    it.each([[true], ['https://api.mine.example'], ['com'], ['*.mine.example'], ['a.example,']])(
        'handleLogin refuses --allow-host %j before opening a browser',
        async (value) => {
            const { handleLogin } = await import('./login.js');
            const open = vi.fn(async (): Promise<undefined> => undefined);

            const code = await handleLogin({ timeout: '30', 'allow-host': value }, { plan: OPEN, open });

            expect(code).toBe(1);
            expect(open).not.toHaveBeenCalled();
            expect(errors.join('\n')).toContain('--allow-host');
        },
    );

    // C107: a config.json hwip cannot read used to load as {}, and the key from the login replaced the file.
    describe('over a config.json that cannot be read as JSON', () => {
        const broken = '{ "apiKey": "ak_old", "baseUrl": "https://api.example/v1", }';
        const brokenFile = () => join(TMP, '.hwip', 'config.json');
        const writeBroken = () => {
            mkdirSync(join(TMP, '.hwip'), { recursive: true });
            writeFileSync(brokenFile(), broken);
        };
        const cb = (bridge: string, key: string) => {
            const { port, state } = Object.fromEntries(new URL(bridge).searchParams) as { port: string; state: string };
            return fetch(`http://127.0.0.1:${port}/cb`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, key }).toString() });
        };

        it('handleLogin says so before opening a browser, and writes nothing', async () => {
            writeBroken();
            const { handleLogin } = await import('./login.js');
            const open = vi.fn(async (): Promise<undefined> => undefined);

            const code = await handleLogin({ timeout: '30' }, { plan: OPEN, open });

            expect(code).toBe(1);
            expect(open).not.toHaveBeenCalled();
            expect(errors.join('\n')).toContain(brokenFile());
            expect(errors.join('\n')).toMatch(/not valid JSON/);
            expect(readFileSync(brokenFile(), 'utf-8')).toBe(broken);
        });

        // The file went bad after the first look: the callback handler must not throw out of the server.
        it('a callback that cannot be saved is answered and ends the login, not the process', async () => {
            const { runLoginFlow } = await import('./login.js');
            let answered: Promise<Response> | undefined;
            const open = async (bridge: string): Promise<undefined> => {
                writeBroken();
                answered = cb(bridge, 'ak_new');
                return undefined;
            };

            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });

            expect(result).toBeNull();
            expect(errors.join('\n')).toMatch(/Login failed: not saving: .*not valid JSON/);
            expect((await answered)?.status).toBe(500);
            expect(readFileSync(brokenFile(), 'utf-8')).toBe(broken);
        });
    });

    // C102: the key used to ride the URL of a top-level GET (browser history, autofill, session restore).
    describe('a callback POST: the key is in the body, never in a URL', () => {
        const KEY = 'ak_0123456789abcdef';
        const target = (bridge: string) => {
            const { port, state } = Object.fromEntries(new URL(bridge).searchParams) as { port: string; state: string };
            return { port, state };
        };
        const post = (bridge: string, fields: Record<string, string>, init: { type?: string; path?: string; body?: string } = {}) => {
            const { port, state } = target(bridge);
            return fetch(`http://127.0.0.1:${port}${init.path ?? '/cb'}`, {
                method: 'POST',
                headers: { 'content-type': init.type ?? 'application/x-www-form-urlencoded' },
                body: init.body ?? new URLSearchParams({ state, ...fields }).toString(),
            });
        };

        it('finishes the login from a form body, and no request URL carries the key', async () => {
            const { runLoginFlow } = await import('./login.js');
            const urls: string[] = [];
            const open = async (bridge: string): Promise<undefined> => {
                urls.push(bridge);
                void post(bridge, { key: KEY, hook: 'hook_x', baseUrl: 'https://api.hwip.app/v1', wsUrl: 'wss://ws.hwip.app' });
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect(result).toEqual({ apiKey: KEY, hookId: 'hook_x', baseUrl: 'https://api.hwip.app/v1', wsUrl: 'wss://ws.hwip.app' });
            expect(JSON.parse(readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8')).apiKey).toBe(KEY);
            expect(urls.join('\n')).not.toContain('ak_');
            expect(logs.join('\n') + errors.join('\n')).not.toContain('0123456789');
        });

        it('does not read a key from the query of a POST', async () => {
            const { runLoginFlow } = await import('./login.js');
            let answer: Promise<Response> | undefined;
            const open = async (bridge: string): Promise<undefined> => {
                const { state } = target(bridge);
                // The key is in the URL, the body is a valid form without one.
                answer = post(bridge, {}, { path: `/cb?${new URLSearchParams({ state, key: KEY })}` });
                setTimeout(() => void post(bridge, { key: 'ak_from_body' }), 50);
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect((await answer)?.status).toBe(400);
            expect(result).toMatchObject({ apiKey: 'ak_from_body' });
        });

        it('answers a request with a wrong state with 403 and keeps waiting: one stray request does not end the sign-in', async () => {
            const { runLoginFlow } = await import('./login.js');
            let answer: Promise<Response> | undefined;
            const open = async (bridge: string): Promise<undefined> => {
                answer = post(bridge, { key: 'ak_stray', state: 'not-the-state' });
                setTimeout(() => void post(bridge, { key: KEY }), 50);
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect((await answer)?.status).toBe(403);
            expect(result).toMatchObject({ apiKey: KEY });
            expect(JSON.parse(readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8')).apiKey).toBe(KEY);
        });

        it('gives up after MAX_STATE_MISMATCHES requests with a wrong state, saving nothing', async () => {
            const { runLoginFlow, MAX_STATE_MISMATCHES } = await import('./login.js');
            const statuses: number[] = [];
            const open = async (bridge: string): Promise<undefined> => {
                void (async () => {
                    // The last one ends the login, and the socket may close before its answer is read.
                    for (let i = 0; i < MAX_STATE_MISMATCHES; i++) statuses.push((await post(bridge, { key: KEY, state: `wrong-${i}` }).catch(() => ({ status: 403 }))).status);
                })();
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect(result).toBeNull();
            await vi.waitFor(() => expect(statuses).toHaveLength(MAX_STATE_MISMATCHES));
            expect(statuses).toEqual(Array(MAX_STATE_MISMATCHES).fill(403));
            expect(errors.join('\n')).toContain(`refused after ${MAX_STATE_MISMATCHES} requests`);
            expect(() => readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8')).toThrow();
        });

        it('does not count the right state against the cap', async () => {
            const { runLoginFlow, MAX_STATE_MISMATCHES } = await import('./login.js');
            const open = async (bridge: string): Promise<undefined> => {
                void (async () => {
                    for (let i = 0; i < MAX_STATE_MISMATCHES - 1; i++) await post(bridge, { key: KEY, state: `wrong-${i}` });
                    await post(bridge, { key: KEY });
                })();
                return undefined;
            };
            expect(await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open })).toMatchObject({ apiKey: KEY });
        });

        // C131: where the key will be sent is part of the callback, so an address the user never chose is not saved.
        describe('the addresses in the callback', () => {
            const run = async (fields: Record<string, string>, webUrl = 'https://console.hwip.app', allowHosts?: string[]) => {
                const { runLoginFlow } = await import('./login.js');
                let answer: Promise<Response> | undefined;
                const open = async (bridge: string): Promise<undefined> => {
                    answer = post(bridge, { key: KEY, ...fields });
                    return undefined;
                };
                const result = await runLoginFlow({ webUrl, timeoutSec: 30, allowHosts }, { plan: OPEN, open });
                return { result, res: await answer! };
            };
            const saved = () => { try { return JSON.parse(readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8')); } catch { return null; } };

            it('saves the hwip.app addresses and an https host of the console', async () => {
                const a = await run({ baseUrl: 'https://api.hwip.app/d1', wsUrl: 'wss://ws-dev.hwip.app' });
                expect(a.result).toMatchObject({ baseUrl: 'https://api.hwip.app/d1', wsUrl: 'wss://ws-dev.hwip.app' });
                const b = await run({ baseUrl: 'https://api.corp.example/v1', wsUrl: 'wss://ws.corp.example' }, 'https://corp.example');
                expect(b.result).toMatchObject({ baseUrl: 'https://api.corp.example/v1' });
            });

            it('saves this machine over http for local development', async () => {
                const r = await run({ baseUrl: 'http://127.0.0.1:3100/v1', wsUrl: 'ws://localhost:3101' }, 'http://127.0.0.1:5173');
                expect(r.result).toMatchObject({ baseUrl: 'http://127.0.0.1:3100/v1', wsUrl: 'ws://localhost:3101' });
            });

            it('saves a host the config file already names', async () => {
                mkdirSync(join(TMP, '.hwip'), { recursive: true });
                writeFileSync(join(TMP, '.hwip', 'config.json'), JSON.stringify({ baseUrl: 'https://api.self-hosted.example/v1' }), { mode: 0o600 });
                const r = await run({ baseUrl: 'https://api.self-hosted.example/v1' });
                expect(r.result).toMatchObject({ baseUrl: 'https://api.self-hosted.example/v1' });
            });

            // C132: the user's own word adds a host; nothing else about the checks relaxes.
            it('saves a host named with --allow-host, and its subdomains, and only those', async () => {
                const a = await run({ baseUrl: 'https://api.mine.example/v1', wsUrl: 'wss://ws.mine.example' }, undefined, ['mine.example']);
                expect(a.result).toMatchObject({ baseUrl: 'https://api.mine.example/v1', wsUrl: 'wss://ws.mine.example' });
                const b = await run({ baseUrl: 'https://mine.example/v1' }, undefined, ['mine.example']);
                expect(b.result).toMatchObject({ baseUrl: 'https://mine.example/v1' });
            });

            it.each([
                ['a lookalike of the allowed host', { baseUrl: 'https://api.mine.example.evil.example/v1' }],
                ['a host that only ends with the allowed one', { baseUrl: 'https://notmine.example/v1' }],
                ['another host', { baseUrl: 'https://evil.example/v1' }],
            ])('still refuses %s when --allow-host names a host', async (_name, fields) => {
                const { result, res } = await run(fields, undefined, ['mine.example']);
                expect(result).toBeNull();
                expect(res.status).toBe(400);
                expect(saved()).toBeNull();
            });

            it('keeps the scheme rules for an allowed host: plain http is refused', async () => {
                const { result } = await run({ baseUrl: 'http://api.mine.example/v1' }, undefined, ['mine.example']);
                expect(result).toBeNull();
                expect(errors.join('\n')).toMatch(/baseUrl is not https/);
            });

            it('names --allow-host in the refusal of an unknown host', async () => {
                await run({ baseUrl: 'https://evil.example/v1' });
                expect(errors.join('\n')).toContain('--allow-host');
            });

            it.each([
                ['an https host nobody named', { baseUrl: 'https://evil.example/v1' }, /baseUrl host evil\.example is not one hwip knows/],
                ['a lookalike of hwip.app', { baseUrl: 'https://api.hwip.app.evil.example/v1' }, /is not one hwip knows/],
                ['a host that only ends with hwip.app', { baseUrl: 'https://nothwip.app/v1' }, /is not one hwip knows/],
                ['plain http off this machine', { baseUrl: 'http://api.hwip.app/v1' }, /baseUrl is not https \(http:\/\/api\.hwip\.app\)/],
                ['a user name and password', { baseUrl: 'https://user:pw@api.hwip.app/v1' }, /user name or password/],
                ['a query', { baseUrl: 'https://api.hwip.app/v1?x=1' }, /query or fragment/],
                ['not a URL', { baseUrl: 'api.hwip.app' }, /baseUrl is not a URL|not https/],
                ['plain ws off this machine', { wsUrl: 'ws://ws.hwip.app' }, /wsUrl is not wss/],
                ['a socket host nobody named', { wsUrl: 'wss://evil.example/ws' }, /wsUrl host evil\.example is not one hwip knows/],
                ['a socket URL with a fragment', { wsUrl: 'wss://ws.hwip.app/#x' }, /fragment/],
                ['a socket URL with a space', { wsUrl: 'wss://ws.hwip.app/a b' }, /has a space in it/],
                ['an address too long', { baseUrl: `https://api.hwip.app/${'a'.repeat(3000)}` }, /too long/],
            ])('refuses %s: nothing saved, the login ends and says why', async (_name, fields, why) => {
                const { result, res } = await run(fields);
                expect(result).toBeNull();
                expect(res.status).toBe(400);
                expect(saved()).toBeNull();
                expect(errors.join('\n')).toMatch(why);
                expect(errors.join('\n')).not.toContain(KEY);
                expect(errors.join('\n')).not.toContain('pw@');
            });
        });

        it('turns away a body that is not a form, a body that is too large and another path, and keeps waiting', async () => {
            const { runLoginFlow, MAX_CALLBACK_BODY_BYTES } = await import('./login.js');
            const statuses: number[] = [];
            const open = async (bridge: string): Promise<undefined> => {
                const { state } = target(bridge);
                void (async () => {
                    const json = await post(bridge, {}, { type: 'application/json', body: JSON.stringify({ state, key: KEY }) });
                    const big = await post(bridge, {}, { body: `state=${state}&key=${'a'.repeat(MAX_CALLBACK_BODY_BYTES)}` }).catch(() => ({ status: 413 }));
                    const other = await post(bridge, { key: KEY }, { path: '/elsewhere' });
                    statuses.push(json.status, big.status, other.status);
                    await post(bridge, { key: 'ak_real' });
                })();
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect(statuses).toEqual([415, 413, 404]);
            expect(result).toMatchObject({ apiKey: 'ak_real' });
        });

        it('survives a browser that drops the connection halfway through the body', async () => {
            const { runLoginFlow } = await import('./login.js');
            const { connect } = await import('node:net');
            const open = async (bridge: string): Promise<undefined> => {
                const { port } = target(bridge);
                const socket = connect(Number(port), '127.0.0.1', () => {
                    socket.write('POST /cb HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/x-www-form-urlencoded\r\ncontent-length: 200\r\n\r\nstate=');
                    setTimeout(() => socket.destroy(), 20);
                });
                setTimeout(() => void post(bridge, { key: 'ak_after' }), 80);
                return undefined;
            };
            expect(await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open })).toMatchObject({ apiKey: 'ak_after' });
        });

        // C102 final: the GET callback that carried the key is gone. A console that still sends it is refused unread.
        it('refuses a key in the URL of a GET: not saved, not in the page or the log, and the login ends saying why', async () => {
            const { runLoginFlow } = await import('./login.js');
            let answer: Promise<Response> | undefined;
            const open = async (bridge: string): Promise<undefined> => {
                const { port, state } = target(bridge);
                answer = fetch(`http://127.0.0.1:${port}/cb?${new URLSearchParams({ state, key: 'ak_in_the_url_0123456789' })}`);
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect(result).toBeNull();
            const res = await answer!;
            expect(res.status).toBe(400);
            const page = await res.text();
            expect(() => readFileSync(join(TMP, '.hwip', 'config.json'), 'utf-8')).toThrow();
            expect(errors.join('\n')).toContain('the console sent the key in a URL, which hwip refuses');
            expect(errors.join('\n')).toContain('revoke the key in the app');
            for (const text of [page, errors.join('\n'), logs.join('\n')]) expect(text).not.toContain('ak_in_the_url');
        });

        it('keeps waiting after the console\'s cancel, a GET with no key, and finishes from the POST that follows', async () => {
            const { runLoginFlow } = await import('./login.js');
            let cancelled: Promise<Response> | undefined;
            const open = async (bridge: string): Promise<undefined> => {
                const { port, state } = target(bridge);
                cancelled = fetch(`http://127.0.0.1:${port}/cb?${new URLSearchParams({ error: 'denied', state })}`);
                setTimeout(() => void post(bridge, { key: KEY }), 50);
                return undefined;
            };
            const result = await runLoginFlow({ webUrl: 'https://w.example', timeoutSec: 30 }, { plan: OPEN, open });
            expect((await cancelled)?.status).toBe(400);
            expect(result).toMatchObject({ apiKey: KEY });
        });
    });

    it('returns null immediately and says why when the browser cannot open', async () => {
        const { runLoginFlow } = await import('./login.js');
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60 }, { plan: OPEN, open: async () => 'xdg-open exited with code 3' });
        expect(result).toBeNull();
        expect(errors.join('\n')).toContain('Could not open a browser: xdg-open exited with code 3.');
        expect(errors.join('\n')).toContain('install --key');
    });

    it('does not try a browser where none can run', async () => {
        const { runLoginFlow } = await import('./login.js');
        const open = vi.fn(async () => undefined);
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60 }, { plan: { kind: 'none', reason: 'no display' }, open });
        expect(result).toBeNull();
        expect(open).not.toHaveBeenCalled();
        expect(errors.join('\n')).toContain('Could not open a browser: no display.');
    });

    // Inside `hwip install` the paste prompt comes next; sending the user off
    // to rerun install, or to Ctrl+C the whole install, would be wrong there.
    it('points at the paste prompt, and offers Enter instead of Ctrl+C, inside install', async () => {
        const { runLoginFlow } = await import('./login.js');
        await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60, pasteNext: true }, { plan: OPEN, open: async () => 'no handler' });
        expect(errors.join('\n')).toContain('Paste the API key below instead.');
        expect(errors.join('\n')).not.toContain('install --key');

        const skip = () => ({ pressed: new Promise<string>(() => {}), close: () => {} });
        await runLoginFlow({ webUrl: 'https://x', timeoutSec: 0.05, pasteNext: true }, { plan: OPEN, open: async () => undefined, skip });
        expect(logs.join('\n')).toContain('(up to 0.05s, or press Enter to paste the API key instead)...');
        expect(logs.join('\n')).not.toContain('Ctrl+C');
    });

    it('stops waiting, without calling it a failure, when Enter skips to the paste prompt', async () => {
        const { runLoginFlow } = await import('./login.js');
        const close = vi.fn();
        const skip = () => ({ pressed: Promise.resolve(''), close });
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60, pasteNext: true }, { plan: OPEN, open: async () => undefined, skip });
        expect(result).toBeNull();
        expect(close).toHaveBeenCalled();
        expect(errors.join('\n')).not.toContain('Login failed');
    });

    // A key pasted at the waiting line, then Enter, would otherwise be thrown away.
    it('hands back a key typed before Enter as the pasted key', async () => {
        const { runLoginFlow } = await import('./login.js');
        const skip = () => ({ pressed: Promise.resolve('ak_pasted'), close: () => {} });
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60, pasteNext: true }, { plan: OPEN, open: async () => undefined, skip });
        expect(result).toEqual({ pastedKey: 'ak_pasted' });
    });

    // It used to wait the whole timeout in silence and then drop the reason.
    it('says it is waiting, then why it gave up, when no callback arrives', async () => {
        const { runLoginFlow } = await import('./login.js');
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 0.05 }, { plan: OPEN, open: async () => undefined });
        expect(result).toBeNull();
        expect(logs.join('\n')).toContain('Waiting for sign-in in the browser (up to 0.05s, Ctrl+C to cancel)');
        expect(errors.join('\n')).toContain('Login failed: no sign-in within 0.05s');
    });

    // cli#11 ended an SSH login at once, which broke signing in from the
    // laptop's browser over an `ssh -L` forward of the callback port.
    it('over SSH, names the port to forward and still takes the callback', async () => {
        const { runLoginFlow } = await import('./login.js');
        const open = vi.fn(async () => undefined);
        const flow = runLoginFlow({ webUrl: 'https://x', timeoutSec: 5 }, { plan: { kind: 'ssh' }, open });
        await vi.waitFor(() => expect(logs.join('\n')).toContain('Waiting for sign-in'));

        const printed = logs.join('\n');
        const bridge = new URL(printed.match(/https:\/\/x\/auth\/cli-bridge\?\S+/)![0]);
        const port = bridge.searchParams.get('port');
        expect(printed).toContain(`ssh -L ${port}:127.0.0.1:${port} <this host>`);
        expect(printed).toContain('install --key');
        expect(open).not.toHaveBeenCalled();

        const res = await fetch(`http://127.0.0.1:${port}/cb`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ key: 'ak_1', hook: 'hook_1', state: bridge.searchParams.get('state')! }).toString(),
        });
        expect(await flow).toMatchObject({ apiKey: 'ak_1', hookId: 'hook_1' });
        // The browser is shown the completion page, as an HTML document.
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        // The browser itself refuses anything but the inline styles; the page it lands on follows the key's POST.
        expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(await res.text()).toContain("You're connected");
    });

    it('answers a callback that does not match with the error page and a 403', async () => {
        const { runLoginFlow } = await import('./login.js');
        const flow = runLoginFlow({ webUrl: 'https://x', timeoutSec: 5 }, { plan: { kind: 'ssh' }, open: vi.fn(async () => undefined) });
        await vi.waitFor(() => expect(logs.join('\n')).toContain('Waiting for sign-in'));
        const port = new URL(logs.join('\n').match(/https:\/\/x\/auth\/cli-bridge\?\S+/)![0]).searchParams.get('port');

        const { MAX_STATE_MISMATCHES } = await import('./login.js');
        let res!: Response;
        for (let i = 0; i < MAX_STATE_MISMATCHES; i++) {
            res = await fetch(`http://127.0.0.1:${port}/cb`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=ak_1&state=WRONG' });
            expect(res.status).toBe(403);
        }
        expect(await res.text()).toContain("Sign-in didn't match");
        expect(await flow).toBeNull();
        expect(errors.join('\n')).toContain('state mismatch');
    });
});

describe('openBrowser', () => {
    afterEach(() => {
        vi.doUnmock('node:child_process');
    });

    /** A spawn stub whose child plays `script` once it has started. */
    const mockSpawn = (script: (child: import('node:events').EventEmitter) => void) => {
        vi.doMock('node:child_process', async () => {
            const { EventEmitter } = await import('node:events');
            return {
                spawn: () => {
                    const child = Object.assign(new EventEmitter(), { unref: () => {} });
                    queueMicrotask(() => script(child));
                    return child;
                },
            };
        });
    };

    // A missing xdg-open fails after spawn() returns, as an 'error' event.
    it('reports an opener that fails after spawning', async () => {
        mockSpawn((child) => child.emit('error', new Error('spawn xdg-open ENOENT')));
        const { openBrowser } = await import('./login.js');
        expect(await openBrowser('https://x', 50)).toMatch(/^\S+ failed: spawn xdg-open ENOENT$/);
    });

    // xdg-open with no handler exits 3; this used to wait out the 300s timeout.
    it('reports an opener that exits non-zero right after starting', async () => {
        mockSpawn((child) => { child.emit('spawn'); child.emit('exit', 3); });
        const { openBrowser } = await import('./login.js');
        expect(await openBrowser('https://x', 50)).toMatch(/^\S+ exited with code 3$/);
    });

    it.each([
        ['exits 0', (child: import('node:events').EventEmitter) => { child.emit('spawn'); child.emit('exit', 0); }],
        ['is still running after the grace window', (child: import('node:events').EventEmitter) => { child.emit('spawn'); }],
    ])('counts an opener that %s as started', async (_, script) => {
        mockSpawn(script);
        const { openBrowser } = await import('./login.js');
        expect(await openBrowser('https://x', 20)).toBeUndefined();
    });
});

describe('browserPlan', () => {
    it.each([
        ['an SSH session', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, 'darwin', { kind: 'ssh' }],
        ['an SSH tty', { SSH_TTY: '/dev/pts/0' }, 'linux', { kind: 'ssh' }],
        ['Linux with no display', {}, 'linux', { kind: 'none', reason: 'no display (DISPLAY and WAYLAND_DISPLAY are unset)' }],
        ['Linux under X', { DISPLAY: ':0' }, 'linux', { kind: 'open' }],
        ['Linux under Wayland', { WAYLAND_DISPLAY: 'wayland-0' }, 'linux', { kind: 'open' }],
        // VS Code Remote-SSH: a $BROWSER helper and a forwarded loopback port.
        ['SSH with a $BROWSER helper', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22', BROWSER: '/vscode/helper.sh' }, 'linux', { kind: 'open' }],
        ['WSL with no display', { WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', { kind: 'open' }],
        ['a local Mac', {}, 'darwin', { kind: 'open' }],
        ['Windows', {}, 'win32', { kind: 'open' }],
    ] as const)('%s', async (_, env, platform, expected) => {
        const { browserPlan } = await import('./login.js');
        expect(browserPlan(env, platform)).toEqual(expected);
    });
});

describe('parseCallback (a GET: no key is read from it)', () => {
    it('refuses a key in the query with 400, and the result holds nothing of it', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/cb?key=ak_secret_1&hook=hook_1&baseUrl=https://api&wsUrl=wss://api&state=S1', 'S1');
        expect(result).toMatchObject({ ok: false, status: 400, reason: 'a key in the URL is refused', endsLogin: expect.stringContaining('refuses') });
        expect(JSON.stringify(result)).not.toContain('ak_secret_1');
    });

    it('refuses an empty key param too: the field is not allowed here at all', async () => {
        const { parseCallback } = await import('./login.js');
        expect(parseCallback('/cb?key=&state=S1', 'S1')).toMatchObject({ ok: false, status: 400, endsLogin: expect.any(String) });
    });

    it('rejects a state mismatch with 403, ahead of everything else', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/cb?key=ak_1&state=WRONG', 'S1');
        expect(result).toMatchObject({ ok: false, status: 403 });
        expect(JSON.stringify(result)).not.toContain('ak_1');
    });

    it('answers the console\'s cancel with "missing key" and does not end the login', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/cb?error=denied&state=S1', 'S1');
        expect(result).toEqual({ ok: false, status: 400, reason: 'missing key' });
    });

    it('ignores non-/cb paths with 404', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/favicon.ico', 'S1');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(404);
    });
});

describe('parseCallbackParams (the form body)', () => {
    it('accepts a matching state and extracts config', async () => {
        const { parseCallbackParams } = await import('./login.js');
        const result = parseCallbackParams(new URLSearchParams('key=ak_1&hook=hook_1&baseUrl=https://api.hwip.app&wsUrl=wss://ws.hwip.app&state=S1'), 'S1');
        expect(result).toEqual({ ok: true, config: { apiKey: 'ak_1', hookId: 'hook_1', baseUrl: 'https://api.hwip.app', wsUrl: 'wss://ws.hwip.app' } });
    });

    it('rejects a state mismatch with 403 and a missing key with 400', async () => {
        const { parseCallbackParams } = await import('./login.js');
        expect(parseCallbackParams(new URLSearchParams('key=ak_1&state=WRONG'), 'S1')).toMatchObject({ ok: false, status: 403 });
        expect(parseCallbackParams(new URLSearchParams('state=S1'), 'S1')).toMatchObject({ ok: false, status: 400 });
    });
});
