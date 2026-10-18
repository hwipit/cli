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
    RECORDER_RECIPIENTS_TIMEOUT_MS,
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

// The always-on recorder (I28): reads every known session's transcript with no
// viewer, and uploads sealed chunks. Fake transcript files, a fake clock, a fake
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

describe('first sight of a session', () => {
    it('uploads the conversation so far, sealed with the session key in the body', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('hello') + answer('hi there') + tool('t1'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });

        await advance(recorder, 1000);

        expect(rig.uploads).toHaveLength(1);
        const { sessionKey, chunk } = rig.uploads[0]!;
        expect(sessionKey).toBe(`${DEVICE}:hwip-a`);
        const body = opened(chunk);
        expect(body.sessionKey).toBe(`${DEVICE}:hwip-a`);
        expect(body.seq).toBe(chunk.seq);
        expect(kinds(body.events)).toEqual(['prompt', 'text', 'tool']);
        expect(chunk.sealed.deviceKeyMap).toEqual({ dev_phone: expect.any(String) });
        expect(Date.parse(chunk.firstAt)).toBeLessThanOrEqual(Date.parse(chunk.lastAt));
    });

    it('keeps only the last 400 events of a long transcript', async () => {
        const rig = newRig();
        let text = '';
        for (let i = 0; i < 600; i++) text += answer(`line ${i}`);
        writeFileSync(transcript('a'), text);
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });

        await advance(recorder, 3000);

        const events = eventsOf(rig);
        expect(events).toHaveLength(RECORDER_BACKFILL_EVENTS);
        expect(events[events.length - 1]).toMatchObject({ kind: 'text', text: 'line 599' });
        expect(events[0]).toMatchObject({ text: 'line 200' });
    });

    it('starts seq from the clock, so a wiped state directory cannot collide with what the server holds', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('x'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);

        const seq = rig.uploads[0]!.chunk.seq;
        expect(seq).toBeGreaterThan(Math.floor(clock / 1000) * 100);
        expect(seq).toBeLessThan(10 ** 12);
    });

    it('does nothing for an agent whose transcript this cannot read', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('x'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'gemini' } });
        await advance(recorder, 5000);
        expect(rig.uploads).toEqual([]);
    });
});

describe('when events go out', () => {
    const start = async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('first'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        rig.uploads.length = 0;
        return { rig, recorder };
    };

    it('waits for two seconds of quiet', async () => {
        const { rig, recorder } = await start();
        appendFileSync(transcript('a'), answer('working on it') + tool('t1'));

        await advance(recorder, 1000);
        expect(rig.uploads).toEqual([]);
        await advance(recorder, RECORDER_QUIET_MS);
        expect(kinds(eventsOf(rig))).toEqual(['text', 'tool']);
    });

    it('does not wait when a person has typed', async () => {
        const { rig, recorder } = await start();
        appendFileSync(transcript('a'), prompt('and another thing'));

        await advance(recorder, 1000);

        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });

    it('does not wait when 12 KB have piled up, and no chunk is bigger than that', async () => {
        const { rig, recorder } = await start();
        let burst = '';
        for (let i = 0; i < 12; i++) burst += answer('x'.repeat(2000));
        appendFileSync(transcript('a'), burst);

        await advance(recorder, 1000);

        expect(rig.uploads.length).toBeGreaterThanOrEqual(2);
        for (const { chunk } of rig.uploads) {
            const plaintext = Buffer.byteLength(JSON.stringify(opened(chunk).events), 'utf-8');
            expect(plaintext).toBeLessThanOrEqual(RECORDER_FLUSH_BYTES);
        }
        expect(eventsOf(rig)).toHaveLength(12);
    });

    it('numbers chunks upward and keeps events in file order across chunks', async () => {
        const { rig, recorder } = await start();
        for (let i = 0; i < 3; i++) {
            appendFileSync(transcript('a'), prompt(`p${i}`));
            await advance(recorder, 1000);
        }
        const seqs = rig.uploads.map((u) => u.chunk.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(eventsOf(rig).map((e) => (e as { text: string }).text)).toEqual(['p0', 'p1', 'p2']);
    });

    it('writes nothing when nothing was said', async () => {
        const { rig, recorder } = await start();
        const before = readdirSync(stateDir).map((n) => statSync(join(stateDir, n)).mtimeMs);
        await advance(recorder, 10_000);
        expect(rig.uploads).toEqual([]);
        expect(readdirSync(stateDir).map((n) => statSync(join(stateDir, n)).mtimeMs)).toEqual(before);
    });
});

describe('restarts and crashes', () => {
    it('picks up where it left off, without repeating what went out', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one') + answer('two'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(first, 1000);
        const sentBefore = eventsOf(rig).length;

        // The listener restarts; the conversation went on while it was down.
        appendFileSync(transcript('a'), prompt('three'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(second, 1000);

        expect(sentBefore).toBe(2);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'two', 'three']);
        const seqs = rig.uploads.map((u) => u.chunk.seq);
        expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    });

    it('does not lose a line that was still being written when the listener stopped', async () => {
        const rig = newRig();
        const half = prompt('written in two goes');
        const cut = Math.floor(half.length / 2);
        writeFileSync(transcript('a'), prompt('whole') + half.slice(0, cut));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(first, 3000);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['whole']);

        appendFileSync(transcript('a'), half.slice(cut));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(second, 3000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['whole', 'written in two goes']);
    });

    it('resends the stored bytes after a crash between sealing and uploading, then goes on', async () => {
        const rig = newRig();
        rig.outcome = () => ({ kind: 'retry', why: 'offline' });
        writeFileSync(transcript('a'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(first, 1000);
        const stored = readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox;
        expect(stored).toHaveLength(1);

        // Process gone; a new one finds the outbox on disk.
        rig.outcome = () => ({ kind: 'ok' });
        appendFileSync(transcript('a'), prompt('two'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(second, 1000);

        expect(rig.uploads[0]!.chunk).toEqual(stored[0]);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'two']);
    });

    it('keeps no conversation text in its state file', async () => {
        const rig = newRig();
        // A seal that hides its input, as the real one does.
        const recorder = createTurnRecorder({
            dir: stateDir,
            deviceId: () => DEVICE,
            projectorFor: () => projectTranscriptEntries,
            recipients: async () => [PHONE],
            seal: async () => ({ body: JSON.stringify({ ciphertext: 'AAAA', iv: 'BBBB' }), deviceKeyMap: { dev_phone: '{}' }, senderPublicKey: 'k' }),
            upload: async () => ({ kind: 'retry', why: 'offline' }),
            log: () => undefined,
            now: () => clock,
        });
        writeFileSync(transcript('a'), prompt('the password is hunter2') + answer('noted: hunter2'));
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 3000);

        const files = readdirSync(stateDir);
        expect(files).toHaveLength(1);
        const raw = readFileSync(join(stateDir, files[0]!), 'utf-8');
        expect(raw).not.toContain('hunter2');
        expect(raw).not.toContain('password');
        expect(rig.uploads).toEqual([]);
        expect((statSync(join(stateDir, files[0]!)).mode & 0o777).toString(8)).toBe('600');
    });

    it('ignores a state file that is damaged or belongs to another session', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(first, 1000);
        const file = join(stateDir, readdirSync(stateDir)[0]!);
        writeFileSync(file, '{not json');

        rig.uploads.length = 0;
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(second, 1000);

        // A fresh start: the conversation is backfilled, not lost and not a crash.
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });
});

describe('a transcript that changes while the listener is down', () => {
    it('finishes the old file before following the new one', async () => {
        const rig = newRig();
        const history = prompt('one');
        writeFileSync(transcript('old'), history);
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 1000);

        // Listener down: the conversation went on in the old file, then /clear.
        const offline = answer('said while offline');
        appendFileSync(transcript('old'), offline);
        writeFileSync(transcript('new'), prompt('after clear'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
        await advance(second, 3000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'said while offline', 'after clear']);
    });

    it('reads a new file from its start, not only its last 256 KB', async () => {
        const rig = newRig();
        writeFileSync(transcript('old'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 1000);

        let big = '';
        for (let i = 0; i < 3000; i++) big += answer(`n${i} ${'x'.repeat(80)}`);
        writeFileSync(transcript('new'), big);
        expect(statSync(transcript('new')).size).toBeGreaterThan(256 * 1024);
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
        await advance(second, 60_000);

        const texts = eventsOf(rig).map((e) => (e as { text?: string }).text ?? '');
        expect(texts).toHaveLength(3001);
        expect(texts[1]!.startsWith('n0 ')).toBe(true);
        expect(texts[3000]!.startsWith('n2999 ')).toBe(true);
    });

    it('drops copied history on every read of a new file, not only the first', async () => {
        const rig = newRig();
        let history = '';
        for (let i = 0; i < 3000; i++) history += answer(`h${i} ${'x'.repeat(80)}`);
        writeFileSync(transcript('old'), history);
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 60_000);
        const sent = eventsOf(rig).length;
        expect(statSync(transcript('old')).size).toBeGreaterThan(256 * 1024);

        // A resume: the new file opens with a copy of everything, then one new prompt.
        writeFileSync(transcript('new'), history + prompt('later'));
        const second = makeRecorder(rig);
        for (let i = 0; i < 40; i++) {
            second.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
            await advance(second, 1000);
        }

        expect(eventsOf(rig).slice(sent).map((e) => (e as { text?: string }).text)).toEqual(['later']);
    });

    it('does not repeat history when the same name becomes another file while it is followed', async () => {
        const rig = newRig();
        const history = prompt('one') + answer('two');
        writeFileSync(transcript('a'), history);
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);

        // Replaced in place (a new inode, same name), with the old entries first.
        writeFileSync(`${transcript('a')}.next`, history + prompt('three'));
        renameSync(`${transcript('a')}.next`, transcript('a'));
        await advance(recorder, 3000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'two', 'three']);
    });
});

describe('what is stored when the key or the line is odd', () => {
    it('drops a stored chunk sealed with a key this machine no longer has', async () => {
        const rig = newRig();
        rig.ready = false;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 3000);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox).toHaveLength(1);

        // device-keys.json was lost: a new keypair, so the server would answer 403 for that chunk for ever.
        rig.deviceKey = 'a-new-key';
        rig.ready = true;
        appendFileSync(transcript('a'), prompt('two'));
        await advance(recorder, 3000);

        expect(rig.uploads.map((u) => u.chunk.sealed.senderPublicKey)).toEqual(['a-new-key']);
        expect(logs.some((l) => l.includes('dropped chunk') && l.includes('key'))).toBe(true);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox).toEqual([]);
    });

    // What was read before the line goes out, resuming from where the line began: a restart in the middle of it
    // would parse its tail as a record, and holding everything back until it ended held the session for ever.
    it('commits only up to where the line too long to read began, while it is inside one', async () => {
        const rig = newRig();
        rig.sealFails = true;
        writeFileSync(transcript('a'), prompt('before'));
        const beforeEnd = statSync(transcript('a')).size;
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), '{"type":"user","pad":"' + 'z'.repeat(1_300_000));
        for (let i = 0; i < 12; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 1000);
        }
        rig.sealFails = false;
        for (let i = 0; i < 4; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 1000);
        }
        // A restart here must not resume inside that line: it resumes where the line began.
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.offset).toBe(beforeEnd);

        appendFileSync(transcript('a'), '"}\n' + prompt('after'));
        for (let i = 0; i < 4; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 1000);
        }
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['before', 'after']);
    });
});

describe('a file that ends badly, and copies without a time', () => {
    it('treats a torn oversized line at the end of an abandoned file as its end', async () => {
        const rig = newRig();
        writeFileSync(transcript('old'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 1000);

        // The agent died inside a huge line, then /clear began another file.
        appendFileSync(transcript('old'), prompt('before tear') + '{"type":"user","pad":"' + 'z'.repeat(1_300_000));
        writeFileSync(transcript('new'), prompt('after clear'));
        for (let i = 0; i < 20; i++) {
            first.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
            await advance(first, 1000);
        }

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'before tear', 'after clear']);
    });

    it('does not upload a copied event that carries no time', async () => {
        const rig = newRig();
        rig.projector = ((lines, opts) =>
            projectTranscriptEntries(lines, opts).map((e) => {
                if (e.kind !== 'tool_result') return e;
                const { at: _at, ...rest } = e;
                return rest;
            })) as typeof projectTranscriptEntries;
        const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } });
        const history = prompt('one') + result;
        writeFileSync(transcript('old'), history);
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 1000);
        const sent = eventsOf(rig).length;
        expect(kinds(eventsOf(rig))).toEqual(['prompt', 'tool_result']);

        writeFileSync(transcript('new'), history + prompt('later'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
        await advance(second, 3000);

        expect(eventsOf(rig).slice(sent).map((e) => (e as { text?: string }).text)).toEqual(['later']);
    });
});

describe('what the server says about a chunk', () => {
    const conflictOnce = (rig: Rig) => {
        let first = true;
        rig.outcome = () => {
            if (first) {
                first = false;
                return { kind: 'drop', why: 'HTTP 409 TURN_CONFLICT', conflict: true };
            }
            return { kind: 'ok' };
        };
    };

    it('after a 409 numbers the next chunk past what the server holds', async () => {
        const rig = newRig();
        conflictOnce(rig);
        rig.latest = 900_000_000_000;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), prompt('two'));
        await advance(recorder, 1000);

        expect(rig.uploads.map((u) => u.chunk.seq)).toEqual([900_000_000_001]);
    });

    it('after a 409 it still moves on when the server cannot say what it holds', async () => {
        const rig = newRig();
        conflictOnce(rig);
        rig.latest = null;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        const startedAt = Math.floor(clock / 1000) * 100;
        appendFileSync(transcript('a'), prompt('two'));
        await advance(recorder, 1000);

        expect(rig.uploads).toHaveLength(1);
        expect(rig.uploads[0]!.chunk.seq).toBeGreaterThan(startedAt + 100);
    });

    it('gives up on a chunk the server refuses five times in a row, and goes on with the next', async () => {
        const rig = newRig();
        let calls = 0;
        rig.outcome = () => {
            calls += 1;
            return calls <= 5 ? { kind: 'pause', why: 'HTTP 403 FORBIDDEN', untilMs: clock + 300_000, giveUpAfter: 5 } : { kind: 'ok' };
        };
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        for (let i = 0; i < 6; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 300_000, 50_000);
        }
        expect(rig.uploads).toEqual([]);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox).toEqual([]);
        expect(logs.some((l) => l.includes('dropped chunk') && l.includes('5 times'))).toBe(true);

        appendFileSync(transcript('a'), prompt('two'));
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['two']);
    });

    it('does not count refusals that are not 403s towards giving up on a chunk', async () => {
        const rig = newRig();
        let calls = 0;
        rig.outcome = () => {
            calls += 1;
            if (calls <= 4) return { kind: 'pause', why: 'HTTP 401 UNAUTHORIZED', untilMs: clock + 60_000 };
            if (calls === 5) return { kind: 'pause', why: 'HTTP 403 FORBIDDEN', untilMs: clock + 60_000, giveUpAfter: 5 };
            return { kind: 'ok' };
        };
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        for (let i = 0; i < 8; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 60_000, 30_000);
        }
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });

    it('counts only back-to-back 403s: a retry in between starts the count again', async () => {
        const rig = newRig();
        let calls = 0;
        rig.outcome = () => {
            calls += 1;
            if (calls === 5) return { kind: 'retry', why: 'HTTP 503' };
            if (calls <= 6) return { kind: 'pause', why: 'HTTP 403 FORBIDDEN', untilMs: clock + 60_000, giveUpAfter: 5 };
            return { kind: 'ok' };
        };
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        for (let i = 0; i < 10; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 60_000, 30_000);
        }
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });

    it('never lowers the numbering after a 409', async () => {
        const rig = newRig();
        conflictOnce(rig);
        rig.latest = 5;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), prompt('two'));
        await advance(recorder, 1000);
        expect(rig.uploads[0]!.chunk.seq).toBeGreaterThan(1_000_000_000);
    });

    it('does not take the time of the flush for the time of the last event sent', async () => {
        const rig = newRig();
        clock = Date.UTC(2026, 9, 3);
        writeFileSync(transcript('old'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(first, 1000);
        // A line with no time of its own: its chunk is stamped with the clock, which is later than the file's lines.
        appendFileSync(transcript('old'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'untimed' } })}\n`);
        await advance(first, 1000);

        writeFileSync(transcript('new'), prompt('after'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
        await advance(second, 3000);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'untimed', 'after']);
    });

    it('says how many chunks a session has sent today, every hundred', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('p0'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        for (let i = 1; i <= 100; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 1000);
            appendFileSync(transcript('a'), prompt(`p${i}`));
        }
        await advance(recorder, 1000);
        expect(rig.uploads.length).toBeGreaterThanOrEqual(100);
        expect(logs.filter((l) => l.includes('chunks sent today'))).toHaveLength(1);
    });
});

describe('upload failures', () => {
    it('retries the same chunk with a growing wait, and keeps later chunks behind it', async () => {
        const rig = newRig();
        let down = true;
        rig.outcome = () => (down ? { kind: 'retry', why: 'HTTP 503' } : { kind: 'ok' });
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), prompt('two'));
        await advance(recorder, 1000);
        const stored = readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox;
        expect(stored).toHaveLength(2);

        // A retry is not attempted before its wait is up.
        const calls = vi.fn(rig.outcome);
        rig.outcome = calls;
        await advance(recorder, RECORDER_BACKOFF_BASE_MS / 2);
        const early = calls.mock.calls.length;
        down = false;
        await advance(recorder, 10 * RECORDER_BACKOFF_BASE_MS);

        expect(early).toBeLessThanOrEqual(1);
        expect(rig.uploads.map((u) => u.chunk.seq)).toEqual(stored.map((c) => c.seq));
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox).toEqual([]);
    });

    it('a refusal pauses that session only', async () => {
        const rig = newRig();
        rig.outcome = (key) => (key.endsWith('hwip-a') ? { kind: 'pause', why: 'HTTP 429 TURN_DAILY_LIMIT' } : { kind: 'ok' });
        writeFileSync(transcript('a'), prompt('one'));
        writeFileSync(transcript('b'), prompt('other'));
        const recorder = makeRecorder(rig);
        recorder.observe({
            'hwip-a': { path: transcript('a'), kind: 'claude' },
            'hwip-b': { path: transcript('b'), kind: 'claude' },
        });
        await advance(recorder, 2000);

        expect(rig.uploads.map((u) => u.sessionKey)).toEqual([`${DEVICE}:hwip-b`]);
        expect(logs.filter((l) => l.includes('paused'))).toHaveLength(1);

        // Later the server takes it again.
        rig.outcome = () => ({ kind: 'ok' });
        await advance(recorder, RECORDER_PAUSE_MS + 2000);
        expect(rig.uploads.map((u) => u.sessionKey)).toContain(`${DEVICE}:hwip-a`);
    });

    it('stops reading while a full outbox waits, and loses nothing once the server is back', async () => {
        const rig = newRig();
        rig.outcome = () => ({ kind: 'retry', why: 'offline', afterMs: 60 * 60_000 });
        writeFileSync(transcript('a'), prompt('p0'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        for (let i = 1; i < RECORDER_OUTBOX_MAX + 5; i++) {
            appendFileSync(transcript('a'), prompt(`p${i}`));
            await advance(recorder, 1000);
        }
        const key = `${DEVICE}:hwip-a`;
        expect(readSessionState(stateDir, key)!.outbox).toHaveLength(RECORDER_OUTBOX_MAX);

        rig.outcome = () => ({ kind: 'ok' });
        await advance(recorder, 2 * 60 * 60_000, 60_000);

        const texts = eventsOf(rig).map((e) => (e as { text?: string }).text);
        expect(texts).toEqual(Array.from({ length: RECORDER_OUTBOX_MAX + 5 }, (_, i) => `p${i}`));
    });

    it('a seal that fails leaves everything as it was, and tries again', async () => {
        const rig = newRig();
        rig.sealFails = true;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 3000);
        expect(rig.uploads).toEqual([]);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)).toBeNull();
        expect(logs.filter((l) => l.includes('could not seal'))).toHaveLength(1);

        rig.sealFails = false;
        await advance(recorder, 1000);
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });
});

describe('what the recorder does when something is wrong', () => {
    it('drops a chunk the server will never take and goes on with the next', async () => {
        const rig = newRig();
        let calls = 0;
        rig.outcome = () => (++calls === 1 ? { kind: 'drop', why: 'HTTP 400 VALIDATION_ERROR' } : { kind: 'ok' });
        writeFileSync(transcript('a'), prompt('bad'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), prompt('good'));
        await advance(recorder, 1000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['good']);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)!.outbox).toEqual([]);
        expect(logs.filter((l) => l.includes('dropped chunk'))).toHaveLength(1);
    });

    it('keeps the events and tries again when the state cannot be written', async () => {
        const rig = newRig();
        const blocker = join(dir, 'blocker');
        writeFileSync(blocker, 'a file where the directory should be');
        rig.dir = join(blocker, 'state');
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 3000);
        expect(rig.uploads).toEqual([]);
        expect(logs.some((l) => l.includes('could not write state'))).toBe(true);

        rmSync(blocker);
        await advance(recorder, 1000);
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
        expect(rig.uploads).toHaveLength(1);
    });

    it('runs one step per session at a time', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let uploading = 0;
        const recorder = createTurnRecorder({
            dir: stateDir,
            deviceId: () => DEVICE,
            projectorFor: () => projectTranscriptEntries,
            recipients: async () => [PHONE],
            seal: fakeSeal,
            upload: async () => { uploading += 1; await gate; return { kind: 'ok' }; },
            log: () => undefined,
            now: () => clock,
        });
        writeFileSync(transcript('a'), prompt('one'));
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        const slow = recorder.tick();
        await recorder.tick();
        await recorder.tick();
        expect(uploading).toBe(1);
        release();
        await slow;
    });

    // A lookup that never answers must neither pile up a round a second nor hold every session for ever.
    it('asks for the recipients once while the last lookup is still out, however many rounds start', async () => {
        let asked = 0;
        const recorder = createTurnRecorder({
            dir: stateDir,
            deviceId: () => DEVICE,
            projectorFor: () => projectTranscriptEntries,
            recipients: () => { asked += 1; return new Promise<never>(() => undefined); },
            seal: fakeSeal,
            upload: async () => ({ kind: 'ok' }),
            log: () => undefined,
            now: () => clock,
        });
        writeFileSync(transcript('a'), prompt('one'));
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });

        // Rounds that ask while the lookup is out wait for it (up to its own timeout): they are not awaited here.
        void recorder.tick();
        void recorder.tick();
        void recorder.tick();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(asked).toBe(1);
    });

    // A round no longer waits for the last one: one slow upload held every session's prompts for as long as it took.
    it('does not hold the other sessions while one session\'s upload is slow', async () => {
        const gate = new Promise<void>(() => undefined);
        const sent: string[] = [];
        const recorder = createTurnRecorder({
            dir: stateDir,
            deviceId: () => DEVICE,
            projectorFor: () => projectTranscriptEntries,
            recipients: async () => [PHONE],
            seal: fakeSeal,
            upload: async (sessionKey, chunk) => {
                if (sessionKey.endsWith('hwip-a')) await gate;
                sent.push(`${sessionKey}#${chunk.seq}`);
                return { kind: 'ok' };
            },
            log: () => undefined,
            now: () => clock,
        });
        writeFileSync(transcript('a'), prompt('a0'));
        writeFileSync(transcript('b'), answer('b0'));
        const observe = () => recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' }, 'hwip-b': { path: transcript('b'), kind: 'claude' } });
        observe();
        void recorder.tick(); // a's upload hangs here
        await new Promise((resolve) => setTimeout(resolve, 5));
        appendFileSync(transcript('b'), prompt('b-prompt'));

        for (let i = 0; i < 5; i++) {
            clock += 1000;
            observe();
            await recorder.tick();
        }

        expect(sent.some((s) => s.includes('hwip-b'))).toBe(true);
    });

    it('gives up on a recipients lookup that does not answer, says so, and rounds go on', async () => {
        vi.useFakeTimers();
        try {
            let answer: 'hang' | 'phone' = 'hang';
            const rig = newRig();
            const recorder = createTurnRecorder({
                dir: stateDir,
                deviceId: () => DEVICE,
                projectorFor: () => projectTranscriptEntries,
                recipients: () => (answer === 'hang' ? new Promise<never>(() => undefined) : Promise.resolve(rig.recipients)),
                seal: fakeSeal,
                upload: async (sessionKey, chunk) => { rig.uploads.push({ sessionKey, chunk }); return { kind: 'ok' }; },
                log: (m) => logs.push(m),
                now: () => clock,
            });
            writeFileSync(transcript('a'), prompt('one'));
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });

            const round = recorder.tick();
            await vi.advanceTimersByTimeAsync(RECORDER_RECIPIENTS_TIMEOUT_MS);
            await round;
            expect(logs.some((l) => l.includes('could not learn who to seal for within 10 s'))).toBe(true);
            expect(rig.uploads).toEqual([]);

            // Still no answer a round later: said once, not every round.
            const again = recorder.tick();
            await vi.advanceTimersByTimeAsync(RECORDER_RECIPIENTS_TIMEOUT_MS);
            await again;
            expect(logs.filter((l) => l.includes('could not learn who to seal for')).length).toBe(1);

            answer = 'phone';
            clock += 3000;
            await recorder.tick();
            expect(kinds(eventsOf(rig))).toEqual(['prompt']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits to upload until the device key is registered, and says so once', async () => {
        const rig = newRig();
        rig.ready = false;
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 5000);
        expect(rig.uploads).toEqual([]);
        expect(logs.filter((l) => l.includes('key is not registered'))).toHaveLength(1);

        rig.ready = true;
        await advance(recorder, 1000);
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });

    it('survives a projector that throws, losing only what it could not read', async () => {
        const rig = newRig();
        let first = true;
        rig.projector = ((lines, opts) => {
            if (first) { first = false; throw new Error('boom'); }
            return projectTranscriptEntries(lines, opts);
        }) as typeof projectTranscriptEntries;
        writeFileSync(transcript('a'), prompt('unreadable'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        appendFileSync(transcript('a'), prompt('fine'));
        await advance(recorder, 1000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['fine']);
        expect(logs.some((l) => l.includes('could not read'))).toBe(true);
    });

    it('stops reading when events pile up unsealed, and loses none of them', async () => {
        const rig = newRig();
        let linesRead = 0;
        rig.projector = ((lines, opts) => {
            linesRead += lines.length;
            return projectTranscriptEntries(lines, opts);
        }) as typeof projectTranscriptEntries;
        writeFileSync(transcript('a'), prompt('start'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        rig.uploads.length = 0;

        rig.sealFails = true;
        let big = '';
        for (let i = 0; i < 16_000; i++) big += answer(`n${i} ${'y'.repeat(150)}`);
        appendFileSync(transcript('a'), big);
        await advance(recorder, 10_000);
        expect(rig.uploads).toEqual([]);
        // 16 000 lines are ~4.5 MB and ten ticks could read 2.5 MB of them; the recorder holds about 256 KiB of events.
        expect(linesRead).toBeLessThan(2300);

        rig.sealFails = false;
        // The sweep names the session again every few seconds, as it does in the listener.
        for (let i = 0; i < 300; i++) {
            recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
            await advance(recorder, 5000, 5000);
        }
        const texts = eventsOf(rig).map((e) => (e as { text?: string }).text ?? '');
        expect(texts).toHaveLength(16_000);
        expect(texts[0]!.startsWith('n0 ')).toBe(true);
        expect(texts[15_999]!.startsWith('n15999 ')).toBe(true);
    });
});

describe('who can read it', () => {
    it('reads nothing, and sends nothing, while no device is trusted', async () => {
        const rig = newRig();
        rig.recipients = [];
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 5000);
        expect(rig.uploads).toEqual([]);
        expect(readdirSync(dir).includes('state')).toBe(false);
        expect(logs.filter((l) => l.includes('no device to seal'))).toHaveLength(1);

        // The first device pins: what the conversation holds is sealed for it from here.
        rig.recipients = [PHONE];
        await advance(recorder, 1000);
        expect(kinds(eventsOf(rig))).toEqual(['prompt']);
    });

    it('seals for this machine and the newest pinned devices, up to the server limit', () => {
        const self = { deviceId: DEVICE, publicKey: 'self-key' };
        const pinned = Array.from({ length: 70 }, (_, i) => ({
            deviceId: `dev_${i}`,
            publicKey: `k${i}`,
            pinnedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        }));
        const chosen = chooseRecipients(self, pinned);
        expect(chosen).toHaveLength(RECORDER_MAX_RECIPIENTS);
        expect(chosen[0]).toEqual(self);
        expect(chosen.map((c) => c.deviceId)).toContain('dev_69');
        expect(chosen.map((c) => c.deviceId)).not.toContain('dev_0');
    });

    it('has no recipient at all when no device is pinned, whatever this machine holds', () => {
        expect(chooseRecipients({ deviceId: DEVICE, publicKey: 'k' }, [])).toEqual([]);
    });

    it('does not list this machine twice', () => {
        const self = { deviceId: DEVICE, publicKey: 'k' };
        expect(chooseRecipients(self, [{ deviceId: DEVICE, publicKey: 'k' }, PHONE]).map((c) => c.deviceId)).toEqual([DEVICE, 'dev_phone']);
    });
});

describe('the transcript changes name', () => {
    it('sends what the old file held, then follows the new one without repeating copied history', async () => {
        const rig = newRig();
        const history = prompt('old one') + answer('old two');
        writeFileSync(transcript('old'), history);
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude' } });
        await advance(recorder, 1000);
        const lastWords = answer('last words');
        appendFileSync(transcript('old'), lastWords);
        await advance(recorder, 500);

        // /clear or a compaction: the session now writes a new file that starts with a copy
        // (the same entries, the same stamps).
        writeFileSync(transcript('new'), history + lastWords + prompt('fresh start'));
        recorder.observe({ 'hwip-a': { path: transcript('new'), kind: 'claude' } });
        await advance(recorder, 3000);

        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['old one', 'old two', 'last words', 'fresh start']);
        const state = readSessionState(stateDir, `${DEVICE}:hwip-a`)!;
        expect(state.path).toBe(transcript('new'));
    });
});

describe('sessions that come and go', () => {
    it('keeps following a session for a while after the inventory drops it, then forgets it', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);
        recorder.observe({});
        appendFileSync(transcript('a'), prompt('goodbye'));
        await advance(recorder, 2000);
        expect(eventsOf(rig).map((e) => (e as { text?: string }).text)).toEqual(['one', 'goodbye']);

        await advance(recorder, 120_000);
        expect(recorder.size()).toBe(0);
    });

    it('records two sessions side by side under their own keys and seq', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('in a'));
        writeFileSync(transcript('b'), prompt('in b'));
        const recorder = makeRecorder(rig);
        recorder.observe({
            'hwip-a': { path: transcript('a'), kind: 'claude' },
            'hwip-b': { path: transcript('b'), kind: 'claude' },
        });
        await advance(recorder, 1000);
        expect(rig.uploads.map((u) => u.sessionKey).sort()).toEqual([`${DEVICE}:hwip-a`, `${DEVICE}:hwip-b`]);
        expect(readdirSync(stateDir)).toHaveLength(2);
    });
});

describe('sweepRecorderState', () => {
    it('removes old state that has nothing waiting, and keeps the rest', () => {
        const rig = newRig();
        const recorder = makeRecorder(rig);
        void recorder;
        const write = (name: string, outbox: unknown[]): string => {
            const file = join(stateDir, name);
            require('node:fs').mkdirSync(stateDir, { recursive: true });
            writeFileSync(file, JSON.stringify({ v: 1, outbox }));
            const old = new Date(clock - RECORDER_STATE_TTL_MS - 1000);
            utimesSync(file, old, old);
            return file;
        };
        const empty = write('empty.json', []);
        const waiting = write('waiting.json', [{ seq: 1 }]);
        sweepRecorderState(stateDir, clock);
        expect(existsSync(empty)).toBe(false);
        expect(existsSync(waiting)).toBe(true);
    });
});

describe('the to-do list', () => {
    const created = (id: string, subject: string) =>
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${id}`, content: 'ok' }] }, toolUseResult: { task: { id, subject } } });
    const moved = (id: string, to: string) =>
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${id}`, content: 'ok' }] }, toolUseResult: { taskId: id, statusChange: { from: 'pending', to } } });
    const todos = (rig: Rig) => eventsOf(rig).filter((e): e is Extract<TurnEvent, { kind: 'todo' }> => e.kind === 'todo');
    const stateFiles = () => readdirSync(stateDir).map((name) => readFileSync(join(stateDir, name), 'utf-8')).join('\n');

    it('carries the list from one chunk to the next', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('plan it') + created('1', 'write the probe') + created('2', 'ship it'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 5000);

        appendFileSync(transcript('a'), moved('1', 'completed'));
        await advance(recorder, 5000);

        expect(rig.uploads.length).toBeGreaterThanOrEqual(2);
        expect(todos(rig).at(-1)?.items).toEqual([
            { id: '1', text: 'write the probe', status: 'completed' },
            { id: '2', text: 'ship it', status: 'pending' },
        ]);
    });

    it('never writes the tasks\' words into its state on disk', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('plan it') + created('1', 'unmistakable-task-words'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 5000);

        expect(todos(rig)).toHaveLength(1);
        expect(stateFiles()).not.toContain('unmistakable-task-words');
    });

    it('does not carry one session file\'s list into the next', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('plan it') + created('1', 'old task'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 5000);

        writeFileSync(transcript('b'), prompt('fresh') + created('7', 'new task'));
        recorder.observe({ 'hwip-a': { path: transcript('b'), kind: 'claude' } });
        await advance(recorder, 5000);

        expect(todos(rig).at(-1)?.items.map((item) => item.text)).toEqual(['new task']);
    });
});

describe('separate runs of one name (hwip docs/session-runs.md)', () => {
    it('tags each chunk with the run that wrote it, and keeps numbering across runs', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('first run'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1790000000' } });
        await advance(recorder, 1000);

        // The agent ended; another started in the same folder under the same tmux name.
        writeFileSync(transcript('b'), prompt('second run'));
        recorder.observe({ 'hwip-a': { path: transcript('b'), kind: 'claude', runId: '1790003600' } });
        await advance(recorder, 3000);

        expect(rig.uploads.map((u) => [opened(u.chunk).events.map((e) => (e as { text?: string }).text), u.chunk.runId]))
            .toEqual([[['first run'], '1790000000'], [['second run'], '1790003600']]);
        expect(rig.uploads[1]!.chunk.seq).toBeGreaterThan(rig.uploads[0]!.chunk.seq);
    });

    it('sends what is left of the previous run\'s file under that run', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('one'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1790000000' } });
        await advance(first, 1000);

        // The old file grew while the listener was down, and a new run took the name.
        appendFileSync(transcript('a'), answer('late'));
        writeFileSync(transcript('b'), prompt('new'));
        const second = makeRecorder(rig);
        second.observe({ 'hwip-a': { path: transcript('b'), kind: 'claude', runId: '1790003600' } });
        await advance(second, 5000);

        const byText = Object.fromEntries(rig.uploads.flatMap((u) => opened(u.chunk).events.map((e) => [(e as { text?: string }).text, u.chunk.runId])));
        expect(byText).toEqual({ one: '1790000000', late: '1790000000', new: '1790003600' });
    });

    it('uploads a chunk a restart found waiting under the run it was recorded in', async () => {
        const rig = newRig();
        rig.outcome = () => ({ kind: 'retry', why: 'offline' });
        writeFileSync(transcript('a'), prompt('kept'));
        const first = makeRecorder(rig);
        first.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1790000000' } });
        await advance(first, 1000);
        expect(rig.uploads).toHaveLength(0);

        // The listener restarts (a reboot ends the tmux session): the chunk comes back from disk.
        rig.outcome = () => ({ kind: 'ok' });
        const second = makeRecorder(rig);
        second.start();
        try {
            await advance(second, 120_000, 10_000);
        } finally {
            second.stop();
        }

        expect(rig.uploads.map((u) => u.chunk.runId)).toEqual(['1790000000']);
    });

    it('sends no run for a session the sweep gave none', async () => {
        const rig = newRig();
        writeFileSync(transcript('a'), prompt('hello'));
        const recorder = makeRecorder(rig);
        recorder.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude' } });
        await advance(recorder, 1000);

        expect(rig.uploads[0]!.chunk).not.toHaveProperty('runId');
    });
});
