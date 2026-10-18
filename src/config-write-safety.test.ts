/**
 * C107: `~/.hwip/config.json` is read by `loadConfig` and rewritten by `saveConfig`
 * (`install`, `login`) as `{ ...loadConfig(), apiKey }`. A file that cannot be read
 * as a JSON object used to load as `{}`, so the rewrite replaced it with the new key
 * alone and the user's other values (baseUrl, wsUrl, deviceId, hookId) were gone.
 * Every file is under a temp HOME (src/test-setup.ts points HOME at one).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modeOf = (path: string): number => statSync(path).mode & 0o777;

const load = async () => {
    vi.resetModules();
    const config = await import('./config.js');
    mkdirSync(config.CONFIG_DIR, { recursive: true });
    rmSync(config.CONFIG_FILE, { force: true, recursive: true });
    return config;
};

let errors: string[] = [];
const quiet = () => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
};
afterEach(() => {
    vi.restoreAllMocks();
});

const HAND_EDITED = '{\n  "apiKey": "ak_old",\n  "baseUrl": "https://api.example/v1",\n  "wsUrl": "wss://ws.example",\n  "deviceId": "dev_mine",\n}\n'; // trailing comma: not JSON

describe.skipIf(process.platform === 'win32')('saveConfig over a config.json it cannot read as JSON', () => {
    it.each<[string, string | Buffer, RegExp]>([
        ['a trailing comma', HAND_EDITED, /not valid JSON/],
        ['half a file', '{ "apiKey": "ak_old", "baseUr', /not valid JSON/],
        ['an array', '["ak_old"]', /not a JSON object/],
        ['a string', '"ak_old"', /not a JSON object/],
        ['null', 'null', /not a JSON object/],
        ['a byte order mark', '\uFEFF{ "apiKey": "ak_old" }', /starts with a byte order mark/],
        ['bytes that are not UTF-8', Buffer.from('{ "apiKey": "ak_\xE9" }', 'latin1'), /config\.json is not valid UTF-8 text, so it is not being overwritten/],
    ])('refuses %s, names the file, and leaves it byte for byte', async (_why, content, why) => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, content);

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(why);
        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(config.CONFIG_FILE);

        expect(readFileSync(config.CONFIG_FILE).equals(Buffer.from(content as never, typeof content === 'string' ? 'utf-8' : undefined))).toBe(true);
        expect(readdirSync(config.CONFIG_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('refuses a file it cannot read, and leaves it', async () => {
        quiet();
        if (process.getuid?.() === 0) return; // root reads mode 000
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_old', baseUrl: 'https://api.example/v1' }));
        chmodSync(config.CONFIG_FILE, 0o000);

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/cannot be read/);

        chmodSync(config.CONFIG_FILE, 0o600);
        expect(JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8'))).toEqual({ apiKey: 'ak_old', baseUrl: 'https://api.example/v1' });
    });

    it('says what to do: fix the file or move it aside', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, HAND_EDITED);

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/fix it, or move it aside/);
    });
});

describe.skipIf(process.platform === 'win32')('loadConfig on a config.json that is not a JSON object', () => {
    it.each(['null', '[]', '"x"', '42', 'true'])('reads %s as an unusable config, with the warning, never as null', async (text) => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, text);

        expect(config.loadConfig()).toEqual(config.unreadableConfigDefaults);
        expect(errors.join('\n')).toContain(config.CONFIG_FILE);
        expect(errors.join('\n')).toMatch(/not a JSON object/);
    });

    it('does not tell the user that re-running install writes a fresh one', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, HAND_EDITED);

        config.loadConfig();

        expect(errors.join('\n')).not.toMatch(/fresh one/);
        expect(errors.join('\n')).toMatch(/fix it, or move it aside/);
    });
});

describe.skipIf(process.platform === 'win32')('a refused config.json, to a writer', () => {
    it('does not point at --key, which the command already has', async () => {
        quiet();
        const config = await load();
        writeFileSync(config.CONFIG_FILE, '{}');
        chmodSync(config.CONFIG_FILE, 0o666);

        expect(config.configWriteProblem()).toMatch(/can be written by anyone.*chmod 600/);
        expect(config.configWriteProblem()).not.toMatch(/--key/);
        // A reader is still told what works.
        config.loadConfig();
        expect(errors.join('\n')).toMatch(/HWIP_API_KEY and --key still work/);
    });
});

// C119: the rename does not need write permission on the file, so a config.json set to 0400 was replaced. `install`
// and `login` ask `configWriteProblem` before they sign in or verify, so the refusal has to be there too.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only config.json', () => {
    it('is refused before login or install start, and is not replaced', async () => {
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_old', wsUrl: 'wss://ws.example' }));
        chmodSync(config.CONFIG_FILE, 0o400);

        expect(config.configWriteProblem()).toMatch(/not saving: .*config\.json is read-only/);
        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/read-only/);
        expect(JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8'))).toEqual({ apiKey: 'ak_old', wsUrl: 'wss://ws.example' });
        expect(modeOf(config.CONFIG_FILE)).toBe(0o400);
        chmodSync(config.CONFIG_FILE, 0o600);
    });
});

describe.skipIf(process.platform === 'win32')('saveConfig on a readable config.json', () => {
    it('writes it whole or not at all: a temp file beside it is renamed over it', async () => {
        const config = await load();
        writeFileSync(config.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_old', wsUrl: 'wss://ws.example' }));

        config.saveConfig({ ...config.loadConfig(), apiKey: 'ak_new' });

        expect(JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8'))).toEqual({ apiKey: 'ak_new', wsUrl: 'wss://ws.example' });
        expect(readdirSync(config.CONFIG_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('is 0600 when it is renamed into place, new file or old', async () => {
        const modes: number[] = [];
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            return {
                ...mod,
                renameSync: ((from: string, to: string) => {
                    modes.push(mod.statSync(from).mode & 0o777);
                    return mod.renameSync(from, to);
                }) as typeof mod.renameSync,
            };
        });
        const config = await import('./config.js');
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        rmSync(config.CONFIG_FILE, { force: true });

        config.saveConfig({ apiKey: 'ak_1' });
        chmodSync(config.CONFIG_FILE, 0o644);
        config.saveConfig({ apiKey: 'ak_2' });

        vi.doUnmock('fs');
        expect(modes).toEqual([0o600, 0o600]);
        expect(modeOf(config.CONFIG_FILE)).toBe(0o600);
    });

    // A crash in the old non-atomic write left exactly this; there is nothing in it to lose.
    it('writes over an empty file', async () => {
        const config = await load();
        writeFileSync(config.CONFIG_FILE, '  \n');

        config.saveConfig({ apiKey: 'ak_1' });

        expect(JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8'))).toEqual({ apiKey: 'ak_1' });
    });

    it('follows a symlink (dotfiles) instead of replacing it', async () => {
        const config = await load();
        const target = join(config.CONFIG_DIR, 'real-config.json');
        writeFileSync(target, JSON.stringify({ apiKey: 'ak_old', wsUrl: 'wss://ws.example' }), { mode: 0o600 });
        symlinkSync(target, config.CONFIG_FILE);

        config.saveConfig({ ...config.loadConfig(), apiKey: 'ak_new' });

        expect(lstatSync(config.CONFIG_FILE).isSymbolicLink()).toBe(true);
        expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ apiKey: 'ak_new', wsUrl: 'wss://ws.example' });
    });

    it('creates the file when there is none', async () => {
        const config = await load();

        config.saveConfig({ apiKey: 'ak_1' });

        expect(JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8'))).toEqual({ apiKey: 'ak_1' });
        expect(modeOf(config.CONFIG_FILE)).toBe(0o600);
    });

    // Two `hwip install` / `hwip login` at once: the second would write its copy of what it read
    // over the first one's change.
    it('stops when another process wrote the file after it was read', async () => {
        const first = await load();
        writeFileSync(first.CONFIG_FILE, JSON.stringify({ apiKey: 'ak_old' }));
        const theirs = JSON.stringify({ apiKey: 'ak_old', hookId: 'hook_theirs' });
        vi.resetModules();
        let once = false;
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            return {
                ...mod,
                readFileSync: ((p: unknown, o?: unknown) => {
                    const out = (mod.readFileSync as (a: unknown, b?: unknown) => unknown)(p, o);
                    if (!once && p === first.CONFIG_FILE) {
                        once = true;
                        mod.writeFileSync(first.CONFIG_FILE, theirs);
                    }
                    return out;
                }) as typeof mod.readFileSync,
            };
        });
        const config = await import('./config.js');

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/changed while hwip was editing it/);

        vi.doUnmock('fs');
        expect(readFileSync(first.CONFIG_FILE, 'utf-8')).toBe(theirs);
        expect(existsSync(first.CONFIG_FILE)).toBe(true);
    });

    it('stops when another process created the file after it was found missing', async () => {
        const first = await load();
        const theirs = JSON.stringify({ apiKey: 'ak_theirs', hookId: 'hook_theirs' });
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            let once = false;
            return {
                ...mod,
                readFileSync: ((p: unknown, o?: unknown) => {
                    try {
                        return (mod.readFileSync as (a: unknown, b?: unknown) => unknown)(p, o);
                    } finally {
                        if (!once && p === first.CONFIG_FILE) {
                            once = true;
                            mod.mkdirSync(first.CONFIG_DIR, { recursive: true });
                            mod.writeFileSync(first.CONFIG_FILE, theirs);
                        }
                    }
                }) as typeof mod.readFileSync,
            };
        });
        const config = await import('./config.js');

        expect(() => config.saveConfig({ apiKey: 'ak_new' })).toThrow(/changed while hwip was editing it/);

        vi.doUnmock('fs');
        expect(readFileSync(first.CONFIG_FILE, 'utf-8')).toBe(theirs);
    });

    // sudo with HOME kept: the rename makes a new inode, owned by root unless handed back.
    it('hands the file back to its owner when root writes it', async () => {
        vi.resetModules();
        const chowned: unknown[][] = [];
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            // Handbacks go onto the fd, never by name: map each open fd back to its path.
            const fdPaths = new Map<number, string>();
            return {
                ...mod,
                chownSync: ((...a: unknown[]) => { chowned.push(a); }) as unknown as typeof mod.chownSync,
                openSync: ((path: unknown, flags: unknown, mode: unknown): number => {
                    const fd = (mod.openSync as (p: unknown, f: unknown, m: unknown) => number)(path, flags, mode);
                    if (typeof path === 'string') fdPaths.set(fd, path);
                    return fd;
                }) as typeof mod.openSync,
                fchownSync: ((fd: number, uid: number, gid: number): void => { chowned.push([fdPaths.get(fd) ?? `fd:${fd}`, uid, gid]); }) as typeof mod.fchownSync,
                closeSync: ((fd: number): void => {
                    fdPaths.delete(fd);
                    mod.closeSync(fd);
                }) as typeof mod.closeSync,
            };
        });
        const config = await import('./config.js');
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        writeFileSync(config.CONFIG_FILE, '{}', { mode: 0o600 });
        vi.spyOn(process, 'getuid').mockReturnValue(0);

        config.saveConfig({ apiKey: 'ak_1' });

        vi.doUnmock('fs');
        const st = statSync(config.CONFIG_FILE);
        expect(chowned).toHaveLength(1);
        expect(chowned[0]!.slice(1)).toEqual([st.uid, st.gid]);
    });
});
