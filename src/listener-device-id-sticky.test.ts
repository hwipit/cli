import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C109: the listener registers its device id once, at start. When `ioreg` stalls past its 5 s
// then, the machine id reads as missing — and the listener used to write the HOSTNAME hash into
// the sticky file and keep it, while hooks and mcp-server (healthy `ioreg`, machine id first)
// computed the machine-id hash: the same Mac under two ids, until the next restart, and a
// file that kept the wrong one. Now a successful read leaves its id in the sticky file, so a
// later start with `ioreg` wedged still gets it, and a macOS fallback to the hostname is never written down.
const GOLDEN_MACHINE_ID = 'dev_listener_ffd86de0'; // dev_listener_<sha8('HWIP-TEST-MACHINE-ID-0001')>
const IOREG_OUT = '  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n';

const io = vi.hoisted(() => ({ execFileSync: vi.fn(), hostname: vi.fn(), linuxMachineId: null as string | null }));
vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return {
        ...fs,
        // The host's own /etc/machine-id is not what a test should depend on.
        readFileSync: (path: unknown, ...rest: unknown[]) => {
            if (path === '/etc/machine-id' || path === '/var/lib/dbus/machine-id') {
                if (io.linuxMachineId === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return io.linuxMachineId;
            }
            return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
        },
    };
});
vi.mock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    hostname: () => io.hostname(),
}));

const stickyFile = (): string => join(homedir(), '.hwip', 'listener-device-id');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const platform = (name: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: name });
};
const wedged = (): void => {
    io.execFileSync.mockImplementation(() => {
        throw Object.assign(new Error('spawnSync /usr/sbin/ioreg ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
};
/** A fresh start of the process: nothing pinned in memory. */
const listener = async () => {
    vi.resetModules();
    return (await import('./listener.js')).computeListenerDeviceId;
};
const hook = async () => {
    vi.resetModules();
    return (await import('./listener-device-id.js')).listenerDeviceId;
};

beforeEach(() => {
    io.hostname.mockReturnValue('hwip-test-host');
    io.linuxMachineId = null;
    rmSticky();
});
afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.clearAllMocks();
    vi.resetModules();
    rmSticky();
});
const rmSticky = (): void => rmSync(stickyFile(), { force: true });

describe('the listener leaves its machine id where a wedged ioreg cannot hide it', () => {
    it('writes the id it read into the sticky file, private to the user', async () => {
        platform('darwin');
        io.execFileSync.mockReturnValue(IOREG_OUT);

        expect((await listener())()).toBe(GOLDEN_MACHINE_ID);

        expect(readFileSync(stickyFile(), 'utf-8').trim()).toBe(GOLDEN_MACHINE_ID);
        expect(statSync(stickyFile()).mode & 0o777).toBe(0o600);
    });

    it('replaces the file by rename: nothing is left beside it, the directory is private', async () => {
        platform('darwin');
        io.execFileSync.mockReturnValue(IOREG_OUT);
        mkdirSync(join(homedir(), '.hwip'), { recursive: true, mode: 0o755 });
        writeFileSync(stickyFile(), 'dev_listener_e82c9f59\n');

        (await listener())();

        expect(readFileSync(stickyFile(), 'utf-8')).toBe(`${GOLDEN_MACHINE_ID}\n`);
        expect(readdirSync(join(homedir(), '.hwip'))).toEqual(['listener-device-id']);
        expect(statSync(join(homedir(), '.hwip')).mode & 0o777).toBe(0o700);
    });

    it('does not write the file on Linux, where a container sharing the home would take the host\'s id', async () => {
        platform('linux');
        io.linuxMachineId = 'HWIP-TEST-MACHINE-ID-0001';

        expect((await listener())()).toBe(GOLDEN_MACHINE_ID);

        expect(existsSync(stickyFile())).toBe(false);
    });

    it('keeps the machine id across a start whose ioreg stalls, and the hooks agree with it', async () => {
        platform('darwin');
        io.execFileSync.mockReturnValue(IOREG_OUT);
        (await listener())();

        wedged();

        expect((await listener())()).toBe(GOLDEN_MACHINE_ID);
        expect((await hook())()).toBe(GOLDEN_MACHINE_ID);
    });

    it('does not write the hostname hash on macOS: ioreg stalling is a passing fault, the next start should recover', async () => {
        platform('darwin');
        wedged();

        expect((await listener())()).toMatch(/^dev_listener_[0-9a-f]{8}$/);

        expect(existsSync(stickyFile()) ? readFileSync(stickyFile(), 'utf-8').trim() : '').toBe('');
        io.execFileSync.mockReturnValue(IOREG_OUT);
        expect((await listener())()).toBe(GOLDEN_MACHINE_ID);
    });

    it('still pins the hostname hash where no machine id can ever be read (so its drift cannot split the machine)', async () => {
        platform('freebsd');
        const first = (await listener())();

        expect(readFileSync(stickyFile(), 'utf-8').trim()).toBe(first);
        io.hostname.mockReturnValue('renamed-by-the-network');
        expect((await listener())()).toBe(first);
    });

    it('overwrites an id a stalled start left in the file once the machine id reads again', async () => {
        platform('darwin');
        mkdirSync(join(homedir(), '.hwip'), { recursive: true });
        writeFileSync(stickyFile(), 'dev_listener_e82c9f59');
        chmodSync(stickyFile(), 0o644);
        io.execFileSync.mockReturnValue(IOREG_OUT);

        expect((await listener())()).toBe(GOLDEN_MACHINE_ID);

        expect(readFileSync(stickyFile(), 'utf-8').trim()).toBe(GOLDEN_MACHINE_ID);
        expect(statSync(stickyFile()).mode & 0o777).toBe(0o600);
    });
});
