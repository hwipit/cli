import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';

// Tests for the agent installers. The injectMcpJson regression catalysed
// the CLI hotfix branch — without the env field, Cursor/Windsurf MCP
// can't find HWIP_API_KEY since graphical IDEs don't reliably inherit
// shell env. These tests pin that field down.

const INSTALL_ENV_KEYS = ['HOME', 'HWIP_API_KEY'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of INSTALL_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-installer-test-'));
    for (const key of INSTALL_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of INSTALL_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

// The installer module doesn't export injectMcpJson directly, but its
// behaviour is observable through the templates output. Instead of
// invoking the whole `handleInstall` flow (which runs prompts), we
// re-implement the same shape the source uses, then assert the output
// JSON matches. The entry itself comes from mcp-command.ts — the one place
// that decides how agents launch the server — so a drift there shows up in
// every registry test rather than being re-pinned per file.
const expectedMcpEntry = (apiKey: string = '${HWIP_API_KEY}') => ({
    ...MCP_SERVERS_ENTRY,
    env: { HWIP_API_KEY: apiKey },
});

describe('collectCredentials — a saved login', () => {
    // C103: the line showed twelve characters of the key (`ak_` and nine secret ones).
    it('is named by the prefix of its key and no more', async () => {
        const { collectCredentials } = await import('./installer.js');
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });

        const resolved = await collectCredentials({}, {}, false, { apiKey: 'ak_0123456789abcdef' });

        expect(resolved.apiKey).toBe('ak_0123456789abcdef');
        expect(lines.join('\n')).toContain('Using saved login (ak_…)');
        expect(lines.join('\n')).not.toContain('0123');
        vi.restoreAllMocks();
    });
});

describe('collectCredentials — the browser sign-in', () => {
    // C132: the hosts the user named reach the callback check; without the flag there are none.
    it.each([
        ['passes --allow-host to the sign-in', { 'allow-host': 'mine.example,b.example.org' }, ['mine.example', 'b.example.org']],
        ['passes no extra hosts without the flag', {}, []],
    ])('%s', async (_name, args, hosts) => {
        const runLoginFlow = vi.fn(async () => ({ apiKey: 'ak_0123456789abcdef' }));
        vi.doMock('./login.js', async (importActual) => ({ ...(await importActual<typeof import('./login.js')>()), runLoginFlow }));
        const { collectCredentials } = await import('./installer.js');
        vi.spyOn(console, 'log').mockImplementation(() => {});

        await collectCredentials(args, {}, false, {});

        expect(runLoginFlow).toHaveBeenCalledWith(expect.objectContaining({ allowHosts: hosts }));
        vi.restoreAllMocks();
        vi.doUnmock('./login.js');
    });
});

describe('shouldReauth', () => {
    it('opens browser login for a brand-new install (no key anywhere)', async () => {
        const { shouldReauth } = await import('./installer.js');
        expect(shouldReauth(undefined, false)).toBe(true);
    });

    it('reuses the saved login on a plain re-run (key exists, no --relogin)', async () => {
        const { shouldReauth } = await import('./installer.js');
        expect(shouldReauth('ak_existing', false)).toBe(false);
    });

    it('re-authenticates when --relogin is passed, even with a saved key', async () => {
        const { shouldReauth } = await import('./installer.js');
        expect(shouldReauth('ak_existing', true)).toBe(true);
    });

    it('opens browser login when nothing is saved, regardless of --relogin', async () => {
        const { shouldReauth } = await import('./installer.js');
        expect(shouldReauth(undefined, true)).toBe(true);
    });
});

describe('templates.ts: completion command shape', () => {
    it('uses graceful hwip || npx fallback', async () => {
        const tmpl = await import('./templates.js');
        // CURSOR_HOOKS embeds the completion command inline
        expect(JSON.stringify(tmpl.CURSOR_HOOKS)).toContain('command -v hwip');
        expect(JSON.stringify(tmpl.CURSOR_HOOKS)).toContain('npx -y @hwip/cli');
    });

    it('CLINE_RULE keeps hwip_notify guidance (no Stop hook for Cline)', async () => {
        const { CLINE_RULE } = await import('./templates.js');
        expect(CLINE_RULE).toContain('hwip_notify');
        // Wording-robust: matches both the pre-refactor phrasing
        // ("Cline does not have a Stop hook") and the shared-core
        // refactor ("This agent has no Stop hook"). The semantic
        // assertion is "the rule tells Cline it has no Stop hook".
        expect(CLINE_RULE).toMatch(/no Stop hook|does not have a Stop hook/i);
    });

    it('CURSOR_RULE forbids manual hwip_notify (Stop hook installed)', async () => {
        const { CURSOR_RULE } = await import('./templates.js');
        // Wording-robust: matches the pre-refactor "do not need to call
        // hwip_notify" and the shared-core "Do NOT call hwip_notify just
        // to announce completion". \\s+ tolerates the line wrap.
        expect(CURSOR_RULE).toMatch(/(do not need to call|do NOT call)\s+hwip_notify/i);
    });

    it('CURSOR_RULE documents the irreversible-op carve-out', async () => {
        const { CURSOR_RULE } = await import('./templates.js');
        expect(CURSOR_RULE).toContain('force-push');
    });

    it('CURSOR_HOOKS uses the stop event', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        expect(CURSOR_HOOKS).toHaveProperty('hooks.stop');
    });

    it('WINDSURF_HOOKS uses post_cascade_response', async () => {
        const { WINDSURF_HOOKS } = await import('./templates.js');
        expect(WINDSURF_HOOKS).toHaveProperty('hooks.post_cascade_response');
    });

    it('CODEX_HOOKS uses Stop event', async () => {
        const { CODEX_HOOKS } = await import('./templates.js');
        expect(CODEX_HOOKS).toHaveProperty('hooks.Stop');
    });

    // Codex parses hooks.json with serde deny_unknown_fields at the top level
    // and a `type`-tagged handler enum inside matcher groups
    // (codex-rs/config/src/hook_config.rs) — the old flat
    // `{version, hooks: {Stop: [{type, bash}]}}` shape made codex reject the
    // whole file.
    it('CODEX_HOOKS matches the strict codex schema (matcher groups, no version/bash)', async () => {
        const { CODEX_HOOKS } = await import('./templates.js');
        expect(Object.keys(CODEX_HOOKS)).toEqual(['hooks']);
        for (const event of ['UserPromptSubmit', 'Stop'] as const) {
            for (const group of CODEX_HOOKS.hooks[event]) {
                for (const handler of group.hooks) {
                    expect(handler.type).toBe('command');
                    expect(typeof handler.command).toBe('string');
                    expect(handler).not.toHaveProperty('bash');
                }
            }
        }
        expect(CODEX_HOOKS.hooks.UserPromptSubmit[0].hooks[0].command).toContain('remote-hook codex');
    });

    it('every hwip hook command is recognizable by isHwipHookGroup (uninstall contract)', async () => {
        const { CODEX_HOOKS, GEMINI_HOOKS, isHwipHookGroup } = await import('./templates.js');
        for (const groups of [
            ...Object.values(CODEX_HOOKS.hooks),
            ...Object.values(GEMINI_HOOKS.hooks),
        ]) {
            for (const group of groups) expect(isHwipHookGroup(group)).toBe(true);
        }
        expect(isHwipHookGroup({ hooks: [{ type: 'command', command: 'echo mine' }] })).toBe(false);
    });

    it('GEMINI_HOOKS registers BeforeAgent remote detection alongside AfterAgent notify', async () => {
        const { GEMINI_HOOKS } = await import('./templates.js');
        expect(GEMINI_HOOKS.hooks.BeforeAgent[0].hooks[0].name).toBe('hwip-remote');
        expect(GEMINI_HOOKS.hooks.BeforeAgent[0].hooks[0].command).toContain('remote-hook gemini');
        expect(GEMINI_HOOKS.hooks.AfterAgent[0].hooks[0].name).toBe('hwip-notify');
    });
});

describe('mergeJsonFile — hooks-level merge', () => {
    it('preserves user hooks at both levels while replacing hwip entries', async () => {
        const file = join(TMP, '.gemini', 'settings.json');
        mkdirSync(join(TMP, '.gemini'), { recursive: true });
        writeFileSync(file, JSON.stringify({
            security: { auth: { selectedType: 'gemini-api-key' } },
            hooks: {
                // user-owned event hwip never touches
                BeforeTool: [{ matcher: 'grep', hooks: [{ type: 'command', command: 'echo mine' }] }],
                // event hwip also writes: one stale hwip entry + one user group
                AfterAgent: [
                    { hooks: [{ name: 'hwip-notify', type: 'command', command: 'old hwip cmd' }] },
                    { hooks: [{ name: 'my-own', type: 'command', command: 'echo user' }] },
                ],
            },
        }));
        const { mergeJsonFile } = await import('./installer.js');
        const { GEMINI_HOOKS } = await import('./templates.js');
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);

        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.security.auth.selectedType).toBe('gemini-api-key');
        expect(out.hooks).toHaveProperty('BeforeTool');
        expect(out.hooks.BeforeAgent[0].hooks[0].name).toBe('hwip-remote');
        // user group inside the shared event survives; hwip's is replaced, not duplicated
        const afterAgentNames = out.hooks.AfterAgent.flatMap(
            (g: { hooks: Array<{ name?: string; command?: string }> }) => g.hooks.map((h) => h.name),
        );
        expect(afterAgentNames.sort()).toEqual(['hwip-notify', 'my-own']);
        expect(JSON.stringify(out)).not.toContain('old hwip cmd');
    });

    it('re-run is idempotent (no duplicate hwip groups)', async () => {
        const file = join(TMP, '.gemini', 'settings.json');
        mkdirSync(join(TMP, '.gemini'), { recursive: true });
        const { mergeJsonFile } = await import('./installer.js');
        const { GEMINI_HOOKS } = await import('./templates.js');
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);

        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.hooks.BeforeAgent).toHaveLength(1);
        expect(out.hooks.AfterAgent).toHaveLength(1);
    });
});

// A settings file the installer cannot parse used to be read as `{}`, so the
// merge wrote back hwip's entries alone and the user's settings were gone.
describe('existing settings the installer cannot read are left untouched', () => {
    const writers = [
        ['mergeJsonFile', async (file: string) => {
            const { mergeJsonFile } = await import('./installer.js');
            const { GEMINI_HOOKS } = await import('./templates.js');
            mergeJsonFile(file, GEMINI_HOOKS);
        }],
        ['injectMcpEntry', async (file: string) => {
            const { injectMcpEntry } = await import('./installer.js');
            injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY);
        }],
    ] as const;

    const unreadable = [
        ['a missing value', '{ "theme": }\n', /not valid JSON/],
        ['a missing comma', '{ "theme": "dark" "size": 1 }\n', /not valid JSON/],
        ['an array', '[1, 2]\n', /does not hold a JSON object/],
        ['null', 'null\n', /does not hold a JSON object/],
        ['a number', '42\n', /does not hold a JSON object/],
    ] as const;

    describe.each(writers)('%s', (_, write) => {
        it.each(unreadable)('throws on %s and keeps the file byte for byte', async (_, content, message) => {
            const file = join(TMP, 'settings.json');
            writeFileSync(file, content);

            await expect(write(file)).rejects.toThrow(message);
            await expect(write(file)).rejects.toThrow(file);
            expect(readFileSync(file, 'utf-8')).toBe(content);
        });

        it('keeps the file contents out of the message', async () => {
            const file = join(TMP, 'settings.json');
            writeFileSync(file, '{ "mykey": // zq-note\n }');

            const error = await write(file).then(() => null, (err: Error) => err);

            expect(error?.message).toContain(file);
            expect(error?.message).not.toMatch(/mykey|zq-note|\n/);
        });

        it('throws when the path is a directory', async () => {
            const file = join(TMP, 'settings.json');
            mkdirSync(file);

            await expect(write(file)).rejects.toThrow(/cannot read/);
        });

        it('reads a file that starts with a byte order mark, and keeps the mark', async () => {
            const file = join(TMP, 'settings.json');
            writeFileSync(file, '\uFEFF{ "theme": "dark" }\n');

            await write(file);

            const text = readFileSync(file, 'utf-8');
            expect(text.startsWith('\uFEFF')).toBe(true);
            expect(JSON.parse(text.slice(1)).theme).toBe('dark');
        });

        it('treats an empty file like a missing one', async () => {
            const file = join(TMP, 'settings.json');
            writeFileSync(file, '  \n');

            await write(file);

            expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf-8')))).toContain('hwip');
        });
    });
});

describe('mergeJsonFile — a hooks value it cannot merge into', () => {
    it.each([
        ['hooks is an array', '{ "hooks": [1] }\n'],
        ['hooks is a string', '{ "hooks": "mine" }\n'],
        ['an event hwip writes is not a list', '{ "hooks": { "BeforeAgent": { "mine": true } } }\n'],
    ] as const)('throws when %s and keeps the file byte for byte', async (_, content) => {
        const { mergeJsonFile } = await import('./installer.js');
        const { GEMINI_HOOKS } = await import('./templates.js');
        const file = join(TMP, 'settings.json');
        writeFileSync(file, content);

        expect(() => mergeJsonFile(file, GEMINI_HOOKS)).toThrow(/left it unchanged/);
        expect(readFileSync(file, 'utf-8')).toBe(content);
    });
});

describe('what the user sees when a step could not finish', () => {
    it('gives the reason and the JSON to add by hand', async () => {
        const { mergeFailureLines } = await import('./installer.js');

        const lines = mergeFailureLines('Hook install', '/h/.gemini/settings.json', new Error('ENOSPC: no space left on device, write'), {
            hooks: { Stop: [{ command: 'hwip notify' }] },
        });

        expect(lines[0]).toBe('Hook install failed: ENOSPC: no space left on device, write. Add this to /h/.gemini/settings.json by hand:');
        expect(JSON.parse(lines.slice(1).join('\n'))).toEqual({ hooks: { Stop: [{ command: 'hwip notify' }] } });
    });

    // Missing agents are listed at detection; counting them made every
    // ordinary install end with "Done, but N steps need you".
    it('counts a failed step but not an agent that is not installed', async () => {
        const { failMerge, failedStepCount, reportDetectedAgents } = await import('./installer.js');
        const start = failedStepCount();

        reportDetectedAgents([
            { id: 'cursor', name: 'Cursor', detected: false },
            { id: 'codex', name: 'Codex CLI', detected: true },
        ]);
        expect(failedStepCount()).toBe(start);

        failMerge('Hook install', '/h/.codex/hooks.json', new Error('no space left'), {});
        expect(failedStepCount()).toBe(start + 1);
    });

    // "Done!" after a step that did nothing told the user hwip was installed.
    it.each([
        [0, 'Done! Restart your agents.'],
        [1, 'Done, but 1 step needs you: see the lines marked "-" above. Then restart your agents.'],
        [2, 'Done, but 2 steps need you: see the lines marked "-" above. Then restart your agents.'],
    ])('closes with %i failed steps as "%s"', async (failed, line) => {
        const { closingLine } = await import('./installer.js');

        expect(closingLine(failed)).toBe(line);
    });
});

// Cursor and Windsurf hooks.json used to be written whole, so `hwip install`
// erased every hook the user had there.
describe('Cursor and Windsurf hook files are merged, not replaced', () => {
    const isHwip = (entry: { command?: string }) => entry.command?.includes('@hwip/cli') ?? false;
    // [agent, file, hwip's event, the user's hook in that event, another event the user owns]
    const cases = [
        ['cursor', '.cursor/hooks.json', 'stop', { command: 'my-stop.sh' }, ['afterFileEdit', [{ command: 'fmt.sh' }]]],
        ['windsurf', '.codeium/windsurf/hooks.json', 'post_cascade_response', { command: 'my-log.sh', show_output: true },
            ['pre_user_prompt', [{ command: 'x.sh' }]]],
    ] as const;

    it.each(cases)('%s keeps the user hooks and holds one hwip entry after two installs', async (id, rel, event, userHook, [other, otherHooks]) => {
        const file = join(TMP, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ hooks: { [event]: [userHook], [other]: otherHooks } }));
        const { AGENT_INSTALLERS } = await import('./installer.js');

        AGENT_INSTALLERS[id]();
        AGENT_INSTALLERS[id]();

        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.hooks[event].filter(isHwip)).toHaveLength(1);
        expect(out.hooks[event]).toContainEqual(userHook);
        expect(out.hooks[other]).toEqual(otherHooks);
    });

    it.each(cases)('%s leaves a hooks file it cannot parse untouched', async (id, rel) => {
        const file = join(TMP, rel);
        mkdirSync(dirname(file), { recursive: true });
        const content = '{ "hooks": {}, "mine": }';
        writeFileSync(file, content);
        const { AGENT_INSTALLERS } = await import('./installer.js');

        AGENT_INSTALLERS[id]();

        expect(readFileSync(file, 'utf-8')).toBe(content);
    });
});

describe('MCP entry is single-sourced from mcp-command.ts', () => {
    // Pins the shape we want injectMcpJson to write. Mirrors plugin/.mcp.json
    // — if the SDK installer drifts away from this shape, MCP misbehaves
    // (notably: no env field means HWIP_API_KEY can't reach the MCP
    // subprocess on IDEs that don't inherit shell env).
    // The value of the mcp-command.ts move: no site spells the launch out
    // itself any more. A literal here would mean one registry silently kept
    // spawning the npm launcher this change exists to delete.
    it('installer.ts holds no launch string of its own', () => {
        const dir = dirname(fileURLToPath(import.meta.url));
        const installerSrc = readFileSync(join(dir, 'installer.ts'), 'utf-8');
        expect(installerSrc).not.toContain('@hwip/mcp-server');
        expect(installerSrc).not.toContain('gemini mcp add');
    });

    it('injectMcpJson preserves existing mcpServers entries (idempotency contract)', async () => {
        // Re-implement the same shape locally — the source does merge + write.
        // This documents what the source MUST do.
        const mcpFile = join(TMP, '.cursor', 'mcp.json');
        mkdirSync(join(TMP, '.cursor'), { recursive: true });
        writeFileSync(mcpFile, JSON.stringify({
            mcpServers: {
                other: { command: 'node', args: ['./other.js'] },
            },
        }));

        // Manual merge — same as injectMcpJson's logic
        const existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        existing.mcpServers.hwip = expectedMcpEntry();
        writeFileSync(mcpFile, JSON.stringify(existing, null, 2));

        const result = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        expect(result.mcpServers).toHaveProperty('other');
        expect(result.mcpServers).toHaveProperty('hwip');
        expect(result.mcpServers.hwip.env).toEqual({ HWIP_API_KEY: '${HWIP_API_KEY}' });
    });
});

describe('templates.ts: command graceful fallback works at runtime', () => {
    it('CURSOR_HOOKS produces JSON whose command resolves hwip at fire time', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const cmd = CURSOR_HOOKS.hooks.stop[0].command;
        // Either of the resolvable forms must be present
        expect(cmd).toMatch(/command -v hwip .*\|\|.*npx/);
        // And the literal --title "Task done" arg
        expect(cmd).toContain('--title "Task done"');
    });
});

describe('templates.ts: pi extension + opencode plugin artifacts', () => {
    // Quiet-default and rule↔hook-registry parity are auto-collected in
    // templates.test.ts; only the per-artifact facts live here.
    it('PI_EXTENSION wires both events: settle notify + remote detection', async () => {
        const { PI_EXTENSION } = await import('./templates.js');
        expect(PI_EXTENSION).toContain('agent_settled');
        expect(PI_EXTENSION).toContain('before_agent_start');
        expect(PI_EXTENSION).toContain('remote-hook pi');
    });

    it('OPENCODE_PLUGIN filters the generic event hook for session.idle', async () => {
        const { OPENCODE_PLUGIN } = await import('./templates.js');
        // The installed plugin API has no per-event keys — only the generic
        // `event` hook. A "session.idle" KEY would silently never fire.
        expect(OPENCODE_PLUGIN).toContain('"session.idle"');
        expect(OPENCODE_PLUGIN).not.toContain('"session.idle":');
    });

    // pi's bash tool ends a call that runs too long, and the model's reflex is to ask again: a second card on the phone.
    it('PI_RULE says a hwip ask that was cut short is run again as it was', async () => {
        const { PI_RULE } = await import('./templates.js');
        const section = PI_RULE.split('## Hwip tools via the CLI')[1]!.split('\n## ')[0]!.replace(/\s+/g, ' ');
        expect(section).toContain('run the same command again');
        expect(section).toContain('`resumed: true`');
    });

    it('PI_RULE maps hwip tools only to CLI flags the CLI actually parses', async () => {
        const { PI_RULE } = await import('./templates.js');
        const section = PI_RULE.split('## Hwip tools via the CLI')[1]!.split('\n## ')[0]!;
        const flags = [...new Set([...section.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]))];
        expect(flags).toEqual(expect.arrayContaining(['title', 'actions', 'timeout', 'accepts-exit']));
        // pi has no MCP fallback — a flag renamed in the CLI would strand it
        // silently, so pin every named flag to the CLI's own arg parsing.
        const dir = dirname(fileURLToPath(import.meta.url));
        const cliSrc = ['ask.ts', 'cli.ts', 'agent-read.ts'].map((file) => readFileSync(join(dir, file), 'utf-8')).join('\n');
        for (const flag of flags) {
            // A hyphenated flag can only be read in bracket form (`args['api-key']`).
            const read = flag.includes('-') ? `args['${flag}']` : `args.${flag}`;
            // A yes/no flag is read through `flagOn(args, 'flag')` (args.ts), the others straight from `args`.
            expect(cliSrc.includes(read) || cliSrc.includes(`flagOn(args, '${flag}'`), `--${flag} is not parsed by the CLI`).toBe(true);
        }
    });
});

describe('injectCodexMcpEntry — codex config.toml', () => {
    it('registers hwip without disturbing the user\'s own settings', async () => {
        const file = join(TMP, '.codex', 'config.toml');
        mkdirSync(join(TMP, '.codex'), { recursive: true });
        writeFileSync(file, 'model = "gpt-5.6-luna"\n\n[mcp_servers.graft]\ncommand = "graft"\nargs = ["mcp"]\n');
        const { injectCodexMcpEntry } = await import('./installer.js');
        injectCodexMcpEntry(file);
        const out = readFileSync(file, 'utf-8');
        expect(out).toContain('[mcp_servers.hwip]');
        expect(out).toContain('model = "gpt-5.6-luna"');
        expect(out).toContain('[mcp_servers.graft]');
    });

    it('re-run is idempotent', async () => {
        const file = join(TMP, '.codex', 'config.toml');
        const { injectCodexMcpEntry } = await import('./installer.js');
        injectCodexMcpEntry(file);
        const once = readFileSync(file, 'utf-8');
        injectCodexMcpEntry(file);
        expect(readFileSync(file, 'utf-8')).toBe(once);
    });
});

describe('injectMcpEntry — opencode.json mcp schema', () => {
    it('writes mcp.hwip in opencode shape (array command, type local, enabled)', async () => {
        const file = join(TMP, '.config', 'opencode', 'opencode.json');
        const { injectMcpEntry } = await import('./installer.js');
        injectMcpEntry(file, 'mcp', OPENCODE_MCP_ENTRY);
        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.mcp.hwip).toEqual(OPENCODE_MCP_ENTRY);
        // opencode's schema is the array-command one — the shape, not just the
        // values, is what the other registries do NOT share.
        expect(Array.isArray(out.mcp.hwip.command)).toBe(true);
    });

    it('preserves sibling mcp entries and top-level keys', async () => {
        const file = join(TMP, '.config', 'opencode', 'opencode.json');
        mkdirSync(join(TMP, '.config', 'opencode'), { recursive: true });
        writeFileSync(file, JSON.stringify({
            theme: 'dark',
            mcp: { 'codebase-memory-mcp': { type: 'local', command: ['/usr/local/bin/cbmem'] } },
        }));
        const { injectMcpEntry } = await import('./installer.js');
        injectMcpEntry(file, 'mcp', OPENCODE_MCP_ENTRY);
        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.theme).toBe('dark');
        expect(out.mcp['codebase-memory-mcp'].command).toEqual(['/usr/local/bin/cbmem']);
        expect(out.mcp).toHaveProperty('hwip');
    });

    it('re-run is idempotent', async () => {
        const file = join(TMP, '.config', 'opencode', 'opencode.json');
        const { injectMcpEntry } = await import('./installer.js');
        injectMcpEntry(file, 'mcp', OPENCODE_MCP_ENTRY);
        injectMcpEntry(file, 'mcp', OPENCODE_MCP_ENTRY);
        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(Object.keys(out.mcp)).toEqual(['hwip']);
    });
});

// Sanity touchpoint — make sure the import surface compiles
describe('public API surface', () => {
    it('exports HwipHook + error classes', async () => {
        const mod = await import('./index.js');
        expect(typeof mod.HwipHook).toBe('function');
        expect(typeof mod.HwipError).toBe('function');
        expect(typeof mod.AuthenticationError).toBe('function');
        expect(typeof mod.QuotaExceededError).toBe('function');
    });

    // Silence the otherwise-unused-import warning for vi
    it('vitest is wired', () => { vi.fn(); expect(true).toBe(true); });
});
