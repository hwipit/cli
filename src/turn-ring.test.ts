/**
 * The ring is what makes a turn survive the viewer leaving. Everything the
 * daemon sends to a chat is ephemeral — the transcript backfill only replays
 * since the last prompt, and a turn whose completion push was suppressed (the
 * `quiet` dial suppresses every auto-push) has no other record anywhere. So the
 * ring's contract is not bookkeeping: it is the only reason a finished turn is
 * still on screen after a re-subscribe.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { withTmpStateDir } from './test-state-dir.js';

// Counts the syscalls the append path makes per tick; everything passes through.
const calls = vi.hoisted(() => ({ chmod: 0, mkdir: 0, stat: 0 }));
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
            calls.chmod++;
            return actual.chmodSync(...args);
        },
        mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
            calls.mkdir++;
            return actual.mkdirSync(...args);
        },
        statSync: (...args: Parameters<typeof actual.statSync>) => {
            calls.stat++;
            return actual.statSync(...args);
        },
    };
});

withTmpStateDir('hwip-turn-ring-');

const {
    appendTurnRing,
    readTurnRing,
    removeTurnRing,
    sweepTurnRings,
    turnRingPath,
    turnRingDir,
    MAX_TURN_RING_BYTES,
    MAX_TURN_RING_FILES,
    TURN_RING_TTL_MS,
} = await import('./turn-ring.js');

const text = (body: string, at?: string) => ({ kind: 'text' as const, text: body, ...(at ? { at } : {}) });
const tool = (id: string) => ({ kind: 'tool' as const, id, name: 'Bash' });

/** Backdate a ring file so TTL and eviction can be exercised without waiting. */
const backdate = (sessionName: string, msAgo: number): void => {
    const when = new Date(Date.now() - msAgo);
    utimesSync(turnRingPath(sessionName), when, when);
};

describe('turn ring — what came back is what went in', () => {
    it('reads back the events it was given, in order, across separate appends', () => {
        appendTurnRing('hwip-app', [text('first'), tool('t1')]);
        appendTurnRing('hwip-app', [text('second')]);

        expect(readTurnRing('hwip-app')).toEqual([text('first'), tool('t1'), text('second')]);
    });

    it('reads nothing for a session it has never seen', () => {
        expect(readTurnRing('never-watched')).toEqual([]);
    });

    it('reads nothing from a ring file that exists but holds nothing', () => {
        appendTurnRing('hwip-app', [text('seed')]);
        writeFileSync(turnRingPath('hwip-app'), '');

        expect(readTurnRing('hwip-app')).toEqual([]);
    });

    it('writes no file at all for an empty batch', () => {
        appendTurnRing('hwip-app', []);

        expect(existsSync(turnRingPath('hwip-app'))).toBe(false);
    });

    it('keeps one session out of another session ring', () => {
        appendTurnRing('hwip-app', [text('mine')]);
        appendTurnRing('hwip-other', [text('theirs')]);

        expect(readTurnRing('hwip-app')).toEqual([text('mine')]);
    });
});

describe('turn ring — bounded', () => {
    it('drops the oldest events, not the newest, when the file passes its cap', () => {
        // Each line is well over 1KB, so a few hundred of them pass 256KB.
        const filler = 'x'.repeat(2000);
        for (let i = 0; i < 200; i++) appendTurnRing('hwip-app', [text(`${i}-${filler}`)]);

        const kept = readTurnRing('hwip-app');
        expect(statSync(turnRingPath('hwip-app')).size).toBeLessThanOrEqual(MAX_TURN_RING_BYTES);
        // The newest survived and the oldest did not — a ring that trimmed from
        // the wrong end would replay ancient work and lose what just happened.
        expect(kept.at(-1)).toEqual(text(`199-${filler}`));
        expect(kept.some((e) => 'text' in e && e.text.startsWith('0-'))).toBe(false);
    });

    it('keeps the newest line even when that one line is larger than the whole cap', () => {
        // Nothing the projection emits is this big — text clamps at 5000 chars —
        // but `appendTurnRing` takes any TurnEvent[], and taking zero lines here
        // would blank the ring and blank it again on every later append.
        appendTurnRing('hwip-app', [text('a'.repeat(MAX_TURN_RING_BYTES + 1000))]);

        expect(readTurnRing('hwip-app')).toHaveLength(1);
        appendTurnRing('hwip-app', [text('after')]);
        expect(readTurnRing('hwip-app').at(-1)).toEqual(text('after'));
    });

    it('stays under the cap even when a single batch is larger than the whole ring', () => {
        const huge = Array.from({ length: 200 }, (_, i) => text(`${i}-${'y'.repeat(3000)}`));

        appendTurnRing('hwip-app', huge);

        expect(statSync(turnRingPath('hwip-app')).size).toBeLessThanOrEqual(MAX_TURN_RING_BYTES);
        expect(readTurnRing('hwip-app').at(-1)).toEqual(huge.at(-1));
    });
});

describe('turn ring — damaged and expired files', () => {
    it('skips a line the daemon was killed halfway through writing', () => {
        appendTurnRing('hwip-app', [text('intact')]);
        // Appends go straight to the file (only the trim rewrite uses
        // tmp+rename), so a half-written last line is the realistic crash shape.
        writeFileSync(turnRingPath('hwip-app'), '{"kind":"text","tex', { flag: 'a' });

        expect(readTurnRing('hwip-app')).toEqual([text('intact')]);
    });

    it('skips a line that parsed but is not an event — null, a number, an array and a bare object are all valid JSON', () => {
        appendTurnRing('hwip-app', [text('intact')]);
        // Reachable through a hand-edited or planted file, not through a crash
        // (a torn line fails to parse). Slice 02 seals and sends whatever this
        // returns, so the shape check is the boundary.
        writeFileSync(turnRingPath('hwip-app'), 'null\n5\n"a string"\n[1,2]\n{}\n{"kind":7}\n', { flag: 'a' });

        expect(readTurnRing('hwip-app')).toEqual([text('intact')]);
    });

    it('deletes an expired ring instead of quietly appending onto it', () => {
        appendTurnRing('hwip-app', [text('ancient')]);
        backdate('hwip-app', TURN_RING_TTL_MS + 60_000);

        expect(readTurnRing('hwip-app')).toEqual([]);
        // The file has to be gone, not just unread: left in place, the next
        // append lands on top of pre-expiry content and the TTL means nothing.
        appendTurnRing('hwip-app', [text('fresh')]);
        expect(readTurnRing('hwip-app')).toEqual([text('fresh')]);
    });
});

describe('turn ring — retention is hours, and applies to events not just files', () => {
    const HOUR = 60 * 60 * 1000;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('keeps a ring for a day, not a week', () => {
        expect(TURN_RING_TTL_MS).toBe(24 * HOUR);
    });

    // The ring file's mtime moves on every append, so a session that is still
    // being watched never trips the whole-file TTL — while its oldest lines age
    // on disk for as long as the cap lets them stay.
    it('does not replay events older than the TTL out of a ring that is still being written', () => {
        appendTurnRing('hwip-app', [text('stale', ago(TURN_RING_TTL_MS + HOUR)), text('fresh', ago(HOUR))]);

        expect(readTurnRing('hwip-app').map((e) => ('text' in e ? e.text : ''))).toEqual(['fresh']);
    });

    it('keeps an event that carries no timestamp — its age is unknown, not old', () => {
        appendTurnRing('hwip-app', [text('no stamp')]);

        expect(readTurnRing('hwip-app')).toEqual([text('no stamp')]);
    });

    it('takes expired events off the disk on sweep, not just out of the replay', () => {
        appendTurnRing('hwip-app', [text('stale secret prompt', ago(TURN_RING_TTL_MS + HOUR)), text('fresh', ago(HOUR))]);

        sweepTurnRings();

        const onDisk = readFileSync(turnRingPath('hwip-app'), 'utf-8');
        expect(onDisk).not.toContain('stale secret prompt');
        expect(onDisk).toContain('fresh');
        expect(statSync(turnRingPath('hwip-app')).mode & 0o777).toBe(0o600);
    });

    // One line that cannot be judged must not shield what sits behind it.
    it.each([
        ['a torn line', '{"kind":"text","tex\n'],
        ['an event with no timestamp', `${JSON.stringify(text('unstamped'))}\n`],
        ['a non-event', 'null\n'],
    ])('prunes expired events behind %s at the front of the file', (_name, front) => {
        appendTurnRing('hwip-app', [text('stale secret prompt', ago(TURN_RING_TTL_MS + HOUR)), text('fresh', ago(HOUR))]);
        const path = turnRingPath('hwip-app');
        writeFileSync(path, front + readFileSync(path, 'utf-8'));

        sweepTurnRings();

        const onDisk = readFileSync(path, 'utf-8');
        expect(onDisk).not.toContain('stale secret prompt');
        expect(onDisk).toContain('fresh');
        expect(onDisk).not.toContain('"tex\n');
    });

    it('removes the ring file when sweep finds nothing in it that is still in date', () => {
        appendTurnRing('hwip-app', [text('stale', ago(TURN_RING_TTL_MS + HOUR))]);

        sweepTurnRings();

        expect(existsSync(turnRingPath('hwip-app'))).toBe(false);
    });
});

describe('turn ring — cost per tick', () => {
    it('makes no chmod, mkdir or stat once a ring has been set up', () => {
        appendTurnRing('hwip-app', [text('first')]);
        calls.chmod = calls.mkdir = calls.stat = 0;

        for (let i = 0; i < 5; i++) appendTurnRing('hwip-app', [text(`tick ${i}`)]);

        // Modes are fixed on first touch and the size is tracked, not re-read:
        // the append is the only filesystem call a steady-state tick makes.
        expect(calls).toEqual({ chmod: 0, mkdir: 0, stat: 0 });
        expect(readTurnRing('hwip-app')).toHaveLength(6);
    });

    it('recreates a ring directory that disappeared, with the owner-only modes', () => {
        appendTurnRing('hwip-app', [text('before')]);
        rmSync(turnRingDir(), { recursive: true, force: true });

        expect(appendTurnRing('hwip-app', [text('after')])).toBe(true);

        expect(readTurnRing('hwip-app')).toEqual([text('after')]);
        expect(statSync(turnRingDir()).mode & 0o777).toBe(0o700);
        expect(statSync(turnRingPath('hwip-app')).mode & 0o777).toBe(0o600);
    });

    it('reads the real size again after an append that failed', () => {
        appendTurnRing('hwip-app', [text('seed')]);
        // An append into an existing file needs the file writable, not the directory.
        chmodSync(turnRingPath('hwip-app'), 0o400);
        try {
            expect(appendTurnRing('hwip-app', [text('blocked')])).toBe(false);
        } finally {
            chmodSync(turnRingPath('hwip-app'), 0o600);
        }
        calls.stat = 0;

        appendTurnRing('hwip-app', [text('after')]);

        expect(calls.stat).toBeGreaterThan(0);
    });
});

describe('turn ring — reporting what it could not do', () => {
    it('says the write failed instead of reporting a scrollback it never kept', () => {
        // Something else already owns that name. Silence here is what makes a
        // short scrollback undiagnosable: the live lane keeps working and
        // nothing anywhere says why the history stopped growing.
        mkdirSync(turnRingPath('hwip-app'), { recursive: true });

        expect(appendTurnRing('hwip-app', [text('nowhere to go')])).toBe(false);
    });

    it('reports success only when the events are actually readable again', () => {
        expect(appendTurnRing('hwip-app', [text('kept')])).toBe(true);
        expect(readTurnRing('hwip-app')).toEqual([text('kept')]);
    });

    it('reports a ring it could not delete, rather than claiming the session was forgotten', () => {
        appendTurnRing('hwip-app', [text('still here')]);
        chmodSync(turnRingDir(), 0o500);

        try {
            expect(removeTurnRing('hwip-app')).toBe(false);
        } finally {
            chmodSync(turnRingDir(), 0o700);
        }
        expect(removeTurnRing('hwip-app')).toBe(true);
        // Removing a ring that was never there is not a failure — nothing is
        // what the caller asked for.
        expect(removeTurnRing('never-watched')).toBe(true);
    });
});

describe('turn ring — sweep', () => {
    it('removes expired rings and keeps the newest ones when there are too many files', () => {
        for (let i = 0; i < MAX_TURN_RING_FILES + 5; i++) appendTurnRing(`session-${i}`, [text(`${i}`)]);
        // Oldest by mtime are the first five.
        for (let i = 0; i < 5; i++) backdate(`session-${i}`, 60_000 * (5 - i));
        appendTurnRing('expired', [text('gone')]);
        backdate('expired', TURN_RING_TTL_MS + 60_000);

        sweepTurnRings();

        expect(readdirSync(turnRingDir()).length).toBeLessThanOrEqual(MAX_TURN_RING_FILES);
        expect(readTurnRing('expired')).toEqual([]);
        // Both ends pinned: the oldest by mtime went and the newest stayed. Only
        // asserting the survivor would pass a sweep that dropped at random.
        expect(readTurnRing('session-0')).toEqual([]);
        expect(readTurnRing(`session-${MAX_TURN_RING_FILES + 4}`)).toEqual([text(`${MAX_TURN_RING_FILES + 4}`)]);
    });

    it('clears a temp file stranded by a kill during the trim rewrite', () => {
        appendTurnRing('hwip-app', [text('live')]);
        writeFileSync(`${turnRingPath('hwip-app')}.tmp`, 'half-written', { mode: 0o600 });

        sweepTurnRings();

        // Left alone nothing would ever remove it, and it would count against
        // MAX_TURN_RING_FILES — evicting a real session's ring one file early.
        expect(readdirSync(turnRingDir())).toHaveLength(1);
        expect(readdirSync(turnRingDir())[0]).toMatch(/\.jsonl$/);
        expect(readTurnRing('hwip-app')).toEqual([text('live')]);
    });

    it('does nothing when there is no ring directory yet', () => {
        sweepTurnRings();

        // Not just "did not throw": a sweep that started creating the directory
        // would put an empty dir on every machine that never opened a chat.
        expect(existsSync(turnRingDir())).toBe(false);
    });
});

describe('turn ring — the session name never reaches the filesystem', () => {
    it('keeps a name with path separators inside the ring directory', () => {
        appendTurnRing('../../etc/passwd', [text('nope')]);

        const files = readdirSync(turnRingDir());
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[0-9a-f]{16}\.jsonl$/);
        expect(readTurnRing('../../etc/passwd')).toEqual([text('nope')]);
    });

    it('survives a session name that is not a string, because the name comes off the wire', () => {
        // `turn-watch.ts` only checks that sessionName is present. A number here
        // makes createHash throw, and every path in this module promises to cost
        // the scrollback rather than the tick that called it.
        expect(() => appendTurnRing(7 as unknown as string, [text('nope')])).not.toThrow();
        expect(readTurnRing(7 as unknown as string)).toEqual([]);
        expect(() => sweepTurnRings()).not.toThrow();
    });

    it('tightens permissions that already exist — mode only applies when the entry is created', () => {
        mkdirSync(turnRingDir(), { recursive: true, mode: 0o755 });
        chmodSync(turnRingDir(), 0o755);
        writeFileSync(turnRingPath('hwip-app'), '', { mode: 0o644 });
        chmodSync(turnRingPath('hwip-app'), 0o644);

        appendTurnRing('hwip-app', [text('private')]);

        // Pre-created by an installer, an older build, or another local account:
        // without the chmod the ring would sit world-readable forever, and the
        // modes are the only thing protecting a day of prompts and paths.
        expect(statSync(turnRingDir()).mode & 0o777).toBe(0o700);
        expect(statSync(turnRingPath('hwip-app')).mode & 0o777).toBe(0o600);
    });

    it('writes the ring readable only by its owner', () => {
        appendTurnRing('hwip-app', [text('private')]);

        // The projection strips file contents and command output, but a tool's
        // target is still a path on this machine.
        expect(statSync(turnRingPath('hwip-app')).mode & 0o777).toBe(0o600);
        expect(statSync(turnRingDir()).mode & 0o777).toBe(0o700);
    });
});
