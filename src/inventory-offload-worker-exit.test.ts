/**
 * Judging a worker's exit.
 *
 * `terminate()` makes a worker exit with code 1, exactly like a crash, so the
 * offload cannot read the code — it has to ask whether that worker still owed
 * an answer. The bug this pins: the question used to be asked of a map shared
 * by every worker, so a worker killed on timeout was judged against the NEXT
 * worker's pending sweep and its ordinary, deliberate death was read as
 * "the worker died before ever answering" — which disables the offload for the
 * daemon's whole lifetime (`everReplied` is false, so the failure is not
 * treated as transient).
 *
 * The window is about a second wide (terminate to exit) against a five second
 * poll, which is why this showed up as an intermittent line in the log rather
 * than a dead feature.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONSECUTIVE_TIMEOUTS, startInventoryOffload } from './inventory-offload.js';

const FIXTURES = join(__dirname, 'fixtures', 'inventory-worker');
const IN_THREAD = { sessions: [{ name: 'hwip-in-thread' }], rejected: [] };
const inThread = () => IN_THREAD as never;
/** Long enough for a worker to boot, short enough to not stall the suite. */
const TIMEOUT = 300;
/**
 * For a test whose worker must ANSWER (or die) and is never meant to time out: the timeout only bites when
 * the answer does not come, so it costs nothing when it is long, and a worker that boots slowly on
 * a loaded machine cannot turn the test into a timeout it was not about.
 */
const ANSWER_TIMEOUT = 10_000;

/**
 * The two degraded states this module now distinguishes, and the reason they
 * get separate matchers: a helper matching both would pass whether the give-up
 * were a cooldown or permanent, which is the whole difference.
 */
const gaveUp = (log: ReturnType<typeof vi.fn>): boolean =>
    log.mock.calls.some((c) => /in-thread from now on/.test(String(c[0])));
const cooledDown = (log: ReturnType<typeof vi.fn>): boolean =>
    log.mock.calls.some((c) => /in-thread for \d+ ?(min|s)/.test(String(c[0])));
const degraded = (log: ReturnType<typeof vi.fn>): boolean => gaveUp(log) || cooledDown(log);

/**
 * A test that mixes sweeps which must time out with sweeps which must answer cannot use one real timeout for
 * both: short enough to hang up on a worker that never answers, it is also too short for a fresh worker that
 * boots slowly on a loaded machine (C130). So the clock is faked (timers and `Date` only — worker messages are
 * I/O and run for real): a timeout fires when the test advances it, and an answering sweep has no timeout to lose.
 */
const useFakeClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
};
afterEach(() => {
    vi.useRealTimers();
});

/** One sweep that must time out: it is started, then the clock moves past its timeout. */
const sweepTimesOut = async (offload: { collect: () => Promise<unknown> }): Promise<void> => {
    const outcome = expect(offload.collect()).rejects.toThrow(/exceeded/);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await outcome;
};

describe('inventory offload — a timed-out worker is not a failed worker', () => {
    it('keeps using workers after a sweep times out and the next one starts', async () => {
        const log = vi.fn();
        // Hangs first, so sweep 1 times out and the worker is terminated.
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'hangs.cjs'), TIMEOUT);
        try {
            await expect(offload.collect()).rejects.toThrow(/exceeded/);
            // The daemon's next poll lands here, while worker 1 is still dying.
            // Its id goes in the pending map before worker 1's exit arrives.
            const second = offload.collect();
            // Rejecting means it reached a worker and timed out there. Resolving
            // would mean the offload had given up and served the in-thread result.
            await expect(second).rejects.toThrow(/exceeded/);
            // Give worker 1's exit event every chance to land and be misjudged.
            await new Promise((r) => setTimeout(r, 200));
            expect(degraded(log)).toBe(false);
        } finally {
            offload.close();
        }
    });

    // The behaviour that must NOT regress: a worker that dies on its own while
    // owing an answer is still a real failure, and still degrades for good.
    it('still degrades when a worker dies owing an answer', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'dies.cjs'), ANSWER_TIMEOUT);
        try {
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(gaveUp(log)).toBe(true);
        } finally {
            offload.close();
        }
    });

    // close() terminates too, and must not be read as a failure either.
    it('does not log a failure when close terminates a working worker', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'echo.cjs'), ANSWER_TIMEOUT);
        await offload.collect();
        offload.close();
        await new Promise((r) => setTimeout(r, 200));
        expect(log).not.toHaveBeenCalled();
    });
});

/**
 * The escape hatch the exit-judgment fix exposed.
 *
 * A sweep that overruns the timeout is terminated and the next one starts a
 * fresh worker from nothing, so on a host where a cold sweep cannot finish
 * inside the timeout the offload makes no progress at all and the daemon stops
 * reporting entirely. Before the exit judgment was fixed this escaped by
 * accident — the terminated worker's exit was misread as a failure, which
 * degraded to in-thread. Losing that accident must not cost the daemon its
 * reports, so the degrade is now deliberate and takes consecutive timeouts.
 */
describe('inventory offload — repeated timeouts degrade on purpose', () => {
    it('keeps trying workers below the threshold', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'hangs.cjs'), TIMEOUT);
        try {
            for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
                await expect(offload.collect()).rejects.toThrow(/exceeded/);
            }
            expect(degraded(log)).toBe(false);
        } finally {
            offload.close();
        }
    });

    it('degrades in-thread once sweeps time out MAX times in a row', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'hangs.cjs'), TIMEOUT);
        try {
            for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
                await expect(offload.collect()).rejects.toThrow(/exceeded/);
            }
            // The daemon reports again from here, slowly, instead of not at all.
            expect(await offload.collect()).toBe(IN_THREAD);
            // A cooldown, not a verdict: timing out is a statement about the
            // host right now, and the host is allowed to get better.
            expect(cooledDown(log)).toBe(true);
            expect(gaveUp(log)).toBe(false);
            expect(log.mock.calls.some((c) => /timed out/.test(String(c[0])))).toBe(true);
        } finally {
            offload.close();
        }
    });

    // Load-bearing form of "the streak resets": two timeouts, then a sweep that
    // answers, then another timeout. That is three timeouts in total but only
    // one since the last answer, so the offload must NOT have given up. A
    // per-worker counter cannot express this -- each timeout terminates the
    // worker -- hence the marker file.
    it('forgets earlier timeouts once a sweep succeeds', async () => {
        const log = vi.fn();
        const dir = mkdtempSync(join(tmpdir(), 'hwip-offload-'));
        const marker = join(dir, 'answer');
        process.env.HWIP_TEST_MARKER = marker;
        useFakeClock();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'marker.cjs'), TIMEOUT);
        try {
            for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS - 1; i++) await sweepTimesOut(offload);
            writeFileSync(marker, '');
            expect((await offload.collect()).sessions.map((s) => s.name)).toEqual(['hwip-from-worker']);
            rmSync(marker);
            await sweepTimesOut(offload);
            expect(degraded(log)).toBe(false);
        } finally {
            offload.close();
            delete process.env.HWIP_TEST_MARKER;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /**
     * The give-up is a cooldown, not a verdict. A load spike long enough to
     * overrun three sweeps used to cost the offload for the life of the daemon,
     * which put the blocking sweep back on the event loop the worker exists to
     * protect — measured 2026-09-18 as a 5 s timer firing at a median of 28.5 s
     * and a WebSocket torn down every 1-3 minutes.
     */
    it('goes back to the worker once the cooldown passes', async () => {
        const log = vi.fn();
        const dir = mkdtempSync(join(tmpdir(), 'hwip-offload-'));
        const marker = join(dir, 'answer');
        process.env.HWIP_TEST_MARKER = marker;
        useFakeClock();
        const cooldown = 150;
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'marker.cjs'), TIMEOUT, cooldown);
        try {
            for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS; i++) await sweepTimesOut(offload);
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(cooledDown(log)).toBe(true);
            // The spike passes. So must the give-up.
            writeFileSync(marker, '');
            await vi.advanceTimersByTimeAsync(cooldown + 50);
            expect((await offload.collect()).sessions.map((s) => s.name)).toEqual(['hwip-from-worker']);
        } finally {
            offload.close();
            delete process.env.HWIP_TEST_MARKER;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('re-enters the cooldown on one timeout while the host is still slow', async () => {
        const log = vi.fn();
        const cooldown = 150;
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'hangs.cjs'), TIMEOUT, cooldown);
        try {
            for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
                await expect(offload.collect()).rejects.toThrow(/exceeded/);
            }
            expect(await offload.collect()).toBe(IN_THREAD);
            await new Promise((resolve) => setTimeout(resolve, cooldown + 50));
            // One probe sweep is the whole price of finding out. Spending three
            // again would be three full timeouts with no inventory at all, on a
            // host that has already shown it cannot finish one.
            await expect(offload.collect()).rejects.toThrow(/exceeded/);
            expect(await offload.collect()).toBe(IN_THREAD);
        } finally {
            offload.close();
        }
    });
});
