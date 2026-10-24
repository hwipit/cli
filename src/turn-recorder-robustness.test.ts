import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    RECORDER_BACKFILL_EVENTS,
    RECORDER_BACKOFF_BASE_MS,
    RECORDER_FLUSH_BYTES,
    RECORDER_MAX_RECIPIENTS,
    RECORDER_OUTBOX_MAX,
    RECORDER_PAUSE_MS,
    RECORDER_QUIET_MS,
    RECORDER_STATE_TTL_MS,
    chooseRecipients,
    createTurnRecorder,
    readSessionState,
    sweepRecorderState,
    type OutboxChunk,
    type RecorderRecipient,
    type SealedChunk,
    type UploadOutcome,
} from './turn-recorder.js';
import { projectTranscriptEntries, type TurnEvent } from './transcript-tail.js';

// The always-on recorder (I28), reading side: a file that ends inside a multi-byte
// character, one replaced under the same name, an oversized line that never ends,
// invalid UTF-8 in a held partial line. Fake transcript files, a fake clock, a fake
// server — nothing here touches a listener, a network or the user's state.

const DEVICE = 'dev_listener_abc123';
const PHONE: RecorderRecipient = { deviceId: 'dev_phone', publicKey: 'phone-key' };

let dir: string;
let stateDir: string;
let clock: number;
let logs: string[];
let stamp: number;

const ts = (): string => new Date(Date.UTC(2026, 9, 2, 0, 0, 0) + ++stamp * 1000).toISOString();
const line = (obj: Record<string, unknown>): string => `${JSON.stringify({ timestamp: ts(), ...obj })}\n`;
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
const answer = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (id: string, name = 'Read') =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: '/p/a.ts' } }] } });

const transcript = (name: string): string => join(dir, `${name}.jsonl`);

/** Stand-in seal: readable in tests, shaped like the push-v1 envelope the server stores. */
const fakeSeal = async (plaintext: string, recipients: RecorderRecipient[]): Promise<SealedChunk> => ({
    body: JSON.stringify({ ciphertext: Buffer.from(plaintext).toString('base64'), iv: 'iv' }),
    deviceKeyMap: Object.fromEntries(recipients.map((r) => [r.deviceId, '{"encryptedKey":"k","keyIv":"i"}'])),
    senderPublicKey: 'listener-key',
});
const opened = (chunk: OutboxChunk): { sessionKey: string; seq: number; events: TurnEvent[] } =>
    JSON.parse(Buffer.from((JSON.parse(chunk.sealed.body) as { ciphertext: string }).ciphertext, 'base64').toString('utf-8'));

interface Rig {
    uploads: { sessionKey: string; chunk: OutboxChunk }[];
    outcome: (name: string) => UploadOutcome;
    recipients: RecorderRecipient[];
    sealFails: boolean;
    ready: boolean;
    deviceKey: string | null;
    latest: number | null;
    projector: typeof projectTranscriptEntries;
    dir?: string;
}

const makeRecorder = (rig: Rig) =>
    createTurnRecorder({
        dir: rig.dir ?? stateDir,
        deviceId: () => DEVICE,
        uploadReady: () => rig.ready,
        devicePublicKey: () => rig.deviceKey,
        latestSeq: async () => rig.latest,
        projectorFor: (kind) => (kind === 'claude' ? rig.projector : null),
        recipients: async () => rig.recipients,
        seal: async (plaintext, recipients) => {
            if (rig.sealFails) throw new Error('no key');
            return { ...(await fakeSeal(plaintext, recipients)), senderPublicKey: rig.deviceKey ?? 'listener-key' };
        },
        upload: async (sessionKey, chunk) => {
            const outcome = rig.outcome(sessionKey);
            if (outcome.kind === 'ok') rig.uploads.push({ sessionKey, chunk });
            return outcome;
        },
        log: (m) => logs.push(m),
        now: () => clock,
    });

const newRig = (): Rig => ({
    uploads: [],
    outcome: () => ({ kind: 'ok' }),
    recipients: [PHONE],
    sealFails: false,
    ready: true,
    deviceKey: 'listener-key',
    latest: null,
    projector: projectTranscriptEntries,
});

/** Run ticks, moving the clock forward by `ms` in total. */
const advance = async (recorder: ReturnType<typeof makeRecorder>, ms: number, step = 1000): Promise<void> => {
    for (let spent = 0; spent < ms; spent += step) {
        clock += step;
        await recorder.tick();
    }
};

const eventsOf = (rig: Rig): TurnEvent[] => rig.uploads.flatMap((u) => opened(u.chunk).events);
const kinds = (events: TurnEvent[]): string[] => events.map((e) => e.kind);

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-recorder-'));
    stateDir = join(dir, 'state');
    clock = 1_790_000_000_000;
    logs = [];
    stamp = 0;
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});


const texts = (rig: Rig): (string | undefined)[] => eventsOf(rig).map((e) => (e as { text?: string }).text);
const watch = (r: ReturnType<typeof makeRecorder>, name: string) => r.observe({ 'hwip-a': { path: transcript(name), kind: 'claude', runId: '1789999999' } });

describe('the recorder reads a transcript that is torn, replaced or cut short', () => {
    it('an abandoned file that ends in a torn multi-byte character still lets the session move on', async () => {
        const rig = newRig();
        writeFileSync(transcript('old'), prompt('one'));
        const rec = makeRecorder(rig);
        watch(rec, 'old');
        await advance(rec, 1000);
        // agent died mid-write of a Korean line: last char 한 (ED 95 9C) has only 2 of its 3 bytes
        appendFileSync(transcript('old'), answer('before'));
        appendFileSync(transcript('old'), Buffer.concat([Buffer.from('{"type":"user","message":{"role":"user","content":"'), Buffer.from([0xed, 0x95])]));
        writeFileSync(transcript('new'), prompt('after clear'));
        for (let i = 0; i < 30; i++) { watch(rec, 'new'); await advance(rec, 1000); }
        expect(texts(rig)).toEqual(['one', 'before', 'after clear']);
    });

    it('a same-name replacement while followed reads the new content from its start, not a 256 KB window', async () => {
        const rig = newRig();
        const history = prompt('one') + answer('two');
        writeFileSync(transcript('a'), history);
        const rec = makeRecorder(rig);
        watch(rec, 'a');
        await advance(rec, 1000);
        let fresh = '';
        for (let i = 0; i < 3000; i++) fresh += answer(`n${i} ${'x'.repeat(80)}`);
        writeFileSync(`${transcript('a')}.next`, history + fresh);
        renameSync(`${transcript('a')}.next`, transcript('a'));
        expect(statSync(transcript('a')).size).toBeGreaterThan(256 * 1024);
        for (let i = 0; i < 60; i++) { watch(rec, 'a'); await advance(rec, 1000); }
        const t = texts(rig);
        expect(t.length).toBe(3002);
        expect(t[2]!.startsWith('n0 ')).toBe(true);
    });

    it('events read before a torn oversized line in the current file go out eventually, and the session is forgotten', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one'));
        const rec = makeRecorder(rig);
        watch(rec, 'a');
        await advance(rec, 1000);
        // the agent was killed while writing a huge tool_result; tmux session gone
        appendFileSync(transcript('a'), answer('before tear') + '{"type":"user","pad":"' + 'z'.repeat(1_300_000));
        await advance(rec, 2000);
        rec.observe({});
        await advance(rec, 600_000, 5000);
        expect(texts(rig)).toEqual(['one', 'before tear']);
        expect(rec.size()).toBe(0);
    });

    it('invalid UTF-8 in a held partial line does not move the committed offset back (no duplicates after restart)', async () => {
        const rig = newRig();
        let lines = '';
        for (let i = 0; i < 10; i++) lines += answer(`line${i}`);
        writeFileSync(transcript('a'), lines);
        appendFileSync(transcript('a'), Buffer.concat([Buffer.from('{"type":"assistant","x":"'), Buffer.alloc(150, 0xff), Buffer.from('abc')]));
        const first = makeRecorder(rig);
        watch(first, 'a');
        await advance(first, 4000);
        expect(texts(rig)).toHaveLength(10);
        // restart: the line completes, one new answer
        appendFileSync(transcript('a'), '"}\n' + answer('after'));
        const second = makeRecorder(rig);
        watch(second, 'a');
        await advance(second, 4000);
        expect(texts(rig)).toEqual([...Array.from({ length: 10 }, (_, i) => `line${i}`), 'after']);
    });

    it('an abandoned file left inside an oversized line is committed at its end, not in the middle of the line', async () => {
        const rig = newRig();
        writeFileSync(transcript('old'), prompt('one'));
        const rec = makeRecorder(rig);
        watch(rec, 'old');
        await advance(rec, 1000);
        appendFileSync(transcript('old'), answer('before') + '{"type":"user","pad":"' + 'z'.repeat(1_600_000));
        for (let i = 0; i < 4; i++) { watch(rec, 'old'); await advance(rec, 1000); }
        writeFileSync(transcript('new'), ''); // the session writes elsewhere now, and has not said anything yet
        for (let i = 0; i < 20; i++) { watch(rec, 'new'); await advance(rec, 1000); }

        expect(texts(rig)).toEqual(['one', 'before']);
        const state = readSessionState(stateDir, `${DEVICE}:hwip-a`)!;
        expect(state.path).toBe(transcript('old'));
        // A restart resumes at the end of that file, not inside the line it was cut in.
        expect(state.offset).toBe(statSync(transcript('old')).size);
    });

    it('a file truncated in place and then written again is not uploaded twice', async () => {
        const rig = newRig();
        const history = prompt('one') + answer('two');
        writeFileSync(transcript('a'), history);
        const rec = makeRecorder(rig);
        watch(rec, 'a');
        await advance(rec, 4000);
        expect(texts(rig)).toEqual(['one', 'two']);

        writeFileSync(transcript('a'), '');
        for (let i = 0; i < 3; i++) { watch(rec, 'a'); await advance(rec, 1000); }
        appendFileSync(transcript('a'), history + answer('three'));
        for (let i = 0; i < 6; i++) { watch(rec, 'a'); await advance(rec, 1000); }

        expect(texts(rig)).toEqual(['one', 'two', 'three']);
    });

    it('an abandoned file torn inside an ASCII line moves on fine', async () => {
        const rig = newRig();
        writeFileSync(transcript('old'), prompt('one'));
        const rec = makeRecorder(rig);
        watch(rec, 'old');
        await advance(rec, 1000);
        appendFileSync(transcript('old'), answer('before'));
        appendFileSync(transcript('old'), '{"type":"user","message":{"role":"user","content":"ab');
        writeFileSync(transcript('new'), prompt('after clear'));
        for (let i = 0; i < 30; i++) { watch(rec, 'new'); await advance(rec, 1000); }
        expect(texts(rig)).toEqual(['one', 'before', 'after clear']);
    });

    it('a current file that ends in a torn multi-byte char still flushes what it read on quiet', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one'));
        const rec = makeRecorder(rig);
        watch(rec, 'a');
        await advance(rec, 1000);
        appendFileSync(transcript('a'), Buffer.concat([Buffer.from(answer('before')), Buffer.from('{"type":"user","message":{"role":"user","content":"'), Buffer.from([0xed, 0x95])]));
        for (let i = 0; i < 30; i++) { watch(rec, 'a'); await advance(rec, 1000); }
        expect(texts(rig)).toEqual(['one', 'before']);
    });
});
