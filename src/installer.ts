import { execFileSync, execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { isDeepStrictEqual } from 'util';
import { HwipHook } from './hwip-hook.js';
import { HwipError } from './errors.js';
import { withNotifyFailureRecord } from './notify-failure.js';
import { checkBaseUrl, configWriteProblem, fileKeyBaseRefusal, keyIsFromFile, loadConfig, resolvedEnv, saveConfig, CONFIG_FILE, VERSION } from './config.js';
import type { HwipConfig } from './config.js';
import { runLoginFlow, resolveAllowHosts, resolveWebUrl, resolveTimeoutSec } from './login.js';
import { detectAgents, resolveCommand } from './agents.js';
import { ensureTmux, planTmuxInstall } from './tmux-install.js';
import {
  GEMINI_MCP_ADD, GEMINI_MCP_ADD_BARE, GEMINI_MCP_ADD_LEGACY, MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY,
} from './mcp-command.js';
import { upsertHwipMcpTable } from './codex-config.js';
import { FileChangedError, NotUtf8Error, readTextIfExists, replaceFile } from './replace-file.js';
import { JsoncDoc, JsoncEditError, JsoncSyntaxError } from './jsonc-doc.js';
import { installService, serviceSupported } from './listener-service.js';
import type { Agent } from './agents.js';
import { maskKey } from './redact.js';
import {
  CURSOR_HOOKS, CURSOR_RULE,
  WINDSURF_HOOKS, WINDSURF_RULE,
  GEMINI_HOOKS, GEMINI_RULE,
  CODEX_HOOKS, CODEX_RULE,
  COPILOT_HOOKS, COPILOT_RULE,
  CLINE_RULE,
  AIDER_RULE,
  PI_RULE, PI_EXTENSION,
  OPENCODE_RULE, OPENCODE_PLUGIN,
  isHwipHookGroup,
  upsertManagedBlock,
} from './templates.js';
import { flagOn } from './args.js';

const HOME = homedir();

// Settings files hwip merges into — named once, so a failure names the same file.
const CURSOR_MCP_FILE = join(HOME, '.cursor', 'mcp.json');
const CURSOR_HOOKS_FILE = join(HOME, '.cursor', 'hooks.json');
const WINDSURF_MCP_FILE = join(HOME, '.codeium', 'windsurf', 'mcp_config.json');
const WINDSURF_HOOKS_FILE = join(HOME, '.codeium', 'windsurf', 'hooks.json');
const GEMINI_SETTINGS_FILE = join(HOME, '.gemini', 'settings.json');
const CODEX_HOOKS_FILE = join(HOME, '.codex', 'hooks.json');
const OPENCODE_CONFIG_FILE = join(HOME, '.config', 'opencode', 'opencode.json');

// ── Types ────────────────────────────────────────────────────────

interface InstallArgs {
  key?: string;
  hook?: string;
  'base-url'?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

// Steps that did not go through — the closing line counts them instead of
// saying "Done!" over a step that left a file alone.
let failedSteps = 0;

const ok = (msg: string) => console.log(`    + ${msg}`);
const fail = (msg: string) => {
  failedSteps += 1;
  console.log(`    - ${msg}`);
};
const skipNote = (msg: string) => console.log(`    · ${msg}`);

/**
 * True when install should auto-open browser login (ADR 0002): interactive
 * context with no existing credential (--key/env/config all absent).
 */
/**
 * Interactive install, past the `--key` path: open a browser login only when
 * there's nothing saved yet, or the user explicitly asked to re-authenticate
 * with `--relogin`. A plain re-run keeps the saved login untouched.
 */
export const shouldReauth = (currentKey: string | undefined, relogin: boolean): boolean =>
  !currentKey || relogin;

const promptInput = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const writeFile = (filePath: string, content: string): void => replaceFile(filePath, content + '\n');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * An agent's JSON settings, opened for a merge. A missing or empty file is a new
 * one. Comments and trailing commas (JSONC) are read, and kept by the edits that
 * follow. Anything that is not a JSON object throws instead of reading as `{}`:
 * the merge would then write back hwip's entries alone and erase the user's
 * settings — and a file with a syntax error is not edited around either.
 */
const openSettings = (filePath: string): JsoncDoc => {
  let text: string | null;
  try {
    text = readTextIfExists(filePath);
  } catch (err) {
    if (err instanceof NotUtf8Error) throw err;
    throw new Error(`cannot read ${filePath} (${reasonOf(err)}), left it unchanged`, { cause: err });
  }
  if (text === null) return new JsoncDoc('', false);
  try {
    return new JsoncDoc(text);
  } catch (err) {
    // Not the parser's message: it could quote the text around the error, which
    // would echo part of the user's settings into the terminal.
    const why = err instanceof JsoncSyntaxError
      ? 'is not valid JSON (comments and trailing commas are fine, anything else is not)'
      : 'does not hold a JSON object';
    throw new Error(`${filePath} ${why}, left it unchanged`, { cause: err });
  }
};

/**
 * A merge step that left the user's file alone: why, then the JSON to add by
 * hand. Exported for tests — it is the user's only way forward.
 */
export const mergeFailureLines = (
  label: string,
  filePath: string,
  err: unknown,
  snippet: Record<string, unknown>,
): string[] => err instanceof FileChangedError
  // The file is whole and so is the entry: someone else wrote it meanwhile, and running the command again is the way forward.
  ? [`${label} failed: ${reasonOf(err)}`]
  : [
    // The path goes in the instruction: a write error (ENOSPC) names no file.
    `${label} failed: ${reasonOf(err)}. Add this to ${filePath} by hand:`,
    ...JSON.stringify(snippet, null, 2).split('\n'),
  ];

/** Exported for tests, with `failedStepCount`. */
export const failMerge = (label: string, filePath: string, err: unknown, snippet: Record<string, unknown>): void => {
  const [reason, ...json] = mergeFailureLines(label, filePath, err, snippet);
  fail(reason);
  for (const line of json) console.log(`        ${line}`);
};

export const failedStepCount = (): number => failedSteps;

/** The detection list. An agent that is not installed is information, not a
 *  failed step — it never counts toward the closing line. Exported for tests. */
export const reportDetectedAgents = (agents: Agent[]): void => {
  for (const agent of agents) {
    if (agent.detected) ok(agent.name);
    else skipNote(`${agent.name} (not found)`);
  }
};

/** The install's last line. Exported for tests. */
export const closingLine = (failed: number): string => {
  if (failed === 0) return 'Done! Restart your agents.';
  const steps = failed === 1 ? '1 step needs' : `${failed} steps need`;
  return `Done, but ${steps} you: see the lines marked "-" above. Then restart your agents.`;
};

/** An edit that would lose a comment of the user's names the file, like every other refusal. */
const namingFile = <T>(filePath: string, edit: () => T): T => {
  try {
    return edit();
  } catch (err) {
    if (err instanceof JsoncEditError) throw new Error(`${filePath} ${err.message}, left it unchanged`, { cause: err });
    throw err;
  }
};

/** Exported for tests (installGemini shells out to the real `gemini` binary,
 *  so the merge semantics can't be covered through it deterministically). */
export const mergeJsonFile = (filePath: string, patch: Record<string, unknown>): void =>
  namingFile(filePath, () => mergeIntoSettings(filePath, patch));

const mergeIntoSettings = (filePath: string, patch: Record<string, unknown>): void => {
  const doc = openSettings(filePath);
  const data = doc.data;
  // `hooks` maps event names to arrays of matcher groups (Gemini, Codex) or
  // flat handlers (Cursor, Windsurf), and the user may own entries at BOTH
  // levels (their own events, and their own entries inside an event hwip
  // also uses) — so instead of clobbering the whole object, edit events and,
  // inside each event hwip writes, take out only hwip's own groups and add the
  // new ones (re-runs stay idempotent). Every other byte of the file stays.
  const hooksPatch = isPlainObject(patch.hooks) ? patch.hooks : undefined;
  if (hooksPatch) {
    // A `hooks` hwip cannot merge into would be replaced by hwip's alone.
    if (data.hooks !== undefined && !isPlainObject(data.hooks)) {
      throw new Error(`${filePath} has a "hooks" value that is not an object, left it unchanged`);
    }
    for (const event of Object.keys(hooksPatch)) {
      const prev = (data.hooks as Record<string, unknown> | undefined)?.[event];
      if (prev !== undefined && !Array.isArray(prev)) {
        throw new Error(`${filePath} has a "hooks.${event}" value that is not a list, left it unchanged`);
      }
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'hooks' || !hooksPatch) doc.set([key], value);
  }
  if (hooksPatch) {
    for (const [event, patchGroups] of Object.entries(hooksPatch)) {
      const prev = (data.hooks as Record<string, unknown> | undefined)?.[event];
      const add = Array.isArray(patchGroups) ? patchGroups : [];
      if (!Array.isArray(prev)) {
        doc.set(['hooks', event], add);
        continue;
      }
      // hwip's own groups are replaced where they stand, so a re-run changes
      // nothing and the user's neighbouring entries and comments are not moved.
      const ours = prev.flatMap((group, i) => (isHwipHookGroup(group) ? [i] : []));
      add.forEach((group, n) => {
        if (n < ours.length && !isDeepStrictEqual(prev[ours[n]], group)) doc.set(['hooks', event, ours[n]], group);
      });
      for (const i of ours.slice(add.length).reverse()) doc.remove(['hooks', event, i]);
      for (const group of add.slice(ours.length)) doc.append(['hooks', event], group);
    }
  }
  replaceFile(filePath, doc.text(), doc.expected);
};

/**
 * Write a Hwip rule into a SHARED agent rule file (Windsurf global_rules.md,
 * Gemini GEMINI.md, Codex AGENTS.md) without clobbering the user's own
 * content. The rule lands inside <!-- HWIP:START/END --> markers; a re-run
 * replaces just that block.
 */
/** Exported for tests. */
export const writeManagedRule = (filePath: string, rule: string): void => {
  // Missing is a new file; anything else that stops the read (no permission, not text) stops the write too.
  const existing = readTextIfExists(filePath);
  replaceFile(filePath, upsertManagedBlock(existing ?? '', rule), existing);
};

/**
 * Add a `read:` entry to ~/.aider.conf.yml so Aider always loads the Hwip
 * conventions file. Idempotent — skips if the path is already referenced.
 * Aider's config is YAML; we do a minimal text-level append to avoid
 * pulling in a YAML dependency (the SDK is zero-dep by design).
 */
/** Exported for tests. */
export const addAiderReadDirective = (confPath: string, conventionsPath: string): void => {
  const existing = readTextIfExists(confPath);
  const conf = existing ?? '';
  if (conf.includes(conventionsPath)) return; // already wired up
  const marker = '# Added by Hwip';
  const line = `${marker}\nread: ${conventionsPath}\n`;
  const base = conf.replace(/\n*$/, '');
  replaceFile(confPath, (base ? `${base}\n\n` : '') + line, existing);
};

// ── Per-Agent Installers ─────────────────────────────────────────

/** Add the hwip entry under `key` in an MCP registry JSON file, preserving
 *  everything else in it. Exported for tests (merge semantics). */
export const injectMcpEntry = (filePath: string, key: string, entry: Record<string, unknown>): void =>
  namingFile(filePath, () => {
    const doc = openSettings(filePath);
    if (!isPlainObject(doc.data[key])) doc.set([key], {});
    doc.set([key, 'hwip'], entry);
    replaceFile(filePath, doc.text(), doc.expected);
  });

/** `[mcp_servers.hwip]` in codex's own TOML config — the one registry that is
 *  not JSON. Exported for tests, like `injectMcpEntry`. */
export const injectCodexMcpEntry = (filePath: string): void => {
  const existing = readTextIfExists(filePath);
  replaceFile(filePath, upsertHwipMcpTable(existing ?? '').trimEnd() + '\n', existing);
};

/** The first non-empty line a failed child process wrote to stderr, cut to one terminal line; undefined when it wrote none. */
export const firstStderrLine = (err: unknown): string | undefined => {
  const raw = (err as { stderr?: Buffer | string } | null)?.stderr;
  const line = raw?.toString().split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  // eslint-disable-next-line no-control-regex -- strips colour codes a child printed to its stderr
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
};

const installClaude = (): void => {
  try {
    execSync('claude plugin marketplace add hwipit/plugin', { stdio: 'pipe' });
    execSync('claude plugin install hwip@hwip', { stdio: 'pipe' });
    ok('Plugin installed');
  } catch (err) {
    const why = firstStderrLine(err);
    fail(`Plugin install failed${why ? ` (${why})` : ''}. Manual:`);
    console.log('      claude plugin marketplace add hwipit/plugin');
    console.log('      claude plugin install hwip@hwip');
  }
};

const installCursor = (): void => {
  try {
    injectMcpEntry(CURSOR_MCP_FILE, 'mcpServers', MCP_SERVERS_ENTRY);
    ok('MCP server added');
  } catch (err) {
    failMerge('MCP injection', CURSOR_MCP_FILE, err, { mcpServers: { hwip: MCP_SERVERS_ENTRY } });
  }
  try {
    mergeJsonFile(CURSOR_HOOKS_FILE, CURSOR_HOOKS);
    ok('Stop hook added');
  } catch (err) {
    failMerge('Hook install', CURSOR_HOOKS_FILE, err, CURSOR_HOOKS);
  }
  try {
    writeFile(join(HOME, '.cursor', 'rules', 'hwip.mdc'), CURSOR_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed');
  }
};

const installWindsurf = (): void => {
  try {
    injectMcpEntry(WINDSURF_MCP_FILE, 'mcpServers', MCP_SERVERS_ENTRY);
    ok('MCP server added');
  } catch (err) {
    failMerge('MCP injection', WINDSURF_MCP_FILE, err, { mcpServers: { hwip: MCP_SERVERS_ENTRY } });
  }
  try {
    mergeJsonFile(WINDSURF_HOOKS_FILE, WINDSURF_HOOKS);
    ok('Response hook added');
  } catch (err) {
    failMerge('Hook install', WINDSURF_HOOKS_FILE, err, WINDSURF_HOOKS);
  }
  try {
    // Windsurf reads ~/.codeium/windsurf/memories/global_rules.md as always-on
    // global rules. Managed-block append preserves the user's own rules.
    writeManagedRule(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'), WINDSURF_RULE);
    ok('Rules added to global_rules.md');
  } catch (err) {
    fail(`Rule install failed: ${reasonOf(err)}. Manual: add hwip rules to ~/.codeium/windsurf/memories/global_rules.md`);
  }
};

const installGemini = (): void => {
  try {
    // Both forms are built in mcp-command.ts; older gemini CLIs only accept
    // the legacy one, so try the modern form first and fall back.
    execSync(GEMINI_MCP_ADD, { stdio: 'pipe' });
    ok('MCP server added');
  } catch {
    try {
      execSync(GEMINI_MCP_ADD_LEGACY, { stdio: 'pipe' });
      ok('MCP server added (legacy gemini CLI)');
    } catch {
      try {
        execSync(GEMINI_MCP_ADD_BARE, { stdio: 'pipe' });
        ok('MCP server added (legacy gemini CLI, without auto session names)');
      } catch {
        fail(`MCP add failed. Manual: ${GEMINI_MCP_ADD}`);
      }
    }
  }
  try {
    mergeJsonFile(GEMINI_SETTINGS_FILE, GEMINI_HOOKS);
    ok('BeforeAgent + AfterAgent hooks added');
  } catch (err) {
    failMerge('Hook install', GEMINI_SETTINGS_FILE, err, GEMINI_HOOKS);
  }
  try {
    // Gemini CLI loads ~/.gemini/GEMINI.md as global context every prompt.
    writeManagedRule(join(HOME, '.gemini', 'GEMINI.md'), GEMINI_RULE);
    ok('Rules added to GEMINI.md');
  } catch (err) {
    fail(`Rule install failed: ${reasonOf(err)}. Manual: add hwip rules to ~/.gemini/GEMINI.md`);
  }
};

const installCodex = (): void => {
  try {
    mergeJsonFile(CODEX_HOOKS_FILE, CODEX_HOOKS);
    ok('UserPromptSubmit + Stop hooks added');
  } catch (err) {
    failMerge('Hook install', CODEX_HOOKS_FILE, err, CODEX_HOOKS);
  }
  try {
    // Codex CLI loads ~/.codex/AGENTS.md as global instructions.
    writeManagedRule(join(HOME, '.codex', 'AGENTS.md'), CODEX_RULE);
    ok('Rules added to AGENTS.md');
  } catch (err) {
    fail(`Rule install failed: ${reasonOf(err)}. Manual: add hwip rules to ~/.codex/AGENTS.md`);
  }
  try {
    // The rules above tell codex to call hwip_ask, so it needs the server that
    // provides it: codex has no bundled route to hwip the way pi's extension
    // does. Written straight into the user's config.toml rather than shelled
    // out to `codex mcp add`, which older codex builds do not have.
    injectCodexMcpEntry(join(HOME, '.codex', 'config.toml'));
    ok('MCP server registered in config.toml');
  } catch (err) {
    fail(`MCP install failed: ${reasonOf(err)}. Manual: codex mcp add hwip -- hwip mcp`);
  }
};

const installCopilot = (): void => {
  try {
    writeFile(join(HOME, '.copilot', 'hooks', 'hwip.json'), COPILOT_HOOKS);
    ok('Session end hook added');
  } catch {
    fail('Hook install failed. Manual: add hwip to ~/.copilot/hooks/');
  }
  try {
    // Copilot CLI loads ~/.copilot/instructions/*.instructions.md globally.
    // A dedicated file means no merge needed — overwrite is safe.
    writeFile(join(HOME, '.copilot', 'instructions', 'hwip.instructions.md'), COPILOT_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed. Manual: add hwip rules to ~/.copilot/instructions/');
  }
};

const installCline = (): void => {
  try {
    writeFile(join(HOME, '.cline', 'rules', 'hwip.md'), CLINE_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed. Manual: add hwip to ~/.cline/rules/');
  }
};

const installAider = (): void => {
  // Aider has no hooks; rules reach it via a conventions file loaded by the
  // `read:` directive in ~/.aider.conf.yml. We keep the conventions file in
  // ~/.hwip/ (our own dir — no conflict) and just wire the read directive.
  const conventionsPath = join(HOME, '.hwip', 'aider-conventions.md');
  try {
    writeFile(conventionsPath, AIDER_RULE);
    ok('Conventions file added');
  } catch {
    fail('Conventions install failed. Manual: save hwip rules somewhere readable');
    return;
  }
  try {
    addAiderReadDirective(join(HOME, '.aider.conf.yml'), conventionsPath);
    ok('read: directive added to ~/.aider.conf.yml');
  } catch (err) {
    fail(`Config wiring failed: ${reasonOf(err)}. Manual: add "read: ${conventionsPath}" to ~/.aider.conf.yml`);
  }
};

const installPi = (): void => {
  try {
    // Drop-in auto-load; full-file overwrite is the idempotency model
    // (the header comment is the ownership marker). No MCP — pi has none;
    // PI_RULE maps the hwip_* tools to the CLI instead.
    writeFile(join(HOME, '.pi', 'agent', 'extensions', 'hwip.ts'), PI_EXTENSION);
    ok('Extension added (settle notify + remote detection)');
  } catch {
    fail('Extension install failed. Manual: save the hwip extension to ~/.pi/agent/extensions/hwip.ts');
  }
  try {
    // Pi loads ~/.pi/agent/AGENTS.md as global context.
    writeManagedRule(join(HOME, '.pi', 'agent', 'AGENTS.md'), PI_RULE);
    ok('Rules added to AGENTS.md');
  } catch (err) {
    fail(`Rule install failed: ${reasonOf(err)}. Manual: add hwip rules to ~/.pi/agent/AGENTS.md`);
  }
};

const installOpencode = (): void => {
  try {
    injectMcpEntry(OPENCODE_CONFIG_FILE, 'mcp', OPENCODE_MCP_ENTRY);
    ok('MCP server added');
  } catch (err) {
    failMerge('MCP injection', OPENCODE_CONFIG_FILE, err, { mcp: { hwip: OPENCODE_MCP_ENTRY } });
  }
  try {
    writeFile(join(HOME, '.config', 'opencode', 'plugins', 'hwip.ts'), OPENCODE_PLUGIN);
    ok('Idle-notify plugin added');
    // opencode 2.x runs plugins inside its background server, which loads them
    // at start: one already running keeps going without this file until it
    // reloads (measured on 2.0.24). Not done for the user — a reload touches
    // every session that server is running.
    skipNote('On opencode 2.x, run `opencode reload` so an opencode already running loads it');
  } catch (err) {
    fail(`Plugin install failed: ${reasonOf(err)}. Manual: save the hwip plugin to ~/.config/opencode/plugins/hwip.ts`);
  }
  try {
    writeManagedRule(join(HOME, '.config', 'opencode', 'AGENTS.md'), OPENCODE_RULE);
    ok('Rules added to AGENTS.md');
  } catch (err) {
    fail(`Rule install failed: ${reasonOf(err)}. Manual: add hwip rules to ~/.config/opencode/AGENTS.md`);
  }
};

/** Exported for tests — each runs against the HOME the module was loaded with. */
export const AGENT_INSTALLERS: Record<string, () => void> = {
  claude: installClaude,
  cursor: installCursor,
  windsurf: installWindsurf,
  gemini: installGemini,
  codex: installCodex,
  copilot: installCopilot,
  cline: installCline,
  aider: installAider,
  pi: installPi,
  opencode: installOpencode,
};

// One-line summary of what each agent's installer does — shown in the
// interactive plan before anything is written.
const AGENT_PLAN_LABELS: Record<string, string> = {
  claude: 'Claude Code — install plugin',
  cursor: 'Cursor — MCP + hooks + rules',
  windsurf: 'Windsurf — MCP + hooks + rules',
  gemini: 'Gemini CLI — MCP + hooks + rules',
  codex: 'Codex CLI — MCP + hooks + rules',
  copilot: 'Copilot CLI — hooks + rules',
  cline: 'Cline — rules',
  aider: 'Aider — conventions',
  pi: 'Pi — extension + rules',
  opencode: 'OpenCode — MCP + plugin + rules',
};

// ── Agent selection ──────────────────────────────────────────────

/**
 * Interactive agent picker — an @inquirer/prompts checkbox (arrow keys
 * to move, space to toggle, enter to confirm). Every agent starts
 * checked, so a bare Enter installs for all. Returns the chosen Agent[].
 *
 * Dynamic import keeps @inquirer/prompts (ESM) loadable from this
 * CommonJS build, and means the dependency is only touched on the
 * interactive path — `notify` / `list` / scripted `install --only`
 * never load it.
 */
const pickAgentsInteractive = async (detected: Agent[]): Promise<Agent[]> => {
  const { checkbox } = await import('@inquirer/prompts');
  const picked = await checkbox<string>({
    message: 'Install Hwip for which agents? (space to toggle, enter to confirm)',
    choices: detected.map((agent) => ({
      name: AGENT_PLAN_LABELS[agent.id] ?? agent.name,
      value: agent.id,
      checked: true,
    })),
    loop: false,
  });
  return detected.filter((a) => picked.includes(a.id));
};

/**
 * Resolve agents from a non-interactive `--only cursor,gemini` flag.
 * Matches on agent id (`cc` is accepted for `claude`); ids that are not
 * detected are dropped here, and `unknownOnlyIds` is what flags a typo.
 * Exported for unit testing.
 */
export const filterAgentsByIds = (detected: Agent[], only: string): Agent[] => {
  const ids = new Set(onlyIds(only));
  return detected.filter((a) => ids.has(a.id));
};

/** `hwip cc` is how the landing page names Claude Code, so `--only cc` means `claude`. */
const ONLY_ALIASES: Readonly<Record<string, string>> = { cc: 'claude' };

const onlyIds = (only: string): string[] =>
  only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((id) => ONLY_ALIASES[id] ?? id);

/** The `--only` ids that name no agent hwip knows (detected or not): a typo, not "nothing to install". Exported for tests. */
export const unknownOnlyIds = (all: Agent[], only: string): string[] => {
  const known = new Set(all.map((a) => a.id));
  return onlyIds(only).filter((id) => !known.has(id));
};

// ── Test Connection ──────────────────────────────────────────────

const testConnection = async (apiKey: string, baseUrl?: string): Promise<boolean> => {
  try {
    const hook = new HwipHook({ apiKey, ...(baseUrl && { baseUrl }) });
    // A real push like any other: a good one clears a stale failure record (a
    // re-login after a revoked key), a bad one replaces it.
    const result = await withNotifyFailureRecord(() => hook.notify({
      title: 'Hwip Setup',
      body: `Connected successfully (v${VERSION})`,
    }));
    ok(`Test push sent: ${result.pushId}`);
    return true;
  } catch (err) {
    fail(`Test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return false;
  }
};

/**
 * Why the API refused `apiKey`, or undefined when it did not — a read, not a
 * push, so it can run before the key is saved. Only a 401 is a refusal: a
 * 403 is a quota or a scope, and a network failure says nothing about the key.
 */
const keyRejection = async (apiKey: string, baseUrl?: string): Promise<string | undefined> => {
  try {
    // Short: an offline box still installs, and the test push waits its own timeout after.
    await new HwipHook({ apiKey, timeout: 5000, ...(baseUrl && { baseUrl }) }).list({ limit: 1 });
    return undefined;
  } catch (err) {
    return err instanceof HwipError && err.status === 401 ? err.message : undefined;
  }
};

// ── Credential Resolution ────────────────────────────────────────

interface ResolvedCredentials {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
}

/**
 * Resolve API key + hook for install. Priority: --key/env/config (non-interactive)
 * → a saved login is reused untouched on re-run → otherwise a brand-new
 * interactive install opens browser login (ADR 0002), falling back to manual
 * paste when headless. wsUrl/deviceId from a login are persisted by
 * runLoginFlow and re-read at config-save time.
 */
/** Exported for tests. */
export const collectCredentials = async (
  args: Record<string, string | boolean>,
  installArgs: InstallArgs,
  nonInteractive: boolean,
  existing: HwipConfig,
): Promise<ResolvedCredentials> => {
  if (nonInteractive) {
    // The saved key is checked against, and saved with, the address given here: one from the environment is not where it belongs (C129).
    const envBase = installArgs['base-url'] ? undefined : resolvedEnv('HWIP_BASE_URL');
    const refusal = envBase && keyIsFromFile(installArgs.key, existing) ? fileKeyBaseRefusal(envBase, existing) : null;
    if (refusal) throw new Error(refusal);
    // Saved only after it passes the same checks `resolveBaseUrl` applies: a user name or password
    // in the address would otherwise sit in config.json and stop every later command (C150).
    const rawBase = installArgs['base-url'] || resolvedEnv('HWIP_BASE_URL') || existing.baseUrl;
    const baseUrl = typeof rawBase === 'string'
      ? checkBaseUrl(rawBase, installArgs['base-url'] ? '--base-url' : envBase ? 'HWIP_BASE_URL' : `"baseUrl" in ${CONFIG_FILE}`)
      : rawBase;
    return {
      apiKey: installArgs.key || resolvedEnv('HWIP_API_KEY') || existing.apiKey,
      hookId: installArgs.hook === 'none' ? undefined : (installArgs.hook || resolvedEnv('HWIP_HOOK_ID') || existing.hookId),
      baseUrl,
    };
  }

  console.log('');
  const currentKey = resolvedEnv('HWIP_API_KEY') || existing.apiKey;

  // Re-run with a saved login: reuse it silently and move on to agent wiring.
  // Switching accounts is `hwip login` or `hwip install --relogin`.
  if (!shouldReauth(currentKey, flagOn(args, 'relogin'))) {
    console.log(`  Using saved login (${maskKey(currentKey!)}). Run \`hwip install --relogin\` to switch account.`);
    return {
      apiKey: currentKey,
      hookId: resolvedEnv('HWIP_HOOK_ID') || existing.hookId,
      baseUrl: existing.baseUrl,
    };
  }

  const result = await runLoginFlow({
    webUrl: resolveWebUrl(args['web-url']),
    timeoutSec: resolveTimeoutSec(args.timeout),
    allowHosts: resolveAllowHosts(args['allow-host']),
    pasteNext: true,
  });
  if (result && 'apiKey' in result) {
    return { apiKey: result.apiKey, hookId: result.hookId, baseUrl: result.baseUrl };
  }

  // headless / timeout / skipped → manual paste (a key typed during the wait counts)
  const apiKey = (result?.pastedKey || await promptInput('  API Key (from app > Settings > API Keys): ')) || undefined;
  const hookInput = await promptInput('  Hook ID (optional, for hwip_ask): ');
  return { apiKey, hookId: hookInput || undefined, baseUrl: existing.baseUrl };
};

// ── Login-time service ───────────────────────────────────────────

/**
 * Whether this install should register the service that starts the listener
 * at login (a LaunchAgent on macOS, a systemd user unit on Linux).
 *
 * Interactive installs offer it and default to yes: an empty phone picker
 * after every reboot is precisely the kind of thing a default should fix.
 * Scripted installs (`--key`, CI, provisioning) get it only when asked —
 * planting a background job on a machine whose operator only wanted an API
 * key written is a surprise, not a convenience.
 */
export const serviceInstallChoice = (
  args: Record<string, string | boolean>,
  nonInteractive: boolean,
): 'yes' | 'no' | 'ask' => {
  if (flagOn(args, 'no-service')) return 'no';
  if (!serviceSupported()) return 'no';
  if (flagOn(args, 'service')) return 'yes';
  return nonInteractive ? 'no' : 'ask';
};

/** Run the choice: ask when it should be asked, then install if wanted. */
const applyServiceChoice = async (choice: 'yes' | 'no' | 'ask'): Promise<void> => {
  if (choice === 'no') return;

  let wanted = choice === 'yes';
  if (choice === 'ask') {
    try {
      const { confirm } = await import('@inquirer/prompts');
      wanted = await confirm({
        message: 'Start the listener at every login, so the phone sees this machine after a reboot? (enter to confirm)',
        default: true,
      });
    } catch {
      // Ctrl-C or no TTY — an unanswered question is not a yes.
      wanted = false;
    }
  }
  if (!wanted) {
    skipNote('login-time service not installed (add it later: hwip listener --install-service)');
    return;
  }

  const result = await installService();
  for (const note of result.notes) ok(note);
  if (result.ok) ok('listener starts at every login');
  else fail(`login-time service: ${result.reason}`);
};

// ── Main Install Flow ────────────────────────────────────────────

export const handleInstall = async (args: Record<string, string | boolean>): Promise<number> => {
  const installArgs: InstallArgs = {
    key: args.key as string | undefined,
    hook: args.hook as string | undefined,
    'base-url': args['base-url'] as string | undefined,
  };
  const nonInteractive = !!(installArgs.key || installArgs.hook || installArgs['base-url']);
  failedSteps = 0;

  console.log(`\n  Hwip v${VERSION}\n`);

  // A config.json hwip cannot read as JSON would be replaced by the new key alone: say so before any prompt, login or key check.
  const blocked = configWriteProblem();
  if (blocked) {
    console.error(`  Error: ${blocked}\n`);
    return 1;
  }

  // 1. Detect agents
  console.log('  Detecting agents...');
  const agents = detectAgents();
  const detected = agents.filter((a) => a.detected);

  reportDetectedAgents(agents);

  if (detected.length === 0) {
    console.log('\n  No supported agents found. Config will still be saved.\n');
  }

  // 2. Choose which agents to install for — asked up front so the user
  //    sees the choice before being walked through credential prompts.
  let selected: Agent[] = detected;
  const onlyArg = (args.only as string | undefined)?.trim();
  if (detected.length > 0) {
    if (onlyArg) {
      const unknown = unknownOnlyIds(agents, onlyArg);
      if (unknown.length > 0) {
        console.error(`\n  Error: --only names no agent hwip knows: ${unknown.join(', ')}. Valid ids: ${agents.map((a) => a.id).join(', ')} (cc = claude).\n`);
        return 2;
      }
      // Non-interactive or scripted: --only cursor,gemini
      selected = filterAgentsByIds(detected, onlyArg);
      console.log(`\n  --only ${onlyArg} → ${selected.map((a) => a.name).join(', ') || '(no match)'}`);
    } else if (nonInteractive) {
      // Scripted run with no --only: keep the all-detected default
      selected = detected;
    } else if (process.stdin.isTTY !== true) {
      // The picker needs a terminal; without one it used to print "Cancelled." and exit 0.
      console.error('\n  Error: choosing agents needs a terminal. For a scripted install pass --key (and --only <agents>).\n');
      return 2;
    } else {
      try {
        selected = await pickAgentsInteractive(detected);
      } catch {
        // Ctrl-C in the picker (or no TTY) — treat as a clean cancel.
        console.log('\n  Cancelled.\n');
        return 0;
      }
    }
  }

  // 3. Collect credentials (browser login auto-triggers for brand-new installs)
  const existing = loadConfig();
  let credentials: ResolvedCredentials;
  try {
    credentials = await collectCredentials(args, installArgs, nonInteractive, existing);
  } catch (err) {
    console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { apiKey, hookId, baseUrl } = credentials;

  if (!apiKey) {
    console.error('\n  Error: API key is required.\n');
    return 1;
  }

  // A key the API refuses is not saved: every push after it would fail.
  const rejected = await keyRejection(apiKey, baseUrl);
  if (rejected) {
    console.error(`\n  Error: the API rejected this key (${rejected}). Nothing was saved.`);
    console.error('  Check the key in the Hwip app (Settings > API Keys), or sign in again: hwip install --relogin\n');
    return 3;
  }

  // 4. Show the resolved plan before touching anything (interactive only).
  if (!nonInteractive) {
    console.log('\n  Will do:');
    console.log(`    • Save config to ${CONFIG_FILE}`);
    for (const agent of selected) {
      console.log(`    • ${AGENT_PLAN_LABELS[agent.id] ?? `Install for ${agent.name}`}`);
    }
    if (selected.length === 0) {
      console.log('    (no agents selected — only the config file will be saved)');
    }
    console.log('    • Check tmux (`hwip cc` runs agents inside it)');
    if (serviceInstallChoice(args, nonInteractive) !== 'no') {
      console.log('    • Offer to start the listener at every login');
    }
    console.log('    • Test connection');
  }

  // 5. Save config — merge over the latest on-disk config (re-read, since a
  //    login in step 3 may have written wsUrl/deviceId). hookId set or cleared.
  console.log('');
  const config: HwipConfig = {
    ...loadConfig(),
    apiKey,
    ...(baseUrl && { baseUrl }),
  };
  if (hookId) config.hookId = hookId;
  else delete config.hookId;
  saveConfig(config);
  ok(`Config saved to ${CONFIG_FILE}`);

  // 6. Install for the selected agents only
  for (const agent of selected) {
    console.log(`\n  Installing for ${agent.name}...`);
    const installer = AGENT_INSTALLERS[agent.id];
    if (installer) installer();
  }

  // 7. tmux — `hwip cc` is tmux or nothing, so check before claiming success.
  console.log('\n  Checking tmux...');
  await ensureTmux({
    plan: planTmuxInstall({ resolve: resolveCommand, platform: process.platform }),
    nonInteractive,
    askConfirm: async (message) => {
      try {
        const { confirm } = await import('@inquirer/prompts');
        return await confirm({ message, default: true });
      } catch {
        // Ctrl-C or no TTY — an unanswered question is not a yes.
        return false;
      }
    },
    run: (argv) => { execFileSync(argv[0], argv.slice(1), { stdio: 'inherit' }); },
    // A scripted install (CI, a container that only needs the hooks) does not
    // fail for want of tmux: only `hwip cc` needs it, and the line says so.
    report: { ok, fail: nonInteractive ? skipNote : fail, note: skipNote },
  });

  // 8. Login-time service — the only thing that makes the phone see this
  //    machine after a reboot without a terminal being opened first.
  await applyServiceChoice(serviceInstallChoice(args, nonInteractive));

  // 9. Test connection
  console.log('\n  Testing connection...');
  await testConnection(apiKey, baseUrl);

  console.log(`\n  ${closingLine(failedSteps)}\n`);

  // The single most-reported surprise: pushes are not scoped to `hwip cc`.
  // Hooks fire for every session of every configured agent, so say it here —
  // at the moment the hooks get installed — together with the volume dials.
  console.log('  Notifications now fire for EVERY session of each agent above');
  console.log('  (not only sessions launched with `hwip cc`).');
  console.log('');
  console.log('  In Claude Code the default is QUIET: you get pushed when the agent');
  console.log('  asks you something and when a session finishes, not on every turn.');
  console.log('  Dial it any time:');
  console.log('    /hwip-mode normal      push on every turn that did real work');
  console.log('    /hwip-mode loud        push on every turn');
  console.log('    /hwip-mode mute        full silence, current project');
  console.log('    /hwip-mode             show what is in effect\n');
  // A step marked "-" (the test push included) is not a finished install.
  return failedSteps > 0 ? 1 : 0;
};
