// The always-on recorder (I28), across a listener restart: chunks still waiting in the outbox of a
// session that is gone, and the state file of a session that has been quiet for a long time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
    RECORDER_STATE_TTL_MS,
    createTurnRecorder,
    readSessionState,
    type OutboxChunk,
    type RecorderRecipient,
    type UploadOutcome,
} from './turn-recorder.js';
import { projectTranscriptEntries, type TurnEvent } from './transcript-tail.js';

const DEVICE = 'dev_listener_lifecycle';
const PHONE: RecorderRecipient = { deviceId: 'dev_phone', publicKey: 'phone-key' };
let dir: string;
let stateDir: string;
let clock: number;
let stamp: number;

const ts = (): string => new Date(Date.UTC(2026, 8, 1) + ++stamp * 1000).toISOString();
const line = (o: Record<string, unknown>): string => `${JSON.stringify({ timestamp: ts(), ...o })}\n`;
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
const answer = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const transcript = (n: string) => join(dir, `${n}.jsonl`);

interface Rig { uploads: { sessionKey: string; chunk: OutboxChunk }[]; outcome: UploadOutcome }
const make = (rig: Rig, device: string = DEVICE) =>
    createTurnRecorder({
        dir: stateDir,
        deviceId: () => device,
        uploadReady: () => true,
        devicePublicKey: () => 'listener-key',
        latestSeq: async () => null,
        projectorFor: (k) => (k === 'claude' ? projectTranscriptEntries : null),
        recipients: async () => [PHONE],
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
const opened = (c: OutboxChunk): { events: TurnEvent[] } => JSON.parse(Buffer.from(c.sealed.body, 'base64').toString('utf-8'));
const texts = (rig: Rig, key: string): string[] =>
    rig.uploads.filter((u) => u.sessionKey === key).flatMap((u) => opened(u.chunk).events.map((e) => (e as { text?: string }).text ?? e.kind));
const advance = async (r: ReturnType<typeof make>, ms: number, observe?: () => void) => {
    for (let s = 0; s < ms; s += 1000) { clock += 1000; observe?.(); await r.tick(); }
};

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-recorder-lifecycle-'));
    stateDir = join(dir, 'state');
    clock = 1_790_000_000_000;
    stamp = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('chunks and state files across a restart', () => {
    it('chunks waiting in the outbox of a session that is gone after a restart (reboot kills tmux) still go out', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'retry', why: 'offline' } };
        writeFileSync(transcript('a'), prompt('last words') + answer('bye'));
        const r1 = make(rig);
        const obsA = () => r1.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } });
        await advance(r1, 3000, obsA);
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)?.outbox.length).toBe(1);
        r1.stop();

        // Listener restarts; session hwip-a did not survive (reboot), another session is live.
        rig.outcome = { kind: 'ok' };
        writeFileSync(transcript('b'), prompt('other'));
        const r2 = make(rig);
        r2.start(); // sweeps the state directory and takes up sessions that still have chunks waiting
        r2.stop();
        await advance(r2, 30 * 60_000, () => r2.observe({ 'hwip-b': { path: transcript('b'), kind: 'claude', runId: '1789999999' } }));
        expect(texts(rig, `${DEVICE}:hwip-b`)).toEqual(['other']);
        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['last words', 'bye']);
    });

    it('a session that is gone after a restart is read to the end of its transcript too, and then forgotten', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'retry', why: 'offline' } };
        writeFileSync(transcript('a'), prompt('last words'));
        const r1 = make(rig);
        await advance(r1, 3000, () => r1.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } }));
        r1.stop();
        // The agent said more before the machine went down, after the last chunk was written.
        appendFileSync(transcript('a'), answer('written while the listener was down'));

        rig.outcome = { kind: 'ok' };
        const r2 = make(rig);
        r2.start();
        r2.stop();
        await advance(r2, 5 * 60_000, () => undefined);

        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['last words', 'written while the listener was down']);
        expect(r2.size()).toBe(0);
    });

    // The file the session left was written by the kind the state names, not by the kind of the file it writes now.
    it('reads the file a session left with the projector of the kind that wrote it', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        writeFileSync(transcript('old'), prompt('one'));
        const r1 = make(rig);
        await advance(r1, 3000, () => r1.observe({ 'hwip-a': { path: transcript('old'), kind: 'claude', runId: '1789999999' } }));
        r1.stop();
        appendFileSync(transcript('old'), answer('said just before the switch'));
        writeFileSync(transcript('new'), '');

        // The same tmux name now runs another agent: its kind has no projector here.
        const r2 = make(rig);
        await advance(r2, 10_000, () => r2.observe({ 'hwip-a': { path: transcript('new'), kind: 'codex', runId: '1789999999' } }));

        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['one', 'said just before the switch']);
    });

    it('takes up a drained session too: nothing new goes out, and it is forgotten after the linger', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        writeFileSync(transcript('a'), prompt('one'));
        const r1 = make(rig);
        await advance(r1, 3000, () => r1.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } }));
        r1.stop();
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)?.outbox).toEqual([]);
        const sent = rig.uploads.length;
        expect(sent).toBeGreaterThan(0);

        const r2 = make(rig);
        r2.start();
        expect(r2.size()).toBe(1);
        await advance(r2, 5 * 60_000, () => undefined);
        r2.stop();

        expect(rig.uploads.length).toBe(sent);
        expect(r2.size()).toBe(0);
    });

    it('reads what a drained session gained while the listener was down', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        writeFileSync(transcript('a'), prompt('one'));
        const r1 = make(rig);
        await advance(r1, 3000, () => r1.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } }));
        r1.stop();
        expect(readSessionState(stateDir, `${DEVICE}:hwip-a`)?.outbox).toEqual([]);
        // The agent said more before the machine went down, after the last chunk was written.
        appendFileSync(transcript('a'), answer('written while the listener was down'));

        const r2 = make(rig);
        r2.start();
        r2.stop();
        await advance(r2, 5 * 60_000, () => undefined);

        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['one', 'written while the listener was down']);
        expect(r2.size()).toBe(0);
    });

    it('forgets a drained session whose transcript is gone without uploading', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        writeFileSync(transcript('a'), prompt('one'));
        const r1 = make(rig);
        await advance(r1, 3000, () => r1.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } }));
        r1.stop();
        rmSync(transcript('a'));
        const sent = rig.uploads.length;
        expect(sent).toBeGreaterThan(0);

        const r2 = make(rig);
        r2.start();
        expect(r2.size()).toBe(1);
        await advance(r2, 5 * 60_000, () => undefined);
        r2.stop();

        expect(rig.uploads.length).toBe(sent);
        expect(r2.size()).toBe(0);
    });

    // Chunks sealed for another device record could not be uploaded against this one.
    it('does not take up chunks that wait under another device id', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'retry', why: 'offline' } };
        writeFileSync(transcript('a'), prompt('one'));
        const other = make(rig, 'dev_listener_other');
        await advance(other, 3000, () => other.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } }));
        other.stop();
        expect(readSessionState(stateDir, 'dev_listener_other:hwip-a')?.outbox).toHaveLength(1);

        const mine = make(rig);
        mine.start();
        mine.stop();

        expect(mine.size()).toBe(0);
    });

    it('an idle-but-alive session whose state file passed the 30-day TTL does not re-upload what was already sent', async () => {
        const rig: Rig = { uploads: [], outcome: { kind: 'ok' } };
        writeFileSync(transcript('a'), prompt('one') + answer('two'));
        const r1 = make(rig);
        const obs = (r: ReturnType<typeof make>) => () => r.observe({ 'hwip-a': { path: transcript('a'), kind: 'claude', runId: '1789999999' } });
        await advance(r1, 3000, obs(r1));
        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['one', 'two']);
        r1.stop();

        const file = join(stateDir, `${createHash('sha256').update(`${DEVICE}:hwip-a`).digest('hex').slice(0, 24)}.json`);
        const old = (clock - RECORDER_STATE_TTL_MS - 60_000) / 1000;
        utimesSync(file, old, old);
        const r2 = make(rig);
        r2.start(); // sweeps
        r2.stop();
        await advance(r2, 5000, obs(r2));
        expect(texts(rig, `${DEVICE}:hwip-a`)).toEqual(['one', 'two']);
    });
});
