import { COMMAND_FLAGS } from './args.js';
import { findAgentBySubcommand, REMOTE_AGENTS } from './remote-agents.js';

/**
 * What `hwip --help` prints, and what `hwip <command> --help` cuts out of it
 * (C3). One text, so a command's short usage cannot drift from the full one:
 * `commandUsage` reads the command's entry and its options section back out of
 * the same string. The shapes it relies on — an entry is a two-space-indented
 * head and a description that continues on lines indented 18 columns, an
 * options section is a `<Name> options:` heading to the next blank line — are
 * pinned by `usage.test.ts`.
 */

/** One usage line per registered remote agent — generated so help text can't drift from the table. */
const usageAgentLines = (): string =>
  REMOTE_AGENTS.map(
    (a) => `  ${`${a.subcommands[0]} [args…]`.padEnd(15)} Run '${a.binary}' in a named tmux session ('hwip-<project>')`,
  ).join('\n');

export const usageText = (): string => `Usage: hwip <command> [options]

Commands:
  install         One-command setup: detect agents, save config, install rules
  login           Browser sign-in: auto-fetch API key + hook into ~/.hwip/config.json
  uninstall       Remove Hwip from all detected agents
  verify          Check installation health across detected agents
  check-update    Check whether a newer Hwip version is available
  notify          Send a push notification
  ask             Ask the phone a question and WAIT for the answer
                  (--title required, --body, --actions id:Label,…,
                  --timeout secs [default: 60]; --api-key = --key;
                  --hook <hook-id> instead of the saved one)
                  Prints one JSON line: {"answered":true,"actionId":…} or
                  {"value":…}, else {"answered":false,"reason":…}.
                  Exit 0 answered, 1 not. Built for hooks, which cannot
                  call the MCP hwip_ask tool.
                  --accepts-exit marks an agent's own ask: the phone may
                  "send and exit", and the answer settles REMOTE and
                  reports hwipState like MCP hwip_ask (gates leave it off)
                  A run cut short is taken up by the same command run again
                  from the same place while the question is open: nothing
                  is sent, and the JSON carries "resumed":true
  ask-context [status|on|off|show] [--global]
                  Switch the context a sealed question carries (the git diff
                  against HEAD and the terminal's last lines, masked), for
                  this project (the repository root) or with --global for
                  every project. On by default; a local state file, never
                  sent anywhere. 'status' (the default) says whether it is
                  on and why not. HWIP_ASK_CONTEXT=0 turns it off for one
                  run. 'show' prints as JSON what a question asked from
                  here would carry, and sends nothing
  file-view [status|on|off|log] [--global]
                  Switch whether the phone may browse this computer's files
                  (a session's repository: the tracked and new files, not
                  the ignored ones), for this project (the repository root)
                  or with --global for every project. On by default; a
                  local state file, never sent anywhere. 'status' (the
                  default) says whether it is on and why not. The listener
                  reads HWIP_FILE_VIEW=0 to turn it off for one run. 'log'
                  prints the last reads the phone made (time, device,
                  session, listing or file, path, bytes, secrets masked,
                  result) from ~/.hwip/listener.log — which a listener run
                  in the foreground does not write (it prints to its
                  terminal), so an empty 'log' proves nothing about it
  agent send <target> <message…>
                  Type a message into another agent session, on this
                  machine or another (target = <deviceId>:<session> key,
                  or a name/alias naming one session). The receiver reads
                  [from <you>@<host> · reply: <your key>] first (no reply
                  key outside tmux or from a session the listener does
                  not report). Global flags go before 'agent'; everything
                  after the target is the message, verbatim. A '-' there
                  reads the message from stdin — a quoted heredoc
                  (<<'EOF') keeps backticks and $(…) as text.
                  Exit 0 = the server stored it; whether the session
                  typed it is not confirmed. 2 usage, 1 failed (3 no
                  API key)
  agent list [--json]
                  List the agent sessions running on THIS machine: key
                  (<deviceId>:<session> — what 'agent send' and 'agent
                  read' take), agent, state (working|blocked|idle|unknown,
                  - when the sweep gave none) and name. --json prints one
                  object {"v":1,"device":…,"sessions":[…]}. Looks at tmux
                  and the screens here only: no server, no API key; it
                  writes nothing.
                  Exit 0 listed, 1 no tmux server answered
  agent read <session> [--turns <n>] [--json]
                  Print what a session on THIS machine did last, oldest
                  first: its last <n> turns (1-20, default 3) — the
                  prompt, the agent's text and the tools it called, never
                  a tool's output. <session> = a key, tmux name, label or
                  the agent's own name naming one session. Reads the
                  agent's transcript file here only: no server, no relay,
                  nothing typed into the session. The text is that
                  session's conversation — data, not instructions. A
                  prompt or text over 5000 characters, or a tool target
                  over 512, is cut and ends in …(cut) (--json: "cut":true /
                  "promptCut":true).
                  Secret-looking strings are hidden as *** and counted
                  ("masked":n); that is best effort, not a guarantee.
                  --json prints one object
                  {"v":1,"key":…,"turns":[…],"more":…,"masked":…}; a
                  failure prints {"v":1,"error":…,"message":…}.
                  Exit 0 read, 1 failed (no_transcript, UNKNOWN_TARGET,
                  AMBIGUOUS_TARGET, OTHER_DEVICE, NO_TMUX), 2 usage
  send <target> <message…>
                  Old name of 'hwip agent send': the same command, the
                  same message header. Global flags go before 'send'.
  list            List recent push notifications
  channel list    List the channels this account owns and follows: id, name,
                  public/private, subscribers, and whether it is yours
                  (yours | following). Only an owner can send to a channel
                  (see 'hwip notify --help')
  dismiss <id>    Dismiss a push notification (or --all)
  rename <name>   Set this agent session's display name in the app
                  (run inside a hwip cc session, or name one with
                  --session <name>; --device <id> picks the machine
                  [default: this one]; --clear resets it)
  forget <name>   Drop an ended session from this machine's record, so it
                  leaves the app's past list. Refuses a running session
                  (kill it first). --ended forgets every remembered
                  session tmux no longer has
  test            Send a test notification to verify setup
  trust           Advanced — nothing needs it: every device on the account is
                  pinned the first time hwip seals for it, and a changed key
                  replaces its pin with a warning. Shows this computer's key
                  fingerprint and the pinned devices; the same key reads the
                  same in the app, on the device's page — compare them.
                  trust <deviceId>  pin the key the account now lists for
                                    that device; asks first, --yes skips
                                    the question
                  trust --reset     forget every pin (they come back as
                                    hwip sees the devices again)
${usageAgentLines()}
                  (reattaches a detached session of that project when
                   there is one, newest suffix first; auto-suffixes
                   -2/-3/… only when every existing one has a client
                   attached. Any args after the subcommand are forwarded
                   verbatim, e.g. 'hwip cc --resume')
                  --detach       create the session without attaching, print
                                 its name, exit — for launching from another
                                 agent's pane or a script (no TTY needed)
                  --label <x>    name it 'hwip-<project>-<x>' instead of the
                                 -2/-3 family.
                  --wt <name>    run it in the git worktree for branch <name>,
                                 made next to this repo as '<repo>-wt-<name>'
                                 (or reused); the phone groups it under the
                                 repo. All three must come first.
                  Starts the listener when none runs, and says why when it
                  stops right away (no key, no tmux, a rejected key). Once
                  a day it asks npm for a newer hwip and prints the update
                  line (cached in ~/.hwip/update-check.json; off under CI
                  or HWIP_NO_UPDATE_CHECK=1)
  worktree [clean]
                  List the git worktrees hwip made for agent sessions
                  (see the agent commands above), and what keeps each
                  one: a session still in it, changes, untracked or
                  ignored files, commits not pushed.
                  clean   remove the ones nothing keeps, and say why the
                          rest stay (git is never told to override; a branch
                          hwip made goes only when git says it is merged).
                          Worktrees you made by hand are never listed
                          or removed. Exit 0 unless git refused a
                          removal it had cleared
  schedule        Start an agent session on a timer, in the background. The
                  listener starts it, so it has to be running (installing the
                  listener as a login service keeps it up). A run missed while
                  the computer slept or the listener was down is skipped, never
                  started late, and the phone is told. At most 20 schedules
                  and 3 scheduled sessions at once; a session is ended after
                  --max-runtime. Schedules live in ~/.local/state/hwip/schedules
                  schedule add <agent> (--at HH:MM | --every <N>m|<N>h)
                                    [-- <agent args…>]
                                    add one: <agent> is an agent command above
                                    (cc, codex, …) and the project is this one
                  schedule [list]   show them, with the next run and the last
                                    result (--json for scripts)
                  schedule rm <id>  remove one; a session it already started
                                    keeps running
  sh              Open (or reattach) 'hwip-<project>-sh', a login shell the
                  phone may type into. Every other shell stays refused.
                  Input must be addressed to this machine; each one is
                  logged to ~/.local/state/hwip/shell-audit.log (0600).
                  Agents ('hwip agent send', hwip_agent_send) skip it — keep
                  'hwip' up to date on every machine that runs agents.
                  --label <x>    'hwip-<project>-<x>' instead of '-sh'
                  --detach       create it without attaching, print its
                                 name, exit — '!hwip sh --detach' in a CC
                                 session opens one from the phone
  mcp             Run the MCP server on stdio. This is what agent MCP
                  configs launch — 'hwip install' registers it, you
                  never type it
  listener        Resident daemon — receives 'agent.command' pushes from
                  the phone picker and injects them into the matching
                  tmux session.
                  --ws-url <url>
                             WebSocket endpoint for this run only
                  --stop     stop the running daemon
                  --restart  stop it and relaunch in the background
                             (needed after an upgrade: 'npm i -g' swaps
                              the package but never the live process)
                  --install-service
                             start the listener at every login (systemd
                             on Linux, launchd on macOS). Without it the
                             daemon only exists after a 'hwip cc', so a
                             reboot leaves the phone picker empty until
                             you open a terminal
                  --uninstall-service
                             remove the login-time service
                  --service-status
                             show what the installed service points at
                  --no-keep-awake
                             don't hold the Mac awake on AC power
                             (macOS; default runs 'caffeinate -s' so an
                              idle Mac keeps the socket up)
                  --no-turn-history
                             don't upload your sessions' conversations
                             (sealed for your devices) for the app's
                             session history

Notify options:
  --title <text>     Push title
  --body <text>      Push body
  --url <url>        URL to include
  --type <type>      Push type (note|link|file|hook) [default: hook]
  --priority <p>     Priority (low|normal|high|urgent) [default: normal]
  --device <id>      Target device ID
  --session <id>     AI session ID (or set HWIP_SESSION_ID env)
  --channel <ref>    Send to a channel you own instead of your devices:
                     a channelId or an exact channel name (a name that two
                     channels share needs the id). Sent as plain text, not
                     sealed, even with end-to-end encryption on — the
                     server can read it. Needs --title or --body; cannot
                     be combined with --auto, --device or --session
  --auto             Apply the push gate before sending (honors the
                     /hwip-mode quiet|loud dial; silent exit when gated)
  --pushmode-default <m>
                     Mode --auto assumes when the project has no dial
                     (quiet|normal|loud) [default: quiet]. A dial set with
                     /hwip-mode quiet|normal|loud always wins
  --marker <m>       Push Signal marker for --auto (skip|push|high)
  --tools <n>        Turn tool count for --auto [default: assume real work]
  --nonreadonly <n>  Non-read-only tool count for --auto

List options:
  --limit <n>        Number of pushes (1-20, default 5)
  --type <type>      Filter by push type

Dismiss options:
  --all              Dismiss all notifications

Login options:
  --web-url <url>    Web app URL to sign in at [default: https://console.hwip.app]
  --timeout <sec>    Seconds to wait for the browser [default: 300]
  --allow-host <host>  Also accept this host (and its subdomains) in the sign-in
                     callback's baseUrl / wsUrl — for a self-hosted API
                     outside hwip.app and the console's host. Comma-separate
                     several; bare host names only

Install options:
  (no --key, no saved config → opens browser login automatically,
   and Enter while it waits skips to pasting the key; a saved login
   is reused untouched on re-run; headless falls back to manual key
   entry)
  --key <api-key>    API key (non-interactive; skips browser login).
                     A key the API rejects is not saved (exit 3)
  --hook <hook-id>   Hook ID (non-interactive)
  --service          Install the login-time listener service without
                     asking (macOS). Interactive runs offer it anyway;
                     scripted runs need this flag
  --no-service       Never install it
  --base-url <url>   Base URL (non-interactive)
  --relogin          Force a fresh browser sign-in even if a login is
                     already saved (switch account)
  --web-url <url>    Login web app URL [default: https://console.hwip.app]
  --timeout <sec>    Seconds to wait for the browser sign-in [default: 300]
  --allow-host <host>  Also accept this host (and its subdomains) in the sign-in
                     callback's baseUrl / wsUrl — for a self-hosted API
                     outside hwip.app and the console's host. Comma-separate
                     several; bare host names only
  --only <agents>    Comma-separated agent ids to install for
                     (claude,cursor,windsurf,gemini,codex,copilot,cline,aider,
                     pi,opencode; cc = claude). An unknown id is an error.
                     Skips the interactive picker.

Uninstall options:
  --dry-run          Preview what would be removed, change nothing
  --purge            Also delete ~/.hwip/config.json (kept by default)
  --yes              Don't ask first. It asks only when stdin is a
                     terminal; answering no exits 1

Worktree options:
  --dry-run          With 'clean': say what would be removed, change nothing

Schedule options:
  --at HH:MM         Run at this local time (24-hour)
  --days <days>      With --at: daily [default], weekdays, or day names like
                     mon,wed,fri
  --every <N>m|<N>h  Run this often instead, at least 15m
  --prompt <text>    Type this into the session once the agent is idle. Only
                     agents with an 'idle' rule take one (cc, gemini, pi): for
                     the others the Enter could answer a trust dialog
  --label <x>        Name the session 'hwip-<project>-<x>' [default: sched-<id>]
  --wt <branch>      Run in the git worktree for <branch>, as 'hwip cc --wt'
                     does (not with --label)
  --max-runtime <N>m|<N>h
                     End the session after this long [default: 2h, at most
                     the --every period; 5m to 24h]

Verify options:
  --ping             Also make a live API call to confirm the key works
                     (with the --key / --base-url every command resolves)
  --ws-url <url>     Check this WebSocket URL instead of the configured one
  --json             Print the checks as one JSON object

Global options:
  --key <api-key>    API key (or set HWIP_API_KEY env)
  --base-url <url>   API base URL (or set HWIP_BASE_URL env)
  --json             Output JSON format
  --version          Show version
  A flag the command does not read is ignored, with a warning on stderr.
  A yes/no flag takes nothing, or =true / =1 / =yes and =false / =0 / =no; any other value
  stops the command (exit 2).

Environment:
  HWIP_API_KEY       API key (fallback when --key not provided)
  HWIP_BASE_URL      API base URL (fallback when --base-url not provided)
  HWIP_SESSION_ID    AI session ID (fallback when --session not provided)
  HWIP_NO_UPDATE_CHECK  Set to skip the daily npm check in 'hwip cc'
  HTTPS_PROXY        Proxy for API calls and the listener (HTTP_PROXY, NO_PROXY too)`;

// ── Per-command usage ───────────────────────────────────────────────

const DESCRIPTION_COLUMN = 18;

interface Entry {
  /** What follows `hwip `: `notify`, `dismiss <id>`, `cc [args…]`. */
  readonly head: string;
  /** The description, de-indented, first line to last. */
  readonly description: string[];
}

/** `  head    description` — the head runs to the first double space or the line's end. */
const ENTRY_LINE = /^ {2}(\S(?:\S| (?! ))*)(?: {2,}(.*))?$/;
const agentHeads = (): string[] => REMOTE_AGENTS.map((a) => `${a.subcommands[0]} [args…]`);
const SECTION_HEADING = /^([A-Z][a-z-]+) options:$/;

/** The command word an entry or a section belongs to: `dismiss <id>` → `dismiss`. */
const wordOf = (head: string): string => head.split(' ')[0]!;

const parseUsage = (text: string): { entries: Entry[]; sections: Map<string, string[]>; global: string[] } => {
  const lines = text.split('\n');
  const entries: Entry[] = [];
  const sections = new Map<string, string[]>();
  let global: string[] = [];

  const start = lines.indexOf('Commands:') + 1;
  let i = start;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i]!;
    // An agent line is `head` + one space when the head is too long to pad
    // (`opencode [args…]`), which the double-space rule cannot split.
    const agentHead = agentHeads().find((head) => line.startsWith(`  ${head} `));
    const entry = agentHead ? null : ENTRY_LINE.exec(line);
    if (agentHead) {
      entries.push({ head: agentHead, description: [line.slice(`  ${agentHead} `.length).trimStart()] });
    } else if (entry && !line.startsWith(' '.repeat(DESCRIPTION_COLUMN))) {
      entries.push({ head: entry[1]!, description: entry[2] !== undefined ? [entry[2]] : [] });
    } else if (entries.length > 0) {
      entries[entries.length - 1]!.description.push(line.slice(DESCRIPTION_COLUMN));
    }
  }

  for (; i < lines.length; i++) {
    const heading = lines[i]!;
    const isGlobal = heading === 'Global options:';
    const named = isGlobal ? null : SECTION_HEADING.exec(heading);
    if (!named && !isGlobal) continue;
    const body: string[] = [];
    for (i++; i < lines.length && lines[i] !== ''; i++) body.push(lines[i]!);
    if (named) sections.set(named[1]!.toLowerCase(), body);
    else global = body;
  }
  return { entries, sections, global };
};

/**
 * The short usage of one command: its entry from the full text, its options
 * section if it has one, and the global options. Null for a word that is not a
 * command, which the caller answers with the full usage.
 *
 * Every agent subcommand (`cc`, `codex`, …) shares the paragraph the full text
 * prints once under the last of them, so each gets it.
 */
export const commandUsage = (command: string): string | null => {
  const agent = findAgentBySubcommand(command);
  const word = agent ? agent.subcommands[0]! : command === 'setup' ? 'install' : command;
  const { entries, sections, global } = parseUsage(usageText());

  // `agent` has three entries (send, list, read): the first leads, the others follow it.
  const [entry, ...siblings] = entries.filter((e) => wordOf(e.head) === word);
  if (!entry) return null;
  const description = [...entry.description];
  for (const sibling of siblings) description.push('', `hwip ${sibling.head}`, ...sibling.description);
  if (agent) {
    const lastAgent = [...entries].reverse().find((e) => REMOTE_AGENTS.some((a) => a.subcommands[0] === wordOf(e.head)));
    // The shared paragraph is the part of the last agent's description after its own first line.
    if (lastAgent && lastAgent !== entry) description.push(...lastAgent.description.slice(1));
  }
  const options = sections.get(word);

  // `[options]` when the command reads flags; a command outside the table (`sh`,
  // `mcp`) gets it unless its head already says what follows.
  const flags = COMMAND_FLAGS[word];
  const takesOptions = siblings.length === 0 && (options !== undefined || (flags ? flags.length > 0 : !/[<\[]/.test(entry.head)));
  const heads = [entry, ...siblings].map((e, n) => `${n === 0 ? 'Usage: hwip' : '       hwip'} ${e.head}`);
  heads[0] += takesOptions ? ' [options]' : '';
  const out = [...heads, '', ...description.filter((l, n) => n > 0 || l !== '')];
  if (options) out.push('', `${word[0]!.toUpperCase()}${word.slice(1)} options:`, ...options);
  out.push('', 'Global options:', ...global, '', "'hwip --help' lists every command.");
  return out.join('\n');
};

/**
 * Which command a request for usage is about: `hwip notify --help` and
 * `hwip --help cc` name it, `hwip help notify` names it as its argument, and
 * `hwip` or `hwip help` alone name none.
 */
export const usageTarget = (args: Readonly<Record<string, string | boolean>>): string =>
  String(args._command === 'help' ? args._arg1 : args._command);
