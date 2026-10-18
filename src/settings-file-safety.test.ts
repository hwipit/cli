/**
 * What happens to a user's settings file around hwip's read-edit-write (C92–C95):
 * a link into a dotfiles repo, bytes that are not text, a write by someone else
 * in between, and a long run of whitespace. Every file is under a temp HOME.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError, NotUtf8Error, readText, readTextIfExists, replaceFile } from './replace-file.js';

const originalHome = process.env.HOME;
let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'hwip-file-safety-'));
    process.env.HOME = TMP;
    vi.resetModules();
});
afterEach(() => {
    vi.doUnmock('fs');
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

const put = (rel: string, content: string | Buffer): string => {
    const file = join(TMP, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
};
const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;

describe('uninstall of a hooks file that is a symlink into a dotfiles repo (C92)', () => {
    it('keeps the link and takes hwip\'s hooks out of what it points at', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const target = put('dotfiles/cursor-hooks.json', JSON.stringify(CURSOR_HOOKS, null, 2));
        mkdirSync(join(TMP, '.cursor'), { recursive: true });
        const link = join(TMP, '.cursor', 'hooks.json');
        symlinkSync(target, link);
        const { rmHwipHooks } = await import('./uninstall.js');

        const line = rmHwipHooks(link, false);

        expect(line).toBeTruthy();
        expect(isLink(link)).toBe(true);
        expect(readFileSync(target, 'utf-8')).not.toContain('@hwip/cli');
        // Linked again later, nothing of hwip's is there to run.
        expect(readFileSync(link, 'utf-8')).not.toContain('@hwip/cli');
    });

    it('treats a folder linked into a dotfiles repo like a linked file', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const repoFile = put('dotfiles/cursor/hooks.json', JSON.stringify(CURSOR_HOOKS, null, 2));
        symlinkSync(dirname(repoFile), join(TMP, '.cursor'));
        const file = join(TMP, '.cursor', 'hooks.json');
        const { rmHwipHooks } = await import('./uninstall.js');

        rmHwipHooks(file, false);

        expect(existsSync(repoFile)).toBe(true);
        expect(readFileSync(repoFile, 'utf-8')).not.toContain('@hwip/cli');
    });

    it('still deletes a plain hooks file that held only hwip\'s entries', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const file = put('.cursor/hooks.json', JSON.stringify(CURSOR_HOOKS, null, 2));
        const { rmHwipHooks } = await import('./uninstall.js');

        rmHwipHooks(file, false);

        expect(existsSync(file)).toBe(false);
    });

    it('keeps a symlinked rule file too, with its Hwip block taken out of what it points at', async () => {
        const target = put('dotfiles/global_rules.md', '<!-- HWIP:START -->\nuse hwip\n<!-- HWIP:END -->\n');
        const link = join(TMP, '.codeium', 'windsurf', 'memories', 'global_rules.md');
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link);
        const { stripManagedRule } = await import('./uninstall.js');

        const line = stripManagedRule(link, false);

        expect(line).toBeTruthy();
        expect(isLink(link)).toBe(true);
        expect(readFileSync(target, 'utf-8')).not.toContain('HWIP:START');
    });

    it('still deletes a plain rule file that was only Hwip\'s block', async () => {
        const file = put('.gemini/GEMINI.md', '<!-- HWIP:START -->\nuse hwip\n<!-- HWIP:END -->\n');
        const { stripManagedRule } = await import('./uninstall.js');

        stripManagedRule(file, false);

        expect(existsSync(file)).toBe(false);
    });
});

describe('a file that is not valid UTF-8 is left as it is (C93)', () => {
    const latin1 = Buffer.concat([Buffer.from('{\n  // caf'), Buffer.from([0xe9]), Buffer.from('\n  "theme": "x"\n}\n')]);

    it('install of an MCP entry stops and names the file, bytes untouched', async () => {
        const file = put('.cursor/mcp.json', latin1);
        const { injectMcpEntry } = await import('./installer.js');

        expect(() => injectMcpEntry(file, 'mcpServers', { command: 'hwip' })).toThrow(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid UTF-8 text, left it unchanged$`));

        expect(readFileSync(file).equals(latin1)).toBe(true);
    });

    it('install of hooks, of the Codex TOML table and of the shared rule file stop the same way', async () => {
        const { GEMINI_HOOKS } = await import('./templates.js');
        const { mergeJsonFile, injectCodexMcpEntry } = await import('./installer.js');
        const settings = put('.gemini/settings.json', latin1);
        const toml = put('.codex/config.toml', Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n')]));

        expect(() => mergeJsonFile(settings, GEMINI_HOOKS)).toThrow(/not valid UTF-8/);
        expect(() => injectCodexMcpEntry(toml)).toThrow(/not valid UTF-8/);

        expect(readFileSync(settings).equals(latin1)).toBe(true);
        expect(readFileSync(toml)[5]).toBe(0xe9);
    });

    it('uninstall names the bytes problem instead of rewriting the file (the step runner prints it as a line)', async () => {
        const file = put('.cursor/mcp.json', Buffer.concat([latin1, Buffer.alloc(0)]));
        const { rmMcpEntry } = await import('./uninstall.js');

        expect(() => rmMcpEntry(file, false)).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid UTF-8 text`));

        expect(readFileSync(file).equals(latin1)).toBe(true);
    });

    it('uninstall of the Codex TOML says so too, since a table left there keeps launching hwip\'s server', async () => {
        const toml = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n[mcp_servers.hwip]\ncommand = "npx"\n')]);
        const file = put('.codex/config.toml', toml);
        const { rmCodexMcpEntry } = await import('./uninstall.js');

        const line = rmCodexMcpEntry(file, false);

        expect(line).toMatchObject({ notice: 'attention', text: expect.stringContaining('remove it by hand') });
        expect(readFileSync(file).equals(toml)).toBe(true);
    });

    it('readText keeps a byte order mark and rejects bad bytes; readTextIfExists says null for a missing file only', () => {
        const bom = put('bom.json', '﻿{"a":1}');
        const bad = put('bad.json', Buffer.from([0x7b, 0xff, 0x7d]));

        expect(readText(bom)).toBe('﻿{"a":1}');
        expect(() => readText(bad)).toThrow(NotUtf8Error);
        expect(readTextIfExists(join(TMP, 'missing.json'))).toBeNull();
        expect(() => readTextIfExists(bad)).toThrow(NotUtf8Error);
        expect(() => readTextIfExists(TMP)).toThrow(); // a directory is not "missing"
    });
});

describe('a write by someone else between hwip\'s read and its write is not lost (C94)', () => {
    it('replaceFile refuses when the file is no longer what was read, and leaves the other writer\'s content', () => {
        const file = put('s.json', 'theirs');
        expect(() => replaceFile(file, 'hwip', 'what hwip read')).toThrow(FileChangedError);
        expect(readFileSync(file, 'utf-8')).toBe('theirs');
        expect(readdirSync(TMP).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('writes when the file is what was read, and when it was not there and still is not', () => {
        const file = put('s.json', 'read');
        replaceFile(file, 'new', 'read');
        expect(readFileSync(file, 'utf-8')).toBe('new');

        const fresh = join(TMP, 'fresh.json');
        replaceFile(fresh, 'created', null);
        expect(readFileSync(fresh, 'utf-8')).toBe('created');
    });

    it('refuses to create a file that appeared meanwhile as bytes that are not text', () => {
        const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
        const file = put('s.json', bytes);

        expect(() => replaceFile(file, 'hwip', null)).toThrow(FileChangedError);

        expect(readFileSync(file).equals(bytes)).toBe(true);
    });

    it('refuses to create a file that appeared meanwhile, and writes unchecked when told nothing', () => {
        const file = put('s.json', 'appeared');
        expect(() => replaceFile(file, 'hwip', null)).toThrow(FileChangedError);
        expect(readFileSync(file, 'utf-8')).toBe('appeared');

        replaceFile(file, 'overwritten'); // a file hwip owns whole: nothing to compare
        expect(readFileSync(file, 'utf-8')).toBe('overwritten');
    });

    it('install: a write between the read and the replace keeps the other\'s content and says to run again', async () => {
        const file = put('.cursor/mcp.json', '{\n  "mcpServers": {}\n}\n');
        const real = (await import('fs')).readFileSync;
        let once = false;
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            return {
                ...mod,
                readFileSync: ((p: unknown, o: unknown) => {
                    const out = (real as (a: unknown, b: unknown) => unknown)(p, o);
                    if (!once && p === file) {
                        once = true;
                        // Someone else adds a server right after hwip has read the file.
                        mod.writeFileSync(file, '{\n  "mcpServers": { "other": { "command": "x" } }\n}\n');
                    }
                    return out;
                }) as typeof mod.readFileSync,
            };
        });
        const { injectMcpEntry } = await import('./installer.js');

        expect(() => injectMcpEntry(file, 'mcpServers', { command: 'hwip' })).toThrow(/changed while hwip was editing it/);

        expect(real(file, 'utf-8')).toContain('"other"');
        expect(real(file, 'utf-8')).not.toContain('"hwip"');
    });

    it('uninstall: the same, for the entry it is taking out', async () => {
        const file = put('.cursor/mcp.json', '{\n  "mcpServers": { "hwip": { "command": "hwip" } }\n}\n');
        const real = (await import('fs')).readFileSync;
        let once = false;
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            return {
                ...mod,
                readFileSync: ((p: unknown, o?: unknown) => {
                    const out = (real as (a: unknown, b?: unknown) => unknown)(p, o);
                    if (!once && p === file) {
                        once = true;
                        mod.writeFileSync(file, '{\n  "mcpServers": { "hwip": { "command": "hwip" }, "other": { "command": "x" } }\n}\n');
                    }
                    return out;
                }) as typeof mod.readFileSync,
            };
        });
        const { rmMcpEntry } = await import('./uninstall.js');

        // The step runner turns the throw into a "could not finish" line; called directly it throws.
        expect(() => rmMcpEntry(file, false)).toThrow(/changed while hwip was editing it/);

        expect(real(file, 'utf-8')).toContain('"other"');
        expect(real(file, 'utf-8')).toContain('"hwip"');
    });
});

describe('every read-edit-write notices a write in between (C94)', () => {
    // The first read of `file` by hwip triggers `theirs` being written, as another process would.
    const racing = async (file: string, theirs: string): Promise<(p: string) => string> => {
        const real = (await import('fs')).readFileSync;
        let once = false;
        vi.doMock('fs', async (importOriginal) => {
            const mod = await importOriginal<typeof import('fs')>();
            return {
                ...mod,
                readFileSync: ((p: unknown, o?: unknown) => {
                    const out = (real as (a: unknown, b?: unknown) => unknown)(p, o);
                    if (!once && p === file) {
                        once = true;
                        mod.writeFileSync(file, theirs);
                    }
                    return out;
                }) as typeof mod.readFileSync,
            };
        });
        return (p: string) => real(p, 'utf-8') as string;
    };

    it('hooks merged into an agent\'s settings', async () => {
        const file = put('.gemini/settings.json', '{\n  "theme": "dark"\n}\n');
        const read = await racing(file, '{\n  "theme": "light"\n}\n');
        const { GEMINI_HOOKS } = await import('./templates.js');
        const { mergeJsonFile } = await import('./installer.js');

        expect(() => mergeJsonFile(file, GEMINI_HOOKS)).toThrow(/changed while hwip was editing it/);

        expect(read(file)).toBe('{\n  "theme": "light"\n}\n');
    });

    it('the Codex TOML table, going in and going out', async () => {
        const file = put('.codex/config.toml', 'model = "a"\n');
        const read = await racing(file, 'model = "b"\n');
        const { injectCodexMcpEntry } = await import('./installer.js');
        expect(() => injectCodexMcpEntry(file)).toThrow(/changed while hwip was editing it/);
        expect(read(file)).toBe('model = "b"\n');
        vi.doUnmock('fs');
        vi.resetModules();

        const withHwip = '[mcp_servers.hwip]\ncommand = "npx"\nargs = ["-y", "@hwip/mcp-server"]\n';
        writeFileSync(file, `model = "a"\n\n${withHwip}`);
        const read2 = await racing(file, `model = "b"\n\n${withHwip}`);
        const { rmCodexMcpEntry } = await import('./uninstall.js');
        expect(() => rmCodexMcpEntry(file, false)).toThrow(/changed while hwip was editing it/);
        expect(read2(file)).toBe(`model = "b"\n\n${withHwip}`);
    });

    it('a shared rule file\'s Hwip block going in, and the Aider read: directive going in and out', async () => {
        const rule = put('.gemini/GEMINI.md', 'mine\n');
        const read = await racing(rule, 'mine, edited\n');
        const { writeManagedRule } = await import('./installer.js');
        expect(() => writeManagedRule(rule, 'use hwip')).toThrow(/changed while hwip was editing it/);
        expect(read(rule)).toBe('mine, edited\n');
        vi.doUnmock('fs');
        vi.resetModules();

        const conf = put('.aider.conf.yml', 'model: a\n');
        const read2 = await racing(conf, 'model: b\n');
        const { addAiderReadDirective } = await import('./installer.js');
        expect(() => addAiderReadDirective(conf, '/h/.hwip/aider-conventions.md')).toThrow(/changed while hwip was editing it/);
        expect(read2(conf)).toBe('model: b\n');
        vi.doUnmock('fs');
        vi.resetModules();

        writeFileSync(conf, 'model: a\n# Added by Hwip\nread: /h/.hwip/aider-conventions.md\n');
        const read3 = await racing(conf, 'model: b\n# Added by Hwip\nread: /h/.hwip/aider-conventions.md\n');
        const { rmAiderReadDirective } = await import('./uninstall.js');
        expect(() => rmAiderReadDirective(conf, false)).toThrow(/changed while hwip was editing it/);
        expect(read3(conf)).toBe('model: b\n# Added by Hwip\nread: /h/.hwip/aider-conventions.md\n');
    });

    it('hooks going out of a settings file that holds more than hwip\'s, in both uninstallers', async () => {
        const { CURSOR_HOOKS, GEMINI_HOOKS } = await import('./templates.js');
        const cursor = put('.cursor/hooks.json', JSON.stringify({ ...CURSOR_HOOKS, theme: 'mine' }, null, 2));
        const read = await racing(cursor, JSON.stringify({ ...CURSOR_HOOKS, theme: 'theirs' }, null, 2));
        const { rmHwipHooks } = await import('./uninstall.js');
        expect(() => rmHwipHooks(cursor, false)).toThrow(/changed while hwip was editing it/);
        expect(read(cursor)).toContain('"theirs"');
        vi.doUnmock('fs');
        vi.resetModules();

        const gemini = put('.gemini/settings.json', JSON.stringify({ ...GEMINI_HOOKS, theme: 'mine' }, null, 2));
        const read2 = await racing(gemini, JSON.stringify({ ...GEMINI_HOOKS, theme: 'theirs' }, null, 2));
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(() => rmGeminiHook(gemini, false)).toThrow(/changed while hwip was editing it/);
        expect(read2(gemini)).toContain('"theirs"');
    });

    // A delete is a write too.
    it('a delete: a hooks file that was only hwip\'s but got a line of the user\'s meanwhile is not removed', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const file = put('.cursor/hooks.json', JSON.stringify(CURSOR_HOOKS, null, 2));
        const read = await racing(file, JSON.stringify({ ...CURSOR_HOOKS, mine: true }, null, 2));
        const { rmHwipHooks } = await import('./uninstall.js');

        expect(() => rmHwipHooks(file, false)).toThrow(/changed while hwip was editing it/);

        expect(existsSync(file)).toBe(true);
        expect(read(file)).toContain('"mine"');
    });

    it('a delete: a rule file that was only the Hwip block', async () => {
        const block = '<!-- HWIP:START -->\nuse hwip\n<!-- HWIP:END -->\n';
        const file = put('.gemini/GEMINI.md', block);
        const read = await racing(file, `${block}my own rule\n`);
        const { stripManagedRule } = await import('./uninstall.js');

        expect(() => stripManagedRule(file, false)).toThrow(/changed while hwip was editing it/);

        expect(read(file)).toContain('my own rule');
    });

    it('is not a failure when the other writer wrote exactly what hwip was about to (two installs at once)', async () => {
        const file = put('.cursor/mcp.json', '{\n  "mcpServers": {}\n}\n');
        // What a first install leaves: the same text the second one is about to write.
        const { injectMcpEntry: first } = await import('./installer.js');
        const sibling = put('twin.json', '{\n  "mcpServers": {}\n}\n');
        first(sibling, 'mcpServers', { command: 'hwip' });
        const theirs = readFileSync(sibling, 'utf-8');
        vi.resetModules();
        const read = await racing(file, theirs);
        const { injectMcpEntry } = await import('./installer.js');

        expect(() => injectMcpEntry(file, 'mcpServers', { command: 'hwip' })).not.toThrow();

        expect(read(file)).toBe(theirs);
        expect(readdirSync(dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('a shared rule file\'s Hwip block, going out', async () => {
        const block = '<!-- HWIP:START -->\nuse hwip\n<!-- HWIP:END -->\n';
        const file = put('.gemini/GEMINI.md', `my rules\n\n${block}`);
        const read = await racing(file, `my other rules\n\n${block}`);
        const { stripManagedRule } = await import('./uninstall.js');

        expect(() => stripManagedRule(file, false)).toThrow(/changed while hwip was editing it/);

        expect(read(file)).toBe(`my other rules\n\n${block}`);
    });
});

describe('what the user is told when a step stops (C93, C94)', () => {
    it('a file that changed meanwhile: one line saying to run again, not "add this by hand" with the path twice', async () => {
        const { mergeFailureLines } = await import('./installer.js');
        // From the same module graph as the installer: the file's top-level import is another instance after the reset.
        const { FileChangedError, NotUtf8Error } = await import('./replace-file.js');
        const file = join(TMP, '.cursor', 'mcp.json');

        expect(mergeFailureLines('MCP injection', file, new FileChangedError(file), { mcpServers: {} })).toEqual([
            `MCP injection failed: ${file} changed while hwip was editing it, left it as it is (run the command again)`,
        ]);
        expect(mergeFailureLines('MCP injection', file, new NotUtf8Error(file), { mcpServers: {} })[0]).toContain(`Add this to ${file} by hand:`);
    });

    // These steps swallowed the reason: the user saw "Rule install failed" and no file.
    it('the rule, Codex config and Aider steps of the installers give the reason', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
        put('.pi/agent/AGENTS.md', Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
        put('.codex/AGENTS.md', Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
        put('.codex/config.toml', Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
        put('.aider.conf.yml', Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
        const { AGENT_INSTALLERS } = await import('./installer.js');

        AGENT_INSTALLERS.pi!();
        AGENT_INSTALLERS.codex!();
        AGENT_INSTALLERS.aider!();

        const text = lines.join('\n');
        expect(text).toContain(`Rule install failed: ${join(TMP, '.pi', 'agent', 'AGENTS.md')} is not valid UTF-8 text`);
        expect(text).toContain(`Rule install failed: ${join(TMP, '.codex', 'AGENTS.md')} is not valid UTF-8 text`);
        expect(text).toContain(`MCP install failed: ${join(TMP, '.codex', 'config.toml')} is not valid UTF-8 text`);
        expect(text).toContain(`Config wiring failed: ${join(TMP, '.aider.conf.yml')} is not valid UTF-8 text`);
        vi.restoreAllMocks();
    });
});

describe('writing a settings document back (C95)', () => {
    it('does not take quadratic time on a long run of whitespace inside it', async () => {
        const { JsoncDoc } = await import('./jsonc-doc.js');
        const doc = new JsoncDoc(`{"a": "x"${' '.repeat(200_000)}, "b": 1}`);

        const started = Date.now();
        const text = doc.text();

        expect(Date.now() - started).toBeLessThan(500);
        expect(text.endsWith('\n')).toBe(true);
    });
});
