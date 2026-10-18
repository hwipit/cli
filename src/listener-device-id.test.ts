import { afterEach, describe, expect, it, vi } from 'vitest';

// Cross-repo contract: this read-only `listenerDeviceId()` MUST equal what
// `listener.ts computeListenerDeviceId()` registers for the same machine —
// otherwise a hook/notify tagged with it lands in the Streams feed but never
// threads into the agent chat (the drift this guards). It once regressed in
// hwip-hook.ts, which seeded the id from the hostname instead of the machine id.
//
// The golden constants are hardcoded so a change to EITHER the seed source or
// the hash breaks the test. listener.test.ts + mcp-server assert the same
// `dev_listener_ffd86de0` for the same machine seed.
const GOLDEN_MACHINE_ID = 'dev_listener_ffd86de0'; // dev_listener_<sha8('HWIP-TEST-MACHINE-ID-0001')>
const GOLDEN_HOSTNAME = 'dev_listener_e82c9f59'; //   dev_listener_<sha8('hwip-test-host')>

const io = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    readFileSync: vi.fn(),
    hostname: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));
vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    readFileSync: (...args: unknown[]) => io.readFileSync(...args),
}));
vi.mock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    hostname: () => io.hostname(),
}));

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('listenerDeviceId (must match listener computeListenerDeviceId)', () => {
    it('hashes the platform machine id when one is readable', async () => {
        // Cover both platforms: macOS ioreg IOPlatformUUID + Linux /etc/machine-id.
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        io.readFileSync.mockImplementation((p: string) => {
            if (p === '/etc/machine-id') return 'HWIP-TEST-MACHINE-ID-0001';
            throw new Error('ENOENT');
        });
        const { listenerDeviceId } = await import('./listener-device-id.js');
        expect(listenerDeviceId()).toBe(GOLDEN_MACHINE_ID);
    });

    // PATH-free: a process without /usr/sbin on its PATH must still reach ioreg.
    it('asks ioreg by its absolute path, not through PATH', async () => {
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        const { readMachineId } = await import('./listener-device-id.js');

        expect(readMachineId({ platform: 'darwin', exec: io.execFileSync as never })).toBe('HWIP-TEST-MACHINE-ID-0001');
        expect(io.execFileSync.mock.calls[0]![0]).toBe('/usr/sbin/ioreg');
    });

    it('falls back to a hostname hash when no machine id or sticky file exists', async () => {
        io.execFileSync.mockImplementation(() => {
            throw new Error('no ioreg');
        });
        io.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        io.hostname.mockReturnValue('hwip-test-host');
        const { listenerDeviceId } = await import('./listener-device-id.js');
        expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
    });

    // A notify asks for the id more than once, and on macOS each read was an `ioreg` spawn.
    it('reads the machine id once per process', async () => {
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        io.readFileSync.mockReturnValue('HWIP-TEST-MACHINE-ID-0001');
        const { listenerDeviceId } = await import('./listener-device-id.js');
        listenerDeviceId();
        const reads = io.execFileSync.mock.calls.length + io.readFileSync.mock.calls.length;
        expect(listenerDeviceId()).toBe(GOLDEN_MACHINE_ID);
        expect(io.execFileSync.mock.calls.length + io.readFileSync.mock.calls.length).toBe(reads);
    });

    // C98: a wedged ioreg (a stalled IOKit) held every hook, `hwip rename` and
    // the listener's own start for as long as it hung. mcp-server bounds it at
    // 5 s (config.ts IOREG_TIMEOUT_MS) and falls back to the same hostname
    // hash; both must give up on the same terms or the two ids drift.
    it('bounds ioreg at 5 s, the same ceiling mcp-server uses', async () => {
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        const { readMachineId } = await import('./listener-device-id.js');
        readMachineId({ platform: 'darwin', exec: io.execFileSync as never });
        expect(io.execFileSync.mock.calls[0]![2]).toMatchObject({ timeout: 5_000 });
    });

    it('a timed-out ioreg falls back to the hostname hash, the id mcp-server computes', async () => {
        io.execFileSync.mockImplementation(() => {
            throw Object.assign(new Error('spawnSync /usr/sbin/ioreg ETIMEDOUT'), { code: 'ETIMEDOUT' });
        });
        io.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        io.hostname.mockReturnValue('hwip-test-host');
        const { listenerDeviceId, readMachineId } = await import('./listener-device-id.js');
        expect(readMachineId({ platform: 'darwin', exec: io.execFileSync as never })).toBeNull();
        // mcp-server src/listener-device-id.test.ts pins this same value for a timed-out ioreg (its PR merges with this one).
        expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
    });
});
