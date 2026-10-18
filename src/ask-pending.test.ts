import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchKey, pendingAsks, type AskedQuestion, type PendingDeps } from './ask-pending.js';

const QUESTION: AskedQuestion = {
    hookId: 'hook_1',
    title: 'Run rm -rf ./dist?',
    body: 'in /repo',
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
};
const ASK = { eventId: 'hevt_01JABCDEF', askId: 'ASK-1_x', deadline: 60_000 };
const HOUR = 60 * 60 * 1000;
/** A record as it lies in its file. */
interface Written { v: number; match: string; hookId: string; eventId: string; askId: string; deadline: number }
/** Permission bits bind: not root, and not Windows. */
const MODES_BIND = process.getuid?.() !== 0 && process.platform !== 'win32';

describe('pending asks', () => {
    let dir: string;
    let clock: { t: number };
    let living: Set<number>;
    /** The store as the process `pid` sees it. `living` says which processes still run. */
    const proc = (pid: number, over: Partial<PendingDeps> = {}) =>
        pendingAsks(dir, { now: () => clock.t, pid, alive: (p) => living.has(p), host: 'box', cwd: () => '/repo', ...over });
    const files = (): string[] => readdirSync(dir).sort();
    /** The one record in the folder, by path. */
    const recordPath = (): string => {
        const [name, ...rest] = files();
        expect(rest).toEqual([]);
        return join(dir, name);
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hwip-pending-'));
        clock = { t: 1_000 };
        living = new Set([100, 200, 300]);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('hands a question whose owner has died to the next run of the same command', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);

        expect(proc(200).of(QUESTION).claim()).toEqual(ASK);
    });

    it('leaves a question alone while its owner still runs', () => {
        proc(100).of(QUESTION).record(ASK);

        expect(proc(200).of(QUESTION).claim()).toBeNull();
        // Still the owner's: when it dies, the question can be taken up.
        living.delete(100);
        expect(proc(300).of(QUESTION).claim()).toEqual(ASK);
    });

    it('gives a question to only one of two that reach for it', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);

        expect(proc(200).of(QUESTION).claim()).toEqual(ASK);
        expect(proc(300).of(QUESTION).claim()).toBeNull();
    });

    // One that looked while the owner was dead, and reaches only after another has taken the question up and
    // seen it through, finds nothing to take — and leaves nothing behind for a third to read the answer from.
    it('ends a question for good though another reached for it meanwhile', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);
        const first = proc(200).of(QUESTION);
        let reachedBetween = false;
        const late = proc(300, {
            alive: (pid) => {
                if (pid === 100) {
                    expect(first.claim()).toEqual(ASK);
                    return false;
                }
                // The first has its answer and ends the question, while this one holds what it reached for.
                first.settle();
                reachedBetween = true;
                return true;
            },
        });

        expect(late.of(QUESTION).claim()).toBeNull();
        if (!reachedBetween) first.settle();

        expect(files()).toEqual([]);
        living.delete(200);
        expect(proc(400).of(QUESTION).claim()).toBeNull();
    });

    // A pid is used again: a record under this process's own pid, from before it asked, is a dead one's.
    it('takes up a question left under the pid it now runs as', () => {
        proc(100).of(QUESTION).record(ASK);

        expect(proc(100).of(QUESTION).claim()).toEqual(ASK);
    });

    it('keeps a claimed question under the claimer, so a second death hands it on', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);
        proc(200).of(QUESTION).claim();
        living.delete(200);

        expect(proc(300).of(QUESTION).claim()).toEqual(ASK);
        expect(files()).toHaveLength(1);
    });

    it.each<[string, Partial<AskedQuestion>, Partial<PendingDeps>]>([
        ['another hook', { hookId: 'hook_2' }, {}],
        ['another agent session', { agentDeviceId: 'dev_1', agentSessionName: 'main' }, {}],
        ['another directory', {}, { cwd: () => '/elsewhere' }],
        ['another machine sharing the home folder', {}, { host: 'other-box' }],
        ['another title', { title: 'Run rm -rf ./build?' }, {}],
        ['another body', { body: 'in /other' }, {}],
        ['another button id', { actions: [{ id: 'ok', label: 'Approve' }, { id: 'deny', label: 'Deny' }] }, {}],
        ['another button wording', { actions: [{ id: 'approve', label: 'Yes, delete it' }, { id: 'deny', label: 'Deny' }] }, {}],
        ['an ask that offers send-and-exit', { acceptsExit: true }, {}],
    ])('does not take up a question asked with %s', (_, question, where) => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);

        expect(proc(200, where).of({ ...QUESTION, ...question }).claim()).toBeNull();
        // The first question is untouched.
        expect(proc(300).of(QUESTION).claim()).toEqual(ASK);
    });

    it('matches the same question whatever its timeout or key', () => {
        const where = { host: 'box', cwd: '/repo' };
        expect(matchKey({ ...QUESTION, ...{ timeoutSeconds: 75, apiKey: 'k1' } }, where))
            .toBe(matchKey({ ...QUESTION, ...{ timeoutSeconds: 300, apiKey: 'k2' } }, where));
        expect(matchKey(QUESTION, where)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('keeps nothing of the wording, in a file only its owner reads', () => {
        proc(100).of(QUESTION).record(ASK);

        const path = recordPath();
        expect(path).toMatch(/ask-pending-[0-9a-f]{32}\.100\.[0-9a-f]{8}$/);
        expect(readFileSync(path, 'utf-8')).not.toMatch(/rm -rf|in \/repo|approve|deny/i);
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
            v: 1, match: matchKey(QUESTION, { host: 'box', cwd: '/repo' }), hookId: 'hook_1', ...ASK,
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    // Other commands make the folder first, as open as the umask leaves it.
    it.runIf(MODES_BIND).each(['a new', 'an existing'])('makes %s state folder its owner\'s alone', (which) => {
        const state = join(dir, 'state');
        if (which === 'an existing') mkdirSync(state, { mode: 0o755 });
        pendingAsks(state, { pid: 100 }).of(QUESTION).record(ASK);

        expect(statSync(state).mode & 0o777).toBe(0o700);
    });

    it('keeps the question of each of two that ask side by side', () => {
        const second = { ...ASK, eventId: 'hevt_second' };
        proc(100).of(QUESTION).record(ASK);
        proc(200).of(QUESTION).record(second);
        living.delete(100);
        living.delete(200);
        living.add(400);

        const taken = [proc(300).of(QUESTION).claim(), proc(400).of(QUESTION).claim(), proc(500).of(QUESTION).claim()];
        expect(taken.slice(0, 2)).toEqual(expect.arrayContaining([ASK, second]));
        expect(taken[2]).toBeNull();
    });

    it('drops a question past its deadline instead of handing it on', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);
        clock.t = ASK.deadline;

        expect(proc(200).of(QUESTION).claim()).toBeNull();
        expect(files()).toEqual([]);
    });

    it.each<[string, (kept: Written) => string]>([
        ['is not JSON', () => '{"v":1,'],
        ['is not a record', () => '[]'],
        ['is of another version', (kept) => JSON.stringify({ ...kept, v: 2 })],
        ['names another question', (kept) => JSON.stringify({ ...kept, match: 'f'.repeat(64) })],
        ['names another hook', (kept) => JSON.stringify({ ...kept, hookId: 'hook_other' })],
        ['holds an event id that is a path', (kept) => JSON.stringify({ ...kept, eventId: '../../devices' })],
        ['holds an event id with a query', (kept) => JSON.stringify({ ...kept, eventId: 'hevt_1?x=1' })],
        ['holds an ask id that is not one', (kept) => JSON.stringify({ ...kept, askId: 'a b' })],
        ['holds no ask id', ({ askId: _, ...kept }) => JSON.stringify(kept)],
        ['has no deadline to speak of', (kept) => JSON.stringify({ ...kept, deadline: 'never' })],
    ])('drops a record that %s, and hands nothing on', (_, damage) => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);
        const path = recordPath();
        writeFileSync(path, damage(JSON.parse(readFileSync(path, 'utf-8'))));

        expect(proc(200).of(QUESTION).claim()).toBeNull();
        expect(files()).toEqual([]);
    });

    it('settles its own question, and nobody else\'s', () => {
        proc(100).of(QUESTION).record(ASK);

        proc(200).of(QUESTION).settle();
        expect(files()).toHaveLength(1);

        proc(100).of(QUESTION).settle();
        expect(files()).toEqual([]);
    });

    it.runIf(MODES_BIND)('settles a question whose record it cannot read', () => {
        proc(100).of(QUESTION).record(ASK);
        chmodSync(recordPath(), 0o000);

        expect(proc(100).of(QUESTION).settle()).toBe(true);
        expect(files()).toEqual([]);
    });

    // The answer would be read again by the next run: the caller is told, to say so.
    it.runIf(MODES_BIND)('says so when the record of a question that is over cannot be removed', () => {
        proc(100).of(QUESTION).record(ASK);
        chmodSync(dir, 0o500);
        try {
            expect(proc(100).of(QUESTION).settle()).toBe(false);
        } finally {
            chmodSync(dir, 0o700);
        }
    });

    it.runIf(MODES_BIND)('leaves a record it cannot read for now, and takes up the one it can', () => {
        proc(100).of({ ...QUESTION, title: 'Deploy?' }).record(ASK);
        chmodSync(recordPath(), 0o000);
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);

        expect(proc(200).of(QUESTION).claim()).toEqual(ASK);
        expect(files()).toHaveLength(2);
    });

    it('asks as if nothing were kept when the directory it runs in is gone', () => {
        const store = proc(100, { cwd: () => { throw new Error('ENOENT: no such file or directory, uv_cwd'); } });
        const slot = store.of(QUESTION);

        expect(slot.claim()).toBeNull();
        expect(() => slot.record(ASK)).not.toThrow();
        expect(slot.settle()).toBe(true);
        expect(files()).toEqual([]);
    });

    it('clears away other questions past their deadline and leftovers older than an hour', () => {
        const other = { ...QUESTION, title: 'Deploy?' };
        proc(100).of(other).record({ ...ASK, deadline: 5_000 });
        proc(100).of(QUESTION).record(ASK);
        const fresh = join(dir, 'ask-pending-0123.tmp-fresh');
        const stale = [join(dir, 'ask-pending-0123.tmp-old'), join(dir, 'ask-pending-0123.claim-old')];
        const unrelated = join(dir, 'remote-active-123');
        for (const path of [fresh, ...stale, unrelated]) writeFileSync(path, '{}');
        clock.t = 2 * HOUR;
        const longAgo = new Date(clock.t - HOUR - 1_000);
        for (const path of [...stale, unrelated]) utimesSync(path, longAgo, longAgo);
        utimesSync(fresh, new Date(clock.t - 1_000), new Date(clock.t - 1_000));

        proc(200).of({ ...QUESTION, title: 'Something else?' }).claim();

        // Both records are past their deadline by now; the new leftover and the file that is not ours stay.
        expect(files()).toEqual(['ask-pending-0123.tmp-fresh', 'remote-active-123']);
    });

    it('costs the ask nothing when the state folder cannot be used', () => {
        writeFileSync(join(dir, 'file'), '');
        const store = pendingAsks(join(dir, 'file', 'state'), { now: () => clock.t, pid: 100, alive: () => false, host: 'box', cwd: () => '/repo' });
        const slot = store.of(QUESTION);

        expect(() => slot.record(ASK)).not.toThrow();
        expect(slot.claim()).toBeNull();
        expect(slot.settle()).toBe(true);
    });

    it('takes nothing when another takes the question between its read and its reach', () => {
        proc(100).of(QUESTION).record(ASK);
        living.delete(100);
        let asked = 0;
        // The clock is read to sweep, then once more with the record read and not yet taken.
        const late = proc(300, {
            now: () => {
                if ((asked += 1) === 2) expect(proc(200).of(QUESTION).claim()).toEqual(ASK);
                return clock.t;
            },
        });

        expect(late.of(QUESTION).claim()).toBeNull();
        expect(files()).toHaveLength(1);
        expect(files()[0]).toMatch(/\.200\.[0-9a-f]{8}$/);
    });

    describe('on the real process table', () => {
        const DEADLINE = Date.now() + HOUR;

        it('takes up the question of a process that has exited, and not of one that runs', () => {
            const exited = spawnSync(process.execPath, ['-e', '']).pid;
            pendingAsks(dir, { pid: exited }).of(QUESTION).record({ ...ASK, deadline: DEADLINE });
            pendingAsks(dir, { pid: process.pid }).of({ ...QUESTION, title: 'Mine?' }).record({ ...ASK, deadline: DEADLINE });

            // Asked from a third process: this one is alive, and is not the one asking.
            const next = pendingAsks(dir, { pid: process.pid + 1 });
            expect(next.of({ ...QUESTION, title: 'Mine?' }).claim()).toBeNull();
            expect(next.of(QUESTION).claim()).toEqual({ ...ASK, deadline: DEADLINE });
        });

        // Signal 0 to a process of another user fails with EPERM: it is there.
        it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('counts a process it may not signal as running', () => {
            pendingAsks(dir, { pid: 1 }).of(QUESTION).record({ ...ASK, deadline: DEADLINE });

            expect(pendingAsks(dir).of(QUESTION).claim()).toBeNull();
            expect(existsSync(recordPath())).toBe(true);
        });
    });
});
