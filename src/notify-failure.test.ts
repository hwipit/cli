import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, HwipError, QuotaExceededError } from './errors.js';
import { HwipHook } from './hwip-hook.js';
import {
    classifyNotifyFailure, clearNotifyFailure, describeNotifyFailure, isTransientNotifyFailure, notifyFailurePath,
    readNotifyFailure, recordNotifyFailure, withNotifyFailureRecord,
} from './notify-failure.js';
import { withTmpStateDir } from './test-state-dir.js';

const stateHome = withTmpStateDir('hwip-notify-failure-');

afterEach(() => {
    vi.unstubAllGlobals();
});

// The plugin's tests read this exact line (plugin tests/fixtures/
// last-notify-failure.json). Changing a key, a kind or the path is a
// cross-repo change: update both, or the plugin silently stops seeing failures.
const CONTRACT_LINE =
    '{"v":1,"at":"2026-10-02T00:00:00.000Z","kind":"auth","status":401,"code":"AUTHENTICATION_ERROR"}\n';

describe('the state file contract', () => {
    it('lives in the shared state dir the plugin reads', () => {
        expect(notifyFailurePath()).toBe(join(stateHome(), 'hwip', 'last-notify-failure.json'));
    });

    it('writes exactly the agreed line, readable only by the user', () => {
        recordNotifyFailure(classifyNotifyFailure(new AuthenticationError()), new Date('2026-10-02T00:00:00Z'));

        expect(readFileSync(notifyFailurePath(), 'utf-8')).toBe(CONTRACT_LINE);
        expect(statSync(notifyFailurePath()).mode & 0o777).toBe(0o600);
    });

    it('carries no message text, so no key or push content can land in it', () => {
        recordNotifyFailure(classifyNotifyFailure(new HwipError('key ak_secret123 rejected', 'X', 400)));

        expect(readFileSync(notifyFailurePath(), 'utf-8')).not.toContain('ak_secret123');
    });

    it('reads back what it wrote, and ignores a version or kind it does not know', () => {
        recordNotifyFailure({ kind: 'network', status: null, code: null }, new Date('2026-10-02T00:00:00Z'));
        expect(readNotifyFailure()).toEqual({
            v: 1, at: '2026-10-02T00:00:00.000Z', kind: 'network', status: null, code: null,
        });

        writeFileSync(notifyFailurePath(), '{"v":2,"at":"x","kind":"auth"}');
        expect(readNotifyFailure()).toBeNull();
        writeFileSync(notifyFailurePath(), '{"v":1,"at":"x","kind":"exploded"}');
        expect(readNotifyFailure()).toBeNull();
        writeFileSync(notifyFailurePath(), 'not json');
        expect(readNotifyFailure()).toBeNull();
    });

    it('never throws when the state dir cannot be written', () => {
        // A file where the directory should be: mkdir and the write both fail.
        mkdirSync(stateHome(), { recursive: true });
        writeFileSync(join(stateHome(), 'hwip'), 'not a dir');

        expect(() => recordNotifyFailure({ kind: 'network', status: null, code: null })).not.toThrow();
    });
});

describe('classifyNotifyFailure', () => {
    it.each([
        ['a rejected key', new AuthenticationError(), { kind: 'auth', status: 401, code: 'AUTHENTICATION_ERROR' }],
        ['a used-up quota', new QuotaExceededError(), { kind: 'quota', status: 403, code: 'QUOTA_EXCEEDED' }],
        ['a 429', new HwipError('slow down', 'RATE_LIMIT_EXCEEDED', 429), { kind: 'rate-limit', status: 429, code: 'RATE_LIMIT_EXCEEDED' }],
        ['a 5xx', new HwipError('boom', 'INTERNAL', 503), { kind: 'server', status: 503, code: 'INTERNAL' }],
        ['another 4xx', new HwipError('bad', 'VALIDATION_ERROR', 400), { kind: 'client', status: 400, code: 'VALIDATION_ERROR' }],
        ['a timeout', new HwipError('late', 'TIMEOUT', 408), { kind: 'timeout', status: null, code: 'TIMEOUT' }],
        // Refused here, before any request: the 400 they carry is no answer of the server's and must not show as one.
        ['no app signed in', new HwipError('no app', 'NO_APP_DEVICE', 400), { kind: 'no-app', status: null, code: 'NO_APP_DEVICE' }],
        ['a push that could not be sealed', new HwipError('not sealed', 'E2E_REQUIRED', 400), { kind: 'unsealed', status: null, code: 'E2E_REQUIRED' }],
        ['no HTTP answer at all', new TypeError('fetch failed'), { kind: 'network', status: null, code: null }],
    ])('%s', (_label, err, expected) => {
        expect(classifyNotifyFailure(err)).toEqual(expected);
    });
});

describe('withNotifyFailureRecord', () => {
    it('records a failed push and still throws it', async () => {
        await expect(withNotifyFailureRecord(() => Promise.reject(new QuotaExceededError()))).rejects.toThrow();

        expect(readNotifyFailure()?.kind).toBe('quota');
    });

    it('deletes the record once a push goes through', async () => {
        recordNotifyFailure({ kind: 'auth', status: 401, code: 'AUTHENTICATION_ERROR' });

        await expect(withNotifyFailureRecord(() => Promise.resolve('ok'))).resolves.toBe('ok');

        expect(existsSync(notifyFailurePath())).toBe(false);
    });

    it('records the real client error for a revoked key', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }), {
                status: 401, headers: { 'content-type': 'application/json' },
            }),
        ));
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.invalid' });

        await expect(withNotifyFailureRecord(() => hook.notify({ title: 't', body: 'b' }))).rejects.toThrow();

        expect(readNotifyFailure()).toMatchObject({ kind: 'auth', status: 401 });
    });

    it('records an account with no app as no-app, not as a server rejection', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
        ));
        const hook = new HwipHook({ apiKey: 'ak_test', baseUrl: 'https://api.invalid' });

        await expect(withNotifyFailureRecord(() => hook.notify({ title: 't', body: 'b' }))).rejects.toThrow();

        expect(readNotifyFailure()).toMatchObject({ kind: 'no-app', status: null, code: 'NO_APP_DEVICE' });
    });
});

// A changed key is no failure and no business of this record: the pin that replaced it writes key-changes.json.
describe('a push that went out', () => {
    it('clears the record', async () => {
        recordNotifyFailure({ kind: 'timeout', status: null, code: 'TIMEOUT' });
        await withNotifyFailureRecord(() => Promise.resolve({ pushId: 'p2' }));
        expect(existsSync(notifyFailurePath())).toBe(false);
    });
});

describe('describeNotifyFailure', () => {
    it('names the cause, the time and the status', () => {
        recordNotifyFailure({ kind: 'auth', status: 401, code: 'AUTHENTICATION_ERROR' }, new Date('2026-10-02T00:00:00Z'));
        const failure = readNotifyFailure();

        expect(failure && describeNotifyFailure(failure)).toBe(
            'last push failed at 2026-10-02T00:00:00.000Z: API key rejected — it may have been revoked; run: hwip login (HTTP 401)',
        );
    });

    it.each([
        ['no-app', 'no app is signed in — sign in to the Hwip app on an iPhone or Android phone'],
        ['unsealed', 'could not encrypt the push, so nothing was sent — run: hwip verify'],
    ] as const)('says what %s means, with no HTTP status, and that it needs the user', (kind, text) => {
        const failure = { v: 1, at: '2026-10-02T00:00:00.000Z', kind, status: null, code: null } as const;

        expect(describeNotifyFailure(failure)).toBe(`last push failed at 2026-10-02T00:00:00.000Z: ${text}`);
        expect(isTransientNotifyFailure(failure)).toBe(false);
    });

    it('clearNotifyFailure is a no-op when nothing is recorded', () => {
        expect(() => clearNotifyFailure()).not.toThrow();
    });
});
