import { execFileSync } from 'child_process';
import { accessSync, readFileSync, chmodSync, constants, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { ensurePrivateDir } from './private-files.js';
import { NotUtf8Error, readTextIfExists, replaceFile } from './replace-file.js';
import { carriesCredentials, DEFAULT_API_BASE, originOf } from './ws-url.js';

export const CONFIG_DIR = join(homedir(), '.hwip');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
/** The listener's subscriber trust store (subscriber-trust.ts), shared with `hwip trust`. */
export const TRUST_FILE = join(CONFIG_DIR, 'trusted-devices.json');

export interface HwipConfig {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
  wsUrl?: string;
  /** `false` stops the listener holding the Mac awake on AC (`caffeinate -s`). README § Listener Options. */
  keepAwake?: boolean;
  /** `false` stops the listener uploading sealed session conversations for the app's history (`turn-recorder.ts`). README § Session history. */
  turnHistory?: boolean;
  /** Proxy settings for a process that does not get the shell's `HTTPS_PROXY` (a launchd service); the environment wins. README § Environment Variables. */
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/**
 * What a boolean option is when `config.json` is there and cannot be used (it does
 * not parse, or is ignored for its mode). The options are opt-outs: read as "not set"
 * they come back ON, and a user who wrote `"turnHistory": false` found sealed
 * conversations uploading. Unreadable means off, for every boolean option HwipConfig has
 * (the compiler holds the keys to the interface, and config-unreadable.test.ts reads it too).
 */
export type BooleanConfigKey = { [K in keyof HwipConfig]-?: NonNullable<HwipConfig[K]> extends boolean ? K : never }[keyof HwipConfig];
export const unreadableConfigDefaults: Record<BooleanConfigKey, false> = { keepAwake: false, turnHistory: false };

export const resolvedEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const val = env[key];
  return val && !val.startsWith('${') ? val : undefined;
};

/**
 * The two-way hook id: `HWIP_HOOK_ID` when it carries a real value, else
 * `hookId` from ~/.hwip/config.json — what `hwip setup` writes. The plugin's
 * gate.sh `hwip_hook_id` and the MCP server resolve it in the same order.
 */
export const resolveHookId = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  resolvedEnv('HWIP_HOOK_ID', env) || loadConfig().hookId;

/** tmux session options the listener reads before falling back to parsing the name (listener `parseSessionName`). */
export const SESSION_PROJECT_OPTION = '@hwip_project';
export const SESSION_LABEL_OPTION = '@hwip_session_label';
/**
 * The herdr pane a session is attached from, as `<herdr env var> → <session
 * option>`. herdr finds agents by a pane's foreground process, which for a
 * wrapped pane is the tmux client, so the plugin's `hwip-herdr.sh` hook and
 * the pi extension (templates `PI_EXTENSION`) report the agent's state
 * themselves, to the pane these options name. They are session options rather
 * than the agent's own env because a `hwip` reattach from another herdr pane
 * (or from outside herdr) must retarget a running agent.
 */
export const HERDR_SESSION_OPTIONS = {
  HERDR_PANE_ID: '@hwip_herdr_pane',
  HERDR_SOCKET_PATH: '@hwip_herdr_socket',
  HERDR_BIN_PATH: '@hwip_herdr_bin',
} as const;
/**
 * The env herdr gives the processes of its panes, and its native agent integrations
 * (`herdr integration install <agent>`) read to find their pane. Under tmux an agent
 * inherits the tmux server's global env, copied from the terminal that started the
 * server: a herdr pane long closed, never the pane attaching now. The wrapper sets
 * them on every session it creates (wrapper `herdrEnvArgs`).
 */
export const HERDR_ENV_VARS = [
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HERDR_SOCKET_PATH',
  'HERDR_BIN_PATH',
  'HERDR_TAB_ID',
  'HERDR_WORKSPACE_ID',
  'HERDR_STARTUP_CWD',
] as const;
/**
 * Agent kinds hwip reports to herdr itself (`HERDR_SESSION_OPTIONS`). herdr's native
 * integration must stay silent for them: a second report on the pane replaces hwip's
 * label, and its release drops both (measured on herdr 0.9.3).
 */
export const HERDR_SELF_REPORTING_KINDS: ReadonlySet<string> = new Set(['claude', 'pi']);
/**
 * Set by `hwip sh` on the session it opens, to that session's own name. The
 * one exception to the listener's shell-pane refusal. Only a process on this
 * machine can set a tmux option, so it says the user opened the shell — but it
 * is not a boundary: the phone can set it through `!` in a Claude Code session,
 * or from a shell that is already marked (README § Defense).
 */
export const SESSION_SHELL_OPTION = '@hwip_shell';

/** `name` as tmux holds it: tmux turns `.`/`:` into `_`, and `;` would end a tmux command (wrapper `tmuxSessionName`). */
export const tmuxName = (name: string): string => name.replace(/[.:;]/g, '_');

/**
 * The repo a directory belongs to: `key` names the main checkout, `linked` says the directory is in a linked worktree,
 * `root` is the main checkout's path — null where there is no main checkout to point at (the layouts `key` falls back on).
 */
export interface Checkout {
  key: string;
  linked: boolean;
  root: string | null;
}

/** `git rev-parse` for `checkoutOf`, swappable in tests. */
const revParse = (dir: string): string => execFileSync(
  'git',
  ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
);

/**
 * Which checkout `dir` is in, from one `git rev-parse`; null outside git.
 *
 * Inside a linked worktree `--show-toplevel` is the worktree itself, so its
 * name is not the repo's. The common dir is `<main checkout>/.git` from every
 * worktree, and differs from the git dir only in a linked one. A common dir not
 * named `.git` (bare-repo layout, submodule, `--separate-git-dir`) has no
 * checkout to be named for, so the toplevel's own name stands and nothing is
 * called linked — those worktrees keep reading as their own projects.
 *
 * Anything but three absolute paths is "outside git": a git too old for
 * `--path-format` echoes it back as an unknown flag and exits 0, which would
 * otherwise shift every answer by one and name the repo `--path-format=absolute`.
 *
 * The timeout is for the listener's sweep worker, which calls this for every
 * new pane cwd: a repo on a hung network mount must cost one sweep a moment,
 * not stop inventory. A timeout reads as "outside git" — nothing is regrouped.
 */
export const checkoutOf = (dir: string, run: (dir: string) => string = revParse): Checkout | null => {
  let lines: string[];
  try {
    lines = run(dir).trim().split('\n');
  } catch {
    return null;
  }
  if (lines.length !== 3 || !lines.every(isAbsolute)) return null;
  const [top, common, gitDir] = lines;
  if (basename(common) !== '.git') return { key: basename(top), linked: false, root: null };
  const root = dirname(common);
  const key = basename(root);
  return key ? { key, linked: common !== gitDir, root } : null;
};

/**
 * The project and label a `hwip-<tail>` session groups under, when its name
 * does not say so — null when it does (the whole tail is the project).
 *
 * The one rule behind both the wrapper's session options and the listener's
 * correction of sessions started without them, so the two never disagree.
 * A tail starting `<repo>-` splits there, unless the rest is the wrapper's
 * `-2`/`-3` family counter. Any session in a linked worktree belongs to its
 * repo, whatever the worktree is called.
 */
export const groupOf = (tail: string, checkout: Checkout | null): { project: string; label: string } | null => {
  if (!checkout) return null;
  const { key, linked } = checkout;
  // The tail is a tmux name, the key a directory name.
  const named = tmuxName(key);
  const rest = tail.startsWith(`${named}-`) ? tail.slice(named.length + 1) : '';
  if (rest && !/^\d+$/.test(rest)) return { project: key, label: rest };
  return linked ? { project: key, label: tail } : null;
};

// Per-agent project-dir env vars, in precedence order. Deliberately NOT part
// of the remote-agent registry: Cursor/Windsurf carry project-dir envs but
// are not remote-controllable via tmux — the two tables have different
// membership.
export const PROJECT_DIR_ENV_VARS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** First set project-dir env (unresolved `${VAR}` placeholders ignored), else cwd. */
export const detectProjectDir = (): string => {
  for (const key of PROJECT_DIR_ENV_VARS) {
    const val = resolvedEnv(key);
    if (val) return val;
  }
  return process.cwd();
};

let warnedAboutBrokenConfig = false;
let warnedAboutConfigFile = false;

/**
 * An absent config is normal — plenty of commands run on `--key` alone, so it
 * stays silent. A config that exists but does not parse is not normal, and used
 * to be indistinguishable from absent: every value silently became undefined,
 * so `hwip` behaved as if the file had never been written. That is precisely
 * how "it isn't reading my config" looks from the outside, with nothing
 * anywhere to say otherwise. Say it, on stderr, and carry on with defaults.
 */
/** What a reader of a refused config.json can still do; a writer (install, login) is not helped by it. */
const ENV_STILL_WORKS = 'HWIP_API_KEY and --key still work';

/**
 * Why this machine should not trust `~/.hwip/config.json` as it stands, or null.
 * The file holds the API key AND says where the key is sent (`baseUrl`, `wsUrl`),
 * so one that another user owns, or that anyone can write, is a way to redirect
 * the key. `refuse`: ignore the file (and never write over it); otherwise only
 * warn and restrict it. Group access to a file the user owns is not refused: a
 * user-private group (umask 002, a dotfiles checkout) makes every file 664, and
 * ignoring those would stop every command. Root may read what a user owns (sudo).
 */
export const configModeProblem = (
  st: { uid: number; mode: number },
  myUid: number,
  file: string = CONFIG_FILE,
): { refuse: boolean; why: string } | null => {
  const mode = (st.mode & 0o777).toString(8);
  const envStillWorks = ENV_STILL_WORKS;
  if (st.uid !== myUid && myUid !== 0) {
    return { refuse: true, why: `${file} belongs to another user (uid ${st.uid}), so it is being ignored (${envStillWorks})` };
  }
  if (st.mode & 0o002) {
    return { refuse: true, why: `${file} can be written by anyone (mode ${mode}), so it is being ignored — run \`chmod 600 ${file}\` (${envStillWorks})` };
  }
  if (st.mode & 0o064) {
    return { refuse: false, why: `${file} can be reached by other users (mode ${mode}) and holds your API key — it was restricted to 0600` };
  }
  return null;
};

/** `configModeProblem` for the file as it is now. A symlinked file (dotfiles) is judged by what it points at. Windows has no owner or mode to read. */
const configFileProblem = (): { refuse: boolean; why: string } | null => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  try {
    return configModeProblem(statSync(CONFIG_FILE), process.getuid());
  } catch {
    return null;
  }
};

/** What `config.json` is right now. `broken`: it is there but cannot be read as a JSON object. */
type ConfigFile =
  | { kind: 'absent' }
  | { kind: 'ok'; text: string; config: HwipConfig }
  | { kind: 'broken'; why: string };

const FIX_OR_MOVE = 'fix it, or move it aside and run the command again';

/**
 * Where a parse error is, as " at line 3 column 3", or nothing when V8 does not say. Never its message:
 * that quotes the text around the error ("Unexpected token 'a', …"apiKey": ak_live_ab"…"), and this file
 * holds the API key. The line and column are worked out from the position here, since the message only
 * has the position on some Node versions.
 */
// Anchored to V8's own ending: its quoted snippet of the file comes before it and could hold "position 9" too.
const jsonErrorPlace = (err: unknown, text: string): string => {
  const position = err instanceof Error ? / in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(err.message)?.[1] : undefined;
  if (position === undefined) return '';
  const before = text.slice(0, Number(position));
  const line = before.split('\n').length;
  const column = Number(position) - (before.lastIndexOf('\n') + 1) + 1;
  return ` at line ${line} column ${column}`;
};

const inspectConfigFile = (): ConfigFile => {
  let text: string | null;
  try {
    text = readTextIfExists(CONFIG_FILE);
  } catch (err) {
    if (err instanceof NotUtf8Error) return { kind: 'broken', why: `${CONFIG_FILE} is not valid UTF-8 text` };
    // The code, not the message: it is for a person to find the file, and says nothing of what is in it.
    const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? ` (${err.code})` : '';
    return { kind: 'broken', why: `${CONFIG_FILE} cannot be read${code}` };
  }
  if (text === null) return { kind: 'absent' };
  // Nothing in it to lose, and what a crash in the old plain write left behind.
  if (text.trim() === '') return { kind: 'ok', text, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (text.charCodeAt(0) === 0xfeff) return { kind: 'broken', why: `${CONFIG_FILE} starts with a byte order mark (save it as UTF-8 without BOM)` };
    return { kind: 'broken', why: `${CONFIG_FILE} is not valid JSON${jsonErrorPlace(err, text)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'broken', why: `${CONFIG_FILE} is not a JSON object` };
  }
  return { kind: 'ok', text, config: parsed as HwipConfig };
};

export const loadConfig = (): HwipConfig => {
  // Absent is normal and silent. One that exists but cannot be read is not, and
  // used to be indistinguishable from absent — "it isn't reading my config",
  // with nothing to say otherwise: say it, on stderr, and carry on with defaults.
  // Nothing writes over it meanwhile (`saveConfig`).
  const file = inspectConfigFile();
  if (file.kind === 'absent') return {};
  const problem = configFileProblem();
  if (problem) {
    if (!warnedAboutConfigFile) {
      warnedAboutConfigFile = true;
      console.error(`hwip: ${problem.why}.`);
    }
    if (problem.refuse) return { ...unreadableConfigDefaults };
    try {
      chmodSync(CONFIG_FILE, 0o600);
    } catch { /* not ours to change — the warning stands */ }
  }
  if (file.kind === 'broken') {
    // Once per process: a single command can call loadConfig several times
    // (handleVerify and resolveHookId both do), and repeating the same two
    // lines four times reads like four separate problems.
    if (!warnedAboutBrokenConfig) {
      warnedAboutBrokenConfig = true;
      console.error(`hwip: ${file.why}, so it is being ignored.`);
      console.error('hwip: fix it, or move it aside — hwip will not write over it.');
    }
    return { ...unreadableConfigDefaults };
  }
  return file.config;
};

/** Why `config.json` is being ignored right now (it does not parse, or its mode refuses it), or null. For a log line or `hwip verify`. */
export const configIgnoredBecause = (): string | null => {
  const problem = configFileProblem();
  if (problem?.refuse) return problem.why.replace(` (${ENV_STILL_WORKS})`, '');
  const file = inspectConfigFile();
  return file.kind === 'broken' ? file.why : null;
};

/** The key about to be used is the config file's: none came by flag (`flagKey`) or `HWIP_API_KEY`. */
export const keyIsFromFile = (flagKey: string | boolean | undefined, config: HwipConfig): boolean =>
  !(typeof flagKey === 'string' && flagKey) && !resolvedEnv('HWIP_API_KEY') && Boolean(config.apiKey);

/**
 * Why the config file's key must not go to `envBase`, an address from `HWIP_BASE_URL`, or null. The key belongs to
 * the file's `baseUrl`, else the default API; only the same origin may carry it (C129).
 */
export const fileKeyBaseRefusal = (envBase: string, config: HwipConfig): string | null => {
  // `"baseUrl": true` is no URL: where the key belongs is unknown, so it is not sent anywhere.
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    return `${CONFIG_FILE} has a "baseUrl" that is not text, so where the key goes is unknown — fix it, or pass --base-url`;
  }
  const home = config.baseUrl || DEFAULT_API_BASE;
  const target = originOf(envBase);
  // An address with no origin (not a URL, `data:`) is not the same as anything, another such one included.
  if (target !== null && target === originOf(home)) return null;
  return `HWIP_BASE_URL points at ${target ?? 'something that is not a URL'}, but the API key in ${CONFIG_FILE} belongs to ` +
    `${originOf(home) ?? 'an address it cannot read'}, so it is not sent there — set HWIP_API_KEY as well, pass --base-url, or unset HWIP_BASE_URL`;
};

/**
 * `url`, unless it has a user name or password in it: `fetch` refuses such an address on every call, and quotes
 * it whole when it does (C152). Said here once, by where the address came from (`from`) and never by value.
 */
const withoutCredentials = (url: string, from: string): string => {
  if (carriesCredentials(url)) throw new Error(`${from} has a user name or password in it, and no request can be made to such an address — take it out`);
  return url;
};

/**
 * `url` as a base URL from `from`, before it is saved or sent anywhere: the same checks
 * `resolveBaseUrl` applies (no user name or password in it, and an address at all).
 */
export const checkBaseUrl = (url: string, from: string): string => {
  try {
    void new URL(url);
  } catch {
    throw new Error(`${from} is not a valid address — fix it, or pass --base-url (or set HWIP_BASE_URL)`);
  }
  return withoutCredentials(url, from);
};

/**
 * Where the key goes: the flag, `HWIP_BASE_URL`, the file, else the default API. A file that
 * cannot be read may hold a base URL the key belongs to (staging, self-hosted); falling to the
 * default would send the key to another server, so that stops here instead. A file ignored for
 * its mode is not trusted for a base URL on purpose, and the default stands.
 *
 * `keyFromFile` (see `keyIsFromFile`): the config file's key belongs to the addresses the file says (its
 * `baseUrl`, else the default API), so an address from `HWIP_BASE_URL` on another origin stops here instead of
 * receiving it (C129). A flag is the user's own word on this command and is followed; so is the environment's
 * address when the key came by flag or `HWIP_API_KEY` too.
 */
export const resolveBaseUrl = (flagValue: string | boolean | undefined, config: HwipConfig, keyFromFile = false): string => {
  // A bare flag parses as `true`, which is no URL.
  const fromFlag = typeof flagValue === 'string' ? flagValue : '';
  const fromEnv = fromFlag ? undefined : resolvedEnv('HWIP_BASE_URL');
  if (fromEnv && keyFromFile) {
    const refusal = fileKeyBaseRefusal(fromEnv, config);
    if (refusal) throw new Error(refusal);
  }
  if (fromFlag) return withoutCredentials(fromFlag, '--base-url');
  if (fromEnv) return withoutCredentials(fromEnv, 'HWIP_BASE_URL');
  // `"baseUrl": true` is no URL either, and `.replace` on it would crash the caller.
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    throw new Error(`${CONFIG_FILE} has a "baseUrl" that is not text, so where the key goes is unknown — fix it, or pass --base-url (or set HWIP_BASE_URL)`);
  }
  if (config.baseUrl) return withoutCredentials(config.baseUrl, `"baseUrl" in ${CONFIG_FILE}`);
  const file = inspectConfigFile();
  if (file.kind === 'broken' && !configFileProblem()?.refuse) {
    throw new Error(`${file.why}, so the API base URL it may hold is unknown — fix it, or move it aside, or pass --base-url (or set HWIP_BASE_URL)`);
  }
  return DEFAULT_API_BASE;
};

/**
 * Why `config.json` must not be written over as it stands, or null. A file that
 * is ignored, or that cannot be read as a JSON object, holds values a rewrite
 * built from `{}` would drop (baseUrl, wsUrl, hookId, keepAwake, turnHistory).
 */
const writeBlock = (file: ConfigFile): string | null => {
  const problem = configFileProblem();
  if (problem?.refuse) return `not saving: ${problem.why.replace(` (${ENV_STILL_WORKS})`, '')}`;
  // `replaceFile` refuses too, but only once a login or install has already started: say it first.
  if (file.kind === 'ok') {
    try {
      accessSync(CONFIG_FILE, constants.W_OK);
    } catch {
      return `not saving: ${CONFIG_FILE} is read-only, so it is left as it is — chmod u+w it to let hwip save`;
    }
  }
  return file.kind === 'broken' ? `not saving: ${file.why}, so it is not being overwritten — ${FIX_OR_MOVE}` : null;
};

/** `writeBlock` for the file as it is now. `install` and `login` ask first, so nothing is signed in to or verified for a save that cannot happen. */
export const configWriteProblem = (): string | null => writeBlock(inspectConfigFile());

export const saveConfig = (config: HwipConfig): void => {
  const file = inspectConfigFile();
  const blocked = writeBlock(file);
  if (blocked) throw new Error(blocked);
  ensurePrivateDir(CONFIG_DIR);
  // The file is replaced, not edited: `expected` turns a change by another process since the read above into an error, not a lost update.
  replaceFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', file.kind === 'ok' ? file.text : null, 0o600);
};

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();
