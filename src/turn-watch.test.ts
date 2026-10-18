import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createTurnWatchers,
    MAX_TURN_SEAL_FAILURES,
    MAX_TURN_WATCHERS,
    TRANSCRIPT_RECHECK_MS,
    TURN_LEASE_MS,
    TURN_POLL_INTERVAL_MS,
    MAX_REPLAY_EVENTS,
    MAX_TURN_FRAME_BYTES,
    type TurnWatchDeps,
} from './turn-watch.js';
import {
    projectTranscriptEntries,
    type TranscriptProjector,
    type TranscriptSource,
    type TurnEvent,
} from './transcript-tail.js';
import type { TurnRing } from './turn-ring.js';

const DEVICE = 'dev_listener_abc123';

let dir: string;
let sent: Record<string, unknown>[];
let logs: string[];
let clock: number;
let ring: Map<string, TurnEvent[]>;
let sweeps: number;

/** Real transcripts stamp every entry; the cut against the ring reads that stamp. */
let stamp = 0;
const at = () => new Date(Date.UTC(2026, 8, 8, 0, 0, ++stamp)).toISOString();

const line = (obj: Record<string, unknown>) => `${JSON.stringify({ timestamp: at(), ...obj })}\n`;
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const userPrompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });

/** In-memory stand-in for the disk ring — slice 01 owns the file behaviour. */
const makeRing = (): TurnRing => ({
    read: (session) => [...(ring.get(session) ?? [])],
    append: (session, events) => {
        ring.set(session, [...(ring.get(session) ?? []), ...events]);
        return true;
    },
    sweep: () => {
        sweeps++;
    },
});

const transcriptFor = (session: string) => join(dir, `${session}.jsonl`);

/** The pair `resolveTranscript` answers with. Claude's projector unless a test says otherwise. */
const sourceFor = (session: string, project: TranscriptProjector = projectTranscriptEntries): TranscriptSource => ({
    path: transcriptFor(session),
    project,
});

const makeDeps = (over: Partial<TurnWatchDeps> = {}): TurnWatchDeps => ({
    deviceId: () => DEVICE,
    resolveTranscript: (session) => sourceFor(session),
    sessionExists: () => true,
    initCrypto: async () => {},
    seal: async (plaintext) => ({ ciphertext: `sealed:${plaintext.length}` }),
    log: (m) => logs.push(m),
    now: () => clock,
    ring: makeRing(),
    ...over,
});

const send = (data: Record<string, unknown>) => {
    sent.push(data);
};

const start = (session: string, extra: Record<string, unknown> = {}) => ({
    subtype: 'agent.turn.watch.start',
    targetDeviceId: DEVICE,
    sessionName: session,
    ...extra,
});

const deltas = () => sent.filter((f) => f.subtype === 'agent.turn.delta');

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-turn-'));
    sent = [];
    logs = [];
    clock = 1_000_000;
    ring = new Map();
    sweeps = 0;
    stamp = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('turn watch control', () => {
    it('ignores control messages addressed to another machine', () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('hi'));

        const handled = watchers.handle({ ...start('s1'), targetDeviceId: 'dev_listener_other' }, send);

        expect(handled).toBe(false);
        expect(watchers.size()).toBe(0);
    });

    it('ignores messages that are not watch control at all', () => {
        const watchers = createTurnWatchers(makeDeps());
        expect(watchers.handle({ subtype: 'agent.stream.start', targetDeviceId: DEVICE, sessionName: 's1' }, send)).toBe(false);
    });

    it('refuses a session with no Claude transcript instead of showing an empty timeline', () => {
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => null }));

        watchers.handle(start('codex-session'), send);

        expect(sent).toEqual([
            { subtype: 'agent.turn.watch.error', sessionName: 'codex-session', error: 'no_transcript' },
        ]);
        expect(watchers.size()).toBe(0);
    });

    it('stops the watch instead of floating a rejection when a read throws', async () => {
        const ring = makeRing();
        ring.read = () => { throw new Error('disk gone'); };
        const watchers = createTurnWatchers(makeDeps({ ring }));
        writeFileSync(transcriptFor('s1'), userPrompt('hi'));
        watchers.handle(start('s1'), send);

        await expect(watchers.tick('s1')).resolves.toBeUndefined();
        expect(watchers.size()).toBe(0);
        expect(logs.some((m) => m.includes('s1') && m.includes('disk gone'))).toBe(true);
    });

    // On the phone a resolver that is broken and an agent that has no timeline
    // produce the same sentence. The log is the only place the two are told
    // apart, so the resolver's own account of the null has to reach it — this is
    // the case the reason channel exists for: a row that HAS a resolver, whose
    // path rule came back empty-handed.
    it('logs the resolver\'s reason when a path rule finds nothing', () => {
        const watchers = createTurnWatchers(
            makeDeps({
                resolveTranscript: (_session, onMiss) => {
                    onMiss?.('pi resolver found no transcript under /tmp/proj');
                    return null;
                },
            }),
        );

        watchers.handle(start('pi-session'), send);

        expect(logs.filter((l) => l.includes('pi resolver found no transcript under /tmp/proj'))).toHaveLength(1);
    });

    // The other half of the same distinction: a row with no resolver at all is
    // working as designed, and must not read like the broken case above.
    it('says which branch refused when the agent has no resolver at all', () => {
        const watchers = createTurnWatchers(
            makeDeps({
                resolveTranscript: (_session, onMiss) => {
                    onMiss?.('gemini has no transcript resolver');
                    return null;
                },
            }),
        );

        watchers.handle(start('gemini-session'), send);

        const line = logs.find((l) => l.includes('gemini has no transcript resolver'));
        expect(line).toContain('no transcript to watch');
    });

    // A watch that was reading a file a tick ago and now cannot is a loss, not
    // an agent that never had a timeline. Reporting it with the same sentence
    // as the never-had-one case is a false statement in the log.
    it('distinguishes a transcript that disappeared from one that never existed', async () => {
        let source: TranscriptSource | null = null;
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => source }));
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        source = sourceFor('s1');
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        source = null;
        watchers.handle(start('s1'), send);

        expect(logs.some((l) => l.includes('the transcript this watch was following is gone'))).toBe(true);
        expect(logs.some((l) => l.includes('no transcript to watch'))).toBe(false);
    });

    // Every tick re-resolves on its own cadence; logging there would turn one
    // unsupported agent into a line every ten seconds for as long as the viewer
    // keeps the tab open.
    it('does not repeat the refusal log once a watch is running', async () => {
        let path: string | null = transcriptFor('s1');
        const watchers = createTurnWatchers(
            makeDeps({
                resolveTranscript: (_session, onMiss) => {
                    if (path !== null) return { path, project: projectTranscriptEntries };
                    onMiss?.('resolver found nothing');
                    return null;
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);

        path = null;
        for (let i = 0; i < 3; i++) {
            clock += TRANSCRIPT_RECHECK_MS;
            await watchers.tick('s1');
        }

        expect(logs.filter((l) => l.includes('resolver found nothing'))).toHaveLength(0);
    });

    it('refuses past MAX_TURN_WATCHERS', () => {
        const watchers = createTurnWatchers(makeDeps());
        for (let i = 0; i < MAX_TURN_WATCHERS + 1; i++) {
            writeFileSync(transcriptFor(`s${i}`), userPrompt('hi'));
            watchers.handle(start(`s${i}`), send);
        }

        expect(watchers.size()).toBe(MAX_TURN_WATCHERS);
        expect(sent.at(-1)).toMatchObject({ error: 'watch_limit' });
    });

    // A Claude Code session and its in-process subagents are separate watches
    // of separate transcripts, so one session can fill the machine's slots by
    // itself. The refusal has to name the session that was turned away — the
    // phone puts the message on that view, and a watch it never asked for is
    // not the one the reader is staring at.
    it('refuses a subagent by its own name once the parent filled the slots', () => {
        const watchers = createTurnWatchers(makeDeps());
        for (const session of ['hwip-app', 'hwip-app.1', 'hwip-app.2', 'hwip-app.3']) {
            writeFileSync(transcriptFor(session), userPrompt('hi'));
            watchers.handle(start(session), send);
        }

        expect(watchers.size()).toBe(MAX_TURN_WATCHERS);
        expect(sent.at(-1)).toMatchObject({
            subtype: 'agent.turn.watch.error',
            sessionName: 'hwip-app.3',
            error: 'watch_limit',
        });
    });

    it('answers a renew for a watch that no longer exists', () => {
        const watchers = createTurnWatchers(makeDeps());

        watchers.handle({ subtype: 'agent.turn.watch.renew', targetDeviceId: DEVICE, sessionName: 's1' }, send);

        expect(sent).toEqual([{ subtype: 'agent.turn.watch.gone', sessionName: 's1' }]);
    });
});

describe('turn watch streaming', () => {
    // opencode's transcript is a database, not a file: its source carries a
    // reader, and the watch has to use it — tailing the "path" as a file would
    // read nothing and the phone would see an empty timeline.
    it('reads a source through its own reader when it has one', async () => {
        const read = vi.fn((_path: string, prev: unknown) =>
            prev
                ? null
                : {
                      lines: [JSON.stringify({ kind: 'prompt', text: 'from the db', at: at() })],
                      state: { offset: 1, size: 0, mtimeMs: 0, ino: 0, carry: '', resyncing: false, salvage: [], cursor: { n: 1 } },
                      bytesRead: 0,
                      droppedLines: 0,
                  },
        );
        const project: TranscriptProjector = (lines) => lines.map((l) => JSON.parse(l) as TurnEvent);
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => ({ path: '/store/opencode.db#ses_a', project, read }) }));

        watchers.handle(start('oc'), send);
        await watchers.tick('oc');
        await watchers.tick('oc');

        expect(read).toHaveBeenNthCalledWith(1, '/store/opencode.db#ses_a', null);
        // The reader's own state comes back to it, cursor and all.
        expect(read).toHaveBeenNthCalledWith(2, '/store/opencode.db#ses_a', expect.objectContaining({ cursor: { n: 1 } }));
        expect(JSON.stringify(deltas().flatMap((f) => f.events as unknown[]))).toContain('from the db');
    });

    it('backfills only the in-flight turn, so finished turns stay the pushes they already are', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(
            transcriptFor('s1'),
            userPrompt('old turn') + toolUse('t1', 'Read', { file_path: '/old.ts' }) + userPrompt('current') + toolUse('t2', 'Read', { file_path: '/new.ts' }),
        );

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const events = deltas().flatMap((f) => f.events as unknown[]);
        expect(JSON.stringify(events)).not.toContain('/old.ts');
        expect(JSON.stringify(events)).toContain('/new.ts');
    });

    it('emits new tool calls as they are appended', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        appendFileSync(transcriptFor('s1'), toolUse('t9', 'Bash', { description: 'Run the tests' }));
        await watchers.tick('s1');

        const latest = deltas().at(-1)!;
        expect(deltas().length).toBeGreaterThan(before);
        // `at` comes from the entry's own `timestamp`, which every real
        // transcript carries and the cut against the ring reads.
        expect(latest.events).toEqual([
            { kind: 'tool', id: 't9', name: 'Bash', target: 'Run the tests', at: expect.any(String) },
        ]);
        expect(latest.seq).toBe(deltas().length);
    });

    // C70: what the projector skips as unknown is logged, once per kind per
    // watch, not once per line or per tick.
    it('logs an entry kind the projector skips, once per watch', async () => {
        const project: TranscriptProjector = (lines, opts) => {
            for (const l of lines) if (l.includes('mystery')) opts?.onUnknown?.('codex item Mystery');
            return projectTranscriptEntries(lines, opts);
        };
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: (session) => sourceFor(session, project) }));
        writeFileSync(transcriptFor('s1'), userPrompt('go') + '{"mystery":1}\n{"mystery":2}\n');
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), '{"mystery":3}\n');
        await watchers.tick('s1');
        expect(logs.filter((m) => m.includes('skipped a codex item Mystery'))).toHaveLength(1);
        expect(logs.find((m) => m.includes('Mystery'))).toContain('turn-watch s1');
    });

    // A busy tick — many calls landing at once — used to go out as one frame of
    // any size, past the transport's frame limit (see MAX_TURN_FRAME_BYTES).
    it('pages a large live tick so no frame can exceed the transport limit', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        const label = 'd'.repeat(400);
        appendFileSync(
            transcriptFor('s1'),
            Array.from({ length: 60 }, (_, i) => toolUse(`t${i}`, 'Bash', { description: `${i}-${label}` })).join(''),
        );
        await watchers.tick('s1');

        const live = deltas().slice(before);
        expect(live.length).toBeGreaterThan(1);
        for (const frame of live) {
            expect(Buffer.byteLength(JSON.stringify(frame.events ?? []), 'utf-8')).toBeLessThanOrEqual(MAX_TURN_FRAME_BYTES);
        }
        expect(live.flatMap((f) => f.events as TurnEvent[]).map((e) => (e as { id: string }).id)).toEqual(
            Array.from({ length: 60 }, (_, i) => `t${i}`),
        );
        expect(deltas().map((f) => f.seq)).toEqual(deltas().map((_, i) => i + 1));
        // The ring records every page that went out, in order.
        expect(ring.get('s1')!.filter((e) => e.kind === 'tool')).toHaveLength(60);
    });

    /** A tick of 60 labelled calls — three pages' worth at MAX_TURN_FRAME_BYTES. */
    const busyTick = () =>
        Array.from({ length: 60 }, (_, i) => toolUse(`b${i}`, 'Bash', { description: `${i}-${'d'.repeat(400)}` })).join('');

    // One unsealable page drops the rest of its tick, as a whole batch was
    // dropped before paging: the failure counts once per tick, so a burst of
    // pages cannot spend MAX_TURN_SEAL_FAILURES in milliseconds.
    it('drops the rest of a paged tick once one page will not seal', async () => {
        let failNext = false;
        let seals = 0;
        const sealedFor = new Set<string>();
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext, _key, sessionName) => {
                    seals++;
                    sealedFor.add(sessionName);
                    if (failNext) throw new Error('transient');
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');
        const before = { frames: deltas().length, seals, held: (ring.get('s1') ?? []).length };

        failNext = true;
        appendFileSync(transcriptFor('s1'), busyTick());
        await watchers.tick('s1');

        expect(seals - before.seals).toBe(1);
        // Every batch is bound to the watched session (envelope v2 context).
        expect([...sealedFor]).toEqual(['s1']);
        expect(deltas()).toHaveLength(before.frames);
        expect((ring.get('s1') ?? []).length).toBe(before.held);
        expect(watchers.size()).toBe(1);
    });

    it('stops a busy tick\'s remaining pages when a start re-seeds the watch mid-seal', async () => {
        let reseedOnSeal = false;
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext) => {
                    if (reseedOnSeal) {
                        reseedOnSeal = false;
                        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
                    }
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');
        const firstEpoch = deltas().at(-1)!.epoch;
        const before = deltas().length;

        reseedOnSeal = true;
        appendFileSync(transcriptFor('s1'), busyTick());
        await watchers.tick('s1');

        // The page already sealing goes out; the other two belong to a tail the
        // re-seeded watcher no longer reads. Its own backfill re-reads them, cut
        // at the ring's newest stamp — which drops any event sharing that exact
        // stamp, a limit of `afterRingTail` older than paging.
        const fromOldBatch = deltas().slice(before).filter((f) => f.epoch === firstEpoch);
        expect(fromOldBatch).toHaveLength(1);
    });

    it('stops a busy tick when the viewer stops the watch mid-seal', async () => {
        let stopOnSeal = false;
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext) => {
                    if (stopOnSeal) {
                        stopOnSeal = false;
                        watchers.handle({ subtype: 'agent.turn.watch.stop', targetDeviceId: DEVICE, sessionName: 's1' }, send);
                    }
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');
        const before = deltas().length;

        stopOnSeal = true;
        appendFileSync(transcriptFor('s1'), busyTick());
        await watchers.tick('s1');

        expect(deltas().length - before).toBe(1);
        expect(watchers.size()).toBe(0);
    });

    it('stops a busy tick when the watch ends on its last allowed seal failure', async () => {
        let fail = false;
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext) => {
                    if (fail) throw new Error('gone');
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');
        const before = deltas().length;

        fail = true;
        for (let i = 0; i < MAX_TURN_SEAL_FAILURES; i++) {
            appendFileSync(transcriptFor('s1'), busyTick());
            await watchers.tick('s1');
        }

        expect(deltas()).toHaveLength(before);
        expect(watchers.size()).toBe(0);
        expect(sent.some((f) => f.error === 'seal_failed')).toBe(true);
    });

    it('sends nothing when the transcript did not move', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        await watchers.tick('s1');
        await watchers.tick('s1');

        expect(deltas().length).toBe(before);
    });

    it('seals the batch when the subscriber supplied a key, and never sends the plaintext beside it', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/secret/path.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await watchers.tick('s1');

        const frame = deltas().at(-1)!;
        expect(frame.encrypted).toBeDefined();
        expect(frame.events).toBeUndefined();
        expect(JSON.stringify(frame)).not.toContain('/secret/path.ts');
    });

    it('drops the batch rather than downgrading to plaintext when sealing fails', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async () => {
                    throw new Error('no device key');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/secret/path.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await watchers.tick('s1');

        expect(deltas()).toHaveLength(0);
        expect(JSON.stringify(sent)).not.toContain('/secret/path.ts');
        expect(logs.some((l) => l.includes('seal failed'))).toBe(true);
    });

    it('sends in the clear for a device with no keypair — the timeline is not a paid feature', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(deltas().at(-1)!.events).toBeDefined();
    });
});

describe('turn watch release', () => {
    it('stops on watch.stop', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);

        watchers.handle({ subtype: 'agent.turn.watch.stop', targetDeviceId: DEVICE, sessionName: 's1' }, send);

        expect(watchers.size()).toBe(0);
    });

    it('stops on lease expiry even when watch.stop never arrives', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        expect(watchers.size()).toBe(1);

        clock += TURN_LEASE_MS + 1;
        await watchers.tick('s1');

        expect(watchers.size()).toBe(0);
        expect(logs.some((l) => l.includes('lease expired'))).toBe(true);
    });

    it('keeps the watch alive while renews keep arriving', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);

        for (let i = 0; i < 3; i++) {
            clock += TURN_LEASE_MS - 1_000;
            watchers.handle({ subtype: 'agent.turn.watch.renew', targetDeviceId: DEVICE, sessionName: 's1' }, send);
            await watchers.tick('s1');
        }

        expect(watchers.size()).toBe(1);
    });

    it('releases every watcher when the socket goes — a reconnect must not leave orphans', () => {
        const watchers = createTurnWatchers(makeDeps());
        for (let i = 0; i < MAX_TURN_WATCHERS; i++) {
            writeFileSync(transcriptFor(`s${i}`), userPrompt('go'));
            watchers.handle(start(`s${i}`), send);
        }
        expect(watchers.size()).toBe(MAX_TURN_WATCHERS);

        watchers.stopAll('socket closed');

        expect(watchers.size()).toBe(0);
    });

    it('a tick after stop neither sends nor revives the watcher', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        watchers.stop('s1', 'test');
        const before = sent.length;

        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read'));
        await watchers.tick('s1');

        expect(sent).toHaveLength(before);
        expect(watchers.size()).toBe(0);
    });
});

describe('turn watch regressions', () => {
    it('gives up and says so after repeated seal failures, instead of an endless silent drop', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async () => {
                    throw new Error('no device key');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);

        for (let i = 0; i < MAX_TURN_SEAL_FAILURES; i++) {
            appendFileSync(transcriptFor('s1'), toolUse(`t${i}`, 'Read'));
            await watchers.tick('s1');
        }

        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.turn.watch.error', error: 'seal_failed' });
        expect(watchers.size()).toBe(0);
    });

    it('a repeated start re-states the key, so a keyless viewer cannot pin the session to plaintext', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', { file_path: '/secret.ts' }));
        await watchers.tick('s1');

        const latest = deltas().at(-1)!;
        expect(latest.encrypted).toBeDefined();
        expect(JSON.stringify(latest)).not.toContain('/secret.ts');
    });

    it('bumps the epoch and restarts seq on a repeated start, so the viewer does not discard the new batches', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const first = deltas().at(-1)!;

        watchers.handle(start('s1'), send);
        await Promise.resolve();
        const second = deltas().at(-1)!;

        expect(second.epoch).toBe((first.epoch as number) + 1);
        expect(second.seq).toBe(1);
    });

    it('backfills again on a repeated start — reopening the chat inside the lease must not show a blank turn', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/live.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        // The viewer left without its `stop` landing and came back inside the
        // lease: the watcher is still registered and already at EOF, so without a
        // re-seed the new viewer would see nothing until the next tool call.
        watchers.handle(start('s1'), send);
        await Promise.resolve();

        expect(deltas().length).toBeGreaterThan(before);
        expect(JSON.stringify(deltas().at(-1)!.events)).toContain('/live.ts');
    });

    it('leaves no orphan poll chain behind when a start re-seeds a live watcher', async () => {
        // The poll timers alive right now: one chain is one timer at a time (none while its read
        // is in flight), an orphan chain is a second one. Only timers of the poll's own delay
        // count (the test runner sets timers of its own), and a timer that fires leaves the set:
        // a poll that fired and re-armed is not a second chain.
        const armed = new Set<unknown>();
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
            if (ms !== TURN_POLL_INTERVAL_MS) return realSetTimeout(fn, ms, ...rest);
            const handle: ReturnType<typeof realSetTimeout> = realSetTimeout(() => {
                armed.delete(handle);
                fn();
            }, ms);
            armed.add(handle);
            return handle;
        }) as typeof globalThis.setTimeout;
        globalThis.clearTimeout = ((handle: Parameters<typeof globalThis.clearTimeout>[0]) => {
            armed.delete(handle);
            realClearTimeout(handle);
        }) as typeof globalThis.clearTimeout;

        try {
            const watchers = createTurnWatchers(makeDeps());
            writeFileSync(transcriptFor('s1'), userPrompt('go'));

            // A start's first read (the ring replay, then the transcript) is a chain of real file
            // reads, and how many event-loop turns it takes depends on the machine's load. So
            // nothing here assumes a count of turns: wait for the state, with a deadline, and
            // look for an orphan over a stretch of turns afterwards. The drain uses the real
            // setTimeout, which is not the poll's delay and so is not counted.
            const settle = () => new Promise((r) => realSetTimeout(r, 0));
            const until = async (done: () => boolean, what: string) => {
                const deadline = Date.now() + 5_000;
                while (!done()) {
                    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${armed.size} poll timers armed)`);
                    await settle();
                }
            };
            const neverMoreThan = async (count: number) => {
                for (let turn = 0; turn < 25; turn++) {
                    await settle();
                    expect(armed.size).toBeLessThanOrEqual(count);
                }
            };

            watchers.handle(start('s1'), send);
            await until(() => armed.size === 1, 'the first start to arm its poll');

            for (let i = 0; i < 3; i++) {
                watchers.handle(start('s1'), send);
                await until(() => armed.size === 1, `start ${i + 2} to arm its poll`);
            }
            await neverMoreThan(1);

            watchers.stopAll('test');
            expect(armed.size).toBe(0);
            await neverMoreThan(0);
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    it('stops when tmux no longer holds the session', async () => {
        let alive = true;
        const watchers = createTurnWatchers(makeDeps({ sessionExists: () => alive }));
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        expect(watchers.size()).toBe(1);

        alive = false;
        await watchers.tick('s1');

        expect(watchers.size()).toBe(0);
        expect(logs.some((l) => l.includes('tmux session gone'))).toBe(true);
    });

    it('refuses to watch at all when a seal was asked for and the keypair will not load', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                initCrypto: async () => {
                    throw new Error('keychain locked');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read'));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await new Promise((r) => setTimeout(r, 0));

        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.turn.watch.error', error: 'e2ee_unavailable' });
        expect(watchers.size()).toBe(0);
        expect(deltas()).toHaveLength(0);
    });
});

describe('turn watch follows the session', () => {
    it('moves to the new transcript when the session starts writing elsewhere', async () => {
        // `/clear` writes a file under a new name; the old one just stops growing,
        // so a watcher pinned to it goes quiet and looks like an idle agent.
        let target = 'before-clear';
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => sourceFor(target) }));
        writeFileSync(transcriptFor('before-clear'), userPrompt('old session'));
        writeFileSync(transcriptFor('after-clear'), userPrompt('new session') + toolUse('t9', 'Read', { file_path: '/after.ts' }));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        target = 'after-clear';
        clock += TRANSCRIPT_RECHECK_MS;
        await watchers.tick('s1');

        expect(deltas().length).toBeGreaterThan(before);
        expect(JSON.stringify(deltas().at(-1)!.events)).toContain('/after.ts');
        expect(logs.some((l) => l.includes('transcript rotated'))).toBe(true);
    });

    // The watcher must know nothing about any one transcript format. Whatever
    // projector the resolver names is the one that reads the bytes — that is
    // the whole seam another agent hangs off.
    it('reads the file with the projector its resolver named, not Claude\'s', async () => {
        const seen: string[] = [];
        const shouty: TranscriptProjector = (lines) => {
            seen.push(...lines);
            return [{ kind: 'text', text: 'from the other projector' }];
        };
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: (s) => sourceFor(s, shouty) }));
        // Deliberately Claude-shaped, so a watcher that ignored the projector
        // would still produce plausible events and this test would still catch it.
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/x.ts' }));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(seen.length).toBeGreaterThan(0);
        expect(deltas().flatMap((f) => f.events as TurnEvent[])).toEqual([
            { kind: 'text', text: 'from the other projector' },
        ]);
    });

    // A rotation can land on a file another agent wrote — a reused tmux name is
    // enough. A watcher that followed the path but kept the old projector would
    // read the new bytes with the wrong format's rules.
    it('adopts the new projector when the transcript rotates, not just the new path', async () => {
        let target = 'before';
        let project: TranscriptProjector = projectTranscriptEntries;
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => sourceFor(target, project) }));
        writeFileSync(transcriptFor('before'), userPrompt('old'));
        writeFileSync(transcriptFor('after'), userPrompt('new'));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        target = 'after';
        project = () => [{ kind: 'text', text: 'read by the rotated-in projector' }];
        clock += TRANSCRIPT_RECHECK_MS;
        await watchers.tick('s1');

        expect(deltas().at(-1)!.events).toEqual([{ kind: 'text', text: 'read by the rotated-in projector' }]);
    });

    it('does not re-resolve on every tick — the session registry is not free', async () => {
        let calls = 0;
        const watchers = createTurnWatchers(
            makeDeps({
                resolveTranscript: (session) => {
                    calls += 1;
                    return sourceFor(session);
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const afterStart = calls;

        for (let i = 0; i < 5; i++) await watchers.tick('s1');

        expect(calls).toBe(afterStart);
    });
});

describe('turn watch — the scrollback the ring keeps', () => {
    /** Every event the viewer has been handed, sealed frames included. */
    const received = () => deltas().flatMap((f) => (f.events as TurnEvent[] | undefined) ?? []);

    it('replays the earlier turn when the chat comes back, even though no push ever recorded it', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('first ask') + toolUse('t1', 'Read', { file_path: '/first.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        // The turn ends and a new one begins, so the backfill's own window would
        // now start at the second prompt and the first turn would be lost.
        appendFileSync(transcriptFor('s1'), userPrompt('second ask'));
        await watchers.tick('s1');
        watchers.handle({ subtype: 'agent.turn.watch.stop', targetDeviceId: DEVICE, sessionName: 's1' }, send);
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(JSON.stringify(received())).toContain('/first.ts');
        expect(JSON.stringify(received())).toContain('first ask');
    });

    it('says nothing at all when the ring writes fine', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // The complaint below is once-per-watch, so a fake that reported failure
        // by accident would leave every other case in this file exercising the
        // failure branch and nothing exercising this one.
        expect(logs.filter((l) => l.includes('ring write failed'))).toHaveLength(0);
        expect(ring.get('s1')!.length).toBeGreaterThan(0);
    });

    it('does not write the replay back into the ring', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const afterFirst = ring.get('s1')!.length;

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // A replay that appended would double the ring on every re-open, and the
        // doubling would compound.
        expect(ring.get('s1')!.length).toBe(afterFirst);
    });

    it('cuts the backfill down to what the ring has not already sent', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', { file_path: '/b.ts' }));
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const ids = received().filter((e) => e.kind === 'tool').map((e) => (e as { id: string }).id);
        // t1 arrives once — from the replay — and not a second time from the
        // backfill that re-reads the same region of the transcript.
        expect(ids.filter((id) => id === 't1')).toHaveLength(1);
        expect(ids).toContain('t2');
    });

    it('keeps a backfilled event that carries no timestamp rather than guessing it was sent', async () => {
        const watchers = createTurnWatchers(makeDeps());
        // A transcript entry with no `timestamp` projects an event with no `at`,
        // and the cut has nothing to compare — dropping it would lose a turn.
        writeFileSync(
            transcriptFor('s1'),
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n` +
                `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'nostamp', name: 'Read', input: {} }] } })}\n`,
        );
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(received().some((e) => e.kind === 'tool' && (e as { id: string }).id === 'nostamp')).toBe(true);
    });

    it('replays nothing when the session starts writing a different transcript', async () => {
        let target = 'before-clear';
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => sourceFor(target) }));
        writeFileSync(transcriptFor('before-clear'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/old.ts' }));
        writeFileSync(transcriptFor('after-clear'), userPrompt('after clear') + toolUse('t2', 'Read', { file_path: '/new.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        expect(ring.get('s1')!.length).toBeGreaterThan(0);

        // `/clear` starts a new session file. A rotation re-seeds, and a re-seed
        // that replayed would resend the whole history on every compaction.
        target = 'after-clear';
        clock += TRANSCRIPT_RECHECK_MS;
        sent = [];
        await watchers.tick('s1');

        expect(logs.some((l) => l.includes('transcript rotated'))).toBe(true);
        expect(JSON.stringify(received())).toContain('/new.ts');
        expect(JSON.stringify(received())).not.toContain('/old.ts');
    });

    it('says once, not every tick, that it cannot write the ring', async () => {
        const watchers = createTurnWatchers(
            makeDeps({ ring: { read: () => [], append: () => false, sweep: () => {} } }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', {}));
        await watchers.tick('s1');

        // A full disk stays full: a line every 500ms would bury the log it is
        // trying to explain. And the live send keeps going regardless.
        expect(logs.filter((l) => l.includes('ring write failed'))).toHaveLength(1);
        expect(deltas().length).toBeGreaterThan(0);
    });

    it('keeps sending when the ring itself throws', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                ring: {
                    read: () => [],
                    append: () => {
                        throw new Error('disk on fire');
                    },
                    sweep: () => {},
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // The ring is injected, so its contract is whatever the caller wrote.
        // An unhandled rejection here would take the poll chain down with it.
        expect(deltas().length).toBeGreaterThan(0);
    });

    it('keeps reading after a replay page the seal refused, instead of ending the watch', async () => {
        // Older than anything the transcript below will project, so the cut
        // cannot swallow the backfill and hide what this is measuring.
        ring.set('s1', [{ kind: 'tool', id: 'held', name: 'Read', at: '2020-01-01T00:00:00.000Z' }]);
        let seals = 0;
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext) => {
                    // Only the replay page fails; the backfill behind it seals.
                    if (++seals === 1) throw new Error('nope');
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/live.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');

        // One refused page is not three, so the watch survives it and the turn
        // in flight still reaches the viewer — a replay that took the session
        // down with it would cost the live lane to protect the history.
        expect(seals).toBe(2);
        expect(watchers.size()).toBe(1);
        expect(deltas()).toHaveLength(1);
        expect(logs.some((l) => l.includes('seal failed'))).toBe(true);
    });

    it('pages a long replay so no frame can exceed the transport limit', async () => {
        ring.set('s1', Array.from({ length: 60 }, (_, i) => ({ kind: 'text', text: `${i}-${'z'.repeat(1000)}` })));
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const frames = deltas();
        expect(frames.length).toBeGreaterThan(1);
        for (const frame of frames) {
            expect(Buffer.byteLength(JSON.stringify(frame.events ?? []), 'utf-8')).toBeLessThanOrEqual(MAX_TURN_FRAME_BYTES);
        }
        // Every frame still counts, so the viewer's high-water mark advances
        // instead of discarding page two as already seen.
        expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
    });

    it('replays only the newest MAX_REPLAY_EVENTS, so a long history cannot outrun the viewer cap', async () => {
        ring.set(
            's1',
            Array.from({ length: MAX_REPLAY_EVENTS + 50 }, (_, i) => ({ kind: 'tool', id: `t${i}`, name: 'Read' })),
        );
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const ids = deltas().flatMap((f) => (f.events as { id?: string }[]) ?? []).map((e) => e.id);
        expect(ids).toContain(`t${MAX_REPLAY_EVENTS + 49}`);
        expect(ids).not.toContain('t0');
    });

    it('does not record a batch the seal refused — the ring holds what was sent, not what was read', async () => {
        const watchers = createTurnWatchers(
            makeDeps({ seal: async () => { throw new Error('no key'); } }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');

        expect(ring.get('s1') ?? []).toEqual([]);
    });

    it('sweeps stale rings when a watch opens, so a machine that ran agents for months does not keep every one', () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);

        expect(sweeps).toBe(1);
    });
});

// The listener's own seal for a batch: envelope v2 `turn.batch`, bound to the
// session — it opens as that and as nothing else this listener seals.
describe('the listener\'s turn batch seal', () => {
    const originalHome = process.env.HOME;
    let home: string;
    // The device key lives under HOME: a scratch one, never this machine's.
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'hwip-turn-seal-'));
        process.env.HOME = home;
        vi.resetModules();
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it('should seal as a turn batch of that session', async () => {
        const { sealTurnBatch } = await import('./listener.js');
        const { initDeviceCrypto, getDevicePublicKey, openV2 } = await import('./crypto.js');
        await initDeviceCrypto();
        const self = getDevicePublicKey() ?? '';

        const sealed = await sealTurnBatch('[{"kind":"user"}]', self, 's1');

        expect(await openV2('turn.batch', sealed, self, 's1')).toBe('[{"kind":"user"}]');
        await expect(openV2('turn.batch', sealed, self, 's2')).rejects.toThrow();
        await expect(openV2('stream.frame', sealed, self, 's1')).rejects.toThrow();
    });
});

// ── todo ─────────────────────────────────────────────────────────────────────

const taskCreated = (id: string, subject: string) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${id}`, content: 'ok' }] }, toolUseResult: { task: { id, subject } } });
const taskMoved = (id: string, to: string) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${id}${to}`, content: 'ok' }] }, toolUseResult: { taskId: id, statusChange: { from: 'pending', to } } });

type Todo = Extract<TurnEvent, { kind: 'todo' }>;
const todosSent = () => deltas().flatMap((f) => (f.events as TurnEvent[]).filter((e): e is Todo => e.kind === 'todo'));

describe('turn watch todo list', () => {
    it('carries the list from one read to the next', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + taskCreated('1', 'a') + taskCreated('2', 'b'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        appendFileSync(transcriptFor('s1'), taskMoved('2', 'in_progress'));
        await watchers.tick('s1');

        expect(todosSent().at(-1)?.items).toEqual([
            { id: '1', text: 'a', status: 'pending' },
            { id: '2', text: 'b', status: 'in_progress' },
        ]);
    });

    it('sends no list on a read that does not change it', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + taskCreated('1', 'a'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t1', 'Read', { file_path: '/a.ts' }));
        await watchers.tick('s1');

        expect(todosSent()).toHaveLength(1);
    });

    it('backfills a list made before the latest prompt', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('plan it') + taskCreated('1', 'a') + userPrompt('now go') + toolUse('t1', 'Read'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(todosSent().map((e) => e.items.length)).toEqual([1]);
    });

    it('backfills a list the ring never had even when the ring holds newer events', async () => {
        // A list made while nobody watched, then a watch that saw later turns only.
        writeFileSync(transcriptFor('s1'), userPrompt('plan it') + taskCreated('1', 'a') + userPrompt('later'));
        ring.set('s1', [{ kind: 'prompt', text: 'later', at: at() }]);
        const watchers = createTurnWatchers(makeDeps());
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(todosSent().map((e) => e.items[0]?.text)).toEqual(['a']);
    });

    it('does not send the list again when the ring ends on the same one', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + taskCreated('1', 'a'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t1', 'Read'));
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // Once, from the replay.
        const events = deltas().flatMap((f) => (f.events as TurnEvent[] | undefined) ?? []);
        expect(events.filter((e) => e.kind === 'todo')).toHaveLength(1);
    });

    it('sends the list again when the ring holds it only beyond what a start replays', async () => {
        writeFileSync(transcriptFor('s1'), userPrompt('plan it') + taskCreated('1', 'a') + userPrompt('later'));
        const list: TurnEvent = { kind: 'todo', items: [{ id: '1', text: 'a', status: 'pending' }], at: at() };
        const after = Array.from({ length: MAX_REPLAY_EVENTS }, (_, i): TurnEvent => ({ kind: 'text', text: `t${i}`, at: at() }));
        ring.set('s1', [list, ...after]);
        const watchers = createTurnWatchers(makeDeps());
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(todosSent().map((e) => e.items[0]?.text)).toEqual(['a']);
    });

    it('does not carry one session file\'s list into the next after a rotation', async () => {
        let path = transcriptFor('s1');
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => ({ path, project: projectTranscriptEntries }) }));
        writeFileSync(path, userPrompt('go') + taskCreated('1', 'old task'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        path = join(dir, 's1-next.jsonl');
        writeFileSync(path, userPrompt('fresh') + taskCreated('7', 'new task'));
        clock += TRANSCRIPT_RECHECK_MS;
        await watchers.tick('s1');

        expect(todosSent().at(-1)?.items.map((item) => item.text)).toEqual(['new task']);
    });
});
