/**
 * C121: `sudo hwip login` / `install` with HOME kept (macOS) ran as root and made `~/.hwip` and
 * `config.json` root-owned, so the next plain `hwip` could neither read the key nor save to it.
 * A first write by root now hands what it created to the person who ran `sudo` (`SUDO_UID`),
 * but only inside a home folder that person owns. Run as root through the real uid, none of this
 * can be seen, so the uid is stubbed and `lchownSync` records what it would have been asked to do.
 * `chownSync` is recorded apart: it follows a link, and a path root made a moment ago can have been
 * swapped for one by whoever owns the folder it is in.
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const OTHER_UID = me.uid + 1;

type Chown = [string, number, number];
let chowned: Chown[] = [];
/** Paths handed back by the call that follows a link. */
let followed: string[] = [];

const asRoot = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    chowned = [];
    followed = [];
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) vi.stubEnv(key, '');
        else vi.stubEnv(key, value);
    }
    for (const mod of ['fs', 'node:fs']) {
        vi.doMock(mod, async (importOriginal) => {
            const real = await importOriginal<typeof import('fs')>();
            // Handbacks now go onto the fd, never by name (a link put where the file was must not
            // divert them): map each open fd back to its path so the record stays by path.
            const fdPaths = new Map<number, string>();
            return {
                ...real,
                // Each records the call instead of making it: the test is not root.
                lchownSync: (path: string, uid: number, gid: number): void => { chowned.push([path, uid, gid]); },
                chownSync: (path: string): void => { followed.push(path); },
                openSync: ((path: unknown, flags: unknown, mode: unknown): number => {
                    const fd = (real.openSync as (p: unknown, f: unknown, m: unknown) => number)(path, flags, mode);
                    if (typeof path === 'string') fdPaths.set(fd, path);
                    return fd;
                }) as typeof real.openSync,
                fchownSync: (fd: number, uid: number, gid: number): void => { chowned.push([fdPaths.get(fd) ?? `fd:${fd}`, uid, gid]); },
                closeSync: ((fd: number): void => {
                    fdPaths.delete(fd);
                    real.closeSync(fd);
                }) as typeof real.closeSync,
            };
        });
    }
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const config = await import('./config.js');
    rmSync(config.CONFIG_DIR, { recursive: true, force: true });
    return config;
};

afterEach(() => {
    vi.doUnmock('fs');
    vi.doUnmock('node:fs');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

const SUDO = { SUDO_UID: String(me.uid), SUDO_GID: String(me.gid) };

describe.skipIf(process.platform === 'win32' || me.uid === 0)('root running through sudo with the user\'s HOME kept', () => {
    it('hands the new ~/.hwip and config.json to the person who ran sudo', async () => {
        const config = await asRoot(SUDO);

        config.saveConfig({ apiKey: 'ak_1' });

        const owned = chowned.filter(([, uid, gid]) => uid === me.uid && gid === me.gid).map(([path]) => path);
        expect(owned).toContain(config.CONFIG_DIR);
        // The file is chowned under its temp name, before the rename puts it in place.
        expect(owned.some((path) => path.startsWith(`${config.CONFIG_FILE}.`) && path.endsWith('.tmp'))).toBe(true);
        expect(chowned.every(([path]) => path.startsWith(homedir()))).toBe(true);
    });

    // A link in the place of the file root just made would otherwise hand over whatever it points at.
    it('hands a path back as it is, never what a link in its place points at', async () => {
        const config = await asRoot(SUDO);

        config.saveConfig({ apiKey: 'ak_1' });

        expect(chowned.length).toBeGreaterThan(0);
        expect(followed).toEqual([]);
    });

    it('hands back every folder it makes on the way, not only the last', async () => {
        await asRoot(SUDO);
        const { mkdirHandedBack } = await import('./private-files.js');
        const deep = join(homedir(), 'c121-a', 'b', 'c');
        rmSync(join(homedir(), 'c121-a'), { recursive: true, force: true });

        mkdirHandedBack(deep);

        expect(chowned.map(([path]) => path).sort()).toEqual([join(homedir(), 'c121-a'), join(homedir(), 'c121-a', 'b'), deep].sort());
        rmSync(join(homedir(), 'c121-a'), { recursive: true, force: true });
    });

    it('leaves a folder and a file that were already there alone', async () => {
        const config = await asRoot(SUDO);
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        const { ensurePrivateFile } = await import('./private-files.js');
        ensurePrivateFile(join(config.CONFIG_DIR, 'listener.log'));
        chowned = [];

        ensurePrivateFile(join(config.CONFIG_DIR, 'listener.log'));
        config.saveConfig({ apiKey: 'ak_1' });

        // The existing folder is not chowned; the file replaced under an owner keeps the old rule (to that owner).
        expect(chowned.map(([path]) => path)).not.toContain(config.CONFIG_DIR);
        expect(existsSync(config.CONFIG_DIR)).toBe(true);
    });

    it('hands the device keypair, a private key, to the person who ran sudo', async () => {
        const config = await asRoot(SUDO);
        const { initDeviceCrypto } = await import('./crypto.js');

        await initDeviceCrypto();

        const owned = chowned.map(([path]) => path);
        expect(owned).toContain(config.CONFIG_DIR);
        expect(owned.some((path) => path.includes('.tmp') && path.startsWith(config.CONFIG_DIR))).toBe(true);
    });

    it('makes an exclusive folder and hands it back, and still says EEXIST when it was there', async () => {
        await asRoot(SUDO);
        const { mkdirExclusiveHandedBack } = await import('./private-files.js');
        const dir = join(homedir(), 'c123-exclusive');
        rmSync(dir, { recursive: true, force: true });

        mkdirExclusiveHandedBack(dir);
        expect(chowned.map(([path]) => path)).toEqual([dir]);
        chowned = [];
        expect(() => mkdirExclusiveHandedBack(dir)).toThrow(/EEXIST/);
        expect(chowned).toEqual([]);
        rmSync(dir, { recursive: true, force: true });
    });

    it('hands back a log file hwip creates, once', async () => {
        const config = await asRoot(SUDO);
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        const { ensurePrivateFile } = await import('./private-files.js');
        const log = join(config.CONFIG_DIR, 'listener.log');

        ensurePrivateFile(log);
        ensurePrivateFile(log);

        expect(chowned.filter(([path]) => path === log)).toHaveLength(1);
    });

    it.each([
        ['no SUDO_UID: root by itself', { SUDO_UID: undefined, SUDO_GID: undefined }],
        ['SUDO_UID of root', { SUDO_UID: '0', SUDO_GID: '0' }],
        ['a SUDO_UID that is not a number', { SUDO_UID: 'me', SUDO_GID: String(me.gid) }],
        ['a SUDO_GID that is missing', { SUDO_UID: String(me.uid), SUDO_GID: undefined }],
        ['a SUDO_GID that is not a number', { SUDO_UID: String(me.uid), SUDO_GID: 'staff' }],
        ['a SUDO_UID that only looks like the owner (leading zero)', { SUDO_UID: `0${me.uid}`, SUDO_GID: String(me.gid) }],
        ['a home that another user owns (HOME reset to root\'s on Linux)', { SUDO_UID: String(OTHER_UID), SUDO_GID: String(me.gid) }],
    ])('hands nothing back with %s', async (_name, env) => {
        const config = await asRoot(env);

        config.saveConfig({ apiKey: 'ak_1' });

        expect(chowned).toEqual([]);
        expect(statSync(config.CONFIG_FILE).uid).toBe(me.uid); // written, just not handed anywhere
    });

    // C149 ③: `..` in the path no longer fools the home-folder check — the resolved parent is compared.
    it('hands nothing back for a path that climbs out of the home folder', async () => {
        await asRoot(SUDO);
        const { handBackToSudoUser, sudoOwner } = await import('./private-files.js');
        const escapee = join(homedir(), 'c149-sub', '..', '..', 'c149-escapee');

        expect(sudoOwner(escapee)).toBeNull();
        handBackToSudoUser(escapee);
        expect(chowned).toEqual([]);
        expect(followed).toEqual([]);
    });

    // C149 ①②: a link put where the new file was gets no handback — neither the link nor its target.
    it('hands nothing back for a link put where the new file was', async () => {
        const config = await asRoot(SUDO);
        mkdirSync(config.CONFIG_DIR, { recursive: true });
        const { createdHandedBack } = await import('./private-files.js');
        const { symlinkSync, writeFileSync } = await import('node:fs');
        const target = join(config.CONFIG_DIR, 'c149-target');
        const link = join(config.CONFIG_DIR, 'c149-link');
        writeFileSync(target, 'theirs');
        rmSync(link, { force: true });
        symlinkSync(target, link);

        createdHandedBack(link);

        expect(chowned).toEqual([]);
        expect(followed).toEqual([]);
        rmSync(link, { force: true });
        rmSync(target, { force: true });
    });

    it('hands nothing back outside the home folder, not even a sibling that starts with its name', async () => {
        await asRoot(SUDO);
        const { mkdirHandedBack } = await import('./private-files.js');
        const sibling = `${homedir()}-c121-sibling`;

        mkdirHandedBack(join(sibling, 'x'));

        expect(chowned).toEqual([]);
        rmSync(sibling, { recursive: true, force: true });
    });

    it('hands nothing back when it is not root that runs', async () => {
        const config = await asRoot(SUDO);
        vi.spyOn(process, 'getuid').mockReturnValue(me.uid);

        config.saveConfig({ apiKey: 'ak_1' });

        expect(chowned).toEqual([]);
    });
});

/** C123: the other places hwip makes its own folders and files go through the same gate. */
describe.skipIf(process.platform === 'win32' || me.uid === 0)('every place hwip keeps state, under sudo with the user\'s HOME kept', () => {
    const handedBack = () => chowned.filter(([, uid, gid]) => uid === me.uid && gid === me.gid).map(([path]) => path);

    it.each<[string, (config: typeof import('./config.js')) => Promise<{ folder: string; file: RegExp }>]>([
        ['the hook gate\'s state', async () => {
            const gate = await import('./gate.js');
            gate.touchRemoteActive('/some/project');
            return { folder: gate.stateDir(), file: /remote-active/ };
        }],
        ['the shell audit log', async () => {
            const gate = await import('./gate.js');
            const audit = await import('./shell-audit.js');
            audit.appendShellAudit({ at: new Date(), session: 's', target: '%1', kind: 'body', foreground: 'zsh', atShell: true, text: 'ls' });
            return { folder: gate.stateDir(), file: /shell-audit\.log$/ };
        }],
        ['the notify failure record', async () => {
            const gate = await import('./gate.js');
            const failure = await import('./notify-failure.js');
            failure.recordNotifyFailure({ kind: 'http', status: 500, code: 'x' } as never);
            return { folder: gate.stateDir(), file: /\.tmp$/ };
        }],
        ['the listener runtime files', async (config) => {
            const proc = await import('./listener-process.js');
            proc.writeListenerRuntime('1.0.0', 'wss://example.test');
            return { folder: config.CONFIG_DIR, file: /listener\.(pid|version)/ };
        }],
        ['the subscriber trust state', async (config) => {
            const trust = await import('./subscriber-trust.js');
            trust.writeTrustState(join(config.CONFIG_DIR, 'nested', 'trusted.json'), { devices: new Map(), commands: new Map(), commandKeys: new Map() } as never);
            return { folder: join(config.CONFIG_DIR, 'nested'), file: /trusted\.json\.\d+\.[0-9a-f]+\.tmp$/ };
        }],
        ['the turn ring', async () => {
            const ring = await import('./turn-ring.js');
            ring.appendTurnRing('s', [{ kind: 'prompt', text: 'x' } as never]);
            return { folder: (await import('./gate.js')).stateDir(), file: /\.jsonl$/ };
        }],
    ])('hands back %s', async (_name, run) => {
        const config = await asRoot(SUDO);

        const { folder, file } = await run(config);

        const owned = handedBack();
        expect(owned.some((path) => path.startsWith(folder)), `a folder or file under ${folder} in ${owned.join(', ')}`).toBe(true);
        expect(owned.some((path) => file.test(path)), `a file like ${file} in ${owned.join(', ')}`).toBe(true);
    });
});

