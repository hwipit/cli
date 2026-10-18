import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc-doc.js';
import { MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';

// C1: settings with comments or trailing commas (JSONC) used to be left alone —
// the user was shown JSON to paste by hand. They are merged now, and what the
// user wrote around hwip's entries stays. The fixtures are settings of the
// shape each agent's config has (the entries are the ones hwip's own templates
// write, the user's are ordinary hooks, servers and options), with comments and
// trailing commas the way people write them. Everything runs under a temporary
// HOME; no real settings file is read or written.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', 'jsonc', name), 'utf-8');

const originalHome = process.env.HOME;
let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'installer-jsonc-'));
  process.env.HOME = TMP;
  vi.resetModules();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

const place = (rel: string, name: string): string => {
  const file = join(TMP, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fixture(name));
  return file;
};

/** Every line that holds a comment: the code before it (without a trailing comma) and the comment. */
const commentLines = (text: string): { code: string; comment: string }[] =>
  text.split('\n').flatMap((line) => {
    const m = /^(.*?)(?:^|\s)(\/\/ .*|\/\* .*? \*\/)\s*$/.exec(line);
    return m ? [{ code: m[1]!.replace(/,\s*$/, '').trim(), comment: m[2]! }] : [];
  });

interface Case {
  label: string;
  rel: string;
  name: string;
  /** Run the installer step for this file. */
  apply: (file: string) => Promise<void>;
  /** What the user's part of the file must still hold, and hwip's must now. */
  expected: (data: Record<string, unknown>) => void;
  /** The uninstall step for this file. */
  undo: (file: string) => Promise<unknown>;
  /** Top-level keys the install adds and the uninstall (as before) does not take out. */
  leftBehind?: string[];
}

const isHwipCommand = (entry: unknown): boolean => JSON.stringify(entry).includes('@hwip/cli');

const cases: Case[] = [
  {
    label: 'Gemini settings.json hooks',
    rel: '.gemini/settings.json',
    name: 'gemini-settings.jsonc',
    apply: async (file) => {
      const { mergeJsonFile } = await import('./installer.js');
      const { GEMINI_HOOKS } = await import('./templates.js');
      mergeJsonFile(file, GEMINI_HOOKS);
    },
    expected: (data) => {
      const hooks = data.hooks as Record<string, unknown[]>;
      expect(data.general).toEqual({ preferredEditor: 'vscode' });
      expect(data.mcpServers).toHaveProperty('docs');
      expect(hooks.BeforeTool).toHaveLength(1);
      expect(hooks.BeforeAgent.filter(isHwipCommand)).toHaveLength(1);
      expect(hooks.AfterAgent).toHaveLength(2);
      expect(JSON.stringify(hooks.AfterAgent)).toContain('my-own');
    },
    undo: async (file) => (await import('./uninstall.js')).rmGeminiHook(file, false),
    leftBehind: ['hooksConfig'],
  },
  {
    label: 'Codex hooks.json',
    rel: '.codex/hooks.json',
    name: 'codex-hooks.jsonc',
    apply: async (file) => {
      const { mergeJsonFile } = await import('./installer.js');
      const { CODEX_HOOKS } = await import('./templates.js');
      mergeJsonFile(file, CODEX_HOOKS);
    },
    expected: (data) => {
      const hooks = data.hooks as Record<string, unknown[]>;
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.Stop).toHaveLength(2);
      expect(hooks.Stop.filter(isHwipCommand)).toHaveLength(1);
      expect(hooks.UserPromptSubmit.filter(isHwipCommand)).toHaveLength(1);
    },
    undo: async (file) => (await import('./uninstall.js')).rmHwipHooks(file, false),
  },
  {
    label: 'Cursor mcp.json',
    rel: '.cursor/mcp.json',
    name: 'cursor-mcp.jsonc',
    apply: async (file) => {
      const { injectMcpEntry } = await import('./installer.js');
      injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY);
    },
    expected: (data) => {
      expect(Object.keys(data.mcpServers as object).sort()).toEqual(['figma', 'hwip']);
    },
    undo: async (file) => (await import('./uninstall.js')).rmMcpEntry(file, false),
  },
  {
    label: 'Cursor hooks.json',
    rel: '.cursor/hooks.json',
    name: 'cursor-hooks.jsonc',
    apply: async (file) => {
      const { mergeJsonFile } = await import('./installer.js');
      const { CURSOR_HOOKS } = await import('./templates.js');
      mergeJsonFile(file, CURSOR_HOOKS);
    },
    expected: (data) => {
      const hooks = data.hooks as Record<string, unknown[]>;
      expect(data.version).toBe(1);
      expect(hooks.afterFileEdit).toEqual([{ command: './fmt.sh' }]);
      expect(hooks.stop).toHaveLength(2);
      expect(hooks.stop[0]).toEqual({ command: './my-stop.sh' });
      expect(hooks.stop.filter(isHwipCommand)).toHaveLength(1);
    },
    undo: async (file) => (await import('./uninstall.js')).rmHwipHooks(file, false),
  },
  {
    label: 'Windsurf mcp_config.json',
    rel: '.codeium/windsurf/mcp_config.json',
    name: 'windsurf-mcp.jsonc',
    apply: async (file) => {
      const { injectMcpEntry } = await import('./installer.js');
      injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY);
    },
    expected: (data) => {
      expect(Object.keys(data.mcpServers as object).sort()).toEqual(['github', 'hwip']);
    },
    undo: async (file) => (await import('./uninstall.js')).rmMcpEntry(file, false),
  },
  {
    label: 'Windsurf hooks.json',
    rel: '.codeium/windsurf/hooks.json',
    name: 'windsurf-hooks.jsonc',
    apply: async (file) => {
      const { mergeJsonFile } = await import('./installer.js');
      const { WINDSURF_HOOKS } = await import('./templates.js');
      mergeJsonFile(file, WINDSURF_HOOKS);
    },
    expected: (data) => {
      const hooks = data.hooks as Record<string, unknown[]>;
      expect(hooks.pre_user_prompt).toEqual([{ command: './log.sh' }]);
      expect(hooks.post_cascade_response).toHaveLength(2);
      expect(hooks.post_cascade_response[0]).toEqual({ command: './my-log.sh', show_output: true });
      expect(hooks.post_cascade_response.filter(isHwipCommand)).toHaveLength(1);
    },
    undo: async (file) => (await import('./uninstall.js')).rmHwipHooks(file, false),
  },
  {
    label: 'opencode.json',
    rel: '.config/opencode/opencode.json',
    name: 'opencode.jsonc',
    apply: async (file) => {
      const { injectMcpEntry } = await import('./installer.js');
      injectMcpEntry(file, 'mcp', OPENCODE_MCP_ENTRY);
    },
    expected: (data) => {
      expect(data.$schema).toBe('https://opencode.ai/config.json');
      expect(data.theme).toBe('tokyonight');
      expect(Object.keys(data.mcp as object).sort()).toEqual(['context7', 'hwip']);
    },
    undo: async (file) => (await import('./uninstall.js')).rmMcpEntry(file, false, 'mcp'),
  },
];

describe.each(cases)('$label with comments and trailing commas', ({ rel, name, apply, expected }) => {
  it('is merged, not left alone: the user\'s entries stay, hwip\'s is added', async () => {
    const file = place(rel, name);

    await apply(file);

    const data = parseJsonc(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expected(data);
  });

  it('keeps every comment the user wrote, on the line it was on', async () => {
    const file = place(rel, name);
    const before = commentLines(fixture(name));
    expect(before.length).toBeGreaterThan(0);

    await apply(file);

    const after = commentLines(readFileSync(file, 'utf-8'));
    for (const line of before) expect(after, `lost or moved "${line.comment}"`).toContainEqual(line);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const file = place(rel, name);

    await apply(file);
    const once = readFileSync(file, 'utf-8');
    await apply(file);

    expect(readFileSync(file, 'utf-8')).toBe(once);
  });

  it('does not touch what is before the first change', async () => {
    const file = place(rel, name);
    const original = fixture(name);

    await apply(file);

    // The first line of every fixture is `{` or a comment, and the second the user's own.
    const head = original.split('\n').slice(0, 2).join('\n');
    expect(readFileSync(file, 'utf-8').startsWith(head)).toBe(true);
  });
});

describe.each(cases)('$label: install, then uninstall', ({ rel, name, apply, undo, leftBehind = [] }) => {
  it('leaves the user\'s file as it was, comments and all', async () => {
    const file = place(rel, name);
    const original = fixture(name);

    await apply(file);
    await undo(file);

    const after = readFileSync(file, 'utf-8');
    const data = parseJsonc(after) as Record<string, unknown>;
    for (const key of leftBehind) delete data[key];
    expect(data).toEqual(parseJsonc(original));
    expect(commentLines(after)).toEqual(commentLines(original));
    // Where the uninstall leaves nothing of hwip's behind, the file is the one the user wrote, byte for byte.
    if (leftBehind.length === 0) expect(after).toBe(original);
  });
});

describe('hwip\'s own entries in a JSONC hooks file', () => {
  it('are left as the user formatted them when the install would write the same thing', async () => {
    const file = place('.cursor/hooks.json', 'cursor-hooks.jsonc');
    const { mergeJsonFile } = await import('./installer.js');
    const { CURSOR_HOOKS } = await import('./templates.js');
    mergeJsonFile(file, CURSOR_HOOKS);
    // The user tidies hwip's entry onto one line: same value, their layout.
    const [hwipStop] = CURSOR_HOOKS.hooks.stop;
    const tidied = readFileSync(file, 'utf-8').replace(/\{\n\s+"command": ("(?:[^"\\]|\\.)*")\n\s+\}/, '{ "command": $1 }');
    expect(tidied).toContain(`{ "command": ${JSON.stringify(hwipStop.command)} }`);
    writeFileSync(file, tidied);

    mergeJsonFile(file, CURSOR_HOOKS);

    expect(readFileSync(file, 'utf-8')).toBe(tidied);
  });

  it('are collapsed to one when an older install left several', async () => {
    const { mergeJsonFile } = await import('./installer.js');
    const { CURSOR_HOOKS } = await import('./templates.js');
    const old = JSON.stringify({ command: '$(command -v hwip || echo "npx -y @hwip/cli") notify --title "old" 2>/dev/null || true' });
    const file = join(TMP, 'hooks.json');
    writeFileSync(file, `{\n  "hooks": {\n    "stop": [\n      ${old}, // old hwip\n      { "command": "./mine.sh" }, // mine\n      ${old},\n    ],\n  },\n}\n`);

    mergeJsonFile(file, CURSOR_HOOKS);

    const stop = (parseJsonc(readFileSync(file, 'utf-8')) as { hooks: { stop: unknown[] } }).hooks.stop;
    expect(stop.filter(isHwipCommand)).toHaveLength(1);
    expect(stop).toContainEqual({ command: './mine.sh' });
    expect(stop).toHaveLength(2);
    expect(readFileSync(file, 'utf-8')).toContain('{ "command": "./mine.sh" }, // mine');
  });
});

describe('an edit that would lose a comment', () => {
  it('names the file and leaves it as it was', async () => {
    const { mergeJsonFile } = await import('./installer.js');
    const old = JSON.stringify({ command: '$(command -v hwip || echo "npx -y @hwip/cli") notify --title "old" 2>/dev/null || true' });
    const file = join(TMP, 'hooks.json');
    // An old hwip entry after the user's on one line, with a comment before it: taking it out would take the comment along.
    const content = `{"hooks":{"stop":[{"command":"mine"}, /* keep */ ${old}]}}\n`;
    writeFileSync(file, content);

    // (A patch that holds no hwip group for the event: only the removal is left to do.)
    expect(() => mergeJsonFile(file, { hooks: { stop: [] } })).toThrow(`${file} could not be edited`);
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });
});

describe('a new entry that would take a comment of the user\'s along', () => {
  it('refuses the install, names the file and leaves it as it was', async () => {
    const { injectMcpEntry } = await import('./installer.js');
    const file = join(TMP, 'mcp.json');
    // An uninstall takes the comment at the end of hwip's line along: it must not land there.
    const content = '{"mcpServers": { // add servers below\n  }}\n';
    writeFileSync(file, content);

    expect(() => injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY)).toThrow(`${file} could not be edited`);
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });
});

describe('a file that is still not valid JSONC is left as it is', () => {
  it.each([
    ['a missing value', '{ "theme": // mine\n}\n'],
    ['a missing comma', '{ "a": 1 "b": 2 }\n'],
    ['a half-written file', '{ "hooks": { "stop": [\n'],
  ])('%s: throws, names the file, and keeps its bytes', async (_, content) => {
    const { mergeJsonFile, injectMcpEntry } = await import('./installer.js');
    const { CURSOR_HOOKS } = await import('./templates.js');
    const file = join(TMP, 'broken.json');
    writeFileSync(file, content);

    expect(() => mergeJsonFile(file, CURSOR_HOOKS)).toThrow(file);
    expect(() => injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY)).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf-8')).toBe(content);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
