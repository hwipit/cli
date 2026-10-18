import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName } from './downloads.js';
import { FILE_CHUNK_BYTES, FILE_CHUNK_PREFIX_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES, chunkOf, saveStream } from './file-crypto.js';
import {
    EMPTY_BODY_SHA256,
    LAN_CLOCK_SKEW_MS,
    LAN_HEADERS,
    LAN_PATHS,
    LAN_PING_TRANSFER_ID,
    createBodyHasher,
    createNonceRegistry,
    deriveLanKeys,
    isTimestampFresh,
    openMeta,
    parseLanAuthHeaders,
    signLanReceipt,
    verifyLanMac,
    type LanAuthHeaderFields,
    type LanKeys,
    type NonceRegistry,
} from './lan-auth.js';
import { mkdirExclusiveHandedBack, mkdirHandedBack } from './private-files.js';

/**
 * Local transfer (ADR-0013) — the listener's LAN-facing HTTP server.
 *
 * Binds an OS-assigned port on every interface; the port is what
 * `lan-endpoint.ts` publishes. A remote address may hold only a few of the
 * sockets (`LAN_MAX_CONNECTIONS_PER_IP`), so one address cannot starve the rest. Nothing here is reachable from the internet
 * on purpose (the server only ever stores a private IPv4 for it), but a
 * public Wi-Fi is a LAN too, so every route authenticates before it reads
 * a body, and an unauthenticated peer learns nothing: every refusal it can
 * reach is a 401 with an empty body — the same one, whatever the reason.
 *
 * Two routes:
 *   GET  /hwip/lan/v1/ping    — "are you the device I think, and on my LAN?"
 *                               MAC over an empty body; answers `{deviceId}`.
 *   POST /hwip/lan/v1/upload  — raw ciphertext body, sealed metadata in
 *                               `X-Hwip-Lan-Meta`; decrypted as it streams
 *                               into `<landingDir>/<transferId>/<fileName>`.
 *                               The push record for it arrives over the
 *                               WebSocket afterwards and moves the file to
 *                               the Downloads folder (listener.ts).
 *
 * Order on an upload: header shape → clock → nonce not
 * yet seen → sender on the account → keys → the sealed meta opens. That
 * last step is the pre-body proof: the meta is AES-GCM under a key only
 * the real holder of that device's private key can derive, so a peer that
 * merely knows a registered device id gets no further than 401 either.
 * Only then do the statuses that say anything about this machine appear
 * (409 transfer known, 503 busy, 411/413 length, 400 not wrapped for us),
 * all still before the body. The MAC binds sha256(body), so it is checked
 * when the last byte is in; so is the GCM tag. Either failing removes what
 * was written. The nonce is recorded only once the MAC has verified.
 */

export interface LanReceiverOptions {
    log: (msg: string) => void;
    /** A server error after the bind. The socket is unusable from here;
     *  the caller retracts the endpoint and turns the feature off. */
    onError?: (err: Error) => void;
    deviceId: () => string;
    /** Registered public key (Base64 SPKI) of a device on this account, or null. */
    lookupSenderPublicKey: (deviceId: string) => Promise<string | null>;
    /** ECDH secret between this device and `peerPublicKeyRaw` (crypto.ts `deriveLanSharedSecret`). */
    deriveSharedSecret: (peerPublicKeyRaw: string) => Promise<Buffer>;
    /** Open this device's `deviceKeyMap` slot (crypto.ts `unwrapDeviceKey`). */
    unwrapFileKey: (entryJson: string, senderPublicKeyRaw: string) => Promise<Buffer>;
    /** Where finished transfers wait for their push record: `~/.hwip/attachments/lan`. */
    landingDir: () => string;
    now?: () => number;
    maxBodyBytes?: number;
    /** Bytes free for an unprivileged writer on the volume of `dir`; `statfsSync` unless a test says. */
    freeBytes?: (dir: string) => number;
    maxInFlight?: number;
    /** Open sockets, of any state, the receiver holds at once. */
    maxConnections?: number;
    /** Open sockets one remote address may hold at once. */
    maxConnectionsPerIp?: number;
    nonces?: NonceRegistry;
    /** A body that sends no bytes for this long is dead. */
    idleTimeoutMs?: number;
}

export interface LanReceiver {
    port: number;
    /** Close the socket. Idempotent; resolves once the port is released. */
    stop: () => Promise<void>;
}

/**
 * 16 GiB — a long phone video in 4K fits — and the tag each piece of a file
 * that size sealed in chunks adds. No plan's limit applies here: the bytes
 * never reach the relay, and only a device of this account gets past the MAC.
 * What bounds it is the disk (`freeBytes`). A sender sends a file over the
 * relay's ceiling here only to a listener that lists `LAN_LARGE_CAPABILITY`;
 * one from before it takes 1 GiB.
 */
export const LAN_MAX_FILE_BYTES = 16 * 1024 ** 3;
/** What a listener tells senders when it takes `LAN_MAX_FILE_BYTES` over LAN (`capabilities` on its device record). */
export const LAN_LARGE_CAPABILITY = 'lan-large-v1';
/** Room left on the landing volume after a file, so a transfer never fills the disk to its last byte. */
export const LAN_DISK_RESERVE_BYTES = 1024 ** 3;
export const LAN_MAX_BODY_BYTES = LAN_MAX_FILE_BYTES + (LAN_MAX_FILE_BYTES / FILE_CHUNK_BYTES) * GCM_TAG_BYTES;
export const LAN_MAX_IN_FLIGHT = 2;
/**
 * Beside a landed file, the iv it was sealed under (base64, as the meta gave
 * it). The push record that claims the file comes from the relay; this is what
 * the claim holds it against. A leading dot: no landed file can have this name
 * (`safeFileName` strips them).
 */
export const LAN_LANDED_IV = '.iv';
/** The sockets are the daemon's file descriptors, shared with the relay
 *  WebSocket: a LAN flood may exhaust local transfer (sends fall back to the
 *  relay), never the daemon. */
export const LAN_MAX_CONNECTIONS = 64;
/**
 * Sockets one remote address may hold. The pool above is shared by the whole
 * LAN, and a host that opens 64 sockets and sends nothing holds every slot for
 * the 5 s `headersTimeout` — and reopens them — which locks every real sender
 * out of the LAN path (they fall back to the relay, nothing worse). A real
 * sender needs a ping and at most `LAN_MAX_IN_FLIGHT` uploads, so a handful per
 * address is plenty, and it takes this many remote addresses to fill the pool —
 * a host with several addresses on the subnet counts as several.
 *
 * Not "bind only the published address": the attacker is on the same LAN and
 * reaches that address as well as any other, so a narrower bind removes nothing
 * from this problem — it only hides the port from other interfaces (a VPN, a
 * docker bridge). It also costs: the publisher re-picks the address every
 * minute as the machine changes networks, and the port is what it publishes, so
 * a socket bound to one address would have to be rebound, and republished under
 * a new port, on every move.
 */
export const LAN_MAX_CONNECTIONS_PER_IP = 8;
export const LAN_BODY_IDLE_MS = 60_000;
/** Derived key sets kept; the account has a handful of devices. */
const KEY_CACHE_MAX = 64;
/** After a pre-body refusal, how long the client may keep sending before the socket goes. */
const REFUSE_GRACE_MS = 1_000;

/** One line per refused check per window: anyone on the network can ask. */
const REFUSAL_LOG_WINDOW_MS = 10 * 60_000;

interface LanMeta {
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
    transferId: string;
    /** Present for a file sealed in chunks; `iv` is then the 7-byte prefix. */
    chunk?: number;
}

const asMeta = (parsed: unknown): LanMeta | null => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!isStr(m.fileName) || !isStr(m.iv) || !isStr(m.transferId)) return null;
    if (typeof m.deviceKeyMap !== 'object' || m.deviceKeyMap === null) return null;
    const deviceKeyMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.deviceKeyMap as Record<string, unknown>)) {
        if (typeof v !== 'string') return null;
        deviceKeyMap[k] = v;
    }
    const said = chunkOf(m.chunk);
    if (!said.ok) return null;
    if (Buffer.from(m.iv, 'base64').length !== (said.chunk === undefined ? GCM_IV_BYTES : FILE_CHUNK_PREFIX_BYTES)) return null;
    return {
        fileName: m.fileName,
        fileType: isStr(m.fileType) ? m.fileType : undefined,
        fileSize: typeof m.fileSize === 'number' ? m.fileSize : undefined,
        iv: m.iv,
        deviceKeyMap,
        transferId: m.transferId,
        chunk: said.chunk,
    };
};

const end = (res: ServerResponse, status: number, body?: object): void => {
    res.statusCode = status;
    if (body) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    } else {
        res.end();
    }
};

/**
 * Refuse before the body: answer, then discard what the client is still
 * writing for a short grace; a body still arriving after it takes the
 * socket down. A client mid-write whose bytes stop being read — or whose
 * socket is closed under it, which is what `Connection: close` does —
 * sees a reset, not the 413 it needs to fall back on. The grace bounds
 * what that costs: never the whole gigabyte. A body that finishes inside
 * it leaves the connection usable.
 */
const refuse = (req: IncomingMessage, res: ServerResponse, status: number): void => {
    res.statusCode = status;
    // A refused peer does not get to keep its socket: left alive, one small
    // request per keep-alive window holds a connection slot forever with no
    // reconnect, and the per-address cap would only slow that down. Only when
    // there is no body still arriving — closing under a client mid-write is the
    // reset the grace below exists to avoid. A real sender's refusals (409, 413,
    // 503) carry a body and keep their connection as before.
    if (req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined) {
        res.setHeader('Connection', 'close');
    }
    req.resume();
    res.end(() => {
        if (req.complete) return;
        const timer = setTimeout(() => req.socket.destroy(), REFUSE_GRACE_MS);
        timer.unref();
        const clear = () => clearTimeout(timer);
        req.once('end', clear);
        req.socket.once('close', clear);
    });
};

/**
 * Open-socket count per remote address. `admit` before the socket is used,
 * `release` when it closes; an address with no sockets is forgotten, so the map
 * is as large as the number of hosts connected right now and never larger.
 */
export const createConnectionLimiter = (max: number) => {
    const open = new Map<string, number>();
    return {
        admit: (address: string): boolean => {
            const count = open.get(address) ?? 0;
            if (count >= max) return false;
            open.set(address, count + 1);
            return true;
        },
        release: (address: string): void => {
            const count = open.get(address);
            if (count === undefined) return;
            if (count <= 1) open.delete(address);
            else open.set(address, count - 1);
        },
        tracked: (): number => open.size,
    };
};

export const startLanReceiver = (opts: LanReceiverOptions): Promise<LanReceiver> =>
    new Promise((resolve, reject) => {
        const now = opts.now ?? (() => Date.now());
        const maxBody = opts.maxBodyBytes ?? LAN_MAX_BODY_BYTES;
        const freeBytes = opts.freeBytes ?? ((dir: string): number => {
            const stats = statfsSync(dir);
            return stats.bavail * stats.bsize;
        });
        const maxInFlight = opts.maxInFlight ?? LAN_MAX_IN_FLIGHT;
        const idleMs = opts.idleTimeoutMs ?? LAN_BODY_IDLE_MS;
        const nonces = opts.nonces ?? createNonceRegistry();
        // sender public key → derived keys. The secret is static per pair, and
        // a P-256 derive per request would be the cheapest CPU an outsider
        // who sniffed a device id could buy. With this cache and the device
        // directory's miss brake, the pre-MAC work anyone can buy is a header
        // parse and two map lookups — nothing worth rationing, so there is no
        // request budget for an outsider to drain and lock real senders out.
        const keyCache = new Map<string, LanKeys>();
        let inFlight = 0;
        // Transfer ids with an upload in progress: the 409 must hold from the
        // first byte, not from when the directory appears.
        const active = new Set<string>();

        const keysFor = async (publicKey: string): Promise<LanKeys> => {
            const hit = keyCache.get(publicKey);
            if (hit) return hit;
            const keys = deriveLanKeys(await opts.deriveSharedSecret(publicKey));
            if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value ?? '');
            keyCache.set(publicKey, keys);
            return keys;
        };

        /** Spend a nonce whose MAC held. A refusal here is a replay race or a
         *  sender over its quota — the peer sees the same 401, the log says which. */
        const commitNonce = (sender: string, nonce: string): boolean => {
            if (nonces.commit(sender, nonce, now())) return true;
            opts.log(`local transfer: nonce refused for ${sender} (a replay, or the sender is over its quota)`);
            return false;
        };

        interface Authed { keys: LanKeys; fields: LanAuthHeaderFields; senderPublicKey: string }

        /**
         * The 401 stays one empty answer for the peer; the log says which check
         * failed (C67) — a phone whose clock is off by minutes otherwise never
         * reaches this machine over LAN and nobody can see why. Anyone can
         * trigger these, and every sender id here is the peer's unproven
         * claim, so the limit is per check: one line per check per
         * REFUSAL_LOG_WINDOW_MS, naming the first sender and how many more
         * were refused since.
         */
        const refusalLogged = new Map<string, { at: number; suppressed: number }>();
        const logRefusal = (check: string, detail: string | null, sender: string | null): void => {
            const at = now();
            const last = refusalLogged.get(check);
            if (last && at - last.at < REFUSAL_LOG_WINDOW_MS) {
                last.suppressed++;
                return;
            }
            refusalLogged.set(check, { at, suppressed: 0 });
            // The id is the peer's unauthenticated claim: printable, short.
            const who = sender === null ? 'an unnamed sender' : sender.replace(/[^\w.-]/g, '?').slice(0, 64);
            const more = last?.suppressed ? ` (${last.suppressed} more since the last line)` : '';
            opts.log(`local transfer: refused ${who} — ${detail ?? check} (401)${more}`);
        };

        /**
         * Everything an outsider can reach ends here with one answer: 401,
         * empty. Resolves the sender's keys once the headers are well formed,
         * fresh, unreplayed, and name a device of this account with a key we
         * can derive against; the MAC itself is the caller's, because on an
         * upload it binds a body that has not arrived yet.
         */
        const authenticate = async (req: IncomingMessage, res: ServerResponse): Promise<Authed | null> => {
            const fields = parseLanAuthHeaders(req.headers);
            if (!fields) { logRefusal('malformed auth headers', null, null); refuse(req, res, 401); return null; }
            const sender = fields.senderDeviceId;
            if (!isTimestampFresh(fields.timestamp, now())) {
                const skewS = Math.round((fields.timestamp - now()) / 1000);
                logRefusal('clock', `its clock is ${Math.abs(skewS)} s ${skewS < 0 ? 'behind' : 'ahead of'} this machine's (limit ${LAN_CLOCK_SKEW_MS / 1000} s)`, sender);
                refuse(req, res, 401);
                return null;
            }
            if (nonces.seen(sender, fields.nonce, now())) { logRefusal('a replayed request', null, sender); refuse(req, res, 401); return null; }
            let senderPublicKey: string | null = null;
            try {
                senderPublicKey = await opts.lookupSenderPublicKey(fields.senderDeviceId);
            } catch (err) {
                opts.log(`local transfer: device lookup failed — ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!senderPublicKey) { logRefusal('not a device of this account', null, sender); refuse(req, res, 401); return null; }
            let keys: LanKeys;
            try {
                keys = await keysFor(senderPublicKey);
            } catch {
                logRefusal('its device key does not import', null, sender);
                refuse(req, res, 401);   // a public key that will not import is not a sender we can trust
                return null;
            }
            return { keys, fields, senderPublicKey };
        };

        const ping = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            const auth = await authenticate(req, res);
            if (!auth) return;
            const { keys, fields } = auth;
            const ok = fields.transferId === LAN_PING_TRANSFER_ID
                && verifyLanMac(keys.macKey, { ...fields, method: 'GET', path: LAN_PATHS.ping, bodySha256: EMPTY_BODY_SHA256 }, fields.mac)
                && commitNonce(fields.senderDeviceId, fields.nonce);
            if (!ok) { logRefusal('the ping does not verify', null, fields.senderDeviceId); refuse(req, res, 401); return; }
            res.setHeader(LAN_HEADERS.receipt, signLanReceipt(keys.macKey, fields.mac));
            end(res, 200, { deviceId: opts.deviceId() });
        };

        const upload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            const auth = await authenticate(req, res);
            if (!auth) return;
            const { keys, fields, senderPublicKey } = auth;
            // The sealed meta only opens under the real sender's key: this is
            // where an impersonator with a genuine device id stops, at the
            // same 401 as everyone else.
            const opened = openMeta(keys.metaKey, req.headers[LAN_HEADERS.meta]);
            if (opened === null) { logRefusal('the upload header does not open under its key', null, fields.senderDeviceId); refuse(req, res, 401); return; }

            // From here the peer is a device of this account: the answers may
            // say something about this machine. Still all before the body.
            const meta = asMeta(opened);
            if (!meta || meta.transferId !== fields.transferId) { refuse(req, res, 400); return; }
            if (active.has(meta.transferId)) { refuse(req, res, 409); return; }
            if (inFlight >= maxInFlight) { refuse(req, res, 503); return; }
            inFlight++;
            active.add(meta.transferId);
            const reserved = meta.transferId;
            try {
                const lengthHeader = req.headers['content-length'];
                if (lengthHeader === undefined || req.headers['transfer-encoding'] !== undefined) { refuse(req, res, 411); return; }
                const declared = Number(lengthHeader);
                if (!Number.isInteger(declared) || declared < 0) { refuse(req, res, 400); return; }
                if (declared > maxBody) { refuse(req, res, 413); return; }
                const slot = meta.deviceKeyMap[opts.deviceId()];
                if (!slot) { refuse(req, res, 400); return; }
                const transferDir = join(opts.landingDir(), meta.transferId);
                let rawKey: Buffer;
                try {
                    rawKey = await opts.unwrapFileKey(slot, senderPublicKey);
                } catch {
                    refuse(req, res, 400);   // wrapped, but not for this device's key
                    return;
                }
                try {
                    // The parent on demand (a fresh install has no ~/.hwip/attachments/lan);
                    // the transfer dir itself exclusively, so a second upload is 409.
                    mkdirHandedBack(opts.landingDir());
                    // 507 before a byte is written: the file and the reserve must fit, or the sender goes by the relay.
                    if (freeBytes(opts.landingDir()) < declared + LAN_DISK_RESERVE_BYTES) {
                        opts.log(`local transfer: refused ${declared}B — not enough free disk (507)`);
                        refuse(req, res, 507);
                        return;
                    }
                    mkdirExclusiveHandedBack(transferDir);
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code === 'EEXIST') { refuse(req, res, 409); return; }
                    throw err;
                }

                const hasher = createBodyHasher();
                let received = 0;
                const tee = new Transform({
                    transform(chunk: Buffer, _enc, done) {
                        received += chunk.length;
                        if (received > declared) { done(new Error('body exceeds Content-Length')); return; }
                        hasher.update(chunk);
                        done(null, chunk);
                    },
                });
                // `pipeline`, not `pipe`: a client that drops mid-body must error
                // the tee, or the save waits for bytes that never come and the
                // half-written transfer dir stays until the socket times out.
                void pipeline(req, tee).catch(() => undefined);
                req.setTimeout(idleMs, () => req.destroy(new Error(`no bytes for ${idleMs} ms`)));
                const dest = join(transferDir, safeFileName(meta.fileName));
                try {
                    const saved = await saveStream(tee, () => dest, { rawKey, iv: Buffer.from(meta.iv, 'base64'), chunk: meta.chunk });
                    // Everything is on disk, decrypted and tag-checked; now the
                    // MAC that binds those bytes to this sender and this moment,
                    // and the nonce is spent only for a MAC that held.
                    const bound = { ...fields, method: 'POST', path: LAN_PATHS.upload, bodySha256: hasher.digestHex() };
                    const ok = received === declared
                        && verifyLanMac(keys.macKey, bound, fields.mac)
                        && commitNonce(fields.senderDeviceId, fields.nonce);
                    if (!ok) {
                        rmSync(transferDir, { recursive: true, force: true });
                        logRefusal(received === declared ? 'the upload does not verify' : 'the upload is shorter or longer than declared', null, fields.senderDeviceId);
                        end(res, 401);
                        return;
                    }
                    writeFileSync(join(transferDir, LAN_LANDED_IV), meta.iv, { mode: 0o600 });
                    opts.log(`local transfer: received "${meta.fileName}" (${saved.bytes}B) from ${fields.senderDeviceId} as ${meta.transferId}`);
                    res.setHeader(LAN_HEADERS.receipt, signLanReceipt(keys.macKey, fields.mac));
                    end(res, 201, { transferId: meta.transferId });
                } catch (err) {
                    rmSync(transferDir, { recursive: true, force: true });
                    opts.log(`local transfer: upload ${meta.transferId} failed — ${err instanceof Error ? err.message : String(err)}`);
                    if (!res.headersSent) end(res, 400);
                    else res.destroy();
                }
            } finally {
                inFlight--;
                active.delete(reserved);
            }
        };

        const route = (req: IncomingMessage, res: ServerResponse): void => {
            const url = req.url ?? '';
            const handler = req.method === 'GET' && url === LAN_PATHS.ping ? ping
                : req.method === 'POST' && url === LAN_PATHS.upload ? upload
                : null;
            if (!handler) { refuse(req, res, 404); return; }
            handler(req, res).catch((err: unknown) => {
                opts.log(`local transfer: request failed — ${err instanceof Error ? err.message : String(err)}`);
                if (!res.headersSent) refuse(req, res, 500);
                else res.destroy();
            });
        };

        // A client that opens a socket and never sends headers must not hold
        // it: Node enforces `headersTimeout` only on each connections check
        // (30 s by default), so the check runs every second for the 5 s to be
        // real. The body has no wall-clock budget — a 16 GiB file on Wi-Fi
        // takes what it takes — only the idle timeout set per upload above.
        const server: Server = createServer({ connectionsCheckingInterval: 1_000 }, route);
        server.headersTimeout = 5_000;
        server.requestTimeout = 0;
        server.maxConnections = opts.maxConnections ?? LAN_MAX_CONNECTIONS;
        const perIp = opts.maxConnectionsPerIp ?? LAN_MAX_CONNECTIONS_PER_IP;
        const limiter = createConnectionLimiter(perIp);
        let lastCapLogAt = -Infinity;
        // Before Node's own connection handler, so a socket over its address's
        // cap is destroyed before anything is read from it (Node still sets it up
        // and tears it down on the close that follows). `maxConnections` is
        // checked earlier still, at accept — that one is the global bound.
        server.prependListener('connection', (socket) => {
            // No address means the peer is already gone: nothing to count.
            const address = socket.remoteAddress;
            if (!address) return;
            if (!limiter.admit(address)) {
                socket.destroy();
                // Anyone on the network can cause this line, so one per window.
                const at = now();
                if (at - lastCapLogAt >= REFUSAL_LOG_WINDOW_MS) {
                    lastCapLogAt = at;
                    opts.log(`local transfer: dropped a connection from ${address} — it already holds ${perIp} open connections`);
                }
                return;
            }
            socket.once('close', () => limiter.release(address));
        });
        let listening = false;
        // Stays attached for the server's whole life: an `error` with no
        // listener is an uncaught throw, and this socket must never be the
        // thing that takes the relay-serving daemon down with it.
        server.on('error', (err: Error) => {
            if (!listening) { reject(err); return; }
            opts.log(`local transfer: server error — ${err.message}`);
            opts.onError?.(err);
        });
        server.listen(0, '0.0.0.0', () => {
            listening = true;
            const address = server.address();
            if (typeof address !== 'object' || address === null) {
                // Cannot happen after a TCP listen; if it does, publishing
                // port 0 would only be refused by the server, silently.
                server.close();
                reject(new Error('bound socket reported no address'));
                return;
            }
            const port = address.port;
            opts.log(`local transfer: listening on 0.0.0.0:${port}`);

            let closed: Promise<void> | null = null;
            const stop = (): Promise<void> => {
                if (closed) return closed;
                closed = new Promise<void>((done) => {
                    server.close(() => done());
                    server.closeAllConnections();
                });
                return closed;
            };
            resolve({ port, stop });
        });
    });
