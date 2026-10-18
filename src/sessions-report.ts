/**
 * The `listener.sessions` report, cut to fit the one message size this socket
 * can carry.
 *
 * API Gateway closes a WebSocket whose frame is over 32 KB (close code 1009;
 * "WebSocket frame size", a quota that cannot be raised). `ws` sends a message
 * as one frame, and the report grows by about 290 bytes a session, so a machine
 * with around a hundred sessions would see its connection dropped on every
 * report and the inventory would never arrive.
 *
 * A report that fits goes out exactly as it always did. A larger one goes as
 * (the server's contract, `server/SERVER-API.md`):
 *
 *   - parts of at most `SESSIONS_REPORT_MAX_BYTES`, each `listener.sessions`
 *     with `partial: true` and some of the sessions — the server upserts what
 *     it is given, by name, and acks each part. The first part also carries
 *     `knownSessions` (once is enough);
 *   - then `listener.sessions.names` with every session name in the report, so
 *     the server can drop the sessions that are no longer there — what a
 *     whole-list report does by replacing the list.
 *
 * The next message waits for the previous part's ack (`sendSessionsReport`):
 * the server merges overlapping parts safely, but overlapping ones can fire a
 * blocked-session push twice. Parts also say their place (`part` of `parts`,
 * one `reportId`); the server ignores those, they are for the log.
 *
 * A server that predates parts reads each part as a whole report (the last
 * part would win) and does not know `listener.sessions.names`: the inventory is
 * wrong there, but the connection stays up, which one oversized message did not.
 */

import { randomUUID } from 'node:crypto';

/** Under API Gateway's 32 KB frame, with room for the envelope and a long session or two. */
export const SESSIONS_REPORT_MAX_BYTES = 24 * 1024;

export interface SessionsReportPlan {
    /** The JSON messages to send, in order: one when the report fits, else the parts and then `names`. */
    messages: string[];
    /** Sessions in the report. */
    sessionCount: number;
    /** Bytes of the report sent as one message — what it would have been uncut. */
    wholeBytes: number;
    /** Sessions whose own JSON is bigger than a part can hold: sent alone, over the limit. */
    oversized: string[];
    /** The `names` message is bigger than a message can hold (about 900 sessions): sent anyway. */
    namesOversized: boolean;
    /** Identifies a report in parts; the server echoes it (and `part`) in each ack. Absent for one message. */
    reportId?: string;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf-8');

export const planSessionsReport = (
    sessions: readonly { name: string }[],
    knownSessions: readonly unknown[],
    maxBytes: number = SESSIONS_REPORT_MAX_BYTES,
    reportId: () => string = randomUUID,
): SessionsReportPlan => {
    const whole = JSON.stringify({ type: 'listener.sessions', data: { sessions, knownSessions } });
    const wholeBytes = bytes(whole);
    if (wholeBytes <= maxBytes) {
        return { messages: [whole], sessionCount: sessions.length, wholeBytes, oversized: [], namesOversized: false };
    }

    const id = reportId();
    const knownBytes = bytes(JSON.stringify({ knownSessions }));
    const envelopeBytes = bytes(JSON.stringify({
        type: 'listener.sessions',
        data: { sessions: [], partial: true, reportId: id, part: 999, parts: 999 },
    }));

    // Greedy: a session goes in the current part while it fits. The first part gives up room for
    // `knownSessions`; no part gives up less than one session.
    const groups: (typeof sessions[number])[][] = [];
    const oversized: string[] = [];
    let current: (typeof sessions[number])[] = [];
    let budget = Math.max(maxBytes - envelopeBytes - knownBytes, 0);
    let used = 0;
    for (const session of sessions) {
        // +1 for the comma between sessions in the array.
        const size = bytes(JSON.stringify(session)) + 1;
        if (current.length > 0 && used + size > budget) {
            groups.push(current);
            current = [];
            used = 0;
            budget = Math.max(maxBytes - envelopeBytes, 0);
        }
        if (size > budget) oversized.push(session.name);
        current.push(session);
        used += size;
    }
    groups.push(current);

    const parts = groups.length;
    const messages = groups.map((group, index) => JSON.stringify({
        type: 'listener.sessions',
        data: { sessions: group, partial: true, reportId: id, part: index + 1, parts, ...(index === 0 ? { knownSessions } : {}) },
    }));
    const names = JSON.stringify({ type: 'listener.sessions.names', data: { names: sessions.map((s) => s.name), reportId: id } });
    messages.push(names);
    return { messages, sessionCount: sessions.length, wholeBytes, oversized, namesOversized: bytes(names) > maxBytes, reportId: id };
};

/** How long a part waits for its ack before the report is given up (and tried again on the next poll). */
export const SESSIONS_ACK_TIMEOUT_MS = 10_000;

/**
 * Send a plan's messages in order. With parts, every message but the last (`names`) waits for its
 * ack before the next goes — `awaitAck(part)` is asked for before the send, so a quick answer is not
 * missed, and `names` (which removes whatever it does not list) only goes once every part landed.
 * False when an ack did not come: the rest is not sent, and the caller treats the report as unsent.
 */
export const sendSessionsReport = async (
    messages: readonly string[],
    send: (message: string) => void,
    awaitAck: (part: number) => Promise<boolean>,
): Promise<boolean> => {
    for (let i = 0; i < messages.length; i++) {
        const acked = messages.length > 1 && i < messages.length - 1 ? awaitAck(i + 1) : null;
        send(messages[i]!);
        if (acked && !(await acked)) return false;
    }
    return true;
};
