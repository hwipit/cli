import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAsk, liveDeps, parseActions, pollIntervalMs, remoteTransition, requestApproval, type AskDeps, type AskOutcome } from './ask.js';
import { pendingAsks, type PendingAsk, type PendingAsks } from './ask-pending.js';
import { refusalMessage } from './ask-seal.js';
import { TRUST_FILE } from './config.js';
import { isRemoteActive, touchRemoteActive } from './gate.js';

// handleAsk reads the saved login for its base URL; keep the developer's
// ~/.hwip/config.json out of the tests.
vi.mock('./config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./config.js')>()),
    loadConfig: () => ({}),
    // The seal reads the trust file; keep the developer's own out of the tests.
    TRUST_FILE: '/nonexistent/hwip-test/trusted-devices.json',
}));

// The seal itself is ask-seal.test.ts; here only what `requestApproval` does with its verdicts.
const sealMock = vi.hoisted(() => ({ prepareAsk: vi.fn(), openAnswer: vi.fn() }));
vi.mock('./ask-seal.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./ask-seal.js')>();
    // Unscripted, both do what they really do (`handleAsk` tests go through the real seal).
    sealMock.prepareAsk.mockImplementation(actual.prepareAsk);
    sealMock.openAnswer.mockImplementation(actual.openAnswer);
    return { ...actual, prepareAsk: sealMock.prepareAsk, openAnswer: sealMock.openAnswer };
});

const OPTS = {
    apiKey: 'k',
    baseUrl: 'https://api.example/v1',
    hookId: 'hook_1',
    title: 'Run rm -rf ./dist?',
    timeoutSeconds: 30,
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
};

/** A fetch stub that answers trigger once, then walks a scripted poll list. */
const stubFetch = (pollBodies: unknown[]) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let poll = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/trigger')) {
            return { ok: true, status: 200, json: async () => ({ data: { eventId: 'evt_1' } }) } as unknown as Response;
        }
        const body = pollBodies[Math.min(poll, pollBodies.length - 1)];
        poll += 1;
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
};

const SEALED = { kind: 'sealed', askId: 'ASK', fields: { body: '{"ciphertext":"c","iv":"i"}', senderPublicKey: 'SENDER', deviceKeyMap: { dev_phone: 'k' } }, offered: undefined } as const;

/**
 * `handleAsk` always seals: the seal itself is ask-seal.test.ts, so these tests have it say the question was sealed and
 * the answer opened as `response` says. The server's side is `stubFetch`'s: the question answered, status `responded`.
 */
const answeredBy = (response: { actionId?: string; value?: string; exitRemote?: boolean }) => {
    sealMock.prepareAsk.mockResolvedValue(SEALED);
    sealMock.openAnswer.mockResolvedValue({
        ok: true,
        ...(response.actionId ? { actionId: response.actionId } : {}),
        ...(response.value ? { value: response.value } : {}),
        ...(response.exitRemote ? { exit: true } : {}),
    });
};
/** For the poll loop's own tests: the question seals, and a responded one opens to what its response says. */
const opensAsWritten = (): void => {
    sealMock.prepareAsk.mockResolvedValue(SEALED);
    sealMock.openAnswer.mockImplementation(async (response?: { actionId?: string; value?: string; exitRemote?: boolean }) => ({
        ok: true, actionId: response?.actionId, value: response?.value, ...(response?.exitRemote ? { exit: true } : {}),
    }));
};
const resetSeal = async (): Promise<void> => {
    const actual = await vi.importActual<typeof import('./ask-seal.js')>('./ask-seal.js');
    sealMock.prepareAsk.mockReset().mockImplementation(actual.prepareAsk);
    sealMock.openAnswer.mockReset().mockImplementation(actual.openAnswer);
};

const deps = (fetchFn: typeof fetch, clock = { t: 0 }): AskDeps => ({
    fetchFn,
    now: () => clock.t,
    // Time only moves when the code waits, so a poll loop cannot spin forever
    // in a test and a timeout is reached deterministically rather than by
    // wall-clock luck.
    sleep: async (ms: number) => { clock.t += ms; },
    // The seal itself is mocked above; each suite scripts what it says.
    seal: {} as never,
});

const json = (status: number, body: object): Response => new Response(JSON.stringify(body), { status });
/** What `fetch` throws when nothing listens there: the request was never sent. */
const REFUSED = (): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED', syscall: 'connect' }) });
/** A socket error as `fetch` hands it over: the errno and the call that met it. */
const socketFailure = (code: string, syscall: string): TypeError =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }) });
/** What an error says after a trigger that failed and may have landed. */
const MAY_BE_UP = 'the question may have gone up all the same';
/** An event nobody has answered yet. */
const PENDING = { status: 'pending' };

describe('parseActions', () => {
    it('reads id:Label pairs', () => {
        expect(parseActions('approve:Approve,deny:Deny')).toEqual([
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
        ]);
    });

    it('uses the id as the label when only an id is given', () => {
        expect(parseActions('ok')).toEqual([{ id: 'ok', label: 'ok' }]);
    });

    it('keeps colons inside a label', () => {
        expect(parseActions('go:Deploy: prod')).toEqual([{ id: 'go', label: 'Deploy: prod' }]);
    });

    it('drops empty segments rather than sending a blank button', () => {
        expect(parseActions('a:A,,b:B,')).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    });

    it('returns an empty list for an empty spec', () => {
        expect(parseActions('')).toEqual([]);
        expect(parseActions(undefined)).toEqual([]);
    });
});

describe('requestApproval with a sealed question', () => {
    const FIELDS = { body: '{"ciphertext":"c","iv":"i"}', senderPublicKey: 'SENDER', deviceKeyMap: { dev_phone: 'k' } };
    const ready = () => sealMock.prepareAsk.mockResolvedValue({ kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['approve', 'deny'] });

    afterEach(resetSeal);

    it('sends the envelope and the choices\' ids, and nothing of the wording', async () => {
        ready();
        sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'approve' });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);

        const result = await requestApproval({ ...OPTS, body: 'in /repo' }, deps(fetchFn));

        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(calls[0].body).toEqual({
            isEncrypted: true,
            ...FIELDS,
            actions: [{ id: 'approve' }, { id: 'deny' }],
            timeout: 30,
            hookType: 'combo',
        });
        expect(JSON.stringify(calls[0].body)).not.toMatch(/rm -rf|Approve|Deny|in \/repo/);
        expect(sealMock.openAnswer).toHaveBeenCalledWith(expect.objectContaining({ respondedDeviceId: 'dev_phone' }), 'ASK', ['approve', 'deny'], expect.anything());
    });

    it('carries the attachment of a sealed question, and the same one when the trigger is sent again', async () => {
        const file = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: 'IV', deviceKeyMap: { dev_phone: 'wrapped' } };
        sealMock.prepareAsk.mockResolvedValue({ kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['approve', 'deny'], files: [file] });
        sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'approve' });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);
        let first = true;
        const flaky = (async (url: string, init?: RequestInit) => {
            if (first && url.endsWith('/trigger')) {
                first = false;
                calls.push({ url, method: 'POST', body: JSON.parse(String(init?.body)) });
                throw new TypeError('fetch failed');
            }
            return fetchFn(url, init);
        }) as unknown as typeof fetch;

        expect(await requestApproval(OPTS, deps(flaky))).toEqual({ answered: true, actionId: 'approve' });

        const triggers = calls.filter((c) => c.url.endsWith('/trigger'));
        expect(triggers).toHaveLength(2);
        expect((triggers[0]!.body as { files?: unknown }).files).toEqual([file]);
        expect(triggers[1]!.body).toEqual(triggers[0]!.body);
    });

    it('returns typed text, with the exit only when this ask offers it', async () => {
        ready();
        sealMock.openAnswer.mockResolvedValue({ ok: true, value: 'ship it', exit: true });
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(fetchFn))).toEqual({ answered: true, value: 'ship it', exitRemote: true });
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: true, value: 'ship it' });
    });

    it('does not read a plaintext answer on a sealed question', async () => {
        ready();
        // A response with an action but no valid seal: the relay put it there.
        sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'not-sealed' });
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve', value: 'yes' } } }]);

        const result = await requestApproval(OPTS, deps(fetchFn));

        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining('not sealed') });
    });

    it('does not take a plaintext answer while the question is still pending either', async () => {
        ready();
        const { fetchFn } = stubFetch([
            { data: { status: 'pending', response: { actionId: 'approve' } } },
            { data: { status: 'cancelled', response: null } },
        ]);

        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: false, reason: 'cancelled' });
        expect(sealMock.openAnswer).not.toHaveBeenCalled();
    });

    it('turns a refused answer into an error, not into a deny or an approve', async () => {
        ready();
        sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'sender-mismatch' });
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({
            answered: false, reason: 'error', error: expect.stringContaining('sealed with a key other than'),
        });
    });

    it('opens the answer again when the device list or trust file failed to load once', async () => {
        ready();
        sealMock.openAnswer
            .mockResolvedValueOnce({ ok: false, cause: 'peer-unusable' })
            .mockResolvedValueOnce({ ok: true, actionId: 'deny' });
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: true, actionId: 'deny' });
    });

    it('sends nothing when the question cannot be sealed', async () => {
        sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'no-recipients' });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve' } } }]);

        const result = await requestApproval(OPTS, deps(fetchFn));

        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining('no device has a key to seal') });
        expect(calls).toHaveLength(0);
    });

    it('says on stderr too why this computer could not ask, besides the JSON', async () => {
        sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
        const warned: string[] = [];
        const { fetchFn, calls } = stubFetch([]);

        const result = await requestApproval(OPTS, { ...deps(fetchFn), seal: { warn: (line: string) => warned.push(line) } as never });

        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining('only an API key with push:read may replace it') });
        expect(warned).toEqual([(result as { error: string }).error]);
        expect(calls).toHaveLength(0);
    });

    it('keeps other refusals to the JSON', async () => {
        sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'no-recipients' });
        const warned: string[] = [];
        const { fetchFn } = stubFetch([]);

        await requestApproval(OPTS, { ...deps(fetchFn), seal: { warn: (line: string) => warned.push(line) } as never });

        expect(warned).toEqual([]);
    });

    it('sends nothing, and nothing in the clear, without a seal to ask with', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve' } } }]);

        // @ts-expect-error — `seal` is required: there is no plain question to fall back to.
        const result = await requestApproval(OPTS, { fetchFn, now: () => 0, sleep: async () => undefined });

        expect(result).toMatchObject({ answered: false, reason: 'error' });
        expect(calls).toHaveLength(0);
    });

    it('sends nothing when the lookups used up the whole window', async () => {
        const clock = { t: 0 };
        // The lookups before the send have limits of their own, not the deadline's.
        sealMock.prepareAsk.mockImplementation(async () => { clock.t = OPTS.timeoutSeconds * 1000; return { kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['approve', 'deny'] }; });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve' } } }]);

        const result = await requestApproval(OPTS, deps(fetchFn, clock));

        expect(result).toEqual({ answered: false, reason: 'timeout' });
        expect(calls).toHaveLength(0);
    });

    it('still sends when the lookups left some of the window', async () => {
        const clock = { t: 0 };
        sealMock.prepareAsk.mockImplementation(async () => { clock.t = OPTS.timeoutSeconds * 1000 - 1; return { kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['approve', 'deny'] }; });
        sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'approve' });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { sealed: FIELDS, respondedDeviceId: 'dev_phone' } } }]);

        expect(await requestApproval(OPTS, deps(fetchFn, clock))).toEqual({ answered: true, actionId: 'approve' });
        expect(calls[0].url).toMatch(/\/trigger$/);
    });
});

describe('requestApproval', () => {
    beforeEach(opensAsWritten);
    afterEach(resetSeal);

    it('returns the tapped action', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve' } } }]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(calls[0].url).toBe('https://api.example/v1/hooks/hook_1/trigger');
        expect(calls[0].method).toBe('POST');
    });

    it('returns free text when the user typed instead of tapping', async () => {
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { value: 'not now' } } }]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, value: 'not now' });
    });

    it('keeps polling until an answer arrives', async () => {
        const { fetchFn, calls } = stubFetch([
            { data: { response: null } },
            { data: { response: null } },
            { data: { status: 'responded', response: { actionId: 'deny' } } },
        ]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'deny' });
        // 1 trigger + 3 polls
        expect(calls).toHaveLength(4);
    });

    it('gives up at the deadline instead of polling forever', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { response: null } }]);
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 5 }, deps(fetchFn));
        expect(result).toEqual({ answered: false, reason: 'timeout' });
        // The exact count depends on the interval; what matters is that it stopped.
        expect(calls.length).toBeLessThan(20);
    });

    it('reports a transport failure as unanswered rather than throwing', async () => {
        // A hook calling this needs one shape back, always: an approval gate
        // that throws is an approval gate that stops being a gate.
        const fetchFn = (async () => { throw REFUSED(); }) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: false, reason: 'error', error: 'could not reach api.example (ECONNREFUSED) — check the network' });
    });

    it('reports an API error as unanswered', async () => {
        const fetchFn = (async () => ({
            ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }),
        })) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        // C13: a rejected key says what to do about it.
        expect(result).toEqual({ answered: false, reason: 'error', error: 'bad key — run `hwip login`, or check --key / HWIP_API_KEY' });
    });

    /** A trigger that fails as scripted, try by try, then is taken (answered `taken`); every poll reads `poll`, by default an answer. */
    const scriptedTrigger = (
        failures: Array<(() => Response) | undefined>,
        script: { always?: () => Response; taken?: object; poll?: object } = {},
    ) => {
        const sent: Array<{ key: string | undefined; body: string }> = [];
        const polled: string[] = [];
        const fetchFn: typeof fetch = async (input, init) => {
            const url = String(input);
            if (!url.endsWith('/trigger')) {
                polled.push(url);
                return json(200, { data: script.poll ?? { status: 'responded', response: { actionId: 'approve' } } });
            }
            sent.push({ key: new Headers(init?.headers).get('Idempotency-Key') ?? undefined, body: String(init?.body) });
            const fail = script.always ?? failures[sent.length - 1];
            return fail ? fail() : json(201, { data: script.taken ?? { eventId: 'e' } });
        };
        return { fetchFn, sent, polled };
    };
    const refusal = (status: number, code?: string) => () => json(status, { error: { code, message: `refused ${status}` } });
    const IN_PROGRESS = refusal(409, 'IDEMPOTENCY_IN_PROGRESS');

    it('sends the trigger under an Idempotency-Key the server takes', async () => {
        const { fetchFn, sent } = scriptedTrigger([]);
        await requestApproval(OPTS, deps(fetchFn));
        // hwip server/src/lib/idempotency.ts IDEMPOTENCY_KEY_PATTERN (read 2026-10-14): anything else is a 400.
        expect(sent[0].key).toMatch(/^[\x21-\x7e]{1,128}$/);
    });

    it('sends a new key for each question', async () => {
        const first = scriptedTrigger([]);
        const second = scriptedTrigger([]);
        await requestApproval(OPTS, deps(first.fetchFn));
        await requestApproval(OPTS, deps(second.fetchFn));
        expect(second.sent[0].key).not.toBe(first.sent[0].key);
    });

    describe('how long one request is waited on', () => {
        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        /** One clock for the ask and for its requests: the window runs down while a request is waited on, as it does outside a test. */
        const timed = (fetchFn: typeof fetch): AskDeps => ({
            ...deps(fetchFn),
            now: () => Date.now(),
            sleep: (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        });
        /**
         * A server that does not answer, but for what `answer` says: each request left unanswered ends when
         * its own timer does. `ended` holds how long each of those was waited on.
         */
        const silent = (answer: (url: string, nth: number) => Response | undefined = () => undefined) => {
            const ended: number[] = [];
            let requests = 0;
            const fetchFn: typeof fetch = (input, init) => new Promise((resolve, reject) => {
                const reply = answer(String(input), requests += 1);
                if (reply) return resolve(reply);
                const started = Date.now();
                init?.signal?.addEventListener('abort', () => {
                    ended.push(Date.now() - started);
                    reject(new DOMException('This operation was aborted', 'AbortError'));
                });
            });
            return { fetchFn, ended };
        };
        /** Run the ask to its end, the timers of its requests and its pauses firing as they come due. */
        const settle = async (ask: Promise<AskOutcome>): Promise<AskOutcome> => {
            await vi.advanceTimersByTimeAsync(120_000);
            return ask;
        };

        // A question that goes up after the window has closed sits on the phone with nobody waiting for its answer.
        it('gives a try at sending no longer than what is left of the window', async () => {
            const { fetchFn, ended } = silent();
            const result = await settle(requestApproval({ ...OPTS, timeoutSeconds: 3 }, timed(fetchFn)));
            // The one try takes the whole window: the pause before another would start past its end.
            expect(ended).toEqual([3_000]);
            expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining(MAY_BE_UP) });
        });

        it('still gives a try a second when less is left', async () => {
            // Refused at once, then silence: the 1 s pause leaves half a second of a 1.5 s window.
            const { fetchFn, ended } = silent((_, nth) => (nth === 1 ? json(503, { error: { message: 'refused 503' } }) : undefined));
            await settle(requestApproval({ ...OPTS, timeoutSeconds: 1.5 }, timed(fetchFn)));
            expect(ended).toEqual([1_000]);
        });

        it('gives a try its usual ten seconds when the window is longer', async () => {
            const { fetchFn, ended } = silent();
            await settle(requestApproval({ ...OPTS, timeoutSeconds: 300 }, timed(fetchFn)));
            expect(ended).toEqual([10_000, 10_000, 10_000, 10_000]);
        });

        // Late is all a read can be, and the answer may be there: cut short, an answer the user gave is one nobody reads.
        it('gives a read of the answer its ten seconds, whatever is left of the window', async () => {
            const { fetchFn, ended } = silent((url) => (url.endsWith('/trigger') ? json(201, { data: { eventId: 'evt_1' } }) : undefined));
            const result = await settle(requestApproval({ ...OPTS, timeoutSeconds: 4 }, timed(fetchFn)));
            expect(ended).toEqual([10_000]);
            expect(result).toMatchObject({ answered: false, reason: 'error' });
        });
    });

    it('sends the trigger again after a failure that may pass, under the same key and with the same bytes', async () => {
        for (const fail of [
            () => { throw new TypeError('fetch failed'); },
            () => { throw new DOMException('This operation was aborted', 'AbortError'); },
            () => new Response('<html>', { status: 200 }),
            refusal(500), refusal(504), refusal(408), refusal(429),
        ]) {
            const { fetchFn, sent } = scriptedTrigger([fail]);
            const result = await requestApproval(OPTS, deps(fetchFn));
            expect(result).toEqual({ answered: true, actionId: 'approve' });
            expect(sent).toHaveLength(2);
            // The server replays only a retry whose body is the first one's, byte for byte; another body under the key is a 422.
            expect(sent[1]).toEqual(sent[0]);
        }
    });

    it('does not send again a trigger the server refused', async () => {
        for (const fail of [
            refusal(400), refusal(401), refusal(403), refusal(404),
            refusal(422, 'IDEMPOTENCY_KEY_REUSED'),
            refusal(409, 'EVENT_NOT_PENDING'),
            () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); },
            // An address that is not one stays not one: nothing went out, and nothing will.
            () => { throw new TypeError('Failed to parse URL from https://api.example/v1', { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) }); },
        ]) {
            const { fetchFn, sent } = scriptedTrigger([], { always: fail });
            const result = await requestApproval(OPTS, deps(fetchFn));
            expect(result).toMatchObject({ answered: false, error: expect.not.stringContaining(MAY_BE_UP) });
            expect(sent).toHaveLength(1);
        }
    });

    // A 5xx can follow a request the server took (a gateway that gave up on it): whoever reads the error is not left to ask again blind.
    it('gives up after four tries, saying the question may be up all the same', async () => {
        const clock = { t: 0 };
        const { fetchFn, sent } = scriptedTrigger([], { always: refusal(503) });
        const result = await requestApproval(OPTS, deps(fetchFn, clock));
        expect(result).toEqual({ answered: false, reason: 'error', error: `refused 503 — ${MAY_BE_UP}` });
        expect(sent).toHaveLength(4);
        expect(clock.t).toBe(1_000 + 2_000 + 4_000);
    });

    // What the last try says is not all there is to say: the first one may have landed.
    it.each<[string, () => Response]>([
        ['the server was slow to answer', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }],
        // What `fetch` throws when the server took the request and dropped the socket, and when a 2xx stops mid-body: a TypeError as well.
        ['the connection was reset after the request', () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); }],
        ['the answer stopped mid-body', () => new Response(new ReadableStream({ start: (stream) => stream.error(new TypeError('terminated')) }), { status: 201 })],
        // The same errno as a route that was never there, met by a socket that had one: the request was written.
        ['the route went away after the request was written', () => { throw socketFailure('EHOSTUNREACH', 'write'); }],
        ['the network went away before the answer was read', () => { throw socketFailure('ENETUNREACH', 'read'); }],
    ])('says the question may be up when only an earlier try can have landed: %s', async (_, first) => {
        const down = () => { throw REFUSED(); };
        const { fetchFn } = scriptedTrigger([first, down, down, down]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining(MAY_BE_UP) });
    });

    it('says the question may be up when a refusal follows a try that can have landed', async () => {
        const { fetchFn, sent } = scriptedTrigger([refusal(503), refusal(401)]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringContaining(MAY_BE_UP) });
        expect(sent).toHaveLength(2);
    });

    it.each<[string, () => Response]>([
        ['there was no connection', () => { throw REFUSED(); }],
        ['there was no route to connect by', () => { throw socketFailure('EHOSTUNREACH', 'connect'); }],
        ['the name did not resolve', () => { throw socketFailure('ENOTFOUND', 'getaddrinfo'); }],
        ['the server said too many', refusal(429)],
    ])('keeps the plain error when no try can have landed: %s', async (_, fail) => {
        const { fetchFn, sent } = scriptedTrigger([], { always: fail });
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.not.stringContaining(MAY_BE_UP) });
        expect(sent).toHaveLength(4);
    });

    it('does not send again when the question would be over before the wait is', async () => {
        const { fetchFn, sent } = scriptedTrigger([], { always: refusal(503) });
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 3 }, deps(fetchFn));
        expect(result.answered).toBe(false);
        // 0 s, then 1 s; the third would go at 3 s, which is the deadline.
        expect(sent).toHaveLength(2);
    });

    it('waits out a first request still running under the key, however many tries that takes', async () => {
        // A Lambda that timed out holds the key for 30 s (hwip server/src/entities/idempotency.ts STALE_CLAIM_MS, read 2026-10-14).
        const { fetchFn, sent } = scriptedTrigger(Array<() => Response>(7).fill(IN_PROGRESS));
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 120 }, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(sent).toHaveLength(8);
        expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    });

    it('stops waiting for a running request after seven more tries, 35 s from when the server first said so', async () => {
        const clock = { t: 0 };
        // The first try fails on its own and is repeated at 1 s: the hold is counted from the 409 that try got, not from the first send.
        const { fetchFn, sent } = scriptedTrigger([refusal(503), ...Array<() => Response>(20).fill(IN_PROGRESS)]);
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 300 }, deps(fetchFn, clock));
        expect(result).toEqual({ answered: false, reason: 'error', error: `refused 409 — ${MAY_BE_UP}` });
        // 0 s, 1 s, then every 5 s up to 36 s.
        expect(sent).toHaveLength(9);
        expect(clock.t).toBe(36_000);
    });

    it('stops waiting for a running request at the deadline when that comes first', async () => {
        const { fetchFn, sent } = scriptedTrigger([], { always: IN_PROGRESS });
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 12 }, deps(fetchFn));
        expect(result.answered).toBe(false);
        // 0 s, 5 s, 10 s; 15 s is past the deadline.
        expect(sent).toHaveLength(3);
    });

    it('keeps the tries after a running request apart from the tries after a failure', async () => {
        const { fetchFn, sent } = scriptedTrigger([refusal(503), IN_PROGRESS, IN_PROGRESS, refusal(503), refusal(503)]);
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 120 }, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(sent).toHaveLength(6);
    });

    describe('a question that went up on a retry', () => {
        const UNCONFIRMED = 'the question went up on a retry, and the server did not say the phone was notified: it is in the app either way';
        const asked = async (script: Parameters<typeof scriptedTrigger>[1], failures: Array<() => Response> = [refusal(503)]) => {
            const warn = vi.fn();
            const { fetchFn } = scriptedTrigger(failures, script);
            const d = deps(fetchFn);
            d.seal = { ...d.seal, warn };
            return { warn, result: await requestApproval({ ...OPTS, timeoutSeconds: 5 }, d) };
        };

        // A repeat the server had already taken is answered with the question's ids alone (hwip server/src/functions/hooks.ts,
        // `once.replayed`, read 2026-10-14): the push went out with the first request or not at all, and only that answer said which.
        it('says so, and why the wait may be for nobody, when the answer does not say the phone was notified', async () => {
            const { warn, result } = await asked({ taken: { eventId: 'e' }, poll: PENDING });
            expect(warn).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED);
            expect(result).toEqual({ answered: false, reason: 'timeout', error: UNCONFIRMED });
        });

        it('says so when the server reports the question timed out, too', async () => {
            const { result } = await asked({ taken: { eventId: 'e' }, poll: { status: 'timed_out' } });
            expect(result).toEqual({ answered: false, reason: 'timeout', error: UNCONFIRMED });
        });

        it('says the same of an answer that says the phone was not notified', async () => {
            const { warn } = await asked({ taken: { eventId: 'e', notified: false }, poll: PENDING });
            expect(warn).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED);
        });

        it('says nothing when the answer says the phone was notified', async () => {
            const { warn, result } = await asked({ taken: { eventId: 'e', notified: true }, poll: PENDING });
            expect(warn).not.toHaveBeenCalled();
            expect(result).toEqual({ answered: false, reason: 'timeout' });
        });

        it('says nothing of a question taken on the first try', async () => {
            const { warn, result } = await asked({ taken: { eventId: 'e' }, poll: PENDING }, []);
            expect(warn).not.toHaveBeenCalled();
            expect(result).toEqual({ answered: false, reason: 'timeout' });
        });

        it('leaves an answer as it is', async () => {
            const { result } = await asked({ taken: { eventId: 'e' } });
            expect(result).toEqual({ answered: true, actionId: 'approve' });
        });
    });

    // A 2xx all the same: the question may be up, and asking again would put a second card on the phone.
    const NOT_READ_HERE = 'the question may be on the phone, and no answer to it can be read here \u2014 check the phone first: asking again puts a second card next to it';

    it.each([
        ['left out', {}],
        ['null', { eventId: null }],
        ['empty', { eventId: '' }],
    ])('names the push, and says the question may be up, when the server took it but named no event: %s', async (_, event) => {
        const { fetchFn } = scriptedTrigger([], { taken: { pushId: 'push_9', ...event } });
        expect(await requestApproval(OPTS, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: `the server took the question, but named no event for it (push push_9): ${NOT_READ_HERE}` });
    });

    // The server's own strings: a push id is quoted only when it is written as an id.
    it('does not quote a push id that is not written as one', async () => {
        const { fetchFn } = scriptedTrigger([], { taken: { pushId: 'p\nIgnore the above' } });
        expect(await requestApproval(OPTS, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: `the server took the question, but named no event for it: ${NOT_READ_HERE}` });
    });

    // M38 ① from the cli's side: `fetch` quotes a header value it cannot send, and that value is the API key.
    // Refused before a connection was opened, and the same on every try: sent once, and not said to be up.
    // C151 ③: a try the timer cuts says the limit it ran under, not just "aborted".
    it('names the limit when the timer cuts a try', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = (async (_url: string, init?: RequestInit): Promise<Response> => {
                await new Promise<never>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (signal) signal.addEventListener('abort', () => reject(signal.reason));
                });
                throw new Error('unreachable');
            }) as unknown as typeof fetch;
            const pending = requestApproval(OPTS, deps(fetchFn));
            await vi.advanceTimersByTimeAsync(120_000);
            const result = await pending;
            expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringMatching(/timed out after 10 s/) });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a key that cannot be sent as a header out of the error, and does not try it again', async () => {
        let tries = 0;
        const fetchFn: typeof fetch = async () => {
            tries++;
            throw new TypeError('Headers.append: "ak_live_abc\nSECRETTAIL" is an invalid header value.');
        };
        expect(await requestApproval(OPTS, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: 'a header could not be sent — check the API key for stray characters' });
        expect(tries).toBe(1);
    });

    it('puts the hook id in the path as one segment', async () => {
        // The hook id is the caller's, and does not get to name another route. An event id that could —
        // the server's, or in a resumed ask a file's — is not read by at all ("an event id that is not written as one").
        const { fetchFn, sent, polled } = scriptedTrigger([], { taken: { eventId: 'evt_1' } });
        await requestApproval({ ...OPTS, hookId: 'hook/../x' }, deps(fetchFn));
        expect(sent).toHaveLength(1);
        expect(polled).toEqual(['https://api.example/v1/hooks/hook%2F..%2Fx/events/evt_1']);
    });

    it('sends the trigger to the hook\'s own route', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { actionId: 'approve' } } }]);
        await requestApproval({ ...OPTS, hookId: 'hook/../x' }, deps(fetchFn));
        expect(calls[0].url).toBe('https://api.example/v1/hooks/hook%2F..%2Fx/trigger');
    });

    it('stops at the first poll the server refuses, with its error', async () => {
        const { fetchFn, calls } = (() => {
            const calls: string[] = [];
            const fetchFn = (async (url: string) => {
                calls.push(url);
                if (url.endsWith('/trigger')) {
                    return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
                }
                return { ok: false, status: 401, json: async () => ({ error: { message: 'key revoked' } }) } as unknown as Response;
            }) as unknown as typeof fetch;
            return { fetchFn, calls };
        })();
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: false, reason: 'error', error: expect.stringMatching(/^key revoked — run `hwip login`/) });
        expect(calls).toHaveLength(2);
    });

    it('ends early with the last error after a run of failed polls', async () => {
        let polls = 0;
        const fetchFn = (async (url: string) => {
            if (url.endsWith('/trigger')) {
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
            }
            polls += 1;
            return { ok: false, status: 503, json: async () => { throw new SyntaxError('not json'); } } as unknown as Response;
        }) as unknown as typeof fetch;
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 600 }, deps(fetchFn));
        // C13: an outage page is named as one, not as a JSON parse error.
        expect(result).toEqual({ answered: false, reason: 'error', error: "the server answered 503 with a page that is not the API's (an outage, or a proxy in the way)" });
        expect(polls).toBe(5);
    });

    /** Trigger succeeds; polls walk `steps` (Response-like or thrown), the last repeating. */
    const pollScript = (steps: Array<{ status: number; body?: unknown } | Error>) => {
        let i = 0;
        let polls = 0;
        const fetchFn = (async (url: string) => {
            if (url.endsWith('/trigger')) {
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
            }
            polls += 1;
            const step = steps[Math.min(i++, steps.length - 1)];
            if (step instanceof Error) throw step;
            return { ok: step.status < 300, status: step.status, json: async () => step.body ?? {} } as unknown as Response;
        }) as unknown as typeof fetch;
        return { fetchFn, polls: () => polls };
    };

    it('keeps waiting through 429 and 408 on a poll', async () => {
        const { fetchFn } = pollScript([
            { status: 429 }, { status: 408 },
            { status: 200, body: { data: { status: 'responded', response: { actionId: 'approve' } } } },
        ]);
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: true, actionId: 'approve' });
    });

    it('reads a 404 before the event was ever seen as the read lagging the write', async () => {
        const { fetchFn } = pollScript([
            { status: 404, body: { error: { message: 'HookEvent not found' } } },
            { status: 200, body: { data: { status: 'responded', response: { actionId: 'approve' } } } },
        ]);
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: true, actionId: 'approve' });
    });

    it('stops on a 404 once the event had been seen — it is gone', async () => {
        const { fetchFn, polls } = pollScript([
            { status: 200, body: { data: { status: 'pending', response: null } } },
            { status: 404, body: { error: { message: 'HookEvent not found' } } },
        ]);
        expect(await requestApproval(OPTS, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: 'HookEvent not found' });
        expect(polls()).toBe(2);
    });

    it('carries the last error when the deadline passes during failing polls', async () => {
        const { fetchFn } = pollScript([
            { status: 200, body: { data: { status: 'pending', response: null } } },
            { status: 200, body: { data: { status: 'pending', response: null } } },
            new TypeError('fetch failed'),
        ]);
        // 4s: two good reads, then failures that the deadline cuts before the run of five.
        expect(await requestApproval({ ...OPTS, timeoutSeconds: 4 }, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: 'could not reach api.example (fetch failed) — check the network' });
    });

    it('counts a 2xx with an unreadable body as a failed poll', async () => {
        const fetchFn = (async (url: string) => {
            if (url.endsWith('/trigger')) {
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
            }
            return { ok: true, status: 200, json: async () => { throw new SyntaxError('<html>'); } } as unknown as Response;
        }) as unknown as typeof fetch;
        expect(await requestApproval({ ...OPTS, timeoutSeconds: 600 }, deps(fetchFn)))
            .toEqual({ answered: false, reason: 'error', error: 'unreadable response (HTTP 200)' });
    });

    it('takes an answer over the status it arrives with', async () => {
        const { fetchFn } = pollScript([
            { status: 200, body: { data: { status: 'responded', response: { value: 'go' } } } },
        ]);
        expect(await requestApproval(OPTS, deps(fetchFn))).toEqual({ answered: true, value: 'go' });
    });

    it('reports a question cancelled on the phone as cancelled, without waiting out the deadline', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'pending', response: null } }, { data: { status: 'cancelled' } }]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: false, reason: 'cancelled' });
        expect(calls).toHaveLength(3);
    });

    it('stops when the server reports the question timed out', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'timed_out' } }]);
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 600 }, deps(fetchFn));
        expect(result).toEqual({ answered: false, reason: 'timeout' });
        expect(calls).toHaveLength(2);
    });

    it('survives a poll that fails midway and keeps waiting', async () => {
        let call = 0;
        const fetchFn = (async (url: string) => {
            call += 1;
            if (url.endsWith('/trigger')) {
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
            }
            if (call === 2) throw new Error('flaky');
            return { ok: true, status: 200, json: async () => ({ data: { status: 'responded', response: { actionId: 'approve' } } }) } as unknown as Response;
        }) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
    });

    it('does not wait past the deadline just because a poll is slow to be scheduled', async () => {
        const clock = { t: 0 };
        const { fetchFn } = stubFetch([{ data: { response: null } }]);
        const spy = vi.fn(async (ms: number) => { clock.t += ms; });
        await requestApproval({ ...OPTS, timeoutSeconds: 2 }, { fetchFn, now: () => clock.t, sleep: spy, seal: {} as never });
        expect(clock.t).toBeLessThanOrEqual(2000 + 1000);
    });
});

describe('requestApproval taking up a question cut short', () => {
    const KEPT: PendingAsk = { eventId: 'evt_kept', askId: 'ASK_KEPT', deadline: 20_000 };
    const ANSWERED = { status: 'responded', response: { actionId: 'approve' } };
    const reads = (data: object) => () => json(200, { data });

    /** The server: the kept question's event reads as `kept` says; a new question is taken as `evt_new` and reads as `fresh` says. */
    const server = (kept: () => Response, fresh: object = ANSWERED, trigger: () => Response = () => json(201, { data: { eventId: 'evt_new' } })) => {
        const triggers: Array<{ timeout: number }> = [];
        const polled: string[] = [];
        const fetchFn: typeof fetch = async (input, init) => {
            const url = String(input);
            if (url.endsWith('/trigger')) {
                triggers.push(JSON.parse(String(init?.body)));
                return trigger();
            }
            polled.push(url.slice(url.lastIndexOf('/') + 1));
            return url.endsWith('/evt_kept') ? kept() : json(200, { data: fresh });
        };
        return { fetchFn, triggers, polled };
    };
    /** Ask with a store of one slot: `kept` is what an earlier run left there, `log` what this run did with it. */
    const ask = async (
        kept: PendingAsk | null,
        { fetchFn }: { fetchFn: typeof fetch },
        over: { timeoutSeconds?: number; loadKeys?: () => Promise<void>; settle?: () => boolean; clock?: { t: number } } = {},
    ) => {
        const log: string[] = [];
        const recorded: PendingAsk[] = [];
        const pending: PendingAsks = {
            of: () => ({
                claim: () => kept,
                record: (asked) => { log.push('record'); recorded.push(asked); },
                settle: () => { log.push('settle'); return over.settle?.() ?? true; },
            }),
        };
        const loadKeys = vi.fn(over.loadKeys ?? (async () => undefined));
        const warn = vi.fn();
        const d = { ...deps(fetchFn, over.clock), pending };
        d.seal = { ...d.seal, loadKeys, warn };
        const result = await requestApproval({ ...OPTS, timeoutSeconds: over.timeoutSeconds ?? OPTS.timeoutSeconds }, d);
        return { result, log, recorded, loadKeys, warn };
    };

    beforeEach(opensAsWritten);
    afterEach(resetSeal);

    it('waits on the question an earlier run left, and sends nothing', async () => {
        const srv = server(reads(ANSWERED));
        const { result, log, loadKeys } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: true, actionId: 'approve', resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(srv.polled).toEqual(['evt_kept']);
        // Nothing is sealed again: the answer opens with the id the first run sealed the question under, and this run's own buttons.
        expect(sealMock.prepareAsk).not.toHaveBeenCalled();
        expect(loadKeys).toHaveBeenCalledTimes(1);
        expect(sealMock.openAnswer).toHaveBeenCalledWith(ANSWERED.response, 'ASK_KEPT', ['approve', 'deny'], expect.anything());
        // The answer is used once: forgotten by the time it is handed over.
        expect(log).toEqual(['settle']);
    });

    it('ends with this run\'s window when that is shorter, and leaves the question to be taken up again', async () => {
        const srv = server(reads(PENDING));
        const { result, log } = await ask(KEPT, srv, { timeoutSeconds: 5 });

        expect(result).toEqual({ answered: false, reason: 'timeout', resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual([]);
    });

    // A command run again with `--timeout 300` is not told `timeout` after the few seconds the first question had left.
    it.each([
        ['the server says it timed out', reads({ status: 'timed_out' }), 30],
        ['its own window runs out with no word', reads(PENDING), 10],
    ])('asks anew with what is left of the window when the kept question ends unanswered: %s', async (_, kept, left) => {
        const srv = server(kept);
        const { result, log, recorded } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(srv.triggers.map((t) => t.timeout)).toEqual([left]);
        expect(recorded).toEqual([{ eventId: 'evt_new', askId: 'ASK', deadline: 30_000 }]);
        expect(log).toEqual(['settle', 'record', 'settle']);
    });

    it('does not ask anew a question the user cancelled', async () => {
        const srv = server(reads({ status: 'cancelled' }));
        const { result, log } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: false, reason: 'cancelled', resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual(['settle']);
    });

    // A key that was rotated, or is another account's: the question is still on the phone, and the same
    // key would be refused a new one as well.
    it.each([401, 403])('keeps the question when the read is refused with %i, and sends nothing', async (status) => {
        const srv = server(() => json(status, { error: { message: 'no' } }));
        const { result, log } = await ask(KEPT, srv);

        // A 401 carries the sign-in hint after the server's words.
        expect(result).toEqual({ answered: false, reason: 'error', error: expect.stringMatching(/^no/), resumed: true });
        expect(srv.polled).toEqual(['evt_kept']);
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual([]);
    });

    // The record is written as soon as the question is up: the run that takes it up may be the first to read it.
    it('reads past a 404 on a question nobody has read yet', async () => {
        let n = 0;
        const srv = server(() => ((n += 1) === 1 ? json(404, { error: { message: 'not found' } }) : json(200, { data: ANSWERED })));
        const { result } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: true, actionId: 'approve', resumed: true });
        expect(srv.polled).toEqual(['evt_kept', 'evt_kept']);
        expect(srv.triggers).toEqual([]);
    });

    it('reads the kept question once even when loading the keys used up what was left of its window', async () => {
        const srv = server(reads(ANSWERED));
        const clock = { t: 0 };
        const { result, log } = await ask(KEPT, srv, { clock, loadKeys: async () => { clock.t = KEPT.deadline + 1; } });

        expect(result).toEqual({ answered: true, actionId: 'approve', resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual(['settle']);
    });

    // The answer is there and may open on the next run: a device list that did not load is not a refusal.
    it('keeps a question whose answer could not be opened for want of the device list', async () => {
        sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'peer-unusable' });
        const srv = server(reads(ANSWERED));
        const { result, log } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: false, reason: 'error', error: refusalMessage('peer-unusable'), resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual([]);
    });

    it('says so on stderr when the answered question could not be forgotten', async () => {
        const { result, warn } = await ask(KEPT, server(reads(ANSWERED)), { settle: () => false });

        expect(result).toEqual({
            answered: true,
            actionId: 'approve',
            resumed: true,
            warn: expect.stringMatching(/run again.*answer/s),
        });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/run again.*answer/s));
    });

    it('forgets a kept question whose answer does not open', async () => {
        sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'wrong-labels' });
        const srv = server(reads(ANSWERED));
        const { result, log } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: false, reason: 'error', error: refusalMessage('wrong-labels'), resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual(['settle']);
    });

    it('keeps the question when the server cannot be read: it may still be answered', async () => {
        const srv = server(() => json(503, { error: { message: 'down' } }));
        const { result, log } = await ask(KEPT, srv);

        expect(result).toEqual({ answered: false, reason: 'error', error: 'down', resumed: true });
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual([]);
    });

    it('keeps the question when this machine\'s keys cannot be loaded, and reads nothing', async () => {
        const srv = server(reads(ANSWERED));
        const { result, log } = await ask(KEPT, srv, { loadKeys: async () => { throw new Error('locked'); } });

        expect(result).toEqual({ answered: false, reason: 'error', error: refusalMessage('keystore'), resumed: true });
        expect(srv.polled).toEqual([]);
        expect(srv.triggers).toEqual([]);
        expect(log).toEqual([]);
    });

    // C146 ③: the id goes into the path of every read, and into the record the next run reads by.
    describe('an event id that is not written as one', () => {
        it.each([
            ['two dots', '..'],
            ['a path', 'a/b'],
            ['too long', 'x'.repeat(129)],
            ['a number', 7],
            ['a line break', 'evt\n1'],
        ])('is not read by, and not kept: %s', async (_, eventId) => {
            const srv = server(reads(PENDING), ANSWERED, () => json(201, { data: { eventId } }));
            const { result, log, recorded } = await ask(null, srv);

            expect(result).toMatchObject({ answered: false, reason: 'error', error: expect.stringMatching(/took the question.*may be on the phone/) });
            expect(srv.triggers).toHaveLength(1);
            expect(srv.polled).toEqual([]);
            expect(recorded).toEqual([]);
            expect(log).not.toContain('record');
        });
    });

    describe('a question of its own', () => {
        it('keeps what it put up, with what opens the answer and when its window ends', async () => {
            const { recorded, result } = await ask(null, server(reads(PENDING)));

            expect(recorded).toEqual([{ eventId: 'evt_new', askId: 'ASK', deadline: 30_000 }]);
            expect(result).toEqual({ answered: true, actionId: 'approve' });
        });

        it.each([
            ['answered', ANSWERED],
            ['cancelled', { status: 'cancelled' }],
            ['timed out', { status: 'timed_out' }],
        ])('forgets it once it is %s', async (_, fresh) => {
            expect((await ask(null, server(reads(PENDING), fresh))).log).toEqual(['record', 'settle']);
        });

        it('keeps it when the wait ends with the question still open', async () => {
            // This run's window passing, and the server going away: neither is the question's end.
            expect((await ask(null, server(reads(PENDING), PENDING), { timeoutSeconds: 5 })).log).toEqual(['record']);
            const down: typeof fetch = async (input) =>
                String(input).endsWith('/trigger') ? json(201, { data: { eventId: 'evt_new' } }) : json(503, { error: { message: 'down' } });
            expect((await ask(null, { fetchFn: down })).log).toEqual(['record']);
        });

        it('keeps nothing of a question that did not go up', async () => {
            const refused = server(reads(PENDING), PENDING, () => json(400, { error: { message: 'bad' } }));
            expect((await ask(null, refused)).log).toEqual([]);
        });
    });
});

describe('send and exit', () => {
    beforeEach(opensAsWritten);
    afterEach(resetSeal);

    const SENT = { data: { status: 'responded', response: { value: 'ship it', exitRemote: true } } };

    it('offers the button only on an ask that sets acceptsExit', async () => {
        const offered = stubFetch([SENT]);
        await requestApproval({ ...OPTS, acceptsExit: true }, deps(offered.fetchFn));
        expect(offered.calls[0].body).toMatchObject({ acceptsExit: true });

        const gate = stubFetch([SENT]);
        await requestApproval(OPTS, deps(gate.fetchFn));
        expect(gate.calls[0].body).not.toHaveProperty('acceptsExit');
    });

    it('marks the answer as send-and-exit only when the ask offered it', async () => {
        const offered = stubFetch([SENT]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(offered.fetchFn)))
            .toEqual({ answered: true, value: 'ship it', exitRemote: true });

        // An approval gate has no mode to end, whatever the phone sent.
        const gate = stubFetch([SENT]);
        expect(await requestApproval(OPTS, deps(gate.fetchFn)))
            .toEqual({ answered: true, value: 'ship it' });
    });

    it('does not read plain text on an offering ask as an exit', async () => {
        const { fetchFn } = stubFetch([{ data: { status: 'responded', response: { value: 'run the tests' } } }]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(fetchFn)))
            .toEqual({ answered: true, value: 'run the tests' });
    });

    it('takes an exit with no text as an answer instead of waiting out the deadline', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { exitRemote: true } } }]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(fetchFn)))
            .toEqual({ answered: true, value: '', exitRemote: true });
        expect(calls).toHaveLength(2);
    });
});

describe('remoteTransition — mcp-server remoteTransitionFor', () => {
    it.each(['done', 'Done', 'STOP', ' exit '])('ends REMOTE on the Done-like button %j', (id) => {
        expect(remoteTransition({ answered: true, actionId: id })).toBe('exit');
    });

    it('ends REMOTE on a send-and-exit answer', () => {
        expect(remoteTransition({ answered: true, value: 'ship it', exitRemote: true })).toBe('exit');
    });

    it('enters REMOTE on any other answer', () => {
        expect(remoteTransition({ answered: true, actionId: 'review' })).toBe('enter');
        expect(remoteTransition({ answered: true, value: 'redo it' })).toBe('enter');
    });

    it('leaves the mode alone when nobody answered', () => {
        expect(remoteTransition({ answered: false, reason: 'timeout' })).toBe('keep');
        expect(remoteTransition({ answered: false, reason: 'error', error: 'HTTP 500' })).toBe('keep');
    });
});

describe('hwip ask --accepts-exit', () => {
    let dir: string;
    let out: string[];
    const answer = (response: { actionId?: string; value?: string; exitRemote?: boolean }) =>
        {
            answeredBy(response);
            vi.stubGlobal('fetch', stubFetch([{ data: { status: 'responded', response: { sealed: SEALED.fields, respondedDeviceId: 'dev_phone' } } }]).fetchFn);
        }
    const printed = () => JSON.parse(out.join(''));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hwip-ask-'));
        vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
        vi.stubEnv('TMUX', '');
        vi.stubEnv('HWIP_API_KEY', 'k');
        vi.stubEnv('HWIP_HOOK_ID', 'hook_1');
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        out = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out.push(String(chunk));
            return true;
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
        await resetSeal();
    });

    const ASK = { title: 'next?', actions: 'review:Review,done:Done', timeout: '5', 'accepts-exit': true } as const;

    it('says what is missing as a sentence when there is no login', async () => {
        vi.stubEnv('HWIP_API_KEY', '');
        vi.stubEnv('HWIP_HOOK_ID', '');
        expect(await handleAsk({ title: 'next?' })).toBe(1);
        expect(printed()).toEqual({ answered: false, reason: 'error', error: 'missing an API key and a hook id' });
    });

    it('ends REMOTE and prints the final instruction with hwipState NORMAL', async () => {
        touchRemoteActive(dir);
        answer({ value: 'ship it', exitRemote: true });
        expect(await handleAsk(ASK)).toBe(0);
        expect(printed()).toEqual({ answered: true, value: 'ship it', hwipState: 'NORMAL' });
        expect(isRemoteActive(dir)).toBe(false);
    });

    it('ends REMOTE on a Done-like button', async () => {
        touchRemoteActive(dir);
        answer({ actionId: 'done' });
        await handleAsk(ASK);
        expect(printed()).toEqual({ answered: true, actionId: 'done', hwipState: 'NORMAL' });
        expect(isRemoteActive(dir)).toBe(false);
    });

    it('enters REMOTE on plain text, like any other answer', async () => {
        answer({ value: 'run the tests' });
        await handleAsk(ASK);
        expect(printed()).toEqual({ answered: true, value: 'run the tests', hwipState: 'REMOTE' });
        expect(isRemoteActive(dir)).toBe(true);
    });

    it('leaves REMOTE alone and names no state when nobody answered', async () => {
        touchRemoteActive(dir);
        vi.stubGlobal('fetch', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
        sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'devices' });
        expect(await handleAsk(ASK)).toBe(1);
        // The device list cannot be read either, so the question is not sent at all.
        expect(printed()).toEqual({ answered: false, reason: 'error', error: expect.stringContaining('the device list could not be fetched') });
        expect(isRemoteActive(dir)).toBe(true);
    });

    it('says in its JSON that the answer is to a question an earlier run put up', async () => {
        // The earlier run: a process that has exited, which asked this from this directory.
        const exited = spawnSync(process.execPath, ['-e', '']).pid;
        const stateDir = join(dir, 'state', 'hwip');
        const question = { hookId: 'hook_1', title: 'next?', actions: [{ id: 'review', label: 'Review' }, { id: 'done', label: 'Done' }], acceptsExit: true };
        pendingAsks(stateDir, { pid: exited }).of(question).record({ eventId: 'evt_kept', askId: 'ASK_KEPT', deadline: Date.now() + 60_000 });
        answeredBy({ actionId: 'review' });
        const { fetchFn, calls } = stubFetch([{ data: { status: 'responded', response: { sealed: SEALED.fields, respondedDeviceId: 'dev_phone' } } }]);
        vi.stubGlobal('fetch', fetchFn);

        expect(await handleAsk(ASK)).toBe(0);

        expect(printed()).toEqual({ answered: true, actionId: 'review', resumed: true, hwipState: 'REMOTE' });
        expect(calls.map((c) => c.url)).toEqual(['https://api.hwip.app/v1/hooks/hook_1/events/evt_kept']);
        expect(readdirSync(stateDir).filter((name) => name.startsWith('ask-pending-'))).toEqual([]);
    });

    it('leaves REMOTE alone and names no state on an ask without the flag', async () => {
        touchRemoteActive(dir);
        answer({ value: 'ship it', exitRemote: true });
        await handleAsk({ title: 'next?', actions: 'done:Done', timeout: '5' });
        expect(printed()).toEqual({ answered: true, value: 'ship it' });
        expect(isRemoteActive(dir)).toBe(true);

        out = [];
        answer({ actionId: 'done' });
        await handleAsk({ title: 'Run rm -rf ./dist?', actions: 'done:Done', timeout: '5' });
        expect(printed()).toEqual({ answered: true, actionId: 'done' });
        expect(isRemoteActive(dir)).toBe(true);
    });
});

describe('hwip ask key, base URL and timeout', () => {
    let calls: Array<{ url: string; key: string | null; body?: { timeout?: number } }>;

    beforeEach(() => {
        vi.stubEnv('HWIP_API_KEY', 'env_key');
        vi.stubEnv('HWIP_BASE_URL', '');
        vi.stubEnv('HWIP_HOOK_ID', 'hook_1');
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        calls = [];
        answeredBy({ actionId: 'ok' });
        vi.stubGlobal('fetch', ((async (url: string, init?: RequestInit) => {
            calls.push({
                url,
                key: new Headers(init?.headers).get('X-API-Key'),
                body: init?.body ? JSON.parse(String(init.body)) : undefined,
            });
            const data = url.endsWith('/trigger') ? { eventId: 'evt_1' } : { status: 'responded', response: { sealed: SEALED.fields, respondedDeviceId: 'dev_phone' } };
            return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
        }) as unknown as typeof fetch));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await resetSeal();
    });

    // `hwip ask` read only `--api-key` and the saved base URL, so the global
    // `--key` / `--base-url` / HWIP_BASE_URL every other command honours did nothing.
    it('takes --key and --base-url like every other command', async () => {
        await handleAsk({ title: 'go?', key: 'flag_key', 'base-url': 'http://localhost:3000/v1/' });

        expect(calls[0]).toMatchObject({ url: 'http://localhost:3000/v1/hooks/hook_1/trigger', key: 'flag_key' });
    });

    it('still takes --api-key, its older spelling of --key', async () => {
        await handleAsk({ title: 'go?', 'api-key': 'old_flag_key' });

        expect(calls[0].key).toBe('old_flag_key');
    });

    // A bare flag parses as `true`: it used to send `X-API-Key: true`, and a
    // bare --base-url threw on `.replace` instead of falling back.
    it('ignores a bare --key or --base-url', async () => {
        await handleAsk({ title: 'go?', key: true, 'base-url': true });

        expect(calls[0]).toMatchObject({ url: 'https://api.hwip.app/v1/hooks/hook_1/trigger', key: 'env_key' });
    });

    it('falls back to HWIP_API_KEY and HWIP_BASE_URL', async () => {
        vi.stubEnv('HWIP_BASE_URL', 'http://staging.example/v1');
        await handleAsk({ title: 'go?' });

        expect(calls[0]).toMatchObject({ url: 'http://staging.example/v1/hooks/hook_1/trigger', key: 'env_key' });
    });

    // A bare `--timeout` parses as `true`, which Number() turned into a 1-second ask.
    it('keeps the default timeout when --timeout has no value', async () => {
        await handleAsk({ title: 'go?', timeout: true });

        expect(calls[0].body?.timeout).toBe(60);
    });
});

describe('poll cadence', () => {
    beforeEach(opensAsWritten);
    afterEach(resetSeal);

    it('polls every second for 30 s, then every 2.5 s', () => {
        expect(pollIntervalMs(0)).toBe(1_000);
        expect(pollIntervalMs(29_999)).toBe(1_000);
        expect(pollIntervalMs(30_000)).toBe(2_500);
    });

    // A fixed 1 s poll made a 10-minute wait 600 requests.
    it('keeps a 10-minute unanswered wait near 250 polls and stops at the deadline', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { status: 'pending' } }]);
        const clock = { t: 0 };
        const outcome = await requestApproval({ ...OPTS, timeoutSeconds: 600 }, deps(fetchFn, clock));

        const polls = calls.filter((c) => c.method === 'GET').length;
        expect(outcome).toEqual({ answered: false, reason: 'timeout' });
        expect(polls).toBeGreaterThan(240);
        expect(polls).toBeLessThan(260);
        expect(clock.t).toBe(600_000);
    });
});

describe('the seal\'s device list on the live account', () => {
    const list = (res: { ok: boolean; status: number; body?: unknown }) => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', (async (url: string) => {
            calls.push(url);
            return { ok: res.ok, status: res.status, json: async () => res.body } as unknown as Response;
        }) as unknown as typeof fetch);
        return { calls, seal: liveDeps({ apiKey: 'k', baseUrl: 'https://api.example/v1' }).seal };
    };
    afterEach(() => { vi.unstubAllGlobals(); });

    it('reads GET /devices', async () => {
        const { calls, seal } = list({ ok: true, status: 200, body: { data: [{ deviceId: 'dev_phone', publicKey: 'K' }] } });
        expect(await seal.listDevices()).toEqual([{ deviceId: 'dev_phone', publicKey: 'K' }]);
        expect(calls).toEqual(['https://api.example/v1/devices']);
    });

    // A path that is wrong pins into a file nobody else reads: the listener's hold on a request and `hwip trust` go quiet and nothing else fails.
    it('pins in the listener\'s trust file', () => {
        expect(liveDeps({ apiKey: 'k', baseUrl: 'https://api.example/v1' }).seal.trustPath).toBe(TRUST_FILE);
    });

    it('says a changed key on stderr with the hwip prefix', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            liveDeps({ apiKey: 'k', baseUrl: 'https://api.example/v1' }).seal.warn?.('trust: dev_phone changed its key — now pinned to the new one');

            expect(err).toHaveBeenCalledWith('hwip: trust: dev_phone changed its key — now pinned to the new one');
        } finally {
            err.mockRestore();
        }
    });

    it('rejects a failed or malformed list instead of passing it on', async () => {
        await expect(list({ ok: false, status: 503 }).seal.listDevices()).rejects.toThrow('devices 503');
        await expect(list({ ok: true, status: 200, body: { data: {} } }).seal.listDevices()).rejects.toThrow('unexpected');
    });
});
