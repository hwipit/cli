/**
 * Local transfer (ADR-0013) — who is allowed to send to this machine.
 *
 * A LAN upload is authenticated against the sender's *registered* public
 * key, and the registry is the account's device list (`GET /devices`).
 * This caches it so a burst of uploads does not become a burst of API
 * calls, and refreshes on a miss — once per `refreshMinMs` — so a device
 * registered a moment ago is accepted without waiting a whole TTL. An
 * unknown id after a fresh fetch is simply not a device of this account.
 */

import { apiFetch, apiUrl } from './api.js';

export interface DeviceDirectoryDeps {
    apiKey: string;
    baseUrl: string;
    log: (msg: string) => void;
    fetchFn?: typeof fetch;
    now?: () => number;
    /** Age after which the next lookup refetches even on a hit. */
    ttlMs?: number;
    /** Shortest interval between two miss-triggered refetches. */
    refreshMinMs?: number;
    timeoutMs?: number;
}

/** What the account's device list says about a device besides its key. */
export interface DeviceInfo {
    deviceId: string;
    type?: string;
    nickname?: string;
    publicKey?: string;
}

export interface DeviceDirectory {
    publicKeyOf: (deviceId: string) => Promise<string | null>;
    /** The devices the account lists, refetched when the cache is stale; the last list fetched (empty before any) when the refetch fails. */
    devices: () => Promise<DeviceInfo[]>;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_REFRESH_MIN_MS = 10_000;

export const createDeviceDirectory = (deps: DeviceDirectoryDeps): DeviceDirectory => {
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? (() => Date.now());
    const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    const refreshMinMs = deps.refreshMinMs ?? DEFAULT_REFRESH_MIN_MS;
    const url = apiUrl(deps.baseUrl, '/devices');

    let keys = new Map<string, string>();
    let infos: DeviceInfo[] = [];
    let fetchedAt = -Infinity;
    /** Last attempt, successful or not — the miss brake counts failures too,
     *  or an unreachable API is hit on every unknown id. */
    let triedAt = -Infinity;
    let inFlight: Promise<void> | null = null;

    const refresh = (): Promise<void> => {
        if (inFlight) return inFlight;
        triedAt = now();
        inFlight = (async () => {
            const res = await apiFetch(fetchFn, url, deps.apiKey, deps.timeoutMs ?? 5_000);
            if (!res.ok) throw new Error(`devices ${res.status}`);
            const json = (await res.json()) as { data?: { deviceId?: unknown; publicKey?: unknown; type?: unknown; nickname?: unknown }[] };
            const next = new Map<string, string>();
            const listed: DeviceInfo[] = [];
            for (const d of json.data ?? []) {
                if (typeof d.deviceId !== 'string') continue;
                const publicKey = typeof d.publicKey === 'string' && d.publicKey.length > 0 ? d.publicKey : undefined;
                if (publicKey) next.set(d.deviceId, publicKey);
                listed.push({
                    deviceId: d.deviceId,
                    ...(typeof d.type === 'string' ? { type: d.type } : {}),
                    ...(typeof d.nickname === 'string' ? { nickname: d.nickname } : {}),
                    ...(publicKey ? { publicKey } : {}),
                });
            }
            keys = next;
            infos = listed;
            fetchedAt = now();
        })().finally(() => { inFlight = null; });
        return inFlight;
    };

    return {
        publicKeyOf: async (deviceId) => {
            const stale = now() - fetchedAt > ttlMs;
            const hit = keys.get(deviceId);
            if (hit && !stale) return hit;
            // Miss or stale: refetch, but a miss alone only once per refreshMinMs —
            // an attacker probing unknown ids must not drive the API.
            if (inFlight) {
                await inFlight.catch(() => undefined);   // logged by the caller that started it
            } else if ((stale || now() - fetchedAt > refreshMinMs) && now() - triedAt > refreshMinMs) {
                try {
                    await refresh();
                } catch (err) {
                    deps.log(`local transfer: device list unavailable — ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return keys.get(deviceId) ?? null;
        },
        devices: async () => {
            if (inFlight) {
                await inFlight.catch(() => undefined);
            } else if (now() - fetchedAt > ttlMs && now() - triedAt > refreshMinMs) {
                try {
                    await refresh();
                } catch (err) {
                    deps.log(`local transfer: device list unavailable — ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return infos;
        },
    };
};
