// The always-on recorder (I28) on a transcript that is not a file (C140): opencode keeps its sessions
// in SQLite, so the session's agent hands the recorder a reader, and what was uploaded is remembered as
// that reader's cursor instead of a byte offset. A fake store stands in for the database here; the
// real reader on a real store is in `session-store-read.test.ts`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTurnRecorder, readSessionState, type OutboxChunk, type UploadOutcome } from './turn-recorder.js';
import type { TailState, TranscriptReader, TurnEvent } from './transcript-tail.js';
import { projectOpencodeEntries } from './opencode-transcript.js';

const DEVICE = 'dev_listener_reader';
const PATH = '/store/opencode.db#ses_a';
let dir: string;
let clock: number;

/** Rows per session path; the cursor is how many of them the last read handed out. */
let store: Map<string, TurnEvent[]>;
let reads: number;
/** Like opencode's floor between queries: a read this soon after the last one does not look. */
let floorMs: number;
let lastLook: number;
const reader: TranscriptReader = (path, prev) => {
    const rows = store.get(path);
    if (!rows) return null;
    if (clock - lastLook < floorMs) return null;
    lastLook = clock;
    reads++;
    const at = (prev?.cursor as { at?: number } | undefined)?.at ?? 0;
    if (at >= rows.length) return null;
    // `offset`, `size` and `ino` are the reader's own, not a file's: a size under the offset must not read as a
    // truncated file, nor an inode no file has as a replaced one.
    const state: TailState = { offset: rows.length + 1000, size: 0, mtimeMs: 0, ino: 7, carry: '', resyncing: false, salvage: [], cursor: { at: rows.length } };
    return { lines: rows.slice(at).map((e) => JSON.stringify(e)), state, bytesRead: 0, droppedLines: 0 };
};
const at = (s: number): string => new Date(Date.UTC(2026, 9, 10) + s * 1000).toISOString();
const prompt = (text: string, s: number): TurnEvent => ({ kind: 'prompt', text, at: at(s) });
const text = (t: string, s: number): TurnEvent => ({ kind: 'text', text: t, at: at(s) });

interface Rig { uploads: { sessionKey: string; chunk: OutboxChunk }[]; outcome: UploadOutcome }
const make = (rig: Rig) =>
    createTurnRecorder({
        dir: join(dir, 'state'),
        deviceId: () => DEVICE,
        uploadReady: () => true,
        devicePublicKey: () => 'listener-key',
        latestSeq: async () => null,
        projectorFor: (k) => (k === 'opencode' ? projectOpencodeEntries : null),
        readerFor: (k) => (k === 'opencode' ? reader : null),
        recipients: async () => [{ deviceId: 'dev_phone', publicKey: 'phone-key' }],
        seal: async (plaintext, recipients) => ({
            body: Buffer.from(plaintext).toString('base64'),
            deviceKeyMap: Object.fromEntries(recipients.map((r) => [r.deviceId, 'k'])),
            senderPublicKey: 'listener-key',
        }),
        upload: async (sessionKey, chunk) => {
            if (rig.outcome.kind === 'ok') rig.uploads.push({ sessionKey, chunk });
            return rig.outcome;
        },
        log: () => {},
        now: () => clock,
    });
const texts = (rig: Rig): string[] =>
    rig.uploads.flatMap((u) => (JSON.parse(Buffer.from(u.chunk.sealed.body, 'base64').toString('utf-8')) as { events: TurnEvent[] }).events)
        .map((e) => (e as { text?: string }).text ?? e.kind);
const advance = async (r: ReturnType<typeof make>, ms: number, observe?: () => void) => {
    for (let s = 0; s < ms; s += 1000) { clock += 1000; observe?.(); await r.tick(); }
};
const watching = (r: ReturnType<typeof make>, path = PATH) => () => r.observe({ 'hwip-oc': { path, kind: 'opencode', runId: '1789999999' } });

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-recorder-reader-'));
    clock = 1_790_000_000_000;
    store = new Map([[PATH, [prompt('hello', 1), text('hi', 2)]]]);
    reads = 0;
    floorMs = 0;
    lastLook = -Infinity;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a session whose agent reads its own store', () => {
    it('uploads what the reader hands out, through that reader', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r = make(rig);
        await advance(r, 3000, watching(r));
        expect(texts(rig)).toEqual(['hello', 'hi']);
        expect(reads).toBeGreaterThan(0);
    });

    it('keeps the reader\'s cursor in the state file, and nothing of what was said', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r = make(rig);
        await advance(r, 3000, watching(r));
        const state = readSessionState(join(dir, 'state'), `${DEVICE}:hwip-oc`);
        expect(state?.cursor).toEqual({ at: 2 });
        const raw = readdirSync(join(dir, 'state')).map((f) => readFileSync(join(dir, 'state', f), 'utf-8')).join('');
        expect(raw).not.toContain('hello');
    });

    it('goes on from the stored cursor after a restart, sending nothing twice', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r1 = make(rig);
        await advance(r1, 3000, watching(r1));
        r1.stop();

        // A step's text stamped before what was already sent: only the cursor, not the time, says it is new.
        store.get(PATH)!.push(text('a step that began earlier', 1), prompt('while it was down', 3));
        const r2 = make(rig);
        await advance(r2, 3000, watching(r2));
        expect(texts(rig)).toEqual(['hello', 'hi', 'a step that began earlier', 'while it was down']);
    });

    // opencode sends a step's text once the step is over, stamped when the step began — older than a prompt already sent.
    it('sends an event older than one already sent: a reader\'s position is no file size, nothing was truncated', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r = make(rig);
        await advance(r, 3000, watching(r));
        store.get(PATH)!.push(text('the step that began before the last prompt', 1));
        await advance(r, 3000, watching(r));
        expect(texts(rig)).toEqual(['hello', 'hi', 'the step that began before the last prompt']);
    });

    it('reads a session with chunks waiting after a restart through the reader of the kind its state names', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'retry', why: 'offline' } };
        const r1 = make(rig);
        await advance(r1, 3000, watching(r1));
        r1.stop();
        store.get(PATH)!.push(text('said before the machine went down', 3));

        rig.outcome = { kind: 'ok' };
        const r2 = make(rig);
        r2.start(); // takes up sessions that still have chunks waiting
        r2.stop();
        await advance(r2, 5 * 60_000);
        expect(texts(rig)).toEqual(['hello', 'hi', 'said before the machine went down']);
        expect(r2.size()).toBe(0);
    });

    it('reads the session it left to its end before the one it moved to (`/new` in the same pane)', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r = make(rig);
        await advance(r, 3000, watching(r));
        const next = '/store/opencode.db#ses_b';
        store.get(PATH)!.push(text('last words of the old session', 3));
        store.set(next, [prompt('a new session', 4)]);
        await advance(r, 5000, watching(r, next));
        expect(texts(rig)).toEqual(['hello', 'hi', 'last words of the old session', 'a new session']);
    });

    it('does not take a reader that did not look for the end of the session it left', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r = make(rig);
        await advance(r, 3000, watching(r));
        floorMs = 1500;
        const next = '/store/opencode.db#ses_b';
        store.get(PATH)!.push(text('last words of the old session', 3));
        store.set(next, [prompt('a new session', 4)]);
        // The first look at the old session falls under the floor and answers nothing.
        lastLook = clock;
        await advance(r, 8000, watching(r, next));
        expect(texts(rig)).toEqual(['hello', 'hi', 'last words of the old session', 'a new session']);
    });

    it('after a restart, finishes the session it left while the listener was down before the new one', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        const r1 = make(rig);
        await advance(r1, 3000, watching(r1));
        r1.stop();
        const next = '/store/opencode.db#ses_b';
        store.get(PATH)!.push(text('said before the switch', 3));
        store.set(next, [prompt('a new session', 4)]);

        const r2 = make(rig);
        await advance(r2, 5000, watching(r2, next));
        expect(texts(rig)).toEqual(['hello', 'hi', 'said before the switch', 'a new session']);
    });
});
