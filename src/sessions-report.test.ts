import { describe, it, expect, vi } from 'vitest';
import { planSessionsReport, sendSessionsReport, SESSIONS_REPORT_MAX_BYTES } from './sessions-report.js';

const session = (i: number, extra: Record<string, unknown> = {}) => ({
    name: `hwip-bench${i}`, attached: false, agentKind: 'claude', agentSessionId: null, project: `bench${i}`, label: null,
    providerSessionName: null, createdAt: '2026-10-04T03:09:19.000Z', lastActivityAt: '2026-10-04T03:09:19.000Z',
    state: 'idle', stateChangedAt: '2026-10-04T03:09:19.000Z', stateRuleId: 'claude-idle-prompt', ...extra,
});
const known = Array.from({ length: 30 }, (_, i) => ({ name: `old${i}`, agentKind: 'claude', project: `p${i}`, lastSeenAt: '2026-10-03T00:00:00.000Z' }));
const many = (n: number) => Array.from({ length: n }, (_, i) => session(i));
const byteLength = (s: string) => Buffer.byteLength(s, 'utf-8');
const parse = (message: string) => JSON.parse(message) as { type: string; data: Record<string, unknown> & { sessions: { name: string }[] } };

describe('planSessionsReport', () => {
    it('sends a report that fits as the one message it always was', () => {
        const sessions = many(10);

        const plan = planSessionsReport(sessions, known);

        expect(plan.messages).toEqual([JSON.stringify({ type: 'listener.sessions', data: { sessions, knownSessions: known } })]);
        expect(plan.oversized).toEqual([]);
    });

    it('cuts a larger report into partial parts that each fit, then a names message', () => {
        const sessions = many(300); // ≈ 87 KB whole

        const plan = planSessionsReport(sessions, known, SESSIONS_REPORT_MAX_BYTES, () => 'r1');

        expect(plan.wholeBytes).toBeGreaterThan(SESSIONS_REPORT_MAX_BYTES * 3);
        for (const message of plan.messages) expect(byteLength(message)).toBeLessThanOrEqual(SESSIONS_REPORT_MAX_BYTES);
        const all = plan.messages.map(parse);
        const parts = all.slice(0, -1);
        const names = all[all.length - 1]!;
        expect(parts.length).toBeGreaterThan(3);
        parts.forEach((p, i) => {
            expect(p.type).toBe('listener.sessions');
            expect(p.data).toMatchObject({ partial: true, reportId: 'r1', part: i + 1, parts: parts.length });
        });
        expect(names.type).toBe('listener.sessions.names');
        expect(names.data.names).toEqual(sessions.map((s) => s.name));
        expect(plan.namesOversized).toBe(false);
    });

    it('puts knownSessions in the first part, once', () => {
        const plan = planSessionsReport(many(300), known);

        const messages = plan.messages.map(parse);
        expect(messages[0]!.data.knownSessions).toEqual(known);
        expect(messages.slice(1).some((m) => 'knownSessions' in m.data)).toBe(false);
    });

    it('loses and repeats no session across the parts, in order', () => {
        const sessions = many(250);

        const plan = planSessionsReport(sessions, known);

        const parts = plan.messages.map(parse).filter((m) => m.type === 'listener.sessions');
        expect(parts.flatMap((m) => m.data.sessions)).toEqual(sessions);
    });

    it('keeps every message under a small limit too', () => {
        const plan = planSessionsReport(many(40), known, 8 * 1024);

        expect(plan.messages.length).toBeGreaterThan(2);
        for (const message of plan.messages) expect(byteLength(message)).toBeLessThanOrEqual(8 * 1024);
    });

    it('sends a session bigger than a part alone, and names it', () => {
        const sessions = [session(1), session(2, { label: 'x'.repeat(30 * 1024) }), session(3)];

        const plan = planSessionsReport(sessions, []);

        expect(plan.oversized).toEqual(['hwip-bench2']);
        const parts = plan.messages.map(parse).filter((m) => m.type === 'listener.sessions');
        expect(parts.flatMap((m) => m.data.sessions.map((s) => s.name))).toEqual(['hwip-bench1', 'hwip-bench2', 'hwip-bench3']);
        expect(parts.find((m) => JSON.stringify(m).includes('xxxx'))!.data.sessions).toHaveLength(1);
    });

    it('is one empty message for no sessions', () => {
        expect(planSessionsReport([], []).messages).toHaveLength(1);
    });

    it('holds at the size where one message used to break the connection', () => {
        // ≈ 290 B a session: 120 sessions is over API Gateway's 32 KB frame as one message.
        const sessions = many(120);
        const whole = byteLength(JSON.stringify({ type: 'listener.sessions', data: { sessions, knownSessions: known } }));
        expect(whole).toBeGreaterThan(32 * 1024);

        const plan = planSessionsReport(sessions, known);

        for (const message of plan.messages) expect(byteLength(message)).toBeLessThan(32 * 1024);
    });

    it('says when the names message alone is over the limit', () => {
        const plan = planSessionsReport(many(2200), []);

        expect(plan.namesOversized).toBe(true);
    });
});

describe('planSessionsReport reportId', () => {
    it('names the report in parts, and only then', () => {
        const sessions = Array.from({ length: 120 }, (_, i) => ({ name: `s${i}`, pad: 'x'.repeat(200) }));
        expect(planSessionsReport(sessions, [], SESSIONS_REPORT_MAX_BYTES, () => 'rid').reportId).toBe('rid');
        expect(planSessionsReport(sessions.slice(0, 2), [], SESSIONS_REPORT_MAX_BYTES, () => 'rid').reportId).toBeUndefined();
    });
});

describe('sendSessionsReport', () => {
    it('sends a single message at once, with no ack to wait for', async () => {
        const sent: string[] = [];
        const awaitAck = vi.fn(async () => true);

        expect(await sendSessionsReport(['a'], (m) => sent.push(m), awaitAck)).toBe(true);

        expect(sent).toEqual(['a']);
        expect(awaitAck).not.toHaveBeenCalled();
    });

    it('waits for each part\'s ack before the next message, and not after the last', async () => {
        const events: string[] = [];
        const awaitAck = () => {
            events.push('await');
            return new Promise<boolean>((resolve) => setTimeout(() => { events.push('ack'); resolve(true); }, 5));
        };

        await sendSessionsReport(['p1', 'p2', 'names'], (m) => events.push(`send ${m}`), awaitAck);

        expect(events).toEqual(['await', 'send p1', 'ack', 'await', 'send p2', 'ack', 'send names']);
    });

    it('asks for the ack of the part it just sent, by its number', async () => {
        const asked: number[] = [];

        await sendSessionsReport(['p1', 'p2', 'names'], () => undefined, async (part) => { asked.push(part); return true; });

        expect(asked).toEqual([1, 2]);
    });

    it('stops, and says so, when a part is not acked', async () => {
        const sent: string[] = [];

        const ok = await sendSessionsReport(['p1', 'p2', 'names'], (m) => sent.push(m), async () => false);

        expect(ok).toBe(false);
        expect(sent).toEqual(['p1']); // names never goes: it would remove sessions the server has not got
    });
});
