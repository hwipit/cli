import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
    BACKGROUND_TASK_PROBE_MS,
    initialBackgroundTaskState,
    lsofWriters,
    lsofWritersAsync,
    trackBackgroundTasks,
    type WriterProbe,
} from './background-tasks.js';

// Line shapes as Claude Code 2.x writes them, measured 2026-11-11 on this
// machine (`hwip cc` session, `Bash` with `run_in_background: true`). Paths
// and ids are made up; every key the tracker reads is the real one.
const OUT = '/private/tmp/claude-501/-Users-me-proj/0b7d1f1c-0000-4000-8000-000000000001/tasks/ba3nrpj41.output';

const launch = (toolUseId = 'toolu_01', description = 'Start dev server') => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-10T21:40:00.000Z',
    message: {
        role: 'assistant',
        content: [{
            type: 'tool_use', id: toolUseId, name: 'Bash',
            input: { command: 'API_TOKEN=secret pnpm dev', description, run_in_background: true },
        }],
    },
});

const started = (opts: { toolUseId?: string; taskId?: string; path?: string; structured?: boolean; blocks?: boolean } = {}) => {
    const { toolUseId = 'toolu_01', taskId = 'ba3nrpj41', path = OUT, structured = true, blocks = false } = opts;
    const text = `Command running in background with ID: ${taskId}. Output is being written to: ${path}. You will be notified when it completes — do not poll that file or sleep while waiting.`;
    return JSON.stringify({
        type: 'user',
        timestamp: '2026-11-10T21:40:01.000Z',
        message: {
            role: 'user',
            content: [{ tool_use_id: toolUseId, type: 'tool_result', content: blocks ? [{ type: 'text', text }] : text, is_error: false }],
        },
        toolUseResult: { stdout: '', stderr: '', interrupted: false, ...(structured ? { backgroundTaskId: taskId } : {}) },
    });
};

const notice = (taskId = 'ba3nrpj41', status = 'completed', toolUseId = 'toolu_01') =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${OUT}</output-file>\n<status>${status}</status>\n<summary>Background command "x" ${status}</summary>\n</task-notification>`;

/** The current shape: written the moment the task ends, mid-turn included. */
const queued = (taskId?: string, status?: string) => JSON.stringify({
    type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-10T21:44:39.685Z', content: notice(taskId, status),
});

/** The shape before the queue: a user turn the harness writes. */
const harnessTurn = (taskId?: string) => JSON.stringify({
    type: 'user', timestamp: '2026-11-10T21:44:40.000Z', origin: { kind: 'task-notification' },
    message: { role: 'user', content: notice(taskId) },
});

const attachment = (taskId?: string) => JSON.stringify({
    type: 'attachment', timestamp: '2026-11-10T21:44:39.684Z',
    attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice(taskId) },
});

/** A tool printing a transcript that contains a notice — prose, not an event. */
const quoted = (taskId?: string) => JSON.stringify({
    type: 'user', timestamp: '2026-11-10T21:45:00.000Z',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_99', type: 'tool_result', content: notice(taskId) }] },
});

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const transcript = (...lines: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-tasks-'));
    dirs.push(dir);
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return file;
};

const everyoneWrites: WriterProbe = (paths) => new Set(paths);

describe('trackBackgroundTasks', () => {
    it('reports a launched background command as one running task', () => {
        const file = transcript(launch(), started());
        const tasks = trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites });
        expect(tasks).toEqual([{
            id: 'ba3nrpj41',
            description: 'Start dev server',
            startedAt: '2026-11-10T21:40:01.000Z',
            outputPath: OUT,
        }]);
    });

    it('never carries the command itself — only the description', () => {
        const file = transcript(launch(), started());
        const tasks = trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites });
        expect(JSON.stringify(tasks)).not.toContain('secret');
    });

    it('reads the id and path off a tool_result whose content is a block array', () => {
        const file = transcript(launch(), started({ structured: false, blocks: true }));
        const tasks = trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites });
        expect(tasks.map((t) => [t.id, t.outputPath])).toEqual([['ba3nrpj41', OUT]]);
    });

    it.each([
        ['a queued notice', queued()],
        ['a harness user turn', harnessTurn()],
        ['a queued-command attachment', attachment()],
    ])('ends the task on %s', (_name, end) => {
        const file = transcript(launch(), started(), end);
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites })).toEqual([]);
    });

    it('ends the task when the notice arrives in a later read', () => {
        const file = transcript(launch(), started());
        const state = initialBackgroundTaskState();
        expect(trackBackgroundTasks(file, state, { probe: everyoneWrites })).toHaveLength(1);
        appendFileSync(file, `${queued('ba3nrpj41', 'killed')}\n`);
        expect(trackBackgroundTasks(file, state, { probe: everyoneWrites })).toEqual([]);
    });

    it('ignores a notice for a task it never saw start (a background Agent)', () => {
        const file = transcript(launch(), started(), queued('a0d11664a2d2f36fe'));
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites })).toHaveLength(1);
    });

    it('does not end a task on a tool result that quotes its notice', () => {
        const file = transcript(launch(), started(), quoted());
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites })).toHaveLength(1);
    });

    it('ignores a foreground command and a result with no launch', () => {
        const foreground = JSON.stringify({
            type: 'assistant', timestamp: '2026-11-10T21:40:00.000Z',
            message: { content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'ls' } }] },
        });
        const file = transcript(foreground, started({ toolUseId: 'toolu_02' }), started({ toolUseId: 'toolu_03', taskId: 'zz' }));
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites })).toEqual([]);
    });

    it('skips lines that are not JSON or not shaped as expected', () => {
        const file = transcript('not json', '{"type":"user","message":{"content":[{"type":"tool_result"}]}}', launch(), started());
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: everyoneWrites })).toHaveLength(1);
    });

    it('drops a task whose output nobody writes any more, once per probe window', () => {
        const file = transcript(launch(), started());
        const state = initialBackgroundTaskState();
        let calls = 0;
        const nobody: WriterProbe = () => { calls++; return new Set(); };
        expect(trackBackgroundTasks(file, state, { probe: everyoneWrites, now: 0 })).toHaveLength(1);
        // Inside the window: no second probe, the task stays.
        expect(trackBackgroundTasks(file, state, { probe: nobody, now: BACKGROUND_TASK_PROBE_MS - 1 })).toHaveLength(1);
        expect(calls).toBe(0);
        expect(trackBackgroundTasks(file, state, { probe: nobody, now: BACKGROUND_TASK_PROBE_MS })).toEqual([]);
        expect(calls).toBe(1);
    });

    it('keeps every task when the probe cannot answer', () => {
        const file = transcript(launch(), started());
        expect(trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: () => null })).toHaveLength(1);
    });

    it('never probes while nothing is running', () => {
        const file = transcript(launch());
        let calls = 0;
        trackBackgroundTasks(file, initialBackgroundTaskState(), { probe: () => { calls++; return new Set(); } });
        expect(calls).toBe(0);
    });
});

describe('lsofWriters (the real lsof)', () => {
    const hasLsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].some((p) => existsSync(p));

    it.skipIf(!hasLsof)('sees a file a running process writes, and not one nobody has open', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'bg-lsof-'));
        dirs.push(dir);
        const busy = join(dir, 'busy.output');
        const idle = join(dir, 'idle.output');
        writeFileSync(idle, '');
        const child = spawn('sh', ['-c', `exec sleep 30 > '${busy}'`], { stdio: 'ignore' });
        try {
            for (let i = 0; i < 50 && !existsSync(busy); i++) await new Promise((r) => setTimeout(r, 20));
            expect(lsofWriters([busy, idle])).toEqual(new Set([busy]));
            expect(await lsofWritersAsync([busy, idle])).toEqual(new Set([busy]));
        } finally {
            child.kill('SIGKILL');
        }
    });
});
