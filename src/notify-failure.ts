/**
 * The last failed `hwip notify`, kept so a failure is visible after the fact.
 *
 * Every agent hook runs `hwip notify … 2>/dev/null || true`: a hook must never
 * break the session, so the error output is thrown away. A revoked key, a used
 * up quota or a dead network then looked exactly like "quiet mode, nothing to
 * send". `hwip notify` itself writes this file on failure and deletes it on
 * success — the one writer — so the record survives whatever the hook does
 * with stderr. Concurrent hooks race last-writer-wins: a failure that finishes
 * after a newer success stays until the next good push clears it. `hwip verify` and the Claude Code plugin (/hwip-mode, the
 * SessionStart hook) only read it.
 *
 * THE CONTRACT (the plugin reads it with jq and node, so changing it is a
 * cross-repo change — notify-failure.test.ts pins it):
 *
 *   path  ${XDG_STATE_HOME:-~/.local/state}/hwip/last-notify-failure.json
 *         — the same state dir as the mute and push-mode dials (gate.ts
 *         stateDir, plugin hooks/gate.sh HWIP_STATE_DIR)
 *   body  {"v":1,"at":"<ISO 8601 UTC>","kind":"<kind>","status":<int|null>,"code":"<string|null>"}
 *   kind  no-key | auth | quota | rate-limit | client | server | timeout | network | no-app | unsealed
 *
 * `no-app` (NO_APP_DEVICE) and `unsealed` (E2E_REQUIRED) are refusals made here, before the push went out: they
 * carry no HTTP status, so a reader never shows one as the server's answer.
 *
 * A device whose key changed is not recorded here: the pin that replaced it writes
 * key-changes.json (key-changes.ts), which another process's push cannot clear.
 *
 * No message text and nothing from the request: `status` is the HTTP status
 * and `code` the server's error code (e.g. QUOTA_EXCEEDED), so the file can
 * never carry a key, a title or a body.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AuthenticationError, HwipError, QuotaExceededError } from './errors.js';
import { stateDir } from './gate.js';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';

export const NOTIFY_FAILURE_KINDS = [
    'no-key', 'auth', 'quota', 'rate-limit', 'client', 'server', 'timeout', 'network', 'no-app', 'unsealed',
] as const;
export type NotifyFailureKind = typeof NOTIFY_FAILURE_KINDS[number];

export interface NotifyFailure {
    readonly v: 1;
    readonly at: string;
    readonly kind: NotifyFailureKind;
    readonly status: number | null;
    readonly code: string | null;
}

export const notifyFailurePath = (): string => join(stateDir(), 'last-notify-failure.json');

/** What went wrong, in the contract's terms. Anything that is not an HwipError
 *  never got an HTTP answer — fetch rejects on DNS, refused or reset. The code is read before the
 *  status: a refusal made here carries a status (400) the server never sent. */
export const classifyNotifyFailure = (err: unknown): Pick<NotifyFailure, 'kind' | 'status' | 'code'> => {
    if (err instanceof AuthenticationError) return { kind: 'auth', status: err.status, code: err.code };
    if (err instanceof QuotaExceededError) return { kind: 'quota', status: err.status, code: err.code };
    if (err instanceof HwipError) {
        const { status, code } = err;
        if (code === 'NO_APP_DEVICE') return { kind: 'no-app', status: null, code };
        if (code === 'E2E_REQUIRED') return { kind: 'unsealed', status: null, code };
        if (code === 'TIMEOUT') return { kind: 'timeout', status: null, code };
        if (code === 'NETWORK_ERROR') return { kind: 'network', status: null, code: null };
        if (status === 429) return { kind: 'rate-limit', status, code };
        if (status >= 500) return { kind: 'server', status, code };
        return { kind: 'client', status, code };
    }
    return { kind: 'network', status: null, code: null };
};

/** Best effort: a hook must never fail because its failure could not be noted. */
export const recordNotifyFailure = (
    failure: Pick<NotifyFailure, 'kind' | 'status' | 'code'>,
    now: Date = new Date(),
): void => {
    const record: NotifyFailure = { v: 1, at: now.toISOString(), ...failure };
    const path = notifyFailurePath();
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        mkdirHandedBack(stateDir());
        // Temp + rename: a reader never sees half a file.
        writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        handBackToSudoUser(tmp);
        renameSync(tmp, path);
    } catch {
        try { unlinkSync(tmp); } catch { /* never written */ }
    }
};

export const clearNotifyFailure = (): void => {
    try { unlinkSync(notifyFailurePath()); } catch { /* nothing recorded */ }
};

/** Run one push attempt and leave the record matching its outcome. */
export const withNotifyFailureRecord = async <T>(send: () => Promise<T>): Promise<T> => {
    try {
        const result = await send();
        clearNotifyFailure();
        return result;
    } catch (err) {
        recordNotifyFailure(classifyNotifyFailure(err));
        throw err;
    }
};

/** null when there is no record, or one this version cannot read. */
export const readNotifyFailure = (): NotifyFailure | null => {
    try {
        const raw = JSON.parse(readFileSync(notifyFailurePath(), 'utf-8')) as Partial<NotifyFailure>;
        if (raw.v !== 1 || typeof raw.at !== 'string') return null;
        if (!NOTIFY_FAILURE_KINDS.includes(raw.kind as NotifyFailureKind)) return null;
        return {
            v: 1,
            at: raw.at,
            kind: raw.kind as NotifyFailureKind,
            status: typeof raw.status === 'number' ? raw.status : null,
            code: typeof raw.code === 'string' ? raw.code : null,
        };
    } catch {
        return null;
    }
};

const KIND_TEXT: Record<NotifyFailureKind, string> = {
    'no-key': 'no API key — run: hwip install',
    auth: 'API key rejected — it may have been revoked; run: hwip login',
    quota: 'push quota used up',
    'rate-limit': 'rate limited by the server',
    client: 'request rejected by the server',
    server: 'server error',
    timeout: 'request timed out',
    network: 'could not reach the server',
    'no-app': 'no app is signed in — sign in to the Hwip app on an iPhone or Android phone',
    unsealed: 'could not encrypt the push, so nothing was sent — run: hwip verify',
};

/** One line for a person: what, when, and the HTTP status when there was one. */
export const describeNotifyFailure = (f: NotifyFailure): string =>
    `last push failed at ${f.at}: ${KIND_TEXT[f.kind]}${f.status === null ? '' : ` (HTTP ${f.status})`}`;

/** Transient kinds clear themselves on the next good push; the rest need the user. */
export const isTransientNotifyFailure = (f: NotifyFailure): boolean =>
    f.kind === 'timeout' || f.kind === 'network' || f.kind === 'server' || f.kind === 'rate-limit';
