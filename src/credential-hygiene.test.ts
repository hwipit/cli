/**
 * ④ LOW bundle (C103): the places that handle the API key and where it goes.
 * Every file is under a temp HOME (src/test-setup.ts points HOME at one).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { networkFailureMessage } from './http-failure.js';
import { insecureUrlWarning, warnInsecureUrl } from './insecure-url.js';
import { ensurePrivateDir, ensurePrivateFile } from './private-files.js';
import { maskKey, redactSecrets } from './redact.js';

const modeOf = (path: string): number => statSync(path).mode & 0o777;
let scratch: string;
beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hwip-hygiene-'));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('a key shown on screen', () => {
    it('is the prefix and no more — and nothing of a key too short to have one', () => {
        expect(maskKey('ak_0123456789abcdef')).toBe('ak_…');
        expect(maskKey('ab')).toBe('…');
        expect(maskKey('ak_0123456789abcdef')).not.toMatch(/0123/);
    });
});

describe('credentials in a URL, quoted by an error', () => {
    it('are taken out of the text', () => {
        const text = 'Request cannot be constructed from a URL that includes credentials: https://user:hunter2@api.example/v1/x';

        expect(redactSecrets(text)).toBe('Request cannot be constructed from a URL that includes credentials: https://***@api.example/v1/x');
    });

    it('are matched without running away on a long text, and without eating an address in unrelated text', () => {
        const long = 'a.'.repeat(40_000);
        const started = Date.now();

        expect(redactSecrets(long)).toBe(long);
        expect(Date.now() - started).toBeLessThan(500);
        expect(redactSecrets('{"url":"https://host","email":"a@b.com"}')).toBe('{"url":"https://host","email":"a@b.com"}');
        expect(redactSecrets('https://api.example.com,admin@x.com')).toBe('https://api.example.com,admin@x.com');
        expect(redactSecrets('mail git@github.com:foo or mailto:a@b.c')).toBe('mail git@github.com:foo or mailto:a@b.c');
    });

    it('are not in the message a failed call gives a person (a real fetch to a base URL with userinfo)', async () => {
        const url = 'http://user:hunter2@127.0.0.1:9/v1/pushes';
        const err = await fetch(url).then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(TypeError);
        expect(networkFailureMessage(err, url)).not.toMatch(/hunter2|user:/);
    });
});

describe('a key sent in the clear', () => {
    it.each([
        ['http://api.example.com/v1', /api\.example\.com is reached over plain http:\/\/.*in the clear/],
        ['http://10.0.0.5:3000/v1', /10\.0\.0\.5:3000 is reached over plain http/],
        ['ws://ws.example.com', /WebSocket at ws\.example\.com is reached over plain ws:\/\//],
    ])('is warned about once for %s', (url, why) => {
        expect(insecureUrlWarning(url)).toMatch(why);
    });

    it.each([
        ['https://api.hwip.app/v1'], ['wss://ws.hwip.app'], ['http://localhost:3000/v1'], ['http://127.0.0.1:8080'],
        ['http://127.5.4.3'], ['ws://localhost:3001'], ['http://[::1]:3000'], ['http://dev.localhost'], ['not a url'],
        ['http://0.0.0.0:3000'], ['http://localhost.:3000'], ['http://[::ffff:127.0.0.1]:3000'], ['http://[::]:3000'], ['HTTP://LOCALHOST:3000'],
    ])('is not warned about for %s', (url) => {
        expect(insecureUrlWarning(url)).toBeNull();
    });

    it('is said once per URL per process', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });

        warnInsecureUrl('http://once.example.com/v1');
        warnInsecureUrl('http://once.example.com/v1');
        warnInsecureUrl('http://twice.example.com/v1');

        expect(lines).toHaveLength(2);
    });

    it('is said by every client that is built for such a base URL', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const { HwipHook } = await import('./hwip-hook.js');

        new HwipHook({ apiKey: 'ak_x', baseUrl: 'http://client.example.com/v1' });
        new HwipHook({ apiKey: 'ak_x', baseUrl: 'https://client.example.com/v1' });

        expect(lines).toEqual([expect.stringContaining('client.example.com is reached over plain http://')]);
    });
});

describe('the folder and the files the key lives in', () => {
    it('ensurePrivateDir makes an existing loose folder 0700', () => {
        const dir = join(scratch, 'hwip');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);

        ensurePrivateDir(dir);

        expect(modeOf(dir)).toBe(0o700);
    });

    it('ensurePrivateFile makes an existing loose file 0600, content untouched, and a new one 0600 under any umask', () => {
        const file = join(scratch, 'listener.log');
        writeFileSync(file, 'old line\n', { mode: 0o644 });
        chmodSync(file, 0o644);

        ensurePrivateFile(file);

        expect(modeOf(file)).toBe(0o600);
        expect(readFileSync(file, 'utf-8')).toBe('old line\n');

        const before = process.umask(0);
        try {
            const fresh = join(scratch, 'fresh.log');
            ensurePrivateFile(fresh);
            expect(modeOf(fresh)).toBe(0o600);
        } finally {
            process.umask(before);
        }
    });

    it('ensurePrivateDir leaves a symlinked folder alone: what it points at may be shared on purpose', () => {
        const shared = join(scratch, 'shared');
        mkdirSync(shared, { mode: 0o775 });
        chmodSync(shared, 0o775);
        const link = join(scratch, 'hwip-link');
        symlinkSync(shared, link);

        ensurePrivateDir(link);

        expect(modeOf(shared)).toBe(0o775);
    });

    // Looked at, then changed by name: a link put there in between used to get its target locked instead.
    // The swap comes after whichever look is made first, by name (`lstat`) or by opening it.
    it('ensurePrivateDir does not lock what a link points at when the link takes the folder\'s place after it was looked at', async () => {
        const dir = join(scratch, 'hwip');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        const shared = join(scratch, 'shared');
        mkdirSync(shared, { mode: 0o775 });
        chmodSync(shared, 0o775);
        let looks = 0;
        vi.resetModules();
        vi.doMock('node:fs', async (importOriginal) => {
            const real = await importOriginal<typeof import('node:fs')>();
            const swapAfterFirstLook = (path: PathLike): void => {
                if (path !== dir || looks++ > 0) return;
                real.rmdirSync(dir);
                real.symlinkSync(shared, dir);
            };
            const lstatSync = ((...args: Parameters<typeof real.lstatSync>) => {
                const seen = real.lstatSync(...args);
                swapAfterFirstLook(args[0]);
                return seen;
            }) as typeof real.lstatSync; // the real call with a swap after it: same arguments, same result
            const openSync = ((...args: Parameters<typeof real.openSync>) => {
                const fd = real.openSync(...args);
                swapAfterFirstLook(args[0]);
                return fd;
            }) as typeof real.openSync; // as above
            return { ...real, lstatSync, openSync };
        });
        try {
            const fresh = await import('./private-files.js');
            fresh.ensurePrivateDir(dir);
            expect(looks).toBeGreaterThan(0); // the swap happened: the line below is not true of any code at all
            expect(modeOf(shared)).toBe(0o775);
        } finally {
            vi.doUnmock('node:fs');
            vi.resetModules();
        }
    });

    // A platform without those two flags (Windows) has no such open: there the folder is looked at and changed by name, as before.
    it('ensurePrivateDir still locks a loose folder, and leaves a linked one alone, where a folder cannot be opened without following a link', async () => {
        const dir = join(scratch, 'hwip');
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        const shared = join(scratch, 'shared');
        mkdirSync(shared, { mode: 0o775 });
        chmodSync(shared, 0o775);
        const link = join(scratch, 'hwip-link');
        symlinkSync(shared, link);
        const opened: PathLike[] = [];
        vi.resetModules();
        vi.doMock('node:fs', async (importOriginal) => {
            const real = await importOriginal<typeof import('node:fs')>();
            const openSync = ((...args: Parameters<typeof real.openSync>) => {
                opened.push(args[0]);
                return real.openSync(...args);
            }) as typeof real.openSync; // the real call, recorded
            return { ...real, openSync, constants: { ...real.constants, O_DIRECTORY: undefined, O_NOFOLLOW: undefined } };
        });
        try {
            const fresh = await import('./private-files.js');
            fresh.ensurePrivateDir(dir);
            fresh.ensurePrivateDir(link);
            expect(modeOf(dir)).toBe(0o700);
            expect(modeOf(shared)).toBe(0o775);
            expect(opened).toEqual([]);
        } finally {
            vi.doUnmock('node:fs');
            vi.resetModules();
        }
    });

    // C149 ①: a folder its owner cannot read cannot be opened, yet others may still write into it.
    // Root is skipped: its open of such a folder is not refused here, so it never takes the path below.
    describe.skipIf(process.getuid?.() === 0)('ensurePrivateDir and a folder its owner cannot read', () => {
        it('makes it 0700 as well', () => {
            const dir = join(scratch, 'hwip');
            mkdirSync(dir);
            chmodSync(dir, 0o377);

            ensurePrivateDir(dir);

            expect(modeOf(dir)).toBe(0o700);
        });

        // Root changing a path by name is what a link put there would use. Either id makes it root: the effective one is what the change is allowed by.
        it.each(['getuid', 'geteuid'] as const)('is left as it is when root runs it (%s)', (id) => {
            const dir = join(scratch, 'hwip');
            mkdirSync(dir);
            chmodSync(dir, 0o377);
            const asRoot = vi.spyOn(process, id).mockReturnValue(0);

            try {
                ensurePrivateDir(dir);
            } finally {
                asRoot.mockRestore();
            }

            expect(modeOf(dir)).toBe(0o377);
        });

        // Only the refusal the mode makes takes the path by name: any other one is not a folder its owner cannot read.
        it('is left as it is when the open was refused for another reason', async () => {
            const dir = join(scratch, 'hwip');
            mkdirSync(dir);
            chmodSync(dir, 0o755);
            vi.resetModules();
            vi.doMock('node:fs', async (importOriginal) => {
                const real = await importOriginal<typeof import('node:fs')>();
                const openSync = ((...args: Parameters<typeof real.openSync>) => {
                    if (args[0] === dir) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
                    return real.openSync(...args);
                }) as typeof real.openSync; // the real call, refused for this one folder
                return { ...real, openSync };
            });
            try {
                const fresh = await import('./private-files.js');
                fresh.ensurePrivateDir(dir);
                expect(modeOf(dir)).toBe(0o755);
            } finally {
                vi.doUnmock('node:fs');
                vi.resetModules();
            }
        });

        it('leaves a link alone that took its place once the open was refused', async () => {
            const dir = join(scratch, 'hwip');
            mkdirSync(dir);
            chmodSync(dir, 0o377);
            const shared = join(scratch, 'shared');
            mkdirSync(shared, { mode: 0o775 });
            chmodSync(shared, 0o775);
            let refusals = 0;
            vi.resetModules();
            vi.doMock('node:fs', async (importOriginal) => {
                const real = await importOriginal<typeof import('node:fs')>();
                const openSync = ((...args: Parameters<typeof real.openSync>) => {
                    try {
                        return real.openSync(...args);
                    } catch (err) {
                        if (args[0] === dir && refusals++ === 0) {
                            real.rmdirSync(dir);
                            real.symlinkSync(shared, dir);
                        }
                        throw err;
                    }
                }) as typeof real.openSync; // the real call, with a swap after its refusal
                return { ...real, openSync };
            });
            try {
                const fresh = await import('./private-files.js');
                fresh.ensurePrivateDir(dir);
                expect(refusals).toBe(1); // the swap happened: the line below is not true of any code at all
                expect(modeOf(shared)).toBe(0o775);
            } finally {
                vi.doUnmock('node:fs');
                vi.resetModules();
            }
        });
    });

    it('saveConfig tightens a folder an older install left open', async () => {
        const { CONFIG_DIR, saveConfig } = await import('./config.js');
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
        chmodSync(CONFIG_DIR, 0o755);

        saveConfig({ apiKey: 'ak_x' });

        expect(modeOf(CONFIG_DIR)).toBe(0o700);
        expect(existsSync(join(CONFIG_DIR, 'config.json'))).toBe(true);
    });
});

describe.skipIf(process.platform === 'win32')('config.json that others can reach', () => {
    const load = async () => {
        vi.resetModules();
        const config = await import('./config.js');
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        rmSync(config.CONFIG_FILE, { force: true });
        return config;
    };

    // Linux with user-private groups (umask 002) and any dotfiles checkout make every file 664; ignoring those stopped every command.
    it('is used, restricted to 0600 and warned about, when it is group-writable and the user\'s own', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_x', hookId: 'hook_1' }));
        chmodSync(config.CONFIG_FILE, 0o664);

        expect(config.loadConfig()).toEqual({ apiKey: 'ak_x', hookId: 'hook_1' });

        expect(modeOf(config.CONFIG_FILE)).toBe(0o600);
        expect(lines.join('\n')).toMatch(/can be reached by other users \(mode 664\)/);
    });

    it('is never written over once it is ignored: what is written would replace it, not add to it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        const original = JSON.stringify({ apiKey: 'ak_x', hookId: 'hook_1', baseUrl: 'https://api.example/v1', wsUrl: 'wss://ws.example' });
        writeFileSync(config.CONFIG_FILE, original);
        chmodSync(config.CONFIG_FILE, 0o666);

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/not saving:.*can be written by anyone.*chmod 600/);

        expect(readFileSync(config.CONFIG_FILE, 'utf-8')).toBe(original);
    });

    it('is ignored, with a warning, when anyone can write it: it says where the key goes', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_x', baseUrl: 'https://evil.example/v1' }));
        chmodSync(config.CONFIG_FILE, 0o666);

        expect(config.loadConfig()).toEqual(config.unreadableConfigDefaults);

        expect(lines.join('\n')).toMatch(/can be written by anyone \(mode 666\), so it is being ignored/);
    });

    it('is used, but restricted to 0600 with a warning, when others can only read it', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_x' }));
        chmodSync(config.CONFIG_FILE, 0o644);

        expect(config.loadConfig()).toEqual({ apiKey: 'ak_x' });

        expect(modeOf(config.CONFIG_FILE)).toBe(0o600);
        expect(lines.join('\n')).toMatch(/can be reached by other users \(mode 644\).*restricted to 0600/);
    });

    it('is read without a word when only its owner can reach it', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_x' }), { mode: 0o600 });
        chmodSync(config.CONFIG_FILE, 0o600);

        expect(config.loadConfig()).toEqual({ apiKey: 'ak_x' });
        expect(lines).toEqual([]);
    });

    it('is judged by what a symlink points at', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        const target = join(scratch, 'dotfiles-config.json');
        writeFileSync(target, JSON.stringify({ apiKey: 'ak_linked' }));
        chmodSync(target, 0o666);
        symlinkSync(target, config.CONFIG_FILE);

        expect(config.loadConfig()).toEqual(config.unreadableConfigDefaults);

        chmodSync(target, 0o600);
        vi.resetModules();
        const again = await import('./config.js');
        expect(again.loadConfig()).toEqual({ apiKey: 'ak_linked' });
    });

    it('is ignored when another user owns it, whatever the mode', async () => {
        const { configModeProblem } = await import('./config.js');

        // Group-write alone (no read bit) is still access for others.
        expect(configModeProblem({ uid: 501, mode: 0o100620 }, 501)).toMatchObject({ refuse: false, why: expect.stringContaining('mode 620') });

        expect(configModeProblem({ uid: 0, mode: 0o100600 }, 501, '/h/.hwip/config.json')).toEqual({
            refuse: true,
            why: '/h/.hwip/config.json belongs to another user (uid 0), so it is being ignored (HWIP_API_KEY and --key still work)',
        });
        expect(configModeProblem({ uid: 501, mode: 0o100600 }, 501)).toBeNull();
        // sudo keeps HOME: root reads what a user owns.
        expect(configModeProblem({ uid: 501, mode: 0o100600 }, 0)).toBeNull();
    });
});
