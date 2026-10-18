import { describe, expect, it } from 'vitest';
import { CODEX_MCP_TABLE, readHwipMcpArgv, removeHwipMcpTable, upsertHwipMcpTable } from './codex-config.js';

const USER_CONFIG = `model = "gpt-5.6-luna"
model_reasoning_effort = "low"

[mcp_servers.graft]
command = "graft"
args = ["mcp"]

[projects."/Users/me/work"]
trust_level = "trusted"
`;

describe('upsertHwipMcpTable', () => {
    it('appends the table to a config that has none', () => {
        const out = upsertHwipMcpTable(USER_CONFIG);
        expect(out).toContain(CODEX_MCP_TABLE);
        expect(out).toContain('model = "gpt-5.6-luna"');
        expect(out).toContain('[mcp_servers.graft]');
    });

    it('writes a table into an empty config without a leading blank line', () => {
        expect(upsertHwipMcpTable('')).toBe(`${CODEX_MCP_TABLE}\n`);
    });

    it('replaces a stale entry in place, keeping what follows', () => {
        const stale = `${USER_CONFIG}
[mcp_servers.hwip]
command = "npx"
args = ["-y", "@hwip/mcp-server"]

[history]
persistence = "none"
`;
        const out = upsertHwipMcpTable(stale);
        expect(out).not.toContain('npx');
        expect(out).toContain('command = "hwip"');
        expect(out).toContain('[history]\npersistence = "none"');
    });

    it('is idempotent', () => {
        const once = upsertHwipMcpTable(USER_CONFIG);
        expect(upsertHwipMcpTable(once)).toBe(once);
    });
});

describe('removeHwipMcpTable', () => {
    it('takes out only hwip, leaving the user\'s own servers', () => {
        const out = removeHwipMcpTable(upsertHwipMcpTable(USER_CONFIG));
        expect(out).not.toBeNull();
        expect(out).not.toContain('mcp_servers.hwip');
        expect(out).toContain('[mcp_servers.graft]');
        expect(out).toContain('model = "gpt-5.6-luna"');
    });

    it('reports nothing to do when the table is absent', () => {
        expect(removeHwipMcpTable(USER_CONFIG)).toBeNull();
    });

    it('does not grow the file across install/uninstall cycles', () => {
        const cycled = removeHwipMcpTable(upsertHwipMcpTable(
            removeHwipMcpTable(upsertHwipMcpTable(USER_CONFIG)) as string,
        ));
        expect(cycled).toBe(removeHwipMcpTable(upsertHwipMcpTable(USER_CONFIG)));
    });
});

describe('readHwipMcpArgv', () => {
    it('reads back what the installer wrote', () => {
        expect(readHwipMcpArgv(upsertHwipMcpTable(USER_CONFIG))).toEqual(['hwip', 'mcp']);
    });

    it('returns a stale registration verbatim, so verify can call it stale', () => {
        const stale = `[mcp_servers.hwip]\ncommand = "npx"\nargs = ["-y", "@hwip/mcp-server"]\n`;
        expect(readHwipMcpArgv(stale)).toEqual(['npx', '-y', '@hwip/mcp-server']);
    });

    it('is null when codex has no hwip entry', () => {
        expect(readHwipMcpArgv(USER_CONFIG)).toBeNull();
    });

    it('reads an entry codex wrote with a quoted table name', () => {
        expect(readHwipMcpArgv('[mcp_servers."hwip"]\ncommand = "hwip"\nargs = ["mcp"]\n')).toEqual(['hwip', 'mcp']);
    });
});

describe('the user\'s own bytes survive', () => {
    // Codex writes this itself when the user picks "always allow" for a tool;
    // measured on a live ~/.codex/config.toml.
    const WITH_SUBTABLE = `model = "gpt-5.6-luna"

[mcp_servers.hwip]
command = "hwip"
args = ["mcp"]

[mcp_servers.hwip.tools.hwip_ask]
approval_mode = "approve"

[projects."/Users/me/work"]
trust_level = "trusted"
`;

    it('removes hwip together with its sub-tables, orphaning nothing', () => {
        const out = removeHwipMcpTable(WITH_SUBTABLE) as string;
        expect(out).not.toContain('mcp_servers.hwip');
        expect(out).not.toContain('approval_mode');
        expect(out).toContain('[projects."/Users/me/work"]');
    });

    it('keeps the approval sub-table across a re-install', () => {
        const out = upsertHwipMcpTable(WITH_SUBTABLE);
        expect(out).toContain('[mcp_servers.hwip.tools.hwip_ask]');
        expect(out).toContain('approval_mode = "approve"');
    });

    it('keeps keys of theirs inside our table, and rewrites only ours', () => {
        const withExtras = `[mcp_servers.hwip]
command = "npx"
args = ["-y", "@hwip/mcp-server"]
startup_timeout_sec = 30
`;
        const out = upsertHwipMcpTable(withExtras);
        expect(out).toContain('startup_timeout_sec = 30');
        expect(out).toContain('command = "hwip"');
        expect(out).not.toContain('npx');
    });

    it('leaves a comment that documents the NEXT table where it was', () => {
        const commented = `[mcp_servers.hwip]
command = "hwip"
args = ["mcp"]

# my own server, do not remove
[mcp_servers.graft]
command = "graft"
`;
        expect(removeHwipMcpTable(commented)).toContain('# my own server, do not remove');
        expect(upsertHwipMcpTable(commented)).toContain('# my own server, do not remove');
    });

    it('replaces the dotted form instead of writing a duplicate key', () => {
        const dotted = 'model = "gpt-5.6-luna"\nmcp_servers.hwip = { command = "npx", args = ["mcp"] }\n';
        const out = upsertHwipMcpTable(dotted);
        expect(out).toContain('[mcp_servers.hwip]');
        expect(out).not.toContain('mcp_servers.hwip = {');
        expect(out.match(/mcp_servers\.(?:hwip|"hwip")/g)).toHaveLength(1);
        expect(removeHwipMcpTable(dotted)).not.toContain('mcp_servers.hwip');
    });

    it('keeps CRLF endings CRLF', () => {
        const crlf = 'model = "gpt-5.6-luna"\r\n';
        const out = upsertHwipMcpTable(crlf);
        expect(out).not.toMatch(/[^\r]\n/);
    });
});

describe('readHwipMcpArgv — shapes codex and humans actually write', () => {
    it('reads args split across lines', () => {
        const multiline = '[mcp_servers.hwip]\ncommand = "hwip"\nargs = [\n  "mcp",\n]\n';
        expect(readHwipMcpArgv(multiline)).toEqual(['hwip', 'mcp']);
    });

    it('reads the dotted form', () => {
        expect(readHwipMcpArgv('mcp_servers.hwip = { command = "npx", args = ["mcp"] }\n'))
            .toEqual(['npx', 'mcp']);
    });

    it('is not fooled by a sub-table sitting below ours', () => {
        const withSub = '[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\n\n[mcp_servers.hwip.tools.hwip_ask]\napproval_mode = "approve"\n';
        expect(readHwipMcpArgv(withSub)).toEqual(['hwip', 'mcp']);
    });
});
