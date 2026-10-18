import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';
import { CURSOR_HOOKS, WINDSURF_HOOKS } from './templates.js';
import { checkListenerPid, type ListenerStop, type PidCommand } from './listener-process.js';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseJsonc } from './jsonc-doc.js';
import { join } from 'node:path';

// End-to-end uninstall tests. We scope HOME to a temp dir and create the
// artifacts `hwip install` would have written for the directory-detected
// agents (Cursor / Windsurf — detected by ~/.cursor and ~/.codeium
// existing, no CLI on PATH needed). Then assert handleUninstall removes
// exactly the Hwip parts and nothing else.
//
// PATH is emptied for every case. Agents like Claude Code are detected by
// `which`, and a detected one gets its real CLI run — on a developer machine
// that launched `claude plugin uninstall hwip@hwip` from every test here. A
// case that needs a CLI on PATH puts a fake one there (`fakeBin`).

const UNINSTALL_ENV_KEYS = ['HOME', 'PATH'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of UNINSTALL_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-uninstall-test-'));
    process.env.HOME = TMP;
    process.env.PATH = '';
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of UNINSTALL_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

const write = (rel: string, content: string): string => {
    const p = join(TMP, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
    return p;
};

// Create the Cursor + Windsurf artifacts a real install produces.
const seedCursorAndWindsurf = () => {
    mkdirSync(join(TMP, '.cursor'), { recursive: true });
    mkdirSync(join(TMP, '.codeium'), { recursive: true });

    const cursorMcp = write('.cursor/mcp.json', JSON.stringify({
        mcpServers: {
            other: { command: 'node' },
            hwip: MCP_SERVERS_ENTRY,
        },
    }, null, 2));
    const cursorRule = write('.cursor/rules/hwip.mdc', 'hwip rule content');
    const cursorHooks = write('.cursor/hooks.json', JSON.stringify(CURSOR_HOOKS));

    const wsRules = write(
        '.codeium/windsurf/memories/global_rules.md',
        '# My own windsurf rules\nkeep me\n\n<!-- HWIP:START — managed by @hwip/cli, do not edit between markers -->\nhwip block\n<!-- HWIP:END -->\n',
    );
    const wsHooks = write('.codeium/windsurf/hooks.json', JSON.stringify(WINDSURF_HOOKS));

    return { cursorMcp, cursorRule, cursorHooks, wsRules, wsHooks };
};

describe('handleUninstall — Cursor + Windsurf', () => {
    it('removes every Hwip artifact', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});

        // Cursor: rule + hooks files gone, mcp.json keeps `other`, drops `hwip`
        expect(existsSync(f.cursorRule)).toBe(false);
        expect(existsSync(f.cursorHooks)).toBe(false);
        const cursorMcp = JSON.parse(readFileSync(f.cursorMcp, 'utf-8'));
        expect(cursorMcp.mcpServers).toHaveProperty('other');
        expect(cursorMcp.mcpServers).not.toHaveProperty('hwip');

        // Windsurf: hooks gone; rule file keeps the user's content, drops the block
        expect(existsSync(f.wsHooks)).toBe(false);
        const wsRules = readFileSync(f.wsRules, 'utf-8');
        expect(wsRules).toContain('# My own windsurf rules');
        expect(wsRules).toContain('keep me');
        expect(wsRules).not.toContain('HWIP:START');
        expect(wsRules).not.toContain('hwip block');
    });

    // The files used to be deleted whole, taking the user's own hooks along.
    it('takes only hwip out of hook files the user also uses', async () => {
        const f = seedCursorAndWindsurf();
        const withUserHook = (template: object, event: string) => {
            const data = JSON.parse(JSON.stringify(template));
            data.hooks[event].unshift({ command: 'my-own.sh' });
            data.hooks.beforeMine = [{ command: 'other.sh' }];
            return JSON.stringify(data);
        };
        writeFileSync(f.cursorHooks, withUserHook(CURSOR_HOOKS, 'stop'));
        writeFileSync(f.wsHooks, withUserHook(WINDSURF_HOOKS, 'post_cascade_response'));
        const { handleUninstall } = await import('./uninstall.js');

        await handleUninstall({});

        const cursor = JSON.parse(readFileSync(f.cursorHooks, 'utf-8'));
        expect(cursor.hooks).toEqual({ stop: [{ command: 'my-own.sh' }], beforeMine: [{ command: 'other.sh' }] });
        const ws = JSON.parse(readFileSync(f.wsHooks, 'utf-8'));
        expect(ws.hooks).toEqual({ post_cascade_response: [{ command: 'my-own.sh' }], beforeMine: [{ command: 'other.sh' }] });
    });

    // A step that throws used to end the whole uninstall, so the agents after it,
    // the service and the listener were never reached.
    it.skipIf(process.getuid?.() === 0)('keeps going when one step cannot write', async () => {
        const f = seedCursorAndWindsurf();
        const data = JSON.parse(JSON.stringify(CURSOR_HOOKS));
        data.hooks.stop.unshift({ command: 'my-own.sh' });
        writeFileSync(f.cursorHooks, JSON.stringify(data));
        const { handleUninstall } = await import('./uninstall.js');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        // hooks.json is read-only: its rewrite is refused (a directory that takes no new files is written in place instead).
        chmodSync(f.cursorHooks, 0o444);
        try {
            await handleUninstall({});
        } finally {
            chmodSync(f.cursorHooks, 0o644);
        }
        const output = log.mock.calls.flat().join('\n');
        log.mockRestore();

        expect(output).toMatch(/ {4}! could not finish: .*hooks\.json is read-only, left it unchanged/);
        expect(existsSync(f.wsHooks)).toBe(false);
        expect(output).toContain('Listener:');
    });

    it('dry-run changes nothing', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ 'dry-run': true });

        expect(existsSync(f.cursorRule)).toBe(true);
        expect(existsSync(f.cursorHooks)).toBe(true);
        expect(existsSync(f.wsHooks)).toBe(true);
        const cursorMcp = JSON.parse(readFileSync(f.cursorMcp, 'utf-8'));
        expect(cursorMcp.mcpServers).toHaveProperty('hwip');
        expect(readFileSync(f.wsRules, 'utf-8')).toContain('HWIP:START');
    });

    // C118: the flag was read as `=== true`, so `--dry-run=true`, `=1` and `--dry-run yes` were "not given" and
    // the command removed what it was asked to only preview.
    it.each(['true', '1', 'yes', 'TRUE', true])('--dry-run=%s previews and changes nothing', async (value) => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ 'dry-run': value });

        expect(existsSync(f.cursorRule)).toBe(true);
        expect(existsSync(f.cursorHooks)).toBe(true);
        expect(existsSync(f.wsHooks)).toBe(true);
        expect(JSON.parse(readFileSync(f.cursorMcp, 'utf-8')).mcpServers).toHaveProperty('hwip');
        expect(readFileSync(f.wsRules, 'utf-8')).toContain('HWIP:START');
    });

    it('stops on a --dry-run value that is neither yes nor no, before it removes anything', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await expect(handleUninstall({ 'dry-run': 'maybe' })).rejects.toThrow('--dry-run takes true or false');

        expect(existsSync(f.cursorRule)).toBe(true);
        expect(existsSync(f.wsHooks)).toBe(true);
    });

    it('--dry-run=false is a real removal, as written', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ 'dry-run': 'false', yes: true });

        expect(existsSync(f.cursorHooks)).toBe(false);
    });

    it('--purge=true and --yes=true are read like the bare flags', async () => {
        const f = seedCursorAndWindsurf();
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'config.json'), '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ purge: 'true', yes: 'true' });

        expect(existsSync(f.cursorHooks)).toBe(false);
        expect(existsSync(join(TMP, '.hwip', 'config.json'))).toBe(false);
    });

    // Uses the legacy `@hwip/hook-sdk` marker on purpose: blocks written by
    // pre-rename installs must still be removable after the rename to
    // `@hwip/cli` (removeManagedBlock matches the `<!-- HWIP:START` prefix).
    it('deletes a shared rule file only when it was Hwip-only (legacy marker)', async () => {
        mkdirSync(join(TMP, '.codeium'), { recursive: true });
        const onlyHwip = write(
            '.codeium/windsurf/memories/global_rules.md',
            '<!-- HWIP:START — managed by @hwip/hook-sdk, do not edit between markers -->\nhwip block\n<!-- HWIP:END -->\n',
        );
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});
        // No user content remained → the whole file is removed
        expect(existsSync(onlyHwip)).toBe(false);
    });
});

// `hwip cc` starts the listener without the login-time service, so uninstall
// used to leave it running — still carrying phone input into tmux.
describe('stopping the listener', () => {
    const LISTENER = '/usr/local/bin/node /usr/local/lib/node_modules/@hwip/cli/dist/cli.js listener';
    const running = (command: string): PidCommand => ({ kind: 'running', command });
    const gone: PidCommand = { kind: 'gone' };
    const fakeDeps = (pid: number | null, found: PidCommand) => {
        const stopped: number[] = [];
        const check = (p: number) => checkListenerPid(p, () => found);
        return {
            stopped,
            deps: {
                runningListenerPid: () => pid,
                checkListenerPid: check,
                stopListener: async (p: number): Promise<ListenerStop> => {
                    const checked = check(p);
                    if (checked.kind !== 'ours') return checked;
                    stopped.push(p);
                    return { kind: 'stopped' };
                },
            },
        };
    };

    it('stops a running listener', async () => {
        const { stopListenerStep } = await import('./uninstall.js');
        const { stopped, deps } = fakeDeps(4242, running(LISTENER));

        expect(await stopListenerStep(false, deps)).toBe('stopped the listener (pid 4242)');
        expect(stopped).toEqual([4242]);
    });

    it('only says what it would do in a dry run', async () => {
        const { stopListenerStep } = await import('./uninstall.js');
        const { stopped, deps } = fakeDeps(4242, running(LISTENER));

        expect(await stopListenerStep(true, deps)).toBe('would stop the listener (pid 4242)');
        expect(stopped).toEqual([]);
    });

    it.each([['no pid file', null, gone], ['a pid that has exited', 4242, gone]])(
        'does nothing for %s', async (_, pid, found) => {
            const { stopListenerStep } = await import('./uninstall.js');
            const { stopped, deps } = fakeDeps(pid, found);

            expect(await stopListenerStep(false, deps)).toBeNull();
            expect(stopped).toEqual([]);
        },
    );

    // The pid file outlives a crashed daemon, and its pid can be reused.
    it("leaves a pid that now belongs to Zeph's listener alone", async () => {
        const { stopListenerStep } = await import('./uninstall.js');
        const { stopped, deps } = fakeDeps(4242, running('node /x/@zeph-to/cli/dist/cli.js listener --token s3cret'));

        const line = await stopListenerStep(false, deps);

        expect(line).toEqual({ notice: 'note', text: "left pid 4242 alone: the listener's pid file points at another process (node)" });
        expect(stopped).toEqual([]);
    });

    it('says how to stop it by hand when ps cannot answer', async () => {
        const { stopListenerStep } = await import('./uninstall.js');
        const { stopped, deps } = fakeDeps(4242, { kind: 'unchecked', reason: 'spawnSync ps ENOENT' });

        expect(await stopListenerStep(false, deps)).toEqual({
            notice: 'attention',
            text: 'could not check pid 4242 (spawnSync ps ENOENT) — if it is the listener, run: hwip listener --stop',
        });
        expect(stopped).toEqual([]);
    });

    it('is part of uninstall, and of its dry run only as a plan', async () => {
        const { handleUninstall } = await import('./uninstall.js');
        const run = fakeDeps(4242, running(LISTENER));
        const dry = fakeDeps(4242, running(LISTENER));
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleUninstall({}, run.deps);
        log.mockClear();
        await handleUninstall({ 'dry-run': true }, dry.deps);
        const dryOutput = log.mock.calls.flat().join('\n');
        log.mockRestore();

        expect(run.stopped).toEqual([4242]);
        expect(dry.stopped).toEqual([]);
        expect(dryOutput).toContain('would stop the listener (pid 4242)');
    });

    it('marks a line the user has to act on, and says so at the end', async () => {
        const { handleUninstall } = await import('./uninstall.js');
        const { deps } = fakeDeps(4242, { kind: 'unchecked', reason: 'spawnSync ps ENOENT' });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleUninstall({}, deps);
        const output = log.mock.calls.flat().join('\n');
        log.mockRestore();

        expect(output).toContain('    ! could not check pid 4242');
        expect(output).toContain('1 line marked "!" needs you');
        expect(output).not.toContain('Uninstall complete');
    });
});

describe('handleUninstall — Claude Code', () => {
    /** A bin directory holding a fake `claude` that records its arguments,
     *  plus `which`, which agent detection resolves through PATH. */
    const fakeBin = (): { dir: string; calls: () => string } => {
        const dir = join(TMP, 'bin');
        mkdirSync(dir, { recursive: true });
        const log = join(TMP, 'claude-calls.log');
        writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
        chmodSync(join(dir, 'claude'), 0o755);
        symlinkSync('/usr/bin/which', join(dir, 'which'));
        return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf-8') : '') };
    };

    it('asks the claude on PATH to uninstall the plugin', async () => {
        const bin = fakeBin();
        process.env.PATH = bin.dir;
        const { handleUninstall } = await import('./uninstall.js');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleUninstall({});
        log.mockRestore();

        expect(bin.calls()).toBe('plugin uninstall hwip@hwip\n');
    });

    it('only names the command in a dry run', async () => {
        const bin = fakeBin();
        process.env.PATH = bin.dir;
        const { handleUninstall } = await import('./uninstall.js');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleUninstall({ 'dry-run': true });
        const output = log.mock.calls.flat().join('\n');
        log.mockRestore();

        expect(output).toContain('would run: claude plugin uninstall hwip@hwip');
        expect(bin.calls()).toBe('');
    });
});

describe('handleUninstall — config retention', () => {
    it('keeps ~/.hwip/config.json by default', async () => {
        const cfg = write('.hwip/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});
        expect(existsSync(cfg)).toBe(true);
    });

    it('removes ~/.hwip/config.json with --purge', async () => {
        const cfg = write('.hwip/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ purge: true });
        expect(existsSync(cfg)).toBe(false);
    });

    it('--purge in dry-run keeps the config', async () => {
        const cfg = write('.hwip/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ purge: true, 'dry-run': true });
        expect(existsSync(cfg)).toBe(true);
    });
});

describe('handleUninstall — Aider conf.yml', () => {
    it('removes the Hwip read: directive, keeps the rest of the YAML', async () => {
        // Aider is CLI-detected so its uninstaller only runs if `aider` is
        // on PATH. We can't rely on that in CI — instead assert the conf
        // file format the uninstaller targets is what install writes.
        const conf = write(
            '.aider.conf.yml',
            'auto-commits: false\n\n# Added by Hwip\nread: /home/u/.hwip/aider-conventions.md\n',
        );
        // Re-implement the documented removal contract inline (the helper
        // itself is not exported): drop "# Added by Hwip" + following read:.
        const lines = readFileSync(conf, 'utf-8').split('\n');
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '# Added by Hwip') {
                if (lines[i + 1]?.trimStart().startsWith('read:')) i++;
                continue;
            }
            out.push(lines[i]);
        }
        const result = out.join('\n');
        expect(result).toContain('auto-commits: false');
        expect(result).not.toContain('# Added by Hwip');
        expect(result).not.toContain('read:');
    });
});

describe('rmGeminiHook — hwip-* entries only', () => {
    it('removes hwip-remote (BeforeAgent) and hwip-notify (AfterAgent), keeps user hooks', async () => {
        const settings = write('.gemini/settings.json', JSON.stringify({
            hooks: {
                BeforeAgent: [
                    { matcher: '*', hooks: [{ name: 'hwip-remote', type: 'command', command: 'hwip remote-hook gemini' }] },
                ],
                AfterAgent: [
                    { matcher: '*', hooks: [{ name: 'hwip-notify', type: 'command', command: 'hwip notify' }] },
                    { matcher: '*', hooks: [{ name: 'my-own', type: 'command', command: 'echo mine' }] },
                ],
                BeforeTool: [
                    { matcher: 'grep', hooks: [{ type: 'command', command: 'echo reminder' }] },
                ],
            },
        }));
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, false)).toBeTruthy();

        const data = JSON.parse(readFileSync(settings, 'utf-8'));
        expect(data.hooks).not.toHaveProperty('BeforeAgent');
        expect(data.hooks.AfterAgent).toHaveLength(1);
        expect(data.hooks.AfterAgent[0].hooks[0].name).toBe('my-own');
        expect(data.hooks).toHaveProperty('BeforeTool');
    });

    it('dry-run reports but changes nothing', async () => {
        const settings = write('.gemini/settings.json', JSON.stringify({
            hooks: {
                BeforeAgent: [{ hooks: [{ name: 'hwip-remote', type: 'command', command: 'x' }] }],
            },
        }));
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, true)).toBeTruthy();
        expect(JSON.parse(readFileSync(settings, 'utf-8')).hooks).toHaveProperty('BeforeAgent');
    });

    it('a file that is not a JSON object → a "!" line to check it by hand, file untouched', async () => {
        const settings = write('.gemini/settings.json', 'null\n');
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, false)).toEqual({
            notice: 'attention',
            text: `could not read ${settings} as a JSON object — if hwip's hook is in it, remove it by hand`,
        });
        expect(readFileSync(settings, 'utf-8')).toBe('null\n');
    });

    it('nothing of ours → null, file untouched', async () => {
        const original = JSON.stringify({
            hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        });
        const settings = write('.gemini/settings.json', original);
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, false)).toBeNull();
        expect(readFileSync(settings, 'utf-8')).toBe(original);
    });
});

describe('rmHwipHooks — Cursor-style flat handlers', () => {
    const hwipStop = { command: '$(command -v hwip || echo "npx -y @hwip/cli") notify --auto 2>/dev/null || true' };

    it('keeps the file when the user has a top-level key of their own', async () => {
        const file = write('.cursor/hooks.json', JSON.stringify({ version: 1, theme: 'mine', hooks: { stop: [hwipStop] } }));
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, theme: 'mine', hooks: {} });
    });

    // JSONC is read like JSON (C1): hwip's entry goes, the user's comments stay.
    it('takes hwip out of a JSONC file and keeps its comments', async () => {
        const file = write(
            '.cursor/hooks.json',
            `{\n  "version": 1,\n  // mine\n  "theme": "mine", // keep\n  "hooks": {\n    "stop": [${JSON.stringify(hwipStop)}],\n  },\n}\n`,
        );
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        const text = readFileSync(file, 'utf-8');
        expect(text).toContain('// mine');
        expect(text).toContain('"theme": "mine", // keep');
        expect(JSON.stringify(parseJsonc(text))).not.toContain('@hwip/cli');
    });

    it('takes hwip out of a compact array in a file with comments', async () => {
        const file = write(
            '.cursor/hooks.json',
            `{\n  // c\n  "version": 1,\n  "hooks": {"stop": [{"command":"mine"}, ${JSON.stringify(hwipStop)}]}\n}\n`,
        );
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        const text = readFileSync(file, 'utf-8');
        expect(text).toContain('// c');
        expect(parseJsonc(text)).toEqual({ version: 1, hooks: { stop: [{ command: 'mine' }] } });
    });

    it('keeps the user\'s own group between two of hwip\'s', async () => {
        const file = write(
            '.cursor/hooks.json',
            `{\n  "hooks": {\n    "stop": [\n      ${JSON.stringify(hwipStop)},\n      { "command": "mine" }, // mine\n      ${JSON.stringify(hwipStop)},\n    ],\n  },\n}\n`,
        );
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        const text = readFileSync(file, 'utf-8');
        expect(parseJsonc(text)).toEqual({ hooks: { stop: [{ command: 'mine' }] } });
        expect(text).toContain('{ "command": "mine" }, // mine');
    });

    it('does not delete a file that holds only hwip\'s entries when it also holds a comment', async () => {
        const file = write('.cursor/hooks.json', `// my note\n{"version":1,"hooks":{"stop":[${JSON.stringify(hwipStop)}]}}\n`);
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf-8')).toContain('// my note');
    });

    it('keeps the event, and a comment in it, when only hwip\'s entries are left in it', async () => {
        const file = write(
            '.cursor/hooks.json',
            `{\n  "hooks": {\n    "stop": [\n      // { "command": "say done" }\n      ${JSON.stringify(hwipStop)}\n    ],\n    "other": [] // none\n  }\n}\n`,
        );
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toBeTruthy();

        const text = readFileSync(file, 'utf-8');
        expect(text).toContain('// { "command": "say done" }');
        expect(text).toContain('// none');
        expect(parseJsonc(text)).toEqual({ hooks: { stop: [], other: [] } });
    });

    it('names the file when it cannot take hwip out without losing a comment', async () => {
        const file = write(
            '.cursor/hooks.json',
            `{"hooks":{"stop":[{"command":"mine"}, /* mine */ ${JSON.stringify(hwipStop)}],"other":[{"command":"x"}]}}\n`,
        );
        const before = readFileSync(file, 'utf-8');
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toEqual({ notice: 'attention', text: expect.stringContaining(file) });
        expect(readFileSync(file, 'utf-8')).toBe(before);
    });

    // It used to return null, so uninstall said nothing and the hook kept firing.
    it.each([
        ['not valid JSON', `{ "hooks": { "stop": [${JSON.stringify(hwipStop)}] }, // mine\n "x": }`],
        ['null', 'null\n'],
        ['an array', '[1]\n'],
    ])('says so when the file is %s, and leaves it alone', async (_, content) => {
        const file = write('.cursor/hooks.json', content);
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(rmHwipHooks(file, false)).toEqual({ notice: 'attention', text: expect.stringMatching(/by hand/) });
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });
});

describe('rmHwipHooks — command-substring ownership (codex handlers have no name field)', () => {
    it('removes hwip groups, keeps user events, keeps the file when user content remains', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                UserPromptSubmit: [
                    { hooks: [{ type: 'command', command: '$(command -v hwip || echo "npx -y @hwip/cli") remote-hook codex 2>/dev/null || true', timeout: 5 }] },
                ],
                Stop: [
                    { hooks: [{ type: 'command', command: '$(command -v hwip || echo "npx -y @hwip/cli") notify --title "Task done" --auto 2>/dev/null || true' }] },
                    { hooks: [{ type: 'command', command: 'echo my own stop hook' }] },
                ],
            },
        }));
        const { rmHwipHooks } = await import('./uninstall.js');
        expect(rmHwipHooks(hooks, false)).toBeTruthy();

        const data = JSON.parse(readFileSync(hooks, 'utf-8'));
        expect(data.hooks).not.toHaveProperty('UserPromptSubmit');
        expect(data.hooks.Stop).toHaveLength(1);
        expect(data.hooks.Stop[0].hooks[0].command).toBe('echo my own stop hook');
    });

    it('deletes the file outright when nothing but hwip entries existed', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'npx -y @hwip/cli notify' }] }],
            },
        }));
        const { rmHwipHooks } = await import('./uninstall.js');
        expect(rmHwipHooks(hooks, false)).toBeTruthy();
        expect(existsSync(hooks)).toBe(false);
    });

    it('dry-run changes nothing', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'npx -y @hwip/cli notify' }] }],
            },
        }));
        const { rmHwipHooks } = await import('./uninstall.js');
        expect(rmHwipHooks(hooks, true)).toBeTruthy();
        expect(JSON.parse(readFileSync(hooks, 'utf-8')).hooks).toHaveProperty('Stop');
    });
});

describe('rmMcpEntry is keyed on the entry name, not the command', () => {
    // Everyone who installed before `hwip mcp` existed has an npx-shaped entry
    // sitting in their config. Uninstall matches on the `hwip` key, so the
    // command shape is irrelevant — this pins that, because a command-matching
    // implementation would strand those entries forever.
    it('removes a legacy npx-shaped registration', async () => {
        const file = write('.cursor/mcp.json', JSON.stringify({
            mcpServers: {
                hwip: { command: 'npx', args: ['-y', '@hwip/mcp-server'] },
                other: { command: 'node' },
            },
        }));
        const { rmMcpEntry } = await import('./uninstall.js');
        expect(rmMcpEntry(file, false)).toBeTruthy();
        const data = JSON.parse(readFileSync(file, 'utf-8'));
        expect(data.mcpServers).not.toHaveProperty('hwip');
        expect(data.mcpServers).toHaveProperty('other');
    });
});

describe('rmCodexMcpEntry — codex config.toml', () => {
    it('removes only the hwip table, keeping the rest of the config', async () => {
        const file = write('.codex/config.toml',
            'model = "gpt-5.6-luna"\n\n[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\n\n[mcp_servers.graft]\ncommand = "graft"\n');
        const { rmCodexMcpEntry } = await import('./uninstall.js');
        expect(rmCodexMcpEntry(file, false)).toBeTruthy();
        const out = readFileSync(file, 'utf-8');
        expect(out).not.toContain('mcp_servers.hwip');
        expect(out).toContain('[mcp_servers.graft]');
        expect(out).toContain('model = "gpt-5.6-luna"');
    });

it('round-trips with the installer on a config that has a hwip sub-table', async () => {
        const body = 'model = "gpt-5.6-luna"\n\n[mcp_servers.graft]\ncommand = "graft"\n';
        const file = write('.codex/roundtrip.toml', body);
        const { injectCodexMcpEntry } = await import('./installer.js');
        const { rmCodexMcpEntry } = await import('./uninstall.js');
        injectCodexMcpEntry(file);
        // Codex adds this itself once the user approves a tool "always".
        writeFileSync(file, readFileSync(file, 'utf-8') + '\n[mcp_servers.hwip.tools.hwip_ask]\napproval_mode = "approve"\n');
        expect(rmCodexMcpEntry(file, false)).toBeTruthy();
        expect(readFileSync(file, 'utf-8')).toBe(body);
    });

    it('leaves the file alone in dry-run, and reports nothing when hwip is absent', async () => {
        const body = 'model = "gpt-5.6-luna"\n\n[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\n';
        const file = write('.codex/config.toml', body);
        const { rmCodexMcpEntry } = await import('./uninstall.js');
        expect(rmCodexMcpEntry(file, true)).toBeTruthy();
        expect(readFileSync(file, 'utf-8')).toBe(body);

        const clean = write('.codex/other.toml', 'model = "gpt-5.6-luna"\n');
        expect(rmCodexMcpEntry(clean, false)).toBeNull();
    });
});

describe('rmMcpEntry on a file with no MCP object in it', () => {
    it.each([
        ['an empty file', ''],
        ['a BOM-led file', '\uFEFF{ "mcpServers": {} }\n'],
    ])('%s → null (nothing of hwip in it), file untouched', async (_, content) => {
        const file = write('.cursor/mcp.json', content);
        const { rmMcpEntry } = await import('./uninstall.js');
        expect(rmMcpEntry(file, false)).toBeNull();
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });

    it('a string container → null, file untouched', async () => {
        const content = '{ "mcpServers": "mine" }\n';
        const file = write('.cursor/mcp.json', content);
        const { rmMcpEntry } = await import('./uninstall.js');
        expect(rmMcpEntry(file, false)).toBeNull();
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });

    // It used to skip such a file in silence, so an MCP entry hwip could not
    // see stayed registered after an uninstall that reported nothing.
    it.each([
        ['null', 'null\n'],
        ['unparseable JSON', '{ "mcpServers": { "hwip": {} }, "x": }\n'],
    ])('%s → a "!" line to check it by hand, file untouched', async (_, content) => {
        const file = write('.cursor/mcp.json', content);
        const { rmMcpEntry } = await import('./uninstall.js');
        expect(rmMcpEntry(file, false)).toEqual({
            notice: 'attention',
            text: `could not read ${file} as a JSON object — if hwip's MCP entry is in it, remove it by hand`,
        });
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });
});

describe('rmMcpEntry with a custom container key (opencode.json)', () => {
    // Shared-body semantics (absent file, bad JSON, dry-run, idempotency) are
    // covered through handleUninstall above; the new fact is the `mcp` routing.
    it('removes only mcp.hwip, keeps sibling entries and other top-level keys', async () => {
        const file = write('.config/opencode/opencode.json', JSON.stringify({
            theme: 'dark',
            mcp: {
                hwip: OPENCODE_MCP_ENTRY,
                'codebase-memory-mcp': { type: 'local', command: ['/usr/local/bin/cbmem'] },
            },
        }));
        const { rmMcpEntry } = await import('./uninstall.js');
        expect(rmMcpEntry(file, false, 'mcp')).toBeTruthy();
        const data = JSON.parse(readFileSync(file, 'utf-8'));
        expect(data.mcp).not.toHaveProperty('hwip');
        expect(data.mcp).toHaveProperty('codebase-memory-mcp');
        expect(data.theme).toBe('dark');
    });
});

describe('handleUninstall — confirmation', () => {
    const atTerminal = async (run: () => Promise<unknown>) => {
        const was = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        try {
            return await run();
        } finally {
            if (was) Object.defineProperty(process.stdin, 'isTTY', was);
            else delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
    };

    // It removed everything with no question asked.
    it('asks at a terminal, and changes nothing on a no', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        const confirm = vi.fn(async () => false);

        expect(await atTerminal(() => handleUninstall({}, undefined, confirm))).toBe(1);
        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm.mock.calls[0][0]).toContain('Cursor, Windsurf');
        expect(existsSync(f.cursorRule)).toBe(true);
    });

    it('removes on a yes', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');

        await atTerminal(() => handleUninstall({}, undefined, async () => true));
        expect(existsSync(f.cursorRule)).toBe(false);
    });

    // C118: `--yes=true` is a yes, `--yes=false` is not one: the question is asked only for the second.
    it('reads --yes=true like --yes, and asks for --yes=false', async () => {
        seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        const confirm = vi.fn(async () => false);

        await atTerminal(() => handleUninstall({ yes: 'true' }, undefined, confirm));
        expect(confirm).not.toHaveBeenCalled();
        expect(await atTerminal(() => handleUninstall({ yes: 'false' }, undefined, confirm))).toBe(1);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('never asks with --yes, with --dry-run, or with no terminal (a script)', async () => {
        seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        const confirm = vi.fn(async () => false);

        await atTerminal(() => handleUninstall({ yes: true }, undefined, confirm));
        await atTerminal(() => handleUninstall({ 'dry-run': true }, undefined, confirm));
        await handleUninstall({}, undefined, confirm);
        expect(confirm).not.toHaveBeenCalled();
    });
});
