// ── Arg Parser ──────────────────────────────────────────────────

import { parseAllowHosts } from './login-address.js';

/**
 * A word that starts a flag: `--name` or `--name=value`. A dash run like
 * `--- done` is a value, so `--title "--- done"` keeps its title.
 */
const isFlagWord = (word: string): boolean => /^--[^-=]/.test(word);

/**
 * What each flag the CLI knows does with the word after it. A `value` flag takes
 * that word whatever it looks like: the value can be text nobody typed (a command
 * to approve, the model's last message), and one that starts with `--base-url=…`
 * must not be read as the CLI's own flag. A `boolean` takes a following word only
 * as the old parser did (a word that does not look like a flag); `optional` is a
 * flag whose value may be left out (`trust --reset [device]`). A flag missing here
 * is read the old way, and the test over COMMAND_FLAGS keeps a new one from
 * missing.
 */
export const FLAG_KINDS: Readonly<Record<string, 'value' | 'boolean' | 'optional'>> = {
  key: 'value', 'api-key': 'value', 'base-url': 'value', 'ws-url': 'value', 'web-url': 'value',
  'allow-host': 'value',
  title: 'value', body: 'value', url: 'value', type: 'value', priority: 'value', device: 'value', session: 'value',
  marker: 'value', tools: 'value', nonreadonly: 'value', 'pushmode-default': 'value', actions: 'value',
  timeout: 'value', hook: 'value', only: 'value', limit: 'value', channel: 'value', turns: 'value',
  at: 'value', days: 'value', every: 'value', prompt: 'value', label: 'value', wt: 'value', 'max-runtime': 'value',
  json: 'boolean', version: 'boolean', help: 'boolean', relogin: 'boolean', service: 'boolean', 'no-service': 'boolean',
  'dry-run': 'boolean', purge: 'boolean', yes: 'boolean', ping: 'boolean', auto: 'boolean', clear: 'boolean',
  all: 'boolean', ended: 'boolean', stop: 'boolean', restart: 'boolean', 'no-keep-awake': 'boolean',
  'no-turn-history': 'boolean', 'install-service': 'boolean', 'uninstall-service': 'boolean',
  'service-status': 'boolean', 'accepts-exit': 'boolean', global: 'boolean',
  reset: 'optional',
};

/** A yes/no flag was given a value that is neither (`--dry-run=maybe`). */
export class FlagValueError extends Error {
  constructor(readonly flag: string, readonly value: string) {
    super(`--${flag} takes true or false (or nothing, which is true), not "${value}"`);
    this.name = 'FlagValueError';
  }
}

const ON_WORDS = new Set(['true', '1', 'yes']);
const OFF_WORDS = new Set(['false', '0', 'no']);

/**
 * Is the yes/no flag `name` on? The one reading every consumer of such a flag shares: not given is
 * off; given bare (`--dry-run`), `=true`, `=1`, `=yes` is on; `=false`, `=0`, `=no` is off; any
 * other value stops with `FlagValueError`, because a flag read as "not given" is how
 * `--dry-run=true` removed what it was asked to preview and `--no-turn-history=1` left the
 * upload on. The boolean parser also takes the word after a flag as its value (`--dry-run yes`),
 * and that word goes through the same reading. Words are matched without case.
 * `lenient` reads a value that is neither as off instead of stopping, for the few places
 * that must answer whatever the flags hold (the usage gate, an error report).
 */
export const flagOn = (args: Record<string, string | boolean>, name: string, lenient = false): boolean => {
  const value = args[name];
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  const word = value.trim().toLowerCase();
  if (ON_WORDS.has(word)) return true;
  if (OFF_WORDS.has(word)) return false;
  if (lenient) return false;
  throw new FlagValueError(name, value);
};

/** The yes/no flags, from `FLAG_KINDS`. `trust --yes <device>` reads its own value and is not among those checked. */
const YES_NO_FLAGS = Object.keys(FLAG_KINDS).filter((key) => FLAG_KINDS[key] === 'boolean');

/** The flags and positional words of argv, and where in argv each positional word stands. */
const scanArgs = (argv: string[]): { result: Record<string, string | boolean>; positional: string[]; positionalAt: number[] } => {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const positionalAt: number[] = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    // `-h` is `--help` before anything reads the words, so it is never a
    // positional and never a flag's value.
    const arg = args[i] === '-h' ? '--help' : args[i];
    // `--` ends the flags: every word after it is a positional, as typed.
    if (arg === '--') {
      for (let j = i + 1; j < args.length; j++) {
        positional.push(args[j]);
        positionalAt.push(j + 2);
      }
      break;
    }
    if (!isFlagWord(arg)) {
      positional.push(arg);
      positionalAt.push(i + 2);
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq > 0) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];

    // `--help` never takes a value: `notify --help foo` and
    // `uninstall --dry-run -h` both ask for help instead of running.
    // A `value` flag takes a flag-looking word too; `-h`, `--help` and `--` stay what they are.
    const takesAnyWord = Object.hasOwn(FLAG_KINDS, key) && FLAG_KINDS[key] === 'value' && next !== '--help';
    if (key === 'help' || !next || next === '-h' || next === '--' || (isFlagWord(next) && !takesAnyWord)) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }

  result._command = positional[0] ?? '';
  result._arg1 = positional[1] ?? '';
  result._arg2 = positional[2] ?? '';

  return { result, positional, positionalAt };
};

export const parseArgs = (argv: string[]): Record<string, string | boolean> => scanArgs(argv).result;

/**
 * The CLI's flags, and for `send` and `agent send` the words after it. They take everything
 * after it as the target and the message, verbatim: its flags come from the
 * part before it only, so a `--base-url` word in a message never redirects the
 * API key and a `--version` never swallows the send. The one exception is a
 * help flag where the target goes. The `send` is the positional word the flag
 * parser itself reads as the command (`send`) or as the one right after `agent`
 * — never a word that merely looks like it: a flag value can be spelled
 * `send`, and a message can hold `agent send`.
 */
export const parseCliArgv = (argv: string[]): { args: Record<string, string | boolean>; sendArgv: string[] } => {
  const { result: whole, positional, positionalAt } = scanArgs(argv);
  const at = positional[0] === 'send' ? positionalAt[0] : positional[0] === 'agent' && positional[1] === 'send' ? positionalAt[1] : -1;
  if (at < 0) return { args: whole, sendArgv: [] };
  const args = parseArgs(argv.slice(0, at + 1));
  const sendArgv = argv.slice(at + 1);
  // Where the target goes, a help flag can't be a target: `send --help` is a
  // help request, not a message to a device named "--help".
  if (sendArgv[0] === '-h' || sendArgv[0] === '--help') args.help = true;
  return { args, sendArgv };
};

const isHelpWord = (word: string): boolean => word === '-h' || word === '--help';

/**
 * Print usage instead of running anything. A help flag used to run the
 * command itself, so `notify --help` sent a push and `uninstall --help`
 * uninstalled. An agent subcommand (`hwip cc`) passes the flags after it to
 * the agent untouched, so `hwip cc --help` is the agent's help — but a help
 * flag before it is hwip's own.
 */
export const asksForUsage = (
  argv: string[],
  args: Record<string, string | boolean>,
  isAgentCommand: boolean,
): boolean => {
  const command = args._command;
  if (!command || command === 'help') return true;
  if (!flagOn(args, 'help', true)) return false;
  if (!isAgentCommand) return true;
  const at = argv.indexOf(String(command), 2);
  return argv.slice(2, at).some(isHelpWord);
};

/** Flags every command accepts: `createHook` and the usage gate read them. */
export const GLOBAL_FLAGS = ['key', 'base-url', 'json', 'version', 'help'];

/**
 * The flags each command reads, besides the global ones. Commands missing here
 * (agent subcommands, `sh`, `mcp`) are not checked: an agent subcommand hands
 * the words after it to the agent, and `send`'s message is never parsed.
 */
export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  install: ['hook', 'only', 'relogin', 'service', 'no-service', 'timeout', 'web-url', 'allow-host'],
  login: ['timeout', 'web-url', 'allow-host'],
  uninstall: ['dry-run', 'purge', 'yes'],
  verify: ['ping', 'ws-url'],
  'check-update': [],
  notify: [
    'title', 'body', 'url', 'type', 'priority', 'device', 'session',
    'auto', 'marker', 'pushmode-default', 'tools', 'nonreadonly', 'channel',
  ],
  channel: [],
  ask: ['title', 'body', 'actions', 'timeout', 'hook', 'accepts-exit', 'api-key'],
  'ask-context': ['global'],
  'file-view': ['global'],
  agent: ['json', 'turns'],
  send: [],
  list: ['limit', 'type'],
  dismiss: ['all'],
  rename: ['clear', 'device', 'session'],
  forget: ['ended'],
  worktree: ['dry-run'],
  test: [],
  trust: ['reset', 'yes'],
  schedule: ['at', 'days', 'every', 'prompt', 'label', 'wt', 'max-runtime'],
  listener: [
    'ws-url', 'stop', 'restart', 'no-keep-awake', 'no-turn-history',
    'install-service', 'uninstall-service', 'service-status',
  ],
  'remote-hook': [],
};

/**
 * Flags the command would ignore, in the order typed. A typo (`--titel`) used
 * to vanish silently, and the push went out with the default title.
 */
export const unknownFlags = (args: Record<string, string | boolean>): string[] => {
  const command = String(args._command);
  const table = command === 'setup' ? 'install' : command;
  // Own keys only: `hwip constructor` must not find Object's.
  if (!Object.hasOwn(COMMAND_FLAGS, table)) return [];
  const known = COMMAND_FLAGS[table];
  return Object.keys(args).filter(
    (key) => !key.startsWith('_') && !GLOBAL_FLAGS.includes(key) && !known.includes(key),
  );
};

/**
 * The first yes/no flag of a command that holds a value that is neither yes nor no, as the
 * words to print, or null. Checked before the command runs: its handlers read the flags with
 * `flagOn`, which stops on the same values, and by then work may be under way. A command that
 * hands its words to an agent (or is not in `COMMAND_FLAGS`) is not checked, and neither is
 * `trust --yes`, whose value is the device it names. `--allow-host` is checked here too (C132): a list that is
 * no list of host names stops `login` and `install` before an agent picker or a browser, not after.
 */
export const badFlagValue = (args: Record<string, string | boolean>): string | null => {
  const command = String(args._command);
  const table = command === 'setup' ? 'install' : command;
  if (!Object.hasOwn(COMMAND_FLAGS, table)) return null;
  const read = [...GLOBAL_FLAGS, ...COMMAND_FLAGS[table]];
  for (const name of YES_NO_FLAGS) {
    if (!read.includes(name) || (table === 'trust' && name === 'yes')) continue;
    try {
      flagOn(args, name);
    } catch (err) {
      if (err instanceof FlagValueError) return err.message;
      throw err;
    }
  }
  if (read.includes('allow-host')) {
    const parsed = parseAllowHosts(args['allow-host']);
    if ('error' in parsed) return parsed.error;
  }
  return null;
};
