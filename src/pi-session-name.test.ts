import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPiSessionName } from './remote-agents.js';
import * as templates from './templates.js';

/**
 * What the phone calls a pi session, and who chose it.
 *
 * pi keeps a session's name as `session_info` lines in its transcript — the
 * newest wins — and has no field for who wrote one. `/name` writes one; so
 * does the hwip extension's `hwip_session_title` tool, which also leaves a
 * `hwip-session-name` custom entry holding the same name. A name that matches
 * the newest marker is the agent's own; any other is the user's.
 * Line shapes from pi 1.2.0 dist/core/session-manager.js (appendSessionInfo,
 * appendCustomEntry).
 */

let dir: string;
let transcript: string;

const info = (name: string) => `${JSON.stringify({ type: 'session_info', id: 'e1', parentId: null, timestamp: 't', name })}\n`;
const marker = (name: string) =>
    `${JSON.stringify({ type: 'custom', id: 'e2', parentId: 'e1', timestamp: 't', customType: 'hwip-session-name', data: { name } })}\n`;
const message = `${JSON.stringify({ type: 'message', id: 'e3', message: { role: 'user', content: 'organise Downloads' } })}\n`;

const resolve = (file: string | null = transcript) => detectPiSessionName('/proj', 100, () => file);

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-pi-name-'));
    transcript = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectPiSessionName', () => {
    it('reports a name the hwip tool set as auto', () => {
        writeFileSync(transcript, message + info('Downloads 정리') + marker('Downloads 정리'));

        expect(resolve()).toEqual({ name: 'Downloads 정리', source: 'auto' });
    });

    it('reports a /name name as user', () => {
        writeFileSync(transcript, message + info('release prep'));

        expect(resolve()).toEqual({ name: 'release prep', source: 'user' });
    });

    it('reports a /name after the tool as user', () => {
        writeFileSync(transcript, info('Downloads 정리') + marker('Downloads 정리') + message);
        expect(resolve()?.source).toBe('auto');

        appendFileSync(transcript, info('release prep'));

        expect(resolve()).toEqual({ name: 'release prep', source: 'user' });
    });

    it('reports nothing for a session with no name, or no transcript', () => {
        writeFileSync(transcript, message);

        expect(resolve()).toBeNull();
        expect(resolve(null)).toBeNull();
    });

    it('reports nothing once the name is cleared, and skips a torn line', () => {
        writeFileSync(transcript, info('Fix login') + marker('Fix login') + '{"type":"session_info","name":\n' + info('  '));

        expect(resolve()).toBeNull();
    });
});

/**
 * The extension half: the tool pi's model calls. Driven through the compiled
 * template, the same way templates.test.ts drives the rest of PI_EXTENSION.
 */
describe('PI_EXTENSION hwip_session_title', () => {
    type Tool = {
        name: string;
        promptGuidelines?: string[];
        parameters: unknown;
        execute: (id: string, params: { title: string }) => Promise<{ content: { text: string }[] }>;
    };

    const load = () => {
        const js = transformSync(templates.PI_EXTENSION, { loader: 'ts', format: 'cjs' }).code;
        const mod = { exports: {} as Record<string, unknown> };
        const child = { on: () => {}, unref: () => {}, stdout: { on: () => {} }, stdin: { end: () => {} } };
        new Function('exports', 'module', 'require', js)(mod.exports, mod, () =>
            ({ spawn: () => child, execFile: () => {}, execFileSync: () => '', statSync: () => ({ mtimeMs: 1 }) }));
        const calls: [string, ...unknown[]][] = [];
        const tools: Tool[] = [];
        (mod.exports.default as (pi: unknown) => void)({
            on: () => {},
            registerTool: (tool: Tool) => tools.push(tool),
            setSessionName: (name: string) => calls.push(['setSessionName', name]),
            appendEntry: (type: string, data: unknown) => calls.push(['appendEntry', type, data]),
        });
        return { tool: tools.find((t) => t.name === 'hwip_session_title'), calls };
    };

    it('names the session and leaves the marker holding the same name', async () => {
        const { tool, calls } = load();

        await tool!.execute('call-1', { title: '  Downloads\n정리 ' });

        expect(calls).toEqual([
            ['appendEntry', 'hwip-session-name', { name: 'Downloads 정리' }],
            ['setSessionName', 'Downloads 정리'],
        ]);
    });

    // A throw is how a pi tool reports an error to the model.
    it('refuses a blank or non-string title and writes nothing', async () => {
        const { tool, calls } = load();

        await expect(tool!.execute('call-1', { title: '   ' })).rejects.toThrow(/empty/);
        await expect(tool!.execute('call-1', { title: { x: 1 } as never })).rejects.toThrow(/string/); // the model can send any JSON

        expect(calls).toEqual([]);
    });

    // pi loads the file with its own resolver: anything outside node: has to be one it aliases, and
    // which it aliases depends on the pi version (typebox only from 0.69). One failed import takes
    // the push gate and the REMOTE contract down with it.
    it('imports nothing at run time beyond node: modules', () => {
        const js = transformSync(templates.PI_EXTENSION, { loader: 'ts', format: 'cjs' }).code;
        const required = [...js.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
        expect(required.length).toBeGreaterThan(0);
        expect(required.filter((id) => !id!.startsWith('node:'))).toEqual([]);
    });

    it('cuts a long title by character, never inside an emoji', async () => {
        const { tool, calls } = load();

        await tool!.execute('call-1', { title: `${'x'.repeat(39)}😀😀` });

        expect(calls[1]).toEqual(['setSessionName', `${'x'.repeat(39)}😀`]);
    });

    // Same sentence the MCP server sends with its own hwip_session_title.
    it('tells the model when to call it, through the tool guidelines', () => {
        const { tool } = load();

        expect(tool!.promptGuidelines?.join(' ')).toContain('after the first request, and again only when the task changes');
        expect(tool!.promptGuidelines?.join(' ')).toContain('Do not mention it to the user');
    });
});
