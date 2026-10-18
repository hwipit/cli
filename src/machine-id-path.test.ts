import { afterEach, describe, expect, it, vi } from 'vitest';

// The machine id seeds the listener's device id, and on macOS it comes from
// `ioreg`, which lives in /usr/sbin. A process whose PATH lacks that directory
// (an IDE or hook environment) used to fail the lookup, fall back to a hostname
// hash and register the same Mac as another device. Both readers — the
// listener's and the read-only copy the hooks use — must give the same id
// whatever PATH they run under.
const realPath = process.env.PATH;

afterEach(() => {
    process.env.PATH = realPath;
    vi.resetModules();
});

const listenerId = async (path: string | undefined): Promise<string> => {
    process.env.PATH = path;
    vi.resetModules();
    const { computeListenerDeviceId } = await import('./listener.js');
    return computeListenerDeviceId();
};

const hookId = async (path: string | undefined): Promise<string> => {
    process.env.PATH = path;
    vi.resetModules();
    const { listenerDeviceId } = await import('./listener-device-id.js');
    return listenerDeviceId();
};

describe.runIf(process.platform === 'darwin')('the device id does not depend on PATH (macOS)', () => {
    it('is the same for the listener under a PATH without /usr/sbin', async () => {
        const full = await listenerId(realPath);

        expect(await listenerId('/usr/bin:/bin')).toBe(full);
        expect(await listenerId('')).toBe(full);
    });

    it('is the same for the hook-side reader under a PATH without /usr/sbin', async () => {
        const full = await hookId(realPath);

        expect(await hookId('/usr/bin:/bin')).toBe(full);
        expect(await hookId('')).toBe(full);
    });

    it('is the same in the listener and in the hook-side reader', async () => {
        expect(await hookId('/usr/bin:/bin')).toBe(await listenerId('/usr/bin:/bin'));
    });
});
