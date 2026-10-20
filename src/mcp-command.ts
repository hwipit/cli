/**
 * How every agent launches the Hwip MCP server — one source, three schemas.
 *
 * Registrations used to say `npx -y @hwip/mcp-server`, which left an
 * `npm exec` launcher resident beside the server for the life of the session.
 * `hwip mcp` (see mcp.ts) runs the server in the CLI's own process instead.
 *
 * Cursor/Windsurf, Gemini and OpenCode each want that launch in a different
 * shape, and the shapes drifted apart when each site spelled the command out
 * itself. Everything below is derived from MCP_LAUNCH_ARGV.
 */

/** What the agents run. `hwip` resolves out of the same global bin dir as `npx`. */
export const MCP_LAUNCH_ARGV = ['hwip', 'mcp'] as const;

const [MCP_BIN, ...MCP_SUBCOMMAND] = MCP_LAUNCH_ARGV;

/**
 * Turns on the MCP server's `hwip_session_title` (mcp-server config `autoName`),
 * so an agent with no title of its own names its session after its task. Set
 * for Codex, Cursor, Windsurf and Gemini only: Claude Code and opencode title
 * their sessions themselves, and the instruction would cost every turn.
 */
export const AUTONAME_ENV = 'HWIP_AUTONAME';

/**
 * `mcpServers.hwip` — what the installer writes for Cursor and Windsurf.
 * The env block is deliberate: both spawn the MCP server from a graphical
 * context that may not inherit shell env, so the key is passed through
 * explicitly rather than left to inheritance.
 *
 * `hwipit/plugin`'s `.mcp.json` holds the same shape but is a HAND-KEPT COPY —
 * it lives in another repo and cannot import this. Change one, change both —
 * except AUTONAME_ENV, which the plugin (Claude Code) leaves out on purpose.
 */
export const MCP_SERVERS_ENTRY = {
    command: MCP_BIN,
    args: [...MCP_SUBCOMMAND],
    env: { HWIP_API_KEY: '${HWIP_API_KEY}', [AUTONAME_ENV]: '1' },
};

/**
 * opencode.json's own MCP schema — top-level `mcp` key (not `mcpServers`),
 * `command` as ARRAY (binary + args), `type: "local"`. No `environment` —
 * opencode is a terminal app that inherits shell env, and the MCP server
 * falls back to ~/.hwip/config.json anyway (an unexpanded "${HWIP_API_KEY}"
 * literal would shadow that fallback with junk).
 */
export const OPENCODE_MCP_ENTRY = {
    type: 'local',
    command: [...MCP_LAUNCH_ARGV],
    enabled: true,
};

// gemini ≥0.26 syntax: `mcp add [-s scope] <name> <command> [args…]`. The
// server NAME and the BINARY are both "hwip" here, so the doubled word below
// is correct, not a copy-paste slip. Default scope is "project" (cwd-local
// .gemini/), so user scope is pinned for a machine-wide install.
// `-e` lands in the entry's env; an existing hwip entry is replaced whole, so a reinstall adds it.
export const GEMINI_MCP_ADD = `gemini mcp add -s user -e ${AUTONAME_ENV}=1 hwip ${MCP_BIN} -- ${MCP_SUBCOMMAND.join(' ')}`;

/** Older gemini CLIs only accept `mcp add <name> -- <command…>`, with no scope flag. */
export const GEMINI_MCP_ADD_LEGACY = `gemini mcp add -e ${AUTONAME_ENV}=1 hwip -- ${MCP_LAUNCH_ARGV.join(' ')}`;

/** The legacy form without `-e`, last: should a gemini that old refuse `-e`, the tools still load,
 *  and `hwip verify` says auto session names are off. */
export const GEMINI_MCP_ADD_BARE = `gemini mcp add hwip -- ${MCP_LAUNCH_ARGV.join(' ')}`;
