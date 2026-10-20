/**
 * The hwip entry inside `~/.codex/config.toml`, which Codex CLI owns.
 *
 * Codex is the one supported agent whose MCP registry is TOML, and the file is
 * the user's: it carries their model, their approval settings, their other
 * servers. So this module works at the text level on the one table hwip owns
 * (`[mcp_servers.hwip]`) and never rewrites the document — a parse-and-emit
 * round trip through a TOML library would reorder their keys and drop their
 * comments, which is a worse failure than the entry being missing.
 *
 * What that promise costs, stated once here because every function below is
 * shaped by it:
 *
 *  - **Sub-tables are part of the entry.** Codex writes per-tool settings as
 *    `[mcp_servers.hwip.tools.hwip_ask]` when the user picks "always allow".
 *    Removal takes them along (a child of a deleted server is dead config);
 *    re-install keeps them, since they are the user's answer, not ours.
 *  - **Only `command`, `args` and the `HWIP_AUTONAME` env pair are ours.** Any
 *    other key in the table — `cwd`, `startup_timeout_sec`, a comment, the
 *    user's own env pairs — survives a re-install; the flag joins whichever
 *    env the user already keeps.
 *  - **Comments before the next table belong to that table**, not to ours, so
 *    the region we replace or delete stops short of them.
 *
 * Install, uninstall and verify all go through here so this is stated once.
 */
import { AUTONAME_ENV, MCP_LAUNCH_ARGV } from './mcp-command.js';

const [MCP_BIN, ...MCP_SUBCOMMAND] = MCP_LAUNCH_ARGV;

/** The table header, with or without the quotes TOML also allows. */
const HWIP_TABLE_HEADER = /^\[mcp_servers\.(?:hwip|"hwip")\]$/;
/** A sub-table of ours: `[mcp_servers.hwip.tools.hwip_ask]` and friends. */
const HWIP_SUBTABLE_HEADER = /^\[mcp_servers\.(?:hwip|"hwip")\..+\]$/;
/** The user's own env table for hwip — where the flag goes when they keep one. */
const HWIP_ENV_SUBTABLE_HEADER = /^\[mcp_servers\.(?:hwip|"hwip")\.(?:env|"env")\]$/;
/**
 * The dotted/inline form — `mcp_servers.hwip = { command = "npx", … }` — which
 * is valid TOML and which older hand-written configs use. It has to be found,
 * because appending a header table beside it is a duplicate-key error that
 * makes codex reject the WHOLE config, hwip's entry and the user's alike.
 */
const HWIP_INLINE_ENTRY = /^mcp_servers\.(?:hwip|"hwip")\s*=/;
const ANY_TABLE_HEADER = /^\[/;

const isHwipDefinition = (line: string): boolean =>
    HWIP_TABLE_HEADER.test(line.trim()) || HWIP_INLINE_ENTRY.test(line.trim());

/** The keys hwip owns; everything else in the table is the user's. */
const OWNED_KEY = /^(?:command|args)\s*=/;

const commandLine = `command = "${MCP_BIN}"`;
const argsLine = `args = [${MCP_SUBCOMMAND.map((a) => `"${a}"`).join(', ')}]`;
const flagPair = `${AUTONAME_ENV} = "1"`;
const envLine = `env = { ${flagPair} }`;

/** `env = { … }` in hwip's table — known by its key, so a comment after it cannot hide it. */
const INLINE_ENV = /^env\s*=\s*\{/;
/** `env.KEY = …`, the dotted spelling of the same table. */
const DOTTED_ENV = /^env\./;
/** The flag's key, bare or quoted: TOML reads all three as one key. */
const FLAG = `(?:${AUTONAME_ENV}|"${AUTONAME_ENV}"|'${AUTONAME_ENV}')`;
const FLAG_KEY = new RegExp(`^${FLAG}\\s*=`);
const DOTTED_FLAG_KEY = new RegExp(`^env\\.${FLAG}\\s*=`);
const FLAG_ON = new RegExp(`(?:^|[\\s{,.])${FLAG}\\s*=\\s*["']1["']`);

/** The table hwip writes into a config that has none. Its `env` holds only the
 *  auto-name flag, unlike the Cursor/Windsurf JSON entry: codex is a terminal
 *  app, so the server inherits the shell's `HWIP_API_KEY`, and an unexpanded
 *  `"${HWIP_API_KEY}"` literal would shadow the ~/.hwip/config.json fallback
 *  with junk (the same reasoning as opencode's). */
export const CODEX_MCP_TABLE = ['[mcp_servers.hwip]', commandLine, argsLine, envLine].join('\n');

/**
 * Walks a line of TOML outside its strings: `at(i, depth)` sees every character that is not
 * inside one, with the brace depth before it, and stops the walk by returning true.
 */
const walkOutsideStrings = (text: string, from: number, at: (i: number, depth: number) => boolean): void => {
    let depth = 0;
    let quote: string | null = null;
    for (let i = from; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\' && quote === '"') i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (at(i, depth)) return;
        if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') depth -= 1;
    }
};

/** The inline table's inside and what follows its closing brace (a comment), or null when it does
 *  not close on this line. */
const inlineParts = (line: string): { inner: string; tail: string } | null => {
    const open = line.indexOf('{');
    let parts: { inner: string; tail: string } | null = null;
    walkOutsideStrings(line, open, (i, depth) => {
        if (line[i] !== '}' || depth !== 1) return false;
        parts = { inner: line.slice(open + 1, i), tail: line.slice(i + 1) };
        return true;
    });
    return parts;
};

/** The pairs of an inline table, split at its own commas — never one inside a string or a nested value. */
const inlinePairs = (inner: string): string[] => {
    const pairs: string[] = [];
    let start = 0;
    walkOutsideStrings(inner, 0, (i, depth) => {
        if (inner[i] === ',' && depth === 0) {
            pairs.push(inner.slice(start, i));
            start = i + 1;
        }
        return false;
    });
    pairs.push(inner.slice(start));
    return pairs.map((pair) => pair.trim()).filter(Boolean);
};

/** An inline env table with the flag on and first, the user's pairs and comment kept. One that
 *  cannot be read is left alone: writing a second `env` beside it would break the whole file. */
const withFlag = (line: string): string => {
    const parts = inlineParts(line);
    if (!parts) return line;
    const rest = inlinePairs(parts.inner).filter((pair) => !FLAG_KEY.test(pair));
    return `env = { ${[flagPair, ...rest].join(', ')} }${parts.tail}`;
};

/** CRLF in, CRLF out — a Windows config must not come back with mixed endings. */
const eolOf = (config: string): string => (config.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (config: string): string[] => config.split(/\r?\n/);

/** Line index of hwip's definition — header or inline — or -1. */
const definitionIndex = (lines: readonly string[]): number =>
    lines.findIndex((line) => isHwipDefinition(line));

/** One past the last line of hwip's own key/value body (the next table header
 *  of any kind, or EOF). Meaningless for the inline form, which is one line. */
const bodyEnd = (lines: readonly string[], start: number): number => {
    const next = lines.slice(start + 1).findIndex((line) => ANY_TABLE_HEADER.test(line.trim()));
    return next === -1 ? lines.length : start + 1 + next;
};

/** One past the last line of the whole entry: body plus every sub-table of
 *  ours, stopping at the first header that belongs to someone else. */
const entryEnd = (lines: readonly string[], start: number): number => {
    let end = bodyEnd(lines, start);
    while (end < lines.length && HWIP_SUBTABLE_HEADER.test(lines[end].trim())) {
        end = bodyEnd(lines, end);
    }
    return end;
};

/**
 * `end` walked back past the blank lines and comments that precede whatever
 * comes next. A comment sitting above `[mcp_servers.graft]` documents THAT
 * server; deleting it with our table is the exact loss this module exists to
 * avoid.
 */
const withoutTrailingPreamble = (lines: readonly string[], start: number, end: number): number => {
    let cut = end;
    while (cut > start + 1) {
        const line = lines[cut - 1].trim();
        if (line === '' || line.startsWith('#')) cut -= 1;
        else break;
    }
    return cut;
};

/** The document, ending in exactly one newline, so writing a config that
 *  already carries the table is a no-op rather than a one-byte diff. */
const rejoin = (lines: readonly string[], eol: string): string =>
    `${lines.join(eol).replace(/(?:\r?\n)+$/, '')}${eol}`;

/**
 * The config with hwip's entry present and current, leaving every other byte
 * alone. Appended at the end when absent: a table header ends the table before
 * it, so nothing above can capture the keys.
 */
export const upsertHwipMcpTable = (config: string): string => {
    const eol = eolOf(config);
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) {
        const body = config.replace(/(?:\r?\n)+$/, '');
        const table = CODEX_MCP_TABLE.split('\n').join(eol);
        return `${body ? `${body}${eol}${eol}` : ''}${table}${eol}`;
    }

    // The inline form is a single line and cannot hold keys of ours to keep.
    if (HWIP_INLINE_ENTRY.test(lines[start].trim())) {
        const table = CODEX_MCP_TABLE.split('\n');
        return rejoin([...lines.slice(0, start), ...table, ...lines.slice(start + 1)], eol);
    }

    // A key defined twice makes codex refuse the whole file, so the flag goes
    // into whichever env the user already keeps, and gets one only if none.
    const envTable = lines.slice(bodyEnd(lines, start), entryEnd(lines, start))
        .findIndex((line) => HWIP_ENV_SUBTABLE_HEADER.test(line.trim()));
    const after = [...lines];
    if (envTable !== -1) {
        const header = bodyEnd(lines, start) + envTable;
        const tableEnd = bodyEnd(lines, header);
        const rows = lines.slice(header + 1, tableEnd).filter((line) => !FLAG_KEY.test(line.trim()));
        after.splice(header, tableEnd - header, lines[header], flagPair, ...rows);
    }

    const end = withoutTrailingPreamble(lines, start, bodyEnd(lines, start));
    const kept = lines.slice(start + 1, end)
        .filter((line) => !OWNED_KEY.test(line.trim()) && !DOTTED_FLAG_KEY.test(line.trim()));
    const inline = kept.findIndex((line) => INLINE_ENV.test(line.trim()));
    if (inline !== -1) kept[inline] = withFlag(kept[inline].trim());
    const ours = envTable !== -1 || inline !== -1 ? []
        : kept.some((line) => DOTTED_ENV.test(line.trim())) ? [`env.${flagPair}`]
        : [envLine];
    return rejoin([
        ...after.slice(0, start),
        '[mcp_servers.hwip]',
        commandLine,
        argsLine,
        ...ours,
        ...kept,
        ...after.slice(end),
    ], eol);
};

/** Whether hwip's entry turns auto names on — what verify checks to tell an
 *  install from before the flag existed. */
export const hasHwipAutoName = (config: string): boolean => {
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) return false;
    const end = HWIP_INLINE_ENTRY.test(lines[start].trim()) ? start + 1 : entryEnd(lines, start);
    return lines.slice(start, end).some((line) => FLAG_ON.test(line.trim()));
};

/** The config with hwip's entry and its sub-tables gone, or null when it was
 *  never there (so the caller can report "nothing to remove" rather than
 *  rewriting an untouched file). */
export const removeHwipMcpTable = (config: string): string | null => {
    const eol = eolOf(config);
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) return null;
    const end = HWIP_INLINE_ENTRY.test(lines[start].trim())
        ? start + 1
        : withoutTrailingPreamble(lines, start, entryEnd(lines, start));
    const kept = [...lines.slice(0, start), ...lines.slice(end)];
    // The removed entry left its blank separator behind; collapse the run so
    // repeated install/uninstall cycles cannot grow the file.
    return `${kept.join(eol).replace(/(?:\r?\n){3,}/g, `${eol}${eol}`).replace(/(?:\r?\n)+$/, '')}${eol}`;
};

/**
 * The launch argv codex has recorded for hwip, verbatim, or null when there is
 * no entry. Same contract as `registeredMcpArgv` in verify.ts: returned
 * unnormalized, because a stale entry is only visible if the reader does not
 * reshape it into what it expects.
 */
export const readHwipMcpArgv = (config: string): string[] | null => {
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) return null;
    // Joined, not scanned line by line: `args` is often written across several
    // lines, and a line-wise reader drops it — which verify would then report
    // as a stale registration for an entry that is in fact current.
    const body = HWIP_INLINE_ENTRY.test(lines[start].trim())
        ? lines[start]
        : lines.slice(start + 1, bodyEnd(lines, start)).join('\n');

    const command = body.match(/(?:^|[\s,{])command\s*=\s*["']([^"']+)["']/)?.[1];
    if (!command) return null;
    const rawArgs = body.match(/(?:^|[\s,{])args\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    const args = rawArgs
        .split(',')
        .map((a) => a.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    return [command, ...args];
};
