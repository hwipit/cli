import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasHwipAutoName, readHwipMcpArgv, removeHwipMcpTable, upsertHwipMcpTable } from './codex-config.js';
import { injectMcpEntry } from './installer.js';
import { GEMINI_MCP_ADD, GEMINI_MCP_ADD_LEGACY, MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';
import { registeredAutoName } from './verify.js';

/**
 * Agents with no title of their own (Codex, Cursor, Windsurf, Gemini) name
 * their sessions through the MCP server's `hwip_session_title`, which the
 * server offers only under HWIP_AUTONAME=1. The installer sets it in those
 * agents' registrations and nowhere else: Claude Code and opencode title
 * their sessions themselves, and a second instruction would cost every turn.
 */

describe('registrations that turn auto names on', () => {
    it('sets the flag for Cursor and Windsurf, beside the key placeholder', () => {
        expect(MCP_SERVERS_ENTRY.env).toEqual({ HWIP_API_KEY: '${HWIP_API_KEY}', HWIP_AUTONAME: '1' });
    });

    it('leaves opencode without it', () => {
        expect(JSON.stringify(OPENCODE_MCP_ENTRY)).not.toContain('HWIP_AUTONAME');
    });

    // `gemini mcp add` stores `-e` pairs as the entry's env, and replaces an existing hwip entry whole.
    it('passes it to both gemini forms, before the server name', () => {
        for (const command of [GEMINI_MCP_ADD, GEMINI_MCP_ADD_LEGACY]) {
            expect(command).toMatch(/ -e HWIP_AUTONAME=1 hwip /);
            expect(command.indexOf('-e HWIP_AUTONAME=1')).toBeLessThan(command.indexOf(' -- '));
        }
    });
});

describe('codex config.toml', () => {
    const table = (...body: string[]) => ['[mcp_servers.hwip]', 'command = "hwip"', 'args = ["mcp"]', ...body].join('\n');

    it('writes the flag into a new table', () => {
        const out = upsertHwipMcpTable('model = "o4"\n');

        expect(out).toContain('env = { HWIP_AUTONAME = "1" }');
        expect(hasHwipAutoName(out)).toBe(true);
        expect(readHwipMcpArgv(out)).toEqual(['hwip', 'mcp']);
    });

    it('adds it to a table an older install wrote, and writing again changes nothing', () => {
        const once = upsertHwipMcpTable(`${table('startup_timeout_sec = 20')}\n`);

        expect(once).toBe(`${table('env = { HWIP_AUTONAME = "1" }', 'startup_timeout_sec = 20')}\n`);
        expect(upsertHwipMcpTable(once)).toBe(once);
    });

    // TOML refuses a key defined twice, and codex then refuses the whole file.
    it('adds it to an env of the user\'s own and keeps theirs', () => {
        const out = upsertHwipMcpTable(`${table('env = { HTTPS_PROXY = "http://p:8080" }')}\n`);

        expect(out).toContain('env = { HWIP_AUTONAME = "1", HTTPS_PROXY = "http://p:8080" }');
        expect(out.match(/^env\s*=/gm)).toHaveLength(1);
        expect(upsertHwipMcpTable(out)).toBe(out);
    });

    it('turns a flag set to anything else back on', () => {
        const out = upsertHwipMcpTable(`${table('env = { HWIP_AUTONAME = "0", A = "b" }')}\n`);

        expect(out).toContain('env = { HWIP_AUTONAME = "1", A = "b" }');
    });

    // TOML refuses a key defined twice; these spellings once got a second `env` or a second flag.
    it.each([
        ['an inline env with a comment after it', 'env = { A = "b" } # proxy', 'env = { HWIP_AUTONAME = "1", A = "b" } # proxy'],
        ['a brace inside a value', 'env = { A = "x}y" }', 'env = { HWIP_AUTONAME = "1", A = "x}y" }'],
        ['a quoted flag in an inline env', 'env = { "HWIP_AUTONAME" = "0", B = "c" }', 'env = { HWIP_AUTONAME = "1", B = "c" }'],
        ['a value that holds the flag\'s text', 'env = { A = "HWIP_AUTONAME = 1", B = "x,y" }', 'env = { HWIP_AUTONAME = "1", A = "HWIP_AUTONAME = 1", B = "x,y" }'],
        ['a nested value', 'env = { A = { B = "c" }, HWIP_AUTONAME = "0" }', 'env = { HWIP_AUTONAME = "1", A = { B = "c" } }'],
        ['a quoted dotted flag', 'env."HWIP_AUTONAME" = "0"\nenv.B = "c"', 'env.HWIP_AUTONAME = "1"\nenv.B = "c"'],
    ])('keeps one env and one flag for %s', (_label, body, expected) => {
        const out = upsertHwipMcpTable(`${table(body)}\n`);

        expect(out).toBe(`${table(expected)}\n`);
        expect(hasHwipAutoName(out)).toBe(true);
        expect(upsertHwipMcpTable(out)).toBe(out);
    });

    it('replaces a quoted flag in the user\'s env table', () => {
        const out = upsertHwipMcpTable(`${table()}\n\n[mcp_servers.hwip.env]\n'HWIP_AUTONAME' = "0"\nA = "b"\n`);

        expect(out).toBe(`${table()}\n\n[mcp_servers.hwip.env]\nHWIP_AUTONAME = "1"\nA = "b"\n`);
    });

    it('writes into an [mcp_servers.hwip.env] table the user keeps, and no inline env beside it', () => {
        const config = `${table()}\n\n[mcp_servers.hwip.env]\nHTTPS_PROXY = "http://p:8080"\n\n[mcp_servers.other]\ncommand = "x"\n`;

        const out = upsertHwipMcpTable(config);

        expect(out).toBe(`${table()}\n\n[mcp_servers.hwip.env]\nHWIP_AUTONAME = "1"\nHTTPS_PROXY = "http://p:8080"\n\n[mcp_servers.other]\ncommand = "x"\n`);
        expect(hasHwipAutoName(out)).toBe(true);
        expect(upsertHwipMcpTable(out)).toBe(out);
    });

    it('takes the flag out with the rest of the entry on uninstall', () => {
        const installed = upsertHwipMcpTable('model = "o4"\n');
        const withSubtable = upsertHwipMcpTable(`model = "o4"\n\n${table()}\n\n[mcp_servers.hwip.env]\nA = "b"\n`);

        expect(removeHwipMcpTable(installed)).toBe('model = "o4"\n');
        expect(removeHwipMcpTable(withSubtable)).toBe('model = "o4"\n');
    });

    it('tells an entry with the flag from one without', () => {
        expect(hasHwipAutoName(`${table()}\n`)).toBe(false);
        expect(hasHwipAutoName(`${table()}\n\n[mcp_servers.other]\nenv = { HWIP_AUTONAME = "1" }\n`)).toBe(false);
        expect(hasHwipAutoName('model = "o4"\n')).toBe(false);
    });
});

describe('JSON registries', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hwip-autoname-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('a reinstall over an older entry turns the flag on, and verify can see it', () => {
        const file = join(dir, 'mcp.json');
        writeFileSync(file, JSON.stringify({ mcpServers: { hwip: { command: 'hwip', args: ['mcp'], env: { HWIP_API_KEY: '${HWIP_API_KEY}' } } } }, null, 2));
        expect(registeredAutoName(file, 'mcpServers')).toBe(false);

        injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY);
        const once = readFileSync(file, 'utf-8');
        injectMcpEntry(file, 'mcpServers', MCP_SERVERS_ENTRY);

        expect(registeredAutoName(file, 'mcpServers')).toBe(true);
        expect(readFileSync(file, 'utf-8')).toBe(once);
    });

    it('verify reads a missing file or entry as no flag', () => {
        expect(registeredAutoName(join(dir, 'none.json'), 'mcpServers')).toBe(false);
        writeFileSync(join(dir, 'other.json'), JSON.stringify({ mcpServers: { other: { env: { HWIP_AUTONAME: '1' } } } }));
        expect(registeredAutoName(join(dir, 'other.json'), 'mcpServers')).toBe(false);
    });
});
