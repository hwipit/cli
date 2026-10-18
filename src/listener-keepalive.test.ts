import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

// How the listener keeps its socket alive and notices a dead one (keepalive design D2-D4 in the hwip
// repo): the numbers are written out here, not imported, so a spec that reads the implementation's
// own constants cannot stay green when they change.

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        // No tmux in this machine's view: the inventory is empty, which is all a report needs to go out.
        spawnSync: (cmd: string) => (cmd === 'tmux' ? { status: 1, stdout: '', stderr: 'no server running' } : { status: 1, stdout: '', stderr: '' }),
        execFileSync: ((cmd: string, ...rest: unknown[]) =>
            cmd === '/usr/sbin/ioreg'
                ? '  "IOPlatformUUID" = "HWIP-KEEPALIVE-TEST-MACHINE"\n'
                : (actual.execFileSync as (...args: unknown[]) => unknown)(cmd, ...rest)) as typeof actual.execFileSync,
    };
});

const { heartbeatVerdict, pingDue, sessionsReportDue, createReportAckWatch } = await import('./listener.js');

describe('the idle heartbeat of an unchanged report', () => {
    it('waits 120 s', () => {
        expect(sessionsReportDue('fp', 'fp', 0, 119_999)).toBe(false);
        expect(sessionsReportDue('fp', 'fp', 0, 120_000)).toBe(true);
    });

    it('still sends a change at once', () => {
        expect(sessionsReportDue('fp-new', 'fp', 0, 1)).toBe(true);
    });
});

describe('the idle ping', () => {
    it('is due once nothing was sent for 240 s', () => {
        expect(pingDue(0, 239_999)).toBe(false);
        expect(pingDue(0, 240_000)).toBe(true);
    });

    it('counts from the last send, not from the last ping', () => {
        expect(pingDue(100_000, 339_999)).toBe(false);
        expect(pingDue(100_000, 340_000)).toBe(true);
    });
});

describe('how long the server may say nothing (default limits)', () => {
    it('takes 120 s of silence, the heartbeat\'s own rhythm, as a live socket', () => {
        expect(heartbeatVerdict(120_000, 0)).toBe('alive');
        expect(heartbeatVerdict(300_000, 0)).toBe('alive');
    });

    it('calls a socket dead after 300 s of silence the thread was free to hear', () => {
        expect(heartbeatVerdict(300_001, 0)).toBe('dead');
    });

    it('forgives a blocked thread up to 360 s', () => {
        // A third of the limit blocked (the grace) is what makes the silence the thread's own.
        expect(heartbeatVerdict(360_000, 100_000)).toBe('blocked');
        expect(heartbeatVerdict(360_001, 360_000)).toBe('dead');
    });
});

describe('createReportAckWatch', () => {
    it('is overdue 30 s after a report nobody answered', () => {
        const watch = createReportAckWatch();
        watch.sent(1_000);
        expect(watch.overdue(31_000)).toBe(false);
        expect(watch.overdue(31_001)).toBe(true);
    });

    it('is quiet while nothing waits, and once the report is answered', () => {
        const watch = createReportAckWatch();
        expect(watch.overdue(1e9)).toBe(false);
        watch.sent(0);
        watch.answered();
        expect(watch.overdue(1e9)).toBe(false);
    });

    it('measures from the oldest report still waiting, not the latest', () => {
        const watch = createReportAckWatch();
        watch.sent(0);
        watch.sent(25_000);
        expect(watch.overdue(30_001)).toBe(true);
    });

    it('does not hold the server to the time this thread could not hear it', () => {
        const watch = createReportAckWatch();
        watch.sent(0, 0);
        // 60 s went by, 40 s of it this thread was blocked: 20 s of the server's own silence.
        expect(watch.overdue(60_000, 40_000)).toBe(false);
        expect(watch.overdue(60_000, 29_000)).toBe(true);
    });
});

// The wiring: a real socket to a local server, the clock faked (Date and intervals only — the
// network stays real), so 35 s of silence takes no time.
describe('a listener whose reports go unanswered', () => {
    let tmp: string;
    const originalHome = process.env.HOME;
    const realSetTimeout = setTimeout;
    let wss: WebSocketServer;
    let url: string;
    let connections: ServerSocket[];
    let received: string[];
    let answerReports: boolean;

    const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
        for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => realSetTimeout(resolve, 5));
        if (!condition()) throw new Error(`timed out waiting for ${label}`);
    };

    beforeEach(async () => {
        tmp = mkdtempSync(join(tmpdir(), 'keepalive-'));
        process.env.HOME = tmp;
        vi.resetModules();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        connections = [];
        received = [];
        answerReports = false;
        wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise<void>((resolve) => wss.once('listening', resolve));
        url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
        wss.on('connection', (socket) => {
            connections.push(socket);
            socket.on('message', (raw) => {
                const text = raw.toString('utf-8');
                received.push(text);
                if (answerReports && (JSON.parse(text) as { type?: string }).type === 'listener.sessions') {
                    socket.send(JSON.stringify({ type: 'listener.sessions.ack', data: { count: 0, updatedAt: new Date().toISOString() } }));
                }
            });
        });
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        for (const socket of connections) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        rmSync(tmp, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    const connect = async () => {
        const { streamSession } = await import('./listener.js');
        const handle = streamSession(url, 'test-key');
        let ended = false;
        void handle.done.then(() => { ended = true; });
        await waitFor(() => received.some((m) => (JSON.parse(m) as { type?: string }).type === 'listener.sessions'), 'the first report');
        return { handle, ended: () => ended };
    };

    it('drops the socket when a report gets no answer for 30 s', async () => {
        const { handle, ended } = await connect();

        await vi.advanceTimersByTimeAsync(25_000);
        expect(ended()).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        await waitFor(ended, 'the listener to drop the socket');
        expect(ended()).toBe(true);
        handle.terminate();
    });

    it('keeps the socket when the report is answered', async () => {
        answerReports = true;
        const { handle, ended } = await connect();
        await waitFor(() => true, 'nothing'); // let the ack come back on the real network

        await vi.advanceTimersByTimeAsync(60_000);
        await new Promise((resolve) => realSetTimeout(resolve, 50));

        expect(ended()).toBe(false);
        handle.terminate();
    });

    it('sends the heartbeat every 120 s and no ping while it flows', async () => {
        answerReports = true;
        const { handle, ended } = await connect();
        const types = () => received.map((m) => (JSON.parse(m) as { type?: string }).type);

        // 130 s: the first report, then one heartbeat. Stepped by 5 s so each sweep (a real, async one) can finish.
        for (let i = 0; i < 26; i++) {
            await vi.advanceTimersByTimeAsync(5_000);
            await new Promise((resolve) => realSetTimeout(resolve, 20));
        }

        expect(types().filter((t) => t === 'listener.sessions')).toHaveLength(2);
        expect(types()).not.toContain('ping');
        expect(ended()).toBe(false);
        handle.terminate();
    });
});
