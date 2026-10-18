/** D6: the most file content one session may read in a window. Only a blob's text pages count; a listing carries no content. */
export const FILE_VIEW_WINDOW_BYTES = 32 * 1024 * 1024;
export const FILE_VIEW_WINDOW_MS = 10 * 60_000;

export interface ByteBudget {
    /** Has `key` already read its share in the current window? A request that finds it spent is refused before it reads. */
    spent: (key: string, now?: number) => boolean;
    /** Count `bytes` against `key`. The window opens at the first byte counted after the last one closed. */
    charge: (key: string, bytes: number, now?: number) => void;
}

/**
 * A fixed window per key. Keys are session names a relay can make up, so a window that has run out is
 * dropped whenever any key is looked at — the map holds only sessions that read something recently.
 */
export const createByteBudget = (limitBytes: number, windowMs: number): ByteBudget => {
    const windows = new Map<string, { opened: number; bytes: number }>();
    const prune = (now: number): void => {
        for (const [key, w] of windows) if (now - w.opened >= windowMs) windows.delete(key);
    };
    return {
        spent: (key, now = Date.now()) => {
            prune(now);
            return (windows.get(key)?.bytes ?? 0) >= limitBytes;
        },
        charge: (key, bytes, now = Date.now()) => {
            prune(now);
            // Nothing counted opens no window.
            if (bytes <= 0) return;
            const w = windows.get(key) ?? { opened: now, bytes: 0 };
            w.bytes += bytes;
            windows.set(key, w);
        },
    };
};
