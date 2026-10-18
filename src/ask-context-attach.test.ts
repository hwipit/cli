import { describe, expect, it, vi } from 'vitest';
import {
    ASK_ATTACHMENT_BYTES,
    ASK_ATTACH_RESERVE_MS,
    attachAskContext,
    attachWithinWindow,
    collectAskContext,
    padAskOriginal,
    uploadAskAttachment,
    type CollectDeps,
} from './ask-context-attach.js';
import type { AskContext } from './ask-context.js';

const CONTEXT: AskContext = {
    summary: {
        diff: 'ok', files: 1, added: 2, removed: 1,
        listed: [{ path: 'src/a.ts', status: 'M', added: 2, removed: 1 }],
        moreFiles: 0, screenLines: 1, masked: 0, cut: { diff: false, screen: false },
    },
    original: { diff: 'diff --git a/src/a.ts b/src/a.ts\n+한글\n', screen: '$ npm test' },
};

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'PHONE' }];

describe('padAskOriginal', () => {
    it('holds the original as JSON at the start of exactly 64 KiB, and says how long it is', () => {
        const padded = padAskOriginal(CONTEXT);
        const text = JSON.stringify(CONTEXT.original);

        expect(ASK_ATTACHMENT_BYTES).toBe(65536);
        expect(padded.bytes.length).toBe(65536);
        expect(padded.size).toBe(Buffer.byteLength(text));
        expect(padded.bytes.subarray(0, padded.size).toString('utf-8')).toBe(text);
        expect(padded.bytes.subarray(padded.size).every((b) => b === 0)).toBe(true);
        expect(padded.context).toEqual(CONTEXT.summary);
    });

    it('is the same 64 KiB with nothing in it when there is no context', () => {
        const padded = padAskOriginal(null);
        expect(padded.bytes.length).toBe(65536);
        expect(padded.bytes.every((b) => b === 0)).toBe(true);
        expect(padded.size).toBe(0);
        expect(padded.context).toBeUndefined();
    });

    it('carries nothing rather than part of an original that does not fit', () => {
        const padded = padAskOriginal({ ...CONTEXT, original: { diff: 'x'.repeat(65536), screen: '' } });
        expect(padded.bytes.length).toBe(65536);
        expect(padded.size).toBe(0);
        expect(padded.context).toBeUndefined();
    });

    it('takes an original of exactly 64 KiB', () => {
        const frame = Buffer.byteLength(JSON.stringify({ diff: '', screen: '' }));
        const padded = padAskOriginal({ ...CONTEXT, original: { diff: 'x'.repeat(65536 - frame), screen: '' } });
        expect(padded.size).toBe(65536);
        expect(padded.context).toEqual(CONTEXT.summary);
    });
});

describe('attachAskContext', () => {
    const encrypt = vi.fn(async (content: string | Buffer) => ({
        ciphertext: Buffer.concat([content as Buffer, Buffer.alloc(16)]),
        iv: 'IV',
        deviceKeyMap: { dev_phone: 'wrapped' },
    }));

    it('shows the server the same name, type and size whatever the context is', async () => {
        const withContext = await attachAskContext(RECIPIENTS, { context: async () => CONTEXT, encrypt, upload: async () => 'files/1' });
        const without = await attachAskContext(RECIPIENTS, { context: async () => null, encrypt, upload: async () => 'files/1' });

        const wire = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: 'IV', deviceKeyMap: { dev_phone: 'wrapped' } };
        expect(withContext.file).toEqual(wire);
        expect(without.file).toEqual(wire);
        expect(encrypt.mock.calls.every(([bytes]) => (bytes as Buffer).length === 65536)).toBe(true);
    });

    it('names the original and its real length inside the seal only', async () => {
        const uploaded: Buffer[] = [];
        const attached = await attachAskContext(RECIPIENTS, {
            context: async () => CONTEXT,
            encrypt,
            upload: async (bytes) => { uploaded.push(bytes); return 'files/1'; },
        });

        expect(attached.context).toEqual(CONTEXT.summary);
        expect(attached.meta).toEqual({
            iv: 'IV',
            name: 'ask-context.json',
            type: 'application/vnd.hwip.ask-context+json',
            size: Buffer.byteLength(JSON.stringify(CONTEXT.original)),
        });
        expect(uploaded[0]!.length).toBe(65536 + 16);
    });

    it('attaches the empty original when the context cannot be gathered', async () => {
        const attached = await attachAskContext(RECIPIENTS, {
            context: async () => { throw new Error('git hung'); },
            encrypt,
            upload: async () => 'files/1',
        });
        expect(attached.context).toBeUndefined();
        expect(attached.meta.size).toBe(0);
        expect(attached.file.fileSize).toBe(65536);
    });

    it('fails when the upload fails (the caller sends the question without it)', async () => {
        await expect(attachAskContext(RECIPIENTS, { context: async () => CONTEXT, encrypt, upload: async () => { throw new Error('upload 503'); } }))
            .rejects.toThrow('upload 503');
    });
});

describe('attachWithinWindow', () => {
    const encrypt = async (content: string | Buffer) => ({ ciphertext: content as Buffer, iv: 'IV', deviceKeyMap: {} });

    it('keeps the last ten seconds of the window for the question: with no more than that left, nothing is gathered or stored', async () => {
        const upload = vi.fn(async () => 'files/1');
        const context = vi.fn(async () => null);

        expect(ASK_ATTACH_RESERVE_MS).toBe(10_000);
        await expect(attachWithinWindow(RECIPIENTS, { context, encrypt, upload }, 10_000)).rejects.toThrow();
        expect(context).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    });

    it('gives up on an attachment that is not stored before the question would have to wait for it', async () => {
        vi.useFakeTimers();
        try {
            const attached = attachWithinWindow(RECIPIENTS, { context: async () => null, encrypt, upload: () => new Promise<string>(() => undefined) }, 15_000);
            const settled = expect(attached).rejects.toThrow('5000 ms');
            await vi.advanceTimersByTimeAsync(5_000);
            await settled;
        } finally {
            vi.useRealTimers();
        }
    });

    it('hands on an attachment stored in time', async () => {
        const attached = await attachWithinWindow(RECIPIENTS, { context: async () => null, encrypt, upload: async () => 'files/1' }, 15_000);
        expect(attached.file.fileKey).toBe('files/1');
    });
});

describe('collectAskContext', () => {
    const depsFor = (overrides: Partial<CollectDeps> = {}): CollectDeps => ({
        offBy: () => null,
        capture: vi.fn(async () => 'screen'),
        gather: vi.fn(() => CONTEXT),
        ...overrides,
    });

    it('captures the pane this process runs in, and gathers for the directory', async () => {
        const deps = depsFor();
        const got = await collectAskContext('/repo/sub', { TMUX_PANE: '%12' }, deps);

        expect(got).toEqual({ context: CONTEXT });
        expect(deps.capture).toHaveBeenCalledWith('%12');
        expect(deps.gather).toHaveBeenCalledWith('/repo/sub', 'screen');
    });

    it.each([
        ['outside tmux', {}],
        ['with a pane variable that is not a pane id', { TMUX_PANE: 'hwip-other' }],
        ['with a pane variable that carries a flag', { TMUX_PANE: '%1 -t other' }],
    ])('gathers without a screen %s', async (_name, env) => {
        const deps = depsFor();
        await collectAskContext('/repo', env, deps);
        expect(deps.capture).not.toHaveBeenCalled();
        expect(deps.gather).toHaveBeenCalledWith('/repo', null);
    });

    it('reads nothing when the switch is off, and says who turned it off', async () => {
        const deps = depsFor({ offBy: () => 'project' });
        expect(await collectAskContext('/repo', { TMUX_PANE: '%12' }, deps)).toEqual({ context: null, off: 'project' });
        expect(deps.capture).not.toHaveBeenCalled();
        expect(deps.gather).not.toHaveBeenCalled();
    });

    it('reads nothing when the window left is too short to spend on git', async () => {
        const deps = depsFor();
        expect(await collectAskContext('/repo', { TMUX_PANE: '%12' }, deps, 19_999)).toEqual({ context: null });
        expect(deps.gather).not.toHaveBeenCalled();

        expect(await collectAskContext('/repo', { TMUX_PANE: '%12' }, deps, 20_000)).toEqual({ context: CONTEXT });
    });
});

describe('uploadAskAttachment', () => {
    const ACCOUNT = { apiKey: 'hwip_key', baseUrl: 'https://api.example' };

    it('asks for an upload of the fixed name, type and sealed size, then puts the bytes without the API key', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fetchFn = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return calls.length === 1
                ? new Response(JSON.stringify({ data: { uploadUrl: 'https://s3.example/put?sig=1', fileKey: 'files/abc' } }), { status: 200 })
                : new Response('', { status: 200 });
        }) as unknown as typeof fetch;
        const bytes = Buffer.alloc(65552, 7);

        expect(await uploadAskAttachment(bytes, ACCOUNT, fetchFn)).toBe('files/abc');

        expect(calls[0]!.url).toBe('https://api.example/files/upload-request');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ fileName: 'file', fileType: 'application/octet-stream', fileSize: 65552 });
        expect((calls[0]!.init.headers as Record<string, string>)['X-API-Key']).toBe('hwip_key');
        expect(calls[1]!.url).toBe('https://s3.example/put?sig=1');
        expect(calls[1]!.init.method).toBe('PUT');
        expect(calls[1]!.init.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
        expect(Buffer.from(calls[1]!.init.body as Uint8Array).equals(bytes)).toBe(true);
    });

    it.each([
        ['the request is refused', [new Response('{}', { status: 403 })]],
        ['the answer names no upload', [new Response(JSON.stringify({ data: {} }), { status: 200 })]],
        ['the put is refused', [new Response(JSON.stringify({ data: { uploadUrl: 'https://s3.example/put', fileKey: 'k' } }), { status: 200 }), new Response('', { status: 403 })]],
    ])('throws when %s', async (_name, replies) => {
        const queue = [...replies];
        const fetchFn = (async () => queue.shift()!) as unknown as typeof fetch;
        await expect(uploadAskAttachment(Buffer.alloc(8), ACCOUNT, fetchFn)).rejects.toThrow();
    });
});
