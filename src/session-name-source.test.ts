import { mkdtempSync, writeFileSync, appendFileSync, rmSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectClaudeProviderName, type PidSessionRecord } from './remote-agents.js';
import { createTailWatch } from './session-title.js';
import { readTranscriptDelta } from './transcript-tail.js';
import { sessionsFingerprint, type AgentSession } from './listener.js';

/**
 * What the phone calls a Claude Code session, and who chose it.
 *
 * Claude Code names every session itself: the session record carries a name
 * derived from the cwd (`hybrid-shell-8f`, `nameSource: "derived"`) until the
 * user runs `/rename` (`nameSource: "user"`), and the transcript gets an
 * `ai-title` line summarising the work. The derived name repeats the tmux name
 * and says nothing; the ai-title is what "what did I ask this session to do"
 * looks like. Records and lines below are copied from real CC 2.1.30x files.
 */

let dir: string;
let transcript: string;

const record = (over: Partial<PidSessionRecord>): PidSessionRecord => ({
    pid: 100, sessionId: 'sess-1', cwd: '/proj', ...over,
});

const aiTitle = (title: string) =>
    `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'sess-1' })}\n`;
const userLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'organise Downloads' } })}\n`;

const resolve = (rec: PidSessionRecord, file: string | null = transcript) =>
    detectClaudeProviderName(90, '/proj', {
        records: [rec],
        descendants: new Set([90, 100]),
        transcriptOf: () => file,
    });

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-claude-title-'));
    transcript = join(dir, 'sess-1.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectClaudeProviderName', () => {
    it('reports the latest ai-title as an auto name when the record name is derived', () => {
        writeFileSync(transcript, userLine + aiTitle('Downloads 정리') + userLine + aiTitle('Downloads 폴더 정리'));

        expect(resolve(record({ name: 'proj-8f', nameSource: 'derived' })))
            .toEqual({ name: 'Downloads 폴더 정리', source: 'auto' });
    });

    it('reports a /rename name as a user name, over any ai-title', () => {
        writeFileSync(transcript, aiTitle('Downloads 폴더 정리'));

        expect(resolve(record({ name: 'seo-chrome', nameSource: 'user' })))
            .toEqual({ name: 'seo-chrome', source: 'user' });
    });

    it('reports nothing for a derived name with no ai-title yet', () => {
        writeFileSync(transcript, userLine);

        expect(resolve(record({ name: 'proj-8f', nameSource: 'derived' }))).toBeNull();
    });

    it('reports nothing for a derived name when the transcript is not there', () => {
        expect(resolve(record({ name: 'proj-8f', nameSource: 'derived' }), null)).toBeNull();
    });

    // An older CC writes `name` without `nameSource`. It might be a rename, so
    // it is sent as before — with no source, which no setting hides.
    it('keeps a name with no nameSource and gives it no source', () => {
        writeFileSync(transcript, userLine);

        expect(resolve(record({ name: 'proj-95' }))).toEqual({ name: 'proj-95' });
    });

    it('keeps a name with no nameSource over an ai-title — it may be a rename', () => {
        writeFileSync(transcript, aiTitle('Fix login'));

        expect(resolve(record({ name: 'proj-95' }))).toEqual({ name: 'proj-95' });
    });

    it('ignores a blank ai-title and a malformed line', () => {
        writeFileSync(transcript, aiTitle('Fix login') + '{"type":"ai-title","aiTitle":\n' + aiTitle('   '));

        expect(resolve(record({ name: 'proj-8f', nameSource: 'derived' })))
            .toEqual({ name: 'Fix login', source: 'auto' });
    });

    it('picks up a newer ai-title once the transcript grows', () => {
        writeFileSync(transcript, aiTitle('Fix login'));
        const rec = record({ name: 'proj-8f', nameSource: 'derived' });
        expect(resolve(rec)?.name).toBe('Fix login');

        appendFileSync(transcript, userLine + aiTitle('Fix login and signup'));

        expect(resolve(rec)?.name).toBe('Fix login and signup');
    });
});

describe('createTailWatch', () => {
    const pickTitle = (line: string): string | undefined =>
        line.includes('"ai-title"') ? (JSON.parse(line) as { aiTitle?: string }).aiTitle : undefined;

    it('reads a file once while it does not change, and only the new bytes after it grows', () => {
        writeFileSync(transcript, aiTitle('one'));
        const reads: number[] = [];
        const watch = createTailWatch(pickTitle, (path, prev) => {
            const r = readTranscriptDelta(path, prev);
            if (r) reads.push(r.bytesRead);
            return r;
        });

        expect(watch.read(transcript)).toBe('one');
        expect(watch.read(transcript)).toBe('one');
        expect(reads).toHaveLength(1);

        appendFileSync(transcript, aiTitle('two'));
        expect(watch.read(transcript)).toBe('two');
        expect(reads).toEqual([Buffer.byteLength(aiTitle('one')), Buffer.byteLength(aiTitle('two'))]);
    });

    it('keeps the last value when a later chunk holds no matching line', () => {
        writeFileSync(transcript, aiTitle('one'));
        const watch = createTailWatch(pickTitle);
        watch.read(transcript);

        appendFileSync(transcript, userLine);

        expect(watch.read(transcript)).toBe('one');
    });

    it('forgets a file that was replaced, rather than keeping its old value', () => {
        writeFileSync(transcript, aiTitle('old session'));
        const watch = createTailWatch(pickTitle);
        watch.read(transcript);

        rmSync(transcript);
        writeFileSync(transcript, userLine);

        expect(watch.read(transcript)).toBeUndefined();
    });

    it('forgets the value when the file is cut shorter in place', () => {
        writeFileSync(transcript, userLine + aiTitle('old session'));
        const watch = createTailWatch(pickTitle);
        expect(watch.read(transcript)).toBe('old session');
        const ino = statSync(transcript).ino;

        truncateSync(transcript, 0);
        writeFileSync(transcript, '{}\n');

        expect(statSync(transcript).ino).toBe(ino);
        expect(watch.read(transcript)).toBeUndefined();
    });

    // The listener never says a session is gone, so the watch bounds itself:
    // without a cap every transcript ever resolved would keep its state.
    it('holds at most its capacity of files, dropping the least recently read', () => {
        const watch = createTailWatch(pickTitle, readTranscriptDelta, 2);
        const files = ['a', 'b', 'c'].map((n) => {
            const f = join(dir, `${n}.jsonl`);
            writeFileSync(f, aiTitle(n));
            return f;
        });
        for (const f of files) watch.read(f);

        expect(watch.size()).toBe(2);
        expect(watch.has(files[0]!)).toBe(false);
        expect(watch.has(files[2]!)).toBe(true);
    });
});

describe('sessionsFingerprint', () => {
    const session = (over: Partial<AgentSession>): AgentSession => ({
        name: 'hwip-proj', attached: true, agentKind: 'claude', project: 'proj',
        providerSessionName: 'Fix login', ...over,
    } as AgentSession); // fixture: only the fields the fingerprint reads

    // Same name, different author: a fingerprint that misses the source leaves
    // the server holding the old one until the 50 s write-through.
    it('changes when only the name source changes', () => {
        expect(sessionsFingerprint([session({ providerSessionNameSource: 'auto' })]))
            .not.toBe(sessionsFingerprint([session({ providerSessionNameSource: 'user' })]));
    });
});
