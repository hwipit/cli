/**
 * This computer's own key in the account's device list, put there when it is missing.
 *
 * Every push, question and command is sealed (F16), and the app seals its answer for the computer that asked by the key
 * the device list holds for it. The listener puts that key there over its socket; a computer that only runs `hwip ask`,
 * `hwip agent send` or `hwip notify` used to stay off the list, and every question it asked was refused. Each of
 * those now checks the list it already read: listed under this key, nothing is sent; missing or under another key, one
 * keyed `PUT /devices/{id}/public-key` (server SERVER-API.md), and the list it goes on with holds the new entry —
 * no second `GET /devices`.
 *
 * The server lets only a `push:read` API key replace a key already listed; another key gets 403 and the old key stays.
 */

import { hostname } from 'node:os';
import { apiFetch, apiUrl } from './api.js';
import { samePublicKey } from './crypto.js';

export interface SelfKey {
    deviceId: string;
    publicKey: string;
}

/** Why the key is not on the list: the server's status, no answer, or 403 on replacing a key the list already holds. */
export type RegisterWhy = `http ${number}` | 'network' | 'timeout' | 'replace-forbidden';

/** Put this computer's key on the list: `null` once the server took it. */
export type Register = (self: SelfKey) => Promise<RegisterWhy | null>;

export type SelfListing<D> = { ok: true; devices: D[] } | { ok: false; why: RegisterWhy };

const REGISTER_TIMEOUT_MS = 10_000;

/** The name a new device record gets: the one the listener connects under. The server keeps an existing record's name. */
const nickname = (): string => hostname() || 'listener';

/** The keyed `PUT`, never following a redirect (`apiFetch`). `fetchFn` is read per call, so a stub set later applies. */
export const registerOverApi = (account: { apiKey: string; baseUrl: string }, fetchFn?: typeof fetch): Register => async (self) => {
    let res: Response;
    try {
        res = await apiFetch(fetchFn ?? fetch, apiUrl(account.baseUrl, `/devices/${encodeURIComponent(self.deviceId)}/public-key`), account.apiKey, REGISTER_TIMEOUT_MS, {
            method: 'PUT',
            body: JSON.stringify({ publicKey: self.publicKey, nickname: nickname() }),
        });
    } catch (err) {
        return err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    try { await res.arrayBuffer(); } catch { /* the answer's body is not needed */ }
    return res.ok ? null : `http ${res.status}`;
};

/**
 * `devices` with this computer listed under `self.publicKey`: as given when it already is, else after one `register`.
 * The entry it adds is what the server made of it (`type: 'cli'`); one it replaces keeps every other field.
 */
export const ensureSelfListed = async <D extends { deviceId: string; publicKey?: string }>(
    devices: D[],
    self: SelfKey,
    register: Register,
): Promise<SelfListing<D>> => {
    const listed = devices.find((d) => d.deviceId === self.deviceId);
    if (listed?.publicKey && samePublicKey(listed.publicKey, self.publicKey)) return { ok: true, devices };
    const why = await register(self);
    if (why !== null) return { ok: false, why: why === 'http 403' && listed?.publicKey ? 'replace-forbidden' : why };
    if (listed) return { ok: true, devices: devices.map((d) => (d === listed ? { ...d, publicKey: self.publicKey } : d)) };
    // The server answers with the record; the list only needs what it is read for: an id, a key and a kind.
    return { ok: true, devices: [...devices, { deviceId: self.deviceId, publicKey: self.publicKey, type: 'cli' } as unknown as D] };
};

/** `why` for a person, inside parentheses. */
export const registerWhyText = (why: RegisterWhy): string =>
    why === 'replace-forbidden'
        ? 'the account lists another key for it, and only an API key with push:read may replace it'
        : why === 'network' ? 'could not reach the server'
            : why === 'timeout' ? 'the server did not answer in time'
                : `the server answered HTTP ${why.slice(5)}`;

/** The refusal of a question or a command whose sender is not on the list: `what` was not sent. */
export const unregisteredText = (what: string, why?: RegisterWhy): string =>
    `could not register this machine's key in the account's device list${why ? ` (${registerWhyText(why)})` : ''}; the ${what} was not sent`;
