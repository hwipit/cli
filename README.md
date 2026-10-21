# @hwip/cli

[![npm](https://img.shields.io/npm/v/@hwip/cli.svg)](https://www.npmjs.com/package/@hwip/cli)
[![downloads](https://img.shields.io/npm/dm/@hwip/cli.svg)](https://www.npmjs.com/package/@hwip/cli)
[![node](https://img.shields.io/node/v/@hwip/cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@hwip/cli.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-docs.hwip.app-1f6feb)](https://docs.hwip.app)

**Your agent works, hits a decision, and asks your phone. You tap a button (or type a reply), and the answer lands back in the live session — so the agent keeps going.**

`@hwip/cli` is the terminal side of that round trip: a push SDK, a `hwip` CLI that wires up 10 AI agents in one command, and a resident listener that lets your phone **drive any agent session it can start** (16 agents supported) by typing straight into named tmux sessions.

<p align="center">
  <img src="https://hwip.app/readme/demo.gif" alt="Agent asks 'Deploy to prod?' on your phone; you tap Deploy; the session ships" width="560"><br>
  <sub><em>Your agent asks on your phone → you tap <b>Deploy</b> → the session ships. No terminal.</em></sub>
</p>

- **`HwipHook` SDK** — native `fetch`, no runtime deps. Send / list / dismiss pushes.
- **`hwip` CLI** — one-command setup for 10 agents, push sending, and the resident listener for phone-driven remote control of 16 agents.

Part of the Hwip toolchain: [`@hwip/mcp-server`](https://github.com/hwipit/mcp-server) (the MCP tools your agent calls, e.g. `hwip_ask`) · [`hwipit/plugin`](https://github.com/hwipit/plugin) (Claude Code plugin bundling hooks + MCP + rules) · the [Hwip app](https://hwip.app) on your phone.

> **New here?** [docs.hwip.app](https://docs.hwip.app) walks the whole setup — one command on this machine, the app on your phone, and a restart. The reference below assumes that is already done.

## Quick Start

Install the CLI globally, then run setup:

```bash
npm install -g @hwip/cli
hwip install
```

`hwip install` opens a browser sign-in on a fresh machine — the web app
issues an API key + hook as a matched pair and the CLI writes them to
`~/.hwip/config.json` (no copy-paste). Then it installs rules + hooks +
MCP for every detected agent (Claude Code / Cursor / Windsurf / Gemini /
Codex / …). Safe to re-run: a saved login is reused untouched (no
prompts), so a re-run just refreshes the agent integrations. To switch
account, `hwip install --relogin` forces a fresh sign-in.

**Auto session names.** Agents without a title of their own — Codex,
Cursor, Windsurf, Gemini and pi — name their sessions after what they were
asked, so the phone shows that instead of a tmux name. The registrations
`hwip install` writes turn it on (`HWIP_AUTONAME=1` in the MCP entry, the
`hwip_session_title` tool in the pi extension), so **after updating
`@hwip/cli`, run `hwip install` once more** to get it on a machine
installed before; `hwip verify` says which MCP agents still lack it. Claude
Code and opencode title sessions themselves and are left as they are. To
hide the names agents choose, turn off *Name sessions automatically* in
the app's settings — names you set yourself always show.

**Why global, not `npx`?** `hwip cc` (drive a session from your phone)
needs `hwip` on your `PATH`, and the agent hooks this installs are
`$(command -v hwip || npx …)` — a global binary skips an npx cold-start
on *every* notification. For notifications only, with no phone control,
`npx @hwip/cli install` is a lighter alternative that skips the global
binary — and with it `hwip cc`, which is also where the update notice
(`npm i -g @hwip/cli`) appears.

Once installed, the hooks fire in **every** session of each configured
agent — `hwip cc` is the phone-control bridge, not the notification
switch. In Claude Code the routine per-turn push starts off (`quiet` is
the default) — while you're at the terminal; once you've stepped away, a
finished turn still pushes ([Quiet while away](#quiet-while-away)).
`/hwip-mode normal` turns it on for a project, `/hwip-mode loud`
pushes on every turn, `/hwip-mode mute` silences a project entirely, and
`/hwip-mode` shows what's in effect. See
[Mute & push mode](#mute--push-mode).

`~/.hwip/config.json` is the single source of truth — the CLI, the MCP
server, the plugin hooks, and the listener all read it. You never need
`HWIP_API_KEY`-style env vars for a normal setup; they exist as overrides
(second account, CI).

Variants:

```bash
# Headless box (no browser): paste credentials from another machine's
# ~/.hwip/config.json
hwip install --key ak_... --hook hook_...

# Skip the interactive agent picker
hwip install --only claude,cursor

# Switch account — force a fresh browser sign-in over a saved login
hwip install --relogin

# Refresh credentials only (no agent re-install) — assumes you already
# ran `hwip install` once; on its own it does NOT wire MCP into agents
hwip login
```

To **send** notifications:

```bash
hwip notify --title "Deploy done" --body "v2.1.0 shipped"
```

To **send to a channel you own** (everyone subscribed to it gets the push):

```bash
hwip channel list                                     # channels you own and follow
hwip notify --channel Releases --title "v2.1.0" --body "shipped"
hwip notify --channel ch_abc123 --title "v2.1.0"      # a channelId works too
```

`--channel` takes a channelId or an exact channel name. A name resolves to the
channel *you own* with that name — a channel you only follow under the same name
is not a candidate — and two owned channels with one name are refused: use the
id. `channel list` marks each channel `yours` or `following`; only an owner can
send, and the CLI refuses a channel you follow without sending anything. (Against
a server that predates the `isOwner` field, the list shows each channel's owner
instead, a name shared with a followed channel is refused as ambiguous, and the
server refuses the push for a channel you do not own.)

**A channel push is plain text.** Unlike every other push, it is not sealed — the server can read it, because a sealed push
could not be opened by the subscribers. The CLI says so on stderr each time.
It needs `--title` or `--body` (there is no default text), and does not
combine with `--auto`, `--device` or `--session`, which mean "this agent
session". `hwip send` / `hwip agent send` types into an agent session and has
no channel option. The API key needs the `channel:read` and `push:write`
scopes.

To **drive an agent session from your phone**, see
[Remote Control](#remote-control) below.

## Remote Control

> Send messages from your phone *into* a live agent session — even after
> a `hwip_ask` polling window has expired.

<p align="center">
  <img src="https://hwip.app/readme/ask-phone.png" alt="A Hwip hook on the phone: a question with tappable answer buttons and a text field" width="300">
</p>

The MCP tool `hwip_ask` waits on a fixed
timeout (120–600 s). Once that window closes the
session becomes unaddressable from the phone, even though it's still
running. The `hwip listener` daemon fixes this by keeping a persistent
WebSocket open to Hwip and injecting matching messages into a *named*
tmux session via `tmux send-keys`.

### Architecture

```
[phone — "Active Agents" picker on Hwip app]
   │  selects session, types message
   ▼  POST /pushes/send  { type: 'agent.command',
   │                       agentSessionName: 'hwip-myapp',
   │                       body: '리팩토링 마무리해줘' }
[Hwip backend]
   │  WebSocket fan-out (push.new)
   ▼
[hwip listener — resident daemon, started by `hwip cc` automatically]
   │  tmux send-keys -l -t hwip-myapp "리팩토링 마무리해줘" + Enter
   ▼
[tmux session "hwip-myapp" running claude / codex / cursor-agent / gemini / hermes]
```

The listener polls its tmux session inventory every 5 seconds and
reports it to the server whenever something changed (new session, agent
state transition, activity) — an unchanged inventory is re-sent only as
a two-minute idle heartbeat. The phone picker stays in sync with no
manual configuration, and an idle listener costs the backend a fraction
of what a fixed 5-second report cycle would.

### Live timeline

While a session is working, the phone can draw what the agent is doing right
now — the prompt that started the turn, each tool call and its outcome, the
agent's own replies, and per-message token counts. It is read by tailing the
agent's transcript on disk; nothing a tool read or wrote leaves the machine,
only names, short labels and numbers.

The one list it carries in words is the agent's own to-do list (Claude Code's
TaskCreate · TaskUpdate · TaskList), sent whole as a `todo` event each time it
changes — the tasks as the agent wrote them, at most 30 of 100 characters each,
sealed like the replies are.

Each agent stores its transcript differently, so a row in `REMOTE_AGENT_TABLE`
(`src/remote-agents.ts`) names two things: where the file is, and which
projector reads it. An agent with neither answers `no_transcript` and the phone
says it has no live timeline.

| Agent | Transcript | Projector |
|-------|-----------|-----------|
| Claude Code | `~/.claude/projects/<encoded cwd>/<uuid>.jsonl` | `src/transcript-tail.ts` |
| pi | `~/.pi/agent/sessions/<encoded cwd>/<ts>_<id>.jsonl` (`PI_CODING_AGENT_DIR`) | `src/pi-transcript.ts` |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` (`CODEX_HOME`) | `src/codex-transcript.ts` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (`GEMINI_CLI_HOME`) | `src/gemini-transcript.ts` |
| OpenCode 2.x | no file — the `session_message` table of `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`, `XDG_DATA_HOME`), asked again when the store changes, at most once a second per session. The pane's session is the newest one in its directory written to since the pane started | `src/opencode-transcript.ts` |
| Cursor, Hermes, Kimi, Grok, Antigravity, Qwen, Auggie, Kilo, Copilot, Kiro, Droid | — none yet | — |

Adding an agent means a projector file of its own, not another branch in an
existing one: the formats share no vocabulary. Each projector is pinned to the
vendor layout it was read against, and an entry type it has never seen draws no
row rather than breaking the watch.

### Remote-origin detection (sticky REMOTE mode)

A message injected via `send-keys` is indistinguishable from typing — so
the listener also records each injection as a one-shot marker (epoch +
sha256 of the text, keyed by the pane's project dir). A prompt-submit
hook on the agent side matches the submitted prompt against that marker
and, on an exact match, tells the model the user is driving the session
from their phone — entering sticky REMOTE mode (every response ends with
an answerable `hwip_ask`).

| Agent | Hook | Installed by |
|-------|------|--------------|
| Claude Code | `UserPromptSubmit` → plugin's `hwip-remote.sh` | Hwip plugin |
| Gemini CLI | `BeforeAgent` → `hwip remote-hook gemini` | `hwip setup` |
| Codex CLI | `UserPromptSubmit` → `hwip remote-hook codex` | `hwip setup` |
| Pi | `before_agent_start` → `hwip remote-hook pi` (via extension) | `hwip setup` |
| Cursor CLI | — none yet | — |

**Subagents (view-only).** A subagent shows up on your phone as a child of its
parent card, named `<session>.<n>` — it streams live, but input, keys, exit,
resume and forget are all refused: you watch from the phone and answer at the
terminal, where the parent owns the conversation. A prompt push from a subagent
names it and opens its stream directly.

They reach the roster two ways. A pi subagent spawned into an extra pane of the
same tmux window is found as a pane, and labelled from `@hwip_pane_label` (the
pi extension sets it from `PI_SUBAGENT_NAME`). A Claude Code subagent — the
`Agent` tool — has no pane at all; it is found in the parent's transcript
directory instead (`src/subagent-transcripts.ts`), labelled from the
description the parent gave it, and carries the number of tools it has run so
far. Both kinds are numbered in one sequence, so the names never collide.

A Claude Code subagent is marked `inProcess`, because the phone cannot mirror a
pane that does not exist — its terminal view draws the transcript instead. It
leaves the roster the moment the parent's transcript records its end (a
background subagent's task notification, or a foreground one's `Agent` call
returning), rather than after five quiet minutes; one that is resumed comes
back when it writes again.

Detection is exact-match: a terminal keystroke racing a phone message
can never false-flag. Muted projects are never flagged.

Agents without that hook (Cursor, Windsurf, Copilot, Cline, Aider, OpenCode) have one
other way in: a `hwip_ask` answer reporting `hwipState: "REMOTE"`. Their rule
files therefore keep the after-real-work `hwip_ask` — the "Entering REMOTE
without a prompt hook" preamble in `src/templates.ts` — so the phone always
has a button to tap that starts the loop. The one exception is an answer sent
with the phone's "send and exit": that turn carries out the instruction and
ends without an ask. Agents with the hook drop that
obligation while at the terminal — and their rule file carries only the
NORMAL branch of the core (about a quarter of it), since it is read on every
turn; the hook injects the REMOTE sections in full on the turn a phone
message enters REMOTE, the way the Claude Code plugin's hooks do.

`hwip cursor` has no remote-origin hook, so it never enters sticky REMOTE
mode by itself. **Just ask for it** — one line, once per session:

> I'm driving this session from my phone. End every response with
> `hwip_ask` so I can answer with a button.

Nothing else is missing: injection works, and the MCP tools are all
there, `hwip_ask` included. Check them with `cursor-agent mcp list-tools
hwip` — `mcp list` prints only the *approved* list, not what's
configured, so it reads as empty even when the server is wired up.

Why it isn't automatic: `hooks.json` is honored by the Cursor IDE but not
by `cursor-agent`, and `beforeSubmitPrompt`'s output schema is
`{continue, user_message}` — no context channel to deliver a marker match
through. Same reason the `stop`-hook auto-push `hwip setup` installs
covers the Cursor **IDE** but not `hwip cursor` panes; ask for a
`hwip_notify` when you want one.

`hwip hermes` is in the same position, and asking for it works the same
way. `hwip install` does not wire Hermes either — add the MCP server to
`~/.hermes/config.yaml` by hand, as one entry under `mcp_servers`:

```yaml
mcp_servers:
  hwip:
    command: "hwip"
    args: ["mcp"]
```

`hwip mcp` runs the MCP server inside the CLI process. The older
`command: "npx"` / `args: ["-y", "@hwip/mcp-server"]` form still works,
but leaves an `npm exec` launcher resident beside the server for as long as
the session lives — `hwip verify` flags a config still on it.

Add the entry; do not replace the file. `mcp_servers` is shared with
every other server you have configured, and nothing under `~/.hermes` is
in version control. Then `/reload-mcp` inside Hermes.

`hwip_ask` needs a hook id, which the MCP server reads from
`HWIP_HOOK_ID` or from `hookId` in `~/.hwip/config.json` — `hwip install`
writes the latter, so a machine that has run it once needs no `env`
block here.

### Setup

1. **Install tmux.** The listener uses `send-keys`; the wrapper spawns
   named sessions. `hwip install` checks for it and, on macOS with Homebrew,
   offers to run `brew install tmux` for you. Elsewhere it prints the line to
   run — `sudo apt install tmux` on Debian/Ubuntu, and so on — because
   installing with `sudo` is not something an installer should do on your
   behalf. tmux has no Windows build, so `hwip cc` needs WSL there.

2. **Add `wsUrl` to `~/.hwip/config.json`** (the WebSocket endpoint of
   your Hwip backend — CDK output `WsApiUrl`). Keep it on the same stage as
   `baseUrl`: the REST stage is the path prefix (`/v1` prod, `/d1` dev) and the
   socket stage is the hostname, so they can disagree without either looking
   wrong. `hwip verify` says which stage each one is on, and the listener only
   reads this at startup — `hwip listener --restart` after editing:

   ```json
   {
     "apiKey": "ak_...",
     "hookId": "hook_...",
     "wsUrl": "wss://<api-id>.execute-api.<region>.amazonaws.com/<stage>"
   }
   ```

   This is where it belongs. `--ws-url` overrides it for a single run.
   `HWIP_WS_URL` is deprecated: it used to outrank this file, which meant an
   `export` in a shell profile silently chose the stage and left no trace of
   having done so. It now loses to the file and is read only when the file has
   no `wsUrl`, so nothing that worked stops working — but it will go, and
   `hwip verify` says so while it is still set.

3. **Run agents through the wrapper.** That's it.

   ```bash
   hwip cc        # claude       → tmux session "hwip-<project>"
   hwip codex     # codex        → tmux session "hwip-<project>"
   hwip cursor    # cursor-agent → tmux session "hwip-<project>"
   hwip gemini    # gemini       → tmux session "hwip-<project>"
   hwip hermes    # hermes       → tmux session "hwip-<project>"
   hwip pi        # pi           → tmux session "hwip-<project>"
   hwip opencode  # opencode     → tmux session "hwip-<project>"
   hwip kimi      # kimi         → tmux session "hwip-<project>"
   hwip grok      # grok         → tmux session "hwip-<project>"
   hwip agy       # agy          → tmux session "hwip-<project>"
   hwip qwen      # qwen         → tmux session "hwip-<project>"
   hwip auggie    # auggie       → tmux session "hwip-<project>"
   hwip kilo      # kilo         → tmux session "hwip-<project>"
   hwip copilot   # copilot      → tmux session "hwip-<project>"
   hwip kiro-cli  # kiro-cli     → tmux session "hwip-<project>"
   hwip droid     # droid        → tmux session "hwip-<project>"
   ```

   `hwip install` does not wire MCP, rules or hooks for `kimi` · `grok` · `agy` ·
   `qwen` · `auggie` · `kilo` · `copilot` · `kiro-cli` · `droid` — the wrapper
   makes the session reachable from the phone and nothing more.

   Two wrapper flags, read off the front of the args: `--detach` creates
   the session without attaching (no TTY needed — a script or another
   agent's pane can launch it) and prints its name; `--label <x>` names
   it `hwip-<project>-<x>` instead of the `-2/-3` family. Example — a
   Claude Code planner starting a pi implementer for one plan:

   ```bash
   hwip pi --detach --label plan-auth-pi -n plan-auth '/skill:implement plans/auth.md'
   ```

   **A session in its own git worktree — `--wt <name>`.** `hwip cc --wt feat/x`
   makes the worktree for branch `feat/x` next to the repo's main checkout
   (`<repo>-wt-feat-x`, with the branch started from the HEAD you typed it
   at, or the branch as it is when it already exists) and starts the session
   in it, under the name `hwip-<repo>-wt-feat-x`; the phone groups it under
   `<repo>` as `wt-feat-x`. Typing the same command again reuses the
   worktree (without `--detach` it reattaches the detached session). Typed
   inside a worktree, it still makes the new one beside the main checkout. It
   refuses, with one line and a non-zero exit, outside git, in a bare or
   `--separate-git-dir` layout, for a name git does not take as a branch, and
   when something that is not this worktree is already at the path — nothing
   there is touched. Like `--detach` and `--label`, it goes at the front of
   the args. Claude Code's own `--worktree` is not taken by the wrapper: it
   passes through and uses `.claude/worktrees/`. `hwip sh` has no `--wt`.

   **When the session is over.** The listener takes the worktree back, once,
   after a session that ran in it has ended and no pane is left in it — and
   only when nothing in it would be lost: no uncommitted or untracked file,
   no **ignored** file (a hand-written `.env` is ignored, and `git worktree
   remove` would delete it without a word), and no commit made since the
   worktree was created that is not on a remote. It removes with plain
   `git worktree remove` (never `--force`), then deletes the branch with
   `git branch -d` only if hwip made it and git says it is merged. When
   anything holds the worktree it stays: the listener log gets one line and
   macOS gets one banner naming what holds it (`2 uncommitted or untracked, 1
   unpushed commit`), and it is not judged again until a session uses it
   again. Only worktrees hwip made with `--wt` are ever removed — it keeps
   them in `worktrees.json` under the state directory, and a worktree you
   made by hand has no row. `git worktree list` is the full list; `hwip
   worktree` shows the ones hwip made and what keeps each, and `hwip worktree
   clean` removes the ones nothing keeps now (`--dry-run` only says; it
   judges every worktree not in use, including ones the listener left or
   never saw end). The listener looks when the set of
   `hwip-*` sessions changes (and once when it starts), the last session
   ending with tmux itself included; a run started inside a tmux pane of your
   own (`$TMUX` set, no `--detach`) is not a session it sees end, so
   `hwip worktree clean` is how that one goes. The chat history of an ended
   session stays, so resuming it from the phone after its worktree is gone
   answers with the app's missing-directory error.

   A labelled session, and any session started in a linked git worktree,
   still shows on the phone under its project — the main checkout's name —
   with the label (or the worktree's session name) beside it. The wrapper
   records both as tmux session options (`@hwip_project`,
   `@hwip_session_label`) because the session name alone cannot say where
   the project ends. A session started without them (before this, or by an
   older CLI) is grouped by the listener from its pane's checkout instead,
   so upgrading the listener is enough — no session restart.

   **Inside [herdr](https://herdr.dev).** herdr finds agents by a pane's
   foreground process, which for a wrapped session is the tmux client, so
   the agent would not show in its sidebar. Every `hwip` attach records the
   herdr pane it runs in as session options (`@hwip_herdr_pane`,
   `@hwip_herdr_socket`, `@hwip_herdr_bin`), and clears them when attached
   from outside herdr; a bare `tmux attach` changes neither, so the agent
   keeps reporting to the last herdr pane `hwip` saw. Reporters read them on
   every report and send the agent's `working` / `idle` / `blocked` state to
   that pane: Claude Code through the hwip plugin's `hwip-herdr.sh` hook
   (plugin 0.20.0+) as `hwip cc`, pi through the hwip pi extension as
   `hwip pi`. herdr's own pi extension reads the pane from its env, which
   tmux does not pass, so it stays silent in a wrapped session. Headless runs (`claude -p`, `pi -p`,
   RPC) started from a shell in a wrapped pane inherit its `TMUX_PANE` and
   never report.

   **A shell the phone may type into — `hwip sh`.** Every other shell
   pane is refused (see [Defense](#defense)); `hwip sh` opens the one
   exception, `hwip-<project>-sh` running your login shell, for the jobs an
   agent's permission prompt blocks — a restart, a `kill`, a `sudo`. It is a
   real terminal: `cd` and `export` stick, `sudo`/`ssh` prompts work, and a
   long command does not tie up an agent. `--label <x>` names it
   `hwip-<project>-<x>`; `--detach` creates it without attaching. Away from
   the desk, open one from the phone through any running Claude Code
   session by sending `!hwip sh --detach` (Claude Code's `!` bash mode —
   see Defense item 7). Inside tmux it never attaches; it prints a
   `tmux switch-client -t <session>` line instead. Running it again for a
   session it opened reattaches, and a session of that name it did not open
   is refused.

   ```bash
   hwip sh              # → tmux session "hwip-<project>-sh"
   hwip sh --detach     # create it, print its name, exit
   ```

   **The mirror fits a session to the phone.** A pane is as wide as the
   terminal that last drew it, so a desktop's prompt rules and
   right-aligned clocks fold in two on a phone. Whoever used the session
   last decides its width, the way tmux's `window-size latest` does: typing
   from the phone makes the phone the latest user, and the listener resizes
   the window to the phone's width, and coming back to the mirror later
   (a locked screen, a resubscribe) takes it again unless the desktop was
   used since. Opening the mirror without typing does the same once
   the desktop terminal has been idle for a minute, so a phone reconnecting
   on its own never shrinks a terminal you are typing in. Pressing a key in
   (or attaching) a desktop terminal makes it the latest user, and within a
   renew (5 s) the window is handed back to tmux, which sizes it to that
   terminal. Moving the mouse over a desktop pane or clicking another
   pane is not using it: on macOS the listener reads when a key was last
   pressed (the HID system clock, no permission needed) and counts a
   desktop terminal as used no later than that key or its attach. Elsewhere
   any tmux client activity counts. While the phone holds a session, a desktop terminal still
   attached to it shows it narrower. When the phone leaves, a session no
   terminal is attached to gets its old width back and an attached one is
   sized to its terminal. A window split into panes is never resized. A
   listener that died while a window was fitted restores it the next time
   it starts.

   `hwip cursor` runs **`cursor-agent`**, Cursor's terminal agent — a
   separate install from the Cursor IDE (the bare `cursor` on your PATH
   is the editor launcher, which exits immediately and can't be driven).

   `hwip hermes` runs Hermes in its classic REPL, which is the default.
   Launching it in TUI mode instead (`hwip hermes --tui`, or `HERMES_TUI=1`
   in the environment) puts the pane on the terminal's alternate screen,
   and the alternate screen has no scrollback — the live mirror on your
   phone still draws, but scrolling up in it comes back empty.

   If a Hermes session disappears from the phone's picker, the cause is
   tmux having dropped the pane's `start_command`: all the listener sees
   then is the interpreter Hermes execs (`python3.11` at time of writing),
   which names no agent. `hwip listener` run in the foreground prints the
   reason (`no agent in pane (start=…, current=python3.11)`). Kill the
   session and start it again with `hwip hermes` to recover. `claude` sits
   on the same edge for the same reason — it execs node.

   The first `hwip cc` on a machine **auto-spawns a background
   listener** (singleton, PID file at `~/.hwip/listener.pid`,
   stdout/stderr at `~/.hwip/listener.log`). You never run
   `hwip listener` by hand — every `hwip cc` checks the PID file and
   skips the spawn when one is already alive, so opening a dozen
   terminals doesn't create a dozen daemons. The daemon survives
   between `hwip cc` invocations — but not a reboot, which is what the
   login-time service below is for.

   Project name resolves from `CLAUDE_PROJECT_DIR` /
   `CURSOR_PROJECT_DIR` / `WINDSURF_PROJECT_DIR` if set, else the git
   repo root, else the cwd basename. Any extra args after the command
   pass through to the agent verbatim:

   ```bash
   hwip cc --resume "abc123"
   hwip cc --dangerously-skip-permissions
   hwip codex --model gpt-5-high "fix the failing test"
   ```

   **Multiple sessions in one project.** Open another terminal in the
   same folder, run `hwip cc` again, and the wrapper auto-suffixes:
   first session is `hwip-encl`, the next attached one becomes
   `hwip-encl-2`, then `hwip-encl-3`, etc. The phone picker shows them
   as `encl · Claude`, `encl · Claude #2`, `encl · Claude #3`.
   Once the agent has named the session itself — Claude Code, Codex,
   Hermes and OpenCode 2.x do — the picker shows `<that name> · <Agent>`
   instead.

   **Reattaching wins over spawning.** If any session of that project is
   **detached** (no one attached), the wrapper reattaches instead of
   spawning a new one — close the terminal, come back later, pick up
   where you left off. When several are detached it takes the
   highest-numbered one first, then works down on later runs, so no
   session can end up out of reach. That matters because a session you
   cannot reach still holds a live agent: an agent CLI plus its MCP
   servers is a few hundred MB you can neither see nor reclaim. A
   detached session is never killed for you — nothing here can tell
   "done with this" from "closed the laptop".

   **Only a slot running the same agent is reattached.** `hwip pi` will
   not reattach a detached `hwip cc` session: tmux attaches to a session
   that already exists and drops the command it was given, so you would
   land in claude with pi never started. A slot running another agent is
   skipped and the next suffix is used instead.

   If you're already inside a tmux session (`$TMUX` set) the wrapper
   skips the outer tmux and runs the agent in the current pane — the
   listener can't target an unnamed session that way, but you keep your
   existing multiplexer setup. Unless that session is itself a `hwip-*`
   one, the wrapper says so in one line and points at `--detach` or
   running outside tmux.

### Starting the listener at login

A reboot ends the daemon, and nothing starts it again until you open a
terminal and run `hwip cc`. Until you do, the phone shows **no agents** —
the machine is on, the past sessions are on disk, and the app has no one
to hear from.

```bash
hwip listener --install-service
```

On macOS that registers a launchd LaunchAgent (`app.hwip.listener`), and on
Linux a systemd user unit (`app.hwip.listener.service`, see
[On Linux](#on-linux) below); either starts the listener at every login. `--uninstall-service` removes it and
`--service-status` shows what the installed one points at; `hwip install`
offers it during setup and `hwip uninstall` takes it away again.

What you get back after a reboot is your **past sessions**, ready to
resume from the phone — not live agents. tmux does not survive a reboot
either, and this doesn't try to bring those sessions back to life.
A resume starts the agent in the directory it last ran in; for Claude Code,
OpenCode, Codex, Pi and Hermes it also picks up the conversation that session
last had (`claude --resume <id>`, `opencode --session <id>`,
`codex resume <thread>`, `pi --session <file>`, `hermes --resume <id>` — the
id this machine read off the live pane's own process; an id two panes both
answered to is not kept). Claude Code, Codex and Pi start fresh when that
conversation is no longer on disk, and the other agents always start a new one.
Each ended run of a name is its own row on the phone, and starting one
again picks up that run's conversation, not the newest one. If the name
is live again by then, that run starts beside it under the next free name
of the family (`<name>-2`, `<name>-3`, …) instead of being refused.

Two details worth knowing:

- It fires at **user login**, not at boot. Without automatic login, the
  machine stays silent while it sits on the login screen.
- The plist bakes in absolute paths for node and the CLI, a `PATH` that
  can reach tmux, and a UTF-8 `LANG`. launchd gives a job
  `/usr/bin:/bin:/usr/sbin:/sbin` and no locale at all: without the PATH
  the daemon exits 127 at every login, and without the locale tmux
  escapes the separator the session list is split on, so every session is
  silently dropped while everything else looks healthy. If any of that
  drifts — a version-manager node upgrade, say — `hwip verify` names it,
  and re-running `--install-service` repoints the plist.
- The plist never holds a proxy. A proxy password in `EnvironmentVariables` would sit in a
  file other tools back up and read, so the service takes the proxy from `~/.hwip/config.json`
  (`"httpsProxy": "http://user:pass@proxy.example:3128"`, optionally `"httpProxy"` and
  `"noProxy"`), which hwip keeps at mode 0600 and ignores when another user owns it or anyone can write it. It
  covers both the API calls and the listener's socket; the rules (the environment's `HTTPS_PROXY`
  wins over the file's value, `NO_PROXY` syntax, the error for a bad address) are in
  [Environment Variables](#environment-variables). Restart the service after editing the file:
  `hwip listener --restart`. While `config.json` is ignored (see below) its proxy settings are
  ignored too, and the service connects directly.

With the service installed, launchd owns the process: `hwip cc` and
`hwip listener --stop|--restart` ask launchd rather than signalling the
PID, so there is never a second daemon racing the first.

#### On Linux

Where a systemd user manager is running (`systemctl --user` answers),
`--install-service` writes `~/.config/systemd/user/app.hwip.listener.service`
(`$XDG_CONFIG_HOME/systemd/user/` when that is set), then runs
`systemctl --user daemon-reload`, `enable` and `restart`. The unit bakes in
the same absolute node and CLI paths, `PATH` and UTF-8 `LANG` as the plist —
the user manager's own `PATH` is whatever the distribution configured — and
appends both output streams to `~/.hwip/listener.log` (`append:` needs systemd 240 or
later; behavior on older releases is unverified).
It restarts the listener 30 s after a crash and leaves a clean exit down, as
launchd does. `--uninstall-service` runs `systemctl --user disable --now`,
deletes the file and reloads; `hwip listener --stop|--restart` become
`systemctl --user stop|restart`, and `hwip verify` checks the unit the way it
checks the plist. This Linux path has not been verified against a real machine yet —
the unit and the `systemctl` calls follow the freedesktop.org manual pages.

The unit hangs off the user manager's `default.target`, so it runs while you
are logged in. Without *lingering*, systemd starts your user manager at login
and stops it after your last logout — on a server nobody logs in to, the
listener would not start after a reboot. hwip never changes that setting;
turn it on yourself if you want the listener up from boot:

```bash
sudo loginctl enable-linger $USER
```

### Keeping the Mac awake

The listener holds an *outbound* socket, and macOS **"Wake for network
access" does not protect it** — that setting only wakes the machine for
inbound requests to services it advertises. When the Mac idle-sleeps, the
socket dies and the phone shows "Waiting for the live stream…" until
someone opens the lid. A Mac running Claude Code hides this (the agent
runs `caffeinate` during every turn), so one machine looks fine while
another, idling at a prompt, keeps dropping.

So on macOS the listener runs `caffeinate -s -w <its pid>` for as long as
it lives. `-s` is honoured **on AC power only** — on battery macOS ignores
it, so a laptop still sleeps and nothing drains. The display still turns
off; a closed lid still sleeps. Activity Monitor shows the daemon under
"Preventing Sleep". It holds even when no agent session is open: resuming a
past session from the phone needs this Mac awake to answer. Opt out with `--no-keep-awake` or `"keepAwake": false`
in `~/.hwip/config.json`; the log's `keep-awake:` line says which way it
went.

### Scheduled sessions

`hwip schedule add` makes the listener start an agent session by itself — every morning, every two hours — so the phone has something to look at without anyone opening a terminal first. The listener ticks every 30 seconds for as long as it lives, with or without the socket up, so installing it as a login service ([above](#starting-the-listener-at-login)) is what keeps schedules running across restarts.

- **Times** are local. `--at HH:MM` runs on `--days` (daily by default); `--every <N>m|<N>h` counts from the moment the schedule was made, no more often than every 15 minutes. A time that does not exist on the day the clocks go forward runs once at the moved time.
- **A missed run is never started late.** A run is started only if the listener sees it within two minutes of its time. After the computer slept or the listener was down, every time that passed is counted as missed and skipped; the newest one still starts if it is within those two minutes.
- **One session per schedule, three at once.** A run whose session from the last one is still there is skipped (`overlap`), and so is a fourth scheduled session while three run (`busy`). A directory that is gone, an agent command that does not exist, and a launch that fails are skipped too.
- **The prompt** (`--prompt`) is typed once, and only when the agent is the foreground program of the pane and its detection rules read the screen as `idle` — not working, not a dialog. If that does not happen within 90 seconds the prompt is not typed, the session stays, and the phone is told. **Only agents that have an `idle` rule can take a prompt** (today Claude Code, Codex, Gemini CLI and pi): for any other agent nothing separates "ready" from a trust or permission dialog, and the Enter that submits a prompt would answer the dialog's default with nobody there to read it. `hwip schedule add … --prompt` refuses those agents and says which ones work; a schedule without `--prompt` starts any agent. The rules that decide this are the ones shipped in the `hwip` package, not the detection rules the listener updates over the air: a phone's input is typed by someone who has seen the screen, a schedule by nobody, and a rule set that arrives over the air is not signed — it must not be able to call a dialog `idle` and have your prompt and Enter typed into it.
- **The cap**: a session that runs longer than `--max-runtime` is asked to end the way the phone's *end session* does — the agent's own quit command, then signals. It is never killed; one that stays keeps the schedule from starting its next run (`overlap`).
- **The phone is told** with one push per listener tick, listing each schedule with how many times and why (`<label> · 놓침 31회` — the push is in Korean). A run skipped because the last one is still going counts once until the result changes; a push that does not go out is tried again after 30 seconds, then 1, 2, 4 … minutes up to 30 (only a refusal by the server, such as the daily limit, is not tried again; a timeout, a proxy or a captive portal in the way is), and is dropped after 24 hours. The push has one title per kind of news — skipped or missed, over its runtime, or a prompt not typed — and a general one when a push holds several kinds. The prompt is never in it. A free account sends at most 100 pushes a day (`pushPerDay`), which is why these are batched.
- **Editing**: `hwip schedule edit <id>` changes the time (`--at`, `--days`, `--every`), `--prompt` and `--max-runtime` of a schedule in place; the id, the session, the directory and the agent stay. What a flag does not name is kept — `--at` keeps the days, `--days` the time. A changed time counts from the edit: the times before it are neither started nor counted as missed, and an `--every` schedule runs one period after the edit; changing only the prompt or the run time keeps the schedule on its times. A session already running keeps going. A listener of an older build is restarted first, because it would skip the edited file as unreadable; when it cannot be replaced, a new time is not written (exit 1) and the schedule keeps running as it was.
- **State** is files under `~/.local/state/hwip`: one `schedules/<id>.json` per schedule (limit 20) and `schedule-state.json`, written only by the listener, with where each schedule has got to. `agent-dirs.json` holds the directories `hwip <agent>` typed in a shell found its agent in: a listener run as a login service has only the PATH its service file baked, so a scheduled launch adds these to it — run an agent from a shell once (`hwip cc`) before scheduling it, or the run is skipped with `'claude' not found on PATH` in `~/.hwip/listener.log`.
- **From the phone**: the app lists the schedules of a computer, makes one for a session this computer has run, edits one, and removes one. It names the session, a time and what to do; the directory, the agent's command and its arguments are never the phone's (see *Defense*). A schedule made there needs an agent that can take a prompt, and shows in `hwip schedule` like any other.

### Session history

So the app can show a conversation after the fact, the listener reads each
agent session's transcript (Claude Code, Codex, pi, Gemini CLI, and OpenCode 2.x from its
database) with nobody watching and
uploads what was said as small **sealed** chunks (`POST /sessions/<key>/turns`).
A chunk holds your prompts, the agent's replies, and one line per tool — its
name, what it acted on, and how many lines changed — never a tool's arguments,
output or file contents. Each chunk is sealed for this machine and every device
the account lists with a key (the newest pins first, within the server's
slot limit), so the
server stores ciphertext only, on every plan; a device that signs in later
cannot open earlier chunks. While the account lists no other device with a key,
or its device list has never been fetched, nothing is read or sent. Uploads also wait until this machine's own device key is
registered with the server. Opt out with `--no-turn-history` or `"turnHistory": false` in
`~/.hwip/config.json`; the log says which way it went. The chunks wait in a
small outbox under the state directory (ciphertext and read positions only — a byte
offset, or for OpenCode row numbers and their keys) when
the network is down, and go out in order once it is back — also after the
listener restarts, even when the session they belong to did not survive (a reboot
ends every tmux session): such a session is followed to the end of its
transcript, then forgotten. A session that has been quiet for a long time keeps its
state while its transcript exists, so nothing already sent is sent again (an OpenCode
session, which has no file to check, for 30 days).

A tmux name is used again when an agent starts in the same folder, so each
chunk also names its **run** — the tmux session it was recorded in (`runId`,
tmux's `session_created` in epoch seconds). The app uses it to keep one run's
conversation apart from the one before it under the same name; a chunk read
after a restart keeps the run it was recorded in. The listener's record of past
sessions keeps runs apart the same way: closing `hwip cc` and starting it again
in the same folder leaves the first run as a past session of its own (the
newest ten runs of a name are kept, 100 in all, and up to 50 are reported to
the phone). Each run is reported with the block of chunk numbers it took — the
first and, once it has ended, the last — kept in `run-seqs.json` next to the
registry, so the server reads one run's conversation from that range instead of
every chunk the name ever had. Deleting a past run from the phone forgets that
run on this machine too, even while a later run of the same name is going; the
run that is going is refused (`still_running`).

When a session waits for your approval, the listener also sends what it is waiting
for — the tool, the command or the diff, and the answers — so the app can show it
and answer. That covers Claude Code (a Bash command, a file edit or a new file),
Gemini CLI (its tool approvals), OpenCode (its permission request; the listener reads
the screen with its colours, since only a colour marks the chosen button) and pi
approval extensions that ask through `ctx.ui.select`. Codex's approval dialog is not
read yet. It is sealed the same
way as a chunk, for the same pinned devices, and turned off by the same
`--no-turn-history`; the server stores ciphertext only. Other dialogs (a plan, a
question, a trust prompt) send nothing beyond the state. An answer the app sends is
typed only while that same prompt is still on screen: if you have moved the
highlight or answered at the keyboard, the command is refused (`prompt_changed`)
instead of landing on whatever is there now.


### Diagnostics

The auto-spawned listener writes to three files under `~/.hwip/`:

- `listener.pid` — the running daemon's PID. `cat ~/.hwip/listener.pid`
  + `ps -p <pid>` to confirm it's alive.
- `listener.version` — the CLI version the daemon booted from. This is
  what `hwip cc` compares against the installed package to spot a stale
  daemon (see below).
- `listener.log` — stdout + stderr from the daemon. `tail -f` to watch.

The daemon logs its version on the first line, which is the only
reliable way to tell which build a long-running process is on:

```
[xx:xx:xx] hwip listener starting — v1.26.0 — wss://ws.hwip.app
```

A healthy listener log shows one line per cycle:

```
[xx:xx:xx] reported 2 session(s): hwip-myapp, hwip-otherapp
[xx:xx:xx] ✓ server persisted 2 session(s)
```

If you see `! server rejected listener.sessions: ...` instead, the
message points at the failure (auth, missing device record, etc.) so
you can fix the actual problem instead of guessing.

To force a restart:

```bash
hwip listener --restart
```

It gives the new daemon 1.5 s (under launchd, after it has written its pid
file, up to 5 s in) and exits 1 when that daemon is already gone, with the
last line it logged — a rejected key, say:

```
hwip listener: the listener stopped right after restarting — hwip listener: API key required. (log: /Users/you/.hwip/listener.log)
```

With the service installed launchd restarts such a daemon on a loop, so
`hwip cc` makes the same check after asking launchd and prints `hwip: the
listener stopped right after starting — …` instead of reporting a start.

**After upgrading `@hwip/cli` you normally don't have to.** `npm i -g`
replaces the package on disk but never the daemon already running from
the old build — that daemon keeps answering pushes (so agent chat looks
fine) while silently ignoring every message subtype added since it
booted. `hwip cc` compares `listener.version` against the installed
version and restarts the daemon for you when the installed one is newer
(a daemon *newer* than the `hwip cc` you ran is left alone, so several
installs on one machine don't fight over it):

```
hwip: listener 1.25.0 is stale — restarting on 1.26.0
```

If the PID file is missing (a different account started the daemon, or
it was removed by hand) the singleton guard can't see it. Find the real
process instead:

```bash
ps aux | grep '[c]li.js listener'
```

To run it in the foreground (for development of the SDK itself):

```bash
hwip listener
```

You'll get the same logs you'd otherwise tail from `listener.log`.

### Custom tmux sockets

The listener auto-discovers the tmux socket — it probes the default
socket first and stops there when it answers. Otherwise it probes every
socket file in the per-user `tmux-<uid>/` dirs (`$TMUX_TMPDIR`/`$TMPDIR`,
macOS `/var/folders/.../T/`, `/tmp/`), which is where `tmux -L <name>`
puts its socket. Only when none answers does it ask `lsof` which socket
each running tmux process holds — the slow path, which also covers a
`-S` path outside those dirs. If your tmux
uses `tmux -L <name>` or a non-standard `-S <path>`, set the override
explicitly:

```bash
export HWIP_TMUX_SOCKET=/path/to/socket
```

(The wrapper passes the env to the auto-spawned listener, so setting
it in your shell rc is enough.)

### Wire format

The listener only acts on pushes with `type='agent.command'` carrying
the tmux session name in `agentSessionName` and the message in `body`.
Other pushes (Stop-hook auto-pushes, `hwip_ask` responses, channel
broadcasts, plain notes) are ignored. End-to-end:

```
tmux send-keys -l -t <agentSessionName> "<body>"
tmux send-keys    -t <agentSessionName> Enter
```

If you need to send one from the command line (debugging, scripting),
build the structured push directly:

```bash
curl -X POST "$HWIP_BASE_URL/pushes/send" \
  -H "X-API-Key: $HWIP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "agent.command",
    "targetDeviceId": "dev_listener_<sha8(hostname)>",
    "agentSessionName": "hwip-myapp",
    "body": "테스트 통과시키고 PR 올려줘"
  }'
```

The phone also reads this machine's schedules (see [Scheduled sessions](#scheduled-sessions)) over the ephemeral relay, with two more subtypes:

```
{ subtype: 'agent.schedule.list.request', targetDeviceId, requestId, subscriberPublicKey? }
{ subtype: 'agent.schedule.list.result',  requestId, at, schedules | encrypted | error }
```

`schedules` is the list as a JSON string; `encrypted` is the list sealed for the asking device (purpose `schedule.list`, bound to this machine's device id) as `{ v: 1, requestId, at, schedules: [...], unreadable? }` — the app checks that the `requestId` inside is the one it asked, so an older sealed list is not taken for a newer answer. `unreadable` is how many schedule files could not be read; a directory that cannot be listed at all, or that holds more than 20 files, is the error `read_failed`, never an empty list (and a remove then fails as `schedule_failed`; `hwip schedule rm` still works on the computer). A list too long for one frame has its prompts shortened, step by step (`too_large` only when it does not fit even without them). Each entry holds `id`, `source`, `agentKind`, `project` (the directory's name, not its path), `session`, `when`, `prompt` (cut to 500 characters, shorter when the list would not fit; `promptLocked: true` says the phone cannot change it — it is not the whole text, or the schedule has agent arguments — so the app leaves it to `hwip schedule edit`), `maxRuntimeMin`, `nextAt` and the `last` result — never a directory path or the agent's arguments.

### Your API key and redirects

Every request that carries your API key refuses to follow a redirect: a host
that answers with one (to another host, or from https to http) would otherwise
be handed the key. The call fails with "answered with a redirect … check the
base URL", so a base URL that redirects has to be corrected rather than
followed. The key is also taken out of the socket error line and the CLI's final
error line (`apiKey=***`), and a base URL with credentials written into it
(`https://user:pass@host`) is refused without being repeated (below).

`~/.hwip` is kept at `0700` and `listener.log` at `0600` (it can quote what the
listener was handed). `~/.hwip/config.json` says where your key is sent, so it is
checked when read: a file that another user owns or that anyone can write is
ignored with a warning (`HWIP_API_KEY` and `--key` still work, and nothing is
saved over it), and one that your group or others can reach is restricted to
`0600` and used (a symlink, as dotfiles use, is judged by what it points at). A
`config.json` that cannot be read as a JSON object (a stray comma, half a file, bytes that are not
UTF-8) is ignored with a warning too, and `hwip install` and `hwip login` stop before they ask for
anything and name the file: they would otherwise replace it with the new key alone and drop your
`baseUrl`, `wsUrl` and your other settings. Fix it, or move it aside, and run the command again. Saving is a
write-then-rename, so a crash leaves the old file or the new one, and a write by another process in
between is an error, not a lost update.

Run with `sudo` where your home folder is kept (macOS), a first `hwip login` or `hwip install` would make
`~/.hwip`, `config.json` and the device keypair root-owned, and the next plain `hwip` could neither read the key nor save to
it. What root creates there now goes to the user who ran `sudo` (`SUDO_UID`/`SUDO_GID`) — only inside
a home folder that user owns, so a root whose `HOME` is `/root` keeps its own files. The same goes for the state folders and files hwip keeps (hook state, the shell audit log, the turn ring, the trust state, the listener's runtime files). The agent-rules
manifest is fetched from the same base URL as everything else: with a `config.json` that cannot be
read, `hwip` does not fetch it from the default stage but keeps the manifest it has.

While a `config.json` is ignored (it does not parse, or anyone can write it) the listener keeps
running when it has a key from `--key` or `HWIP_API_KEY` (and, for a file that does not parse, a base
URL from `--base-url` or `HWIP_BASE_URL`), but with every on/off option **off**: `"turnHistory"` and
`"keepAwake"` are opt-outs, and reading an unreadable file as "nothing set" would turn them back on
and start uploading the conversations you had switched off. The listener log says so, `hwip verify`
shows a failed row naming the file, and a restart after fixing the file picks the options up again.
The login service has no key in its environment, so with such a file it cannot start (exit 3, retried
every 30 s) and the log names the file. A command that needs the API base URL and cannot read the
file it may be in (`notify`, `ask`, `trust <deviceId>`, `verify --ping`, `listener`) stops and says so
instead of sending the key to the default API; `--base-url` or `HWIP_BASE_URL` says where. A base URL or socket URL that sends the
key over plain `http://` or `ws://` to a host that is not on this machine draws a
warning (`hwip verify` shows it as a warning row). A base URL with a user name or password in it
(`https://user:password@host`) stops those commands as well: no request can be made to such an address, and the
message says where it came from (`--base-url`, `HWIP_BASE_URL` or the file) without repeating it. Where a command shows which
key is in use it prints the prefix only (`ak_…`).

The key in the file belongs to the addresses the file says (`baseUrl`, else the default API), so it does not
follow an address from the environment: with that key, an `HWIP_BASE_URL` on another origin stops the command
(`install` too, before it checks or saves the key against it), naming both origins and no more. Set `HWIP_API_KEY`
or pass `--key` as well (a key given with the address goes with it), pass `--base-url` (your word on that
command), or unset the variable; the same origin is always fine. The deprecated `HWIP_WS_URL` is held to the
same rule: with the file's key it is used only for the default socket's origin, otherwise it is skipped with a line
saying so — put `wsUrl` in the file to name another socket.

### Defense

The listener is a remote-code-execution surface by design (it types
into a shell-adjacent pane). The defense is layered:

1. **Pane guard** — before injecting, the listener checks the pinned
   pane's `#{pane_current_command}`. If the pane is at an interactive shell
   (`bash`/`zsh`/`fish`/`sh`/`dash`/`ksh`/`tcsh`/`csh`/`pwsh`), the inject
   is refused. CC/Codex/Gemini exited ≠ phone gets free shell access. The
   one exception is a `hwip sh` session: its `@hwip_shell` session option
   names the session itself. Only a process on this machine can set a tmux
   option, and a value inherited from `set -g` names no session. The marker
   says you opened that shell; it is not a boundary — see what it does not
   stop, below.
2. **Addressed shells only** — a marked shell takes a REST
   `agent.command` only when its `targetDeviceId` is this machine. An
   agent session still takes an unaddressed one, which `push.new` fans out
   to every listener of the account; for a shell, two PCs with `hwip sh`
   open in the same project would both run it. Stream input already
   arrives on one listener's own subscription.
3. **Nothing a shell would misread** — into a marked shell the listener
   refuses attachments (their paths would arrive as lines, each a command),
   control bytes such as ESC (which can leave a bracketed paste), and a
   newline in an insert (a shell without bracketed paste, such as macOS
   `/bin/bash` 3.2, would run it). A multi-line body is allowed: each line
   is a command you meant.
4. **Audit** — every input admitted into a shell session is one line in
   `$XDG_STATE_HOME/hwip/shell-audit.log` (default
   `~/.local/state/hwip/shell-audit.log`, mode 0600; past 1 MiB it moves to
   `shell-audit.log.1`, replacing the one before): time, session, pane,
   kind, foreground program, and the text only when the shell itself was in
   front. Input to anything else — a `sudo` or `ssh` password prompt — is
   recorded as `[N chars → "sudo"]`. `listener.log`, which is not private,
   shows only the length. The foreground is judged when the input lands, so
   a secret read by the shell itself (`read -s`) is logged in full, and a
   command typed inside `sudo -s` or `ssh` is logged by length only.
5. **Literal injection** — text is delivered as a paste of data, not typed
   key names; tmux escape sequences inside a message can't drive other tmux
   commands.
6. **Session-name allowlist** — only `[A-Za-z0-9._-]+` is accepted as
   a session target, so shell metacharacters never reach the tmux argv.
   Agents skip a shell: `hwip agent send` (and `hwip send`, its older name) and `hwip_agent_send` (from
   `@hwip/mcp-server` 3.3.0) drop `agentKind: "shell"` sessions from
   their candidates. The check runs on the sending machine only, so an
   older `hwip` on any machine of your account can still type into your
   shell — update every machine that runs agents before you open one.
7. **Per-session rate limit** — a token bucket caps a runaway or
   compromised sender, shell sessions included.
8. **Agent permission gate — with one hole.** Your CC/Codex/Gemini
   permission prompt still stands in front of every tool call the agent
   makes. But Claude Code's `!` prefix runs a shell command directly, as
   typed input, with no permission prompt, and text the phone injects is
   typed input: `!<command>` sent to a Claude Code session runs on this
   machine. This is accepted, and it is how `!hwip sh --detach` opens a
   shell from the phone.

What the marker does not stop: anything running as your user on this
machine can set `@hwip_shell` on a session, or run `hwip sh` itself — and
so can the phone, while a Claude Code session (`!tmux set-option …`) or a
marked shell is open to it. It keeps the phone from choosing panes only
when neither is.
And no layer authenticates the sender: whoever holds your API key, or
controls the backend, can type into every marked shell and, through `!`,
every Claude Code session.

The transport (WS) is authenticated by API key + `push:read` scope.
Whether your backend also reads what crosses it depends on the phone
handing the listener a key:

- **No key — an older app.** It has no device keypair to hand the
  listener, so pane frames and the messages you type both cross the relay
  in plaintext. This listener answers that only until it has pinned a
  device (below); after that it refuses a request that asks for plaintext.
- **A key — the app.** The phone sends its device public key and a
  fresh nonce when it subscribes, and every pane frame comes back
  inside envelope v2: ECDH P-256 between the two device keys, HKDF-SHA256
  with a fresh salt and the message's purpose (`stream.frame`,
  `stream.input`, `stream.alive`, `stream.started`, `screen.snapshot`,
  `screen.history`, `session.diff`, `schedule.list`, `turn.batch`) as the key's info, and
  AES-256-GCM over data that names the purpose, both keys in send →
  receive order and the session. The sealed frame also holds the
  session name, its `seq`/`epoch` and that nonce, so a relay that cannot
  swap in a key of its own (below) can't move one to another stream,
  replay one from an earlier subscription, or hand one back as input —
  or as anything else this listener sealed for the phone. A history page
  (scrolling up past the live window) holds the same nonce and `epoch`,
  the request id it answers and where it sits in the scrollback, so a
  relay can't hand an earlier page back under a new request or move
  where the next one is asked for; only the request id rides beside it
  in the clear. Your
  keystrokes are sealed for this listener as `stream.input` with their
  `seq`/`epoch` stamps, the stream's start epoch and the phone's device
  id inside, so a forged restart can't replay them. The start answer (`agent.stream.start.ok`)
  says the listener seals v2 (`sealVersion: 2`), sealed for the phone on
  a sealed stream; a phone that has seen it never takes the older
  envelope from this machine again. A frame that fails to encrypt is
  dropped, never downgraded.

Two gaps. A message sent while no live stream is open falls
back to REST, which is plaintext to the server unless the phone has
sealed with this computer before (then it is sealed, below) — that
includes every `@<session>` command from the agent chat, and every
command typed into a `hwip sh` shell. Until this listener has pinned a
device, a shell's screen crosses the relay in plaintext too, so keep
secrets off both.

**Whose key it seals for.** A viewer asks for sealed content by sending
its public key, and the relay could put its own there. So the listener
takes a key — on a stream subscription, a chat timeline watch, a diff or
a screen snapshot request — only when it is the key the account's device
list holds for the device the relay says is asking. Any other key gets
an error (`subscriber_unverified`; `subscriber_key_in_use` for another
id asking with a key pinned for a different device) and no pane: nothing is read off
the screen until the key has checked out. The device is pinned in
`~/.hwip/trusted-devices.json` the first time it is seen — by the listener
or by a send of this computer, whichever comes first — and a key that
changed (the app was reinstalled) replaces the pin with one log line,
`trust: <deviceId> changed its key — now pinned to the new one`, and is
not refused. The change is also recorded for a person (see Encryption →
key changes), since nobody reads the daemon log. The app pins the listener's key the same way and stops when
the device list shows another one.

Pins are a record, not a gate: the account's device list decides which
key to believe, and the pins tell this listener when plaintext is over.
Nothing needs `hwip trust`; it is there to look at the record:

```bash
hwip trust                 # this computer's fingerprint, and the pinned devices
hwip trust <deviceId>      # pin the key the account now lists for that device
hwip trust --reset         # forget every pin; each comes back as it is seen again
```

A fingerprint is the first 16 bytes of SHA-256 over the key, as eight
groups of four hex digits. The app shows the same string for the same
key on the device's page, and the listener prints its own at startup:
comparing the two by eye is the check that no key was swapped in
between. It is the only check for what pinning no longer catches — a
backend that registers a device of its own, or lists another key for a
device you know, is followed like a new phone or a reinstalled one.

A screen snapshot — the answer to `agent.screen.request` — is sealed
for the asking device under the same rule.

The schedule list — the answer to `agent.schedule.list.request` — follows
the same rule: sealed for a key that checked out, in the clear only for a
request without a key while this listener pins no device, and otherwise an
error code (`e2ee_required`, `subscriber_unverified`, …) and no schedule. Prompts are in
it, so a request that asked for a seal is never answered in the clear.

**Reading a session's changes** (`agent.diff.files.request` and
`agent.diff.file.request`) is sealed both ways and never answered in the
clear: a request without a key gets `e2ee_required` whether or not this
listener pins a device. What
the request asks — which comparison (the uncommitted changes, or the point
this branch left the default branch), which file, which page — is inside
a sealed question (`session.diff`), so the relay does not see the
comparison, the path, the page or any content. A request that fails is
answered with an error code in the clear (`bad_path`, `no_default_branch`
and so on), which the relay can read and nobody has vouched for. The answer
is sealed back for the same key and carries the request id, the comparison, the path and the offset
inside the seal, which the app checks against what it asked. The file
list also carries, inside the seal, the branch the session's repository is on, the name of the ref it
follows (`origin/main`, not the remote's URL) and how many commits it is ahead of and behind that ref;
a repository with no commit yet leaves that field out, and a `rev-list` that outlasts the request's
time budget leaves out the counts; the list is unchanged either way. The
listener runs `git` only after the key has checked out and the question
opened; the session name picks a directory, the comparison is one of two
fixed choices, and a path is resolved inside the repository (an untracked
file that `.gitignore` covers is neither listed nor shown; a file git tracks
is shown whatever `.gitignore` says). The repository's own configuration is
not trusted, and git can run commands it names. Switched off: `core.fsmonitor`,
external diff drivers and textconv filters, a repository nested as a submodule
(its content is not shown, its config does not run, and a changed submodule
pointer is missing from the list), the lazy fetch of a partial clone
(`remote.<name>.uploadpack`), and the listener's own `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_EXTERNAL_DIFF`, `GIT_ATTR_SOURCE` and `GIT_CONFIG_*`, which are not passed
to git. `GIT_NO_LAZY_FETCH` is heard only by a git that knows it (the release
notes of git 2.45 introduce `--no-lazy-fetch`; the variable's own first release
is unchecked). The `clean` and `process` commands of the filters the config
defines are blanked as git is asked to compare the working tree; a driver whose
name cannot be blanked, or is named `set`, `unset` or `unspecified`, fails the
request. Not closed: the filters are listed by one git run and used by the next,
so a config changed in between can still run a filter once.

A file that a `filter=` attribute names (git-crypt, transcrypt, LFS, global
git-lfs included) is listed without a patch, marked like a binary file with no
counts: without its filter the working-tree file would read as all added lines
in plaintext. The attributes are read from the working tree and from the base
revision, and a file counts as filtered if either names a filter; a git without
`check-attr --source` (before 2.40) fails the request, and so does an
`info/attributes` that unsets `filter` (it outranks both). A patch is asked for
one file at a time: a path that is a directory, or that git would diff as more
than that one file, is `bad_path`. What stays: a filtered file renamed or copied
to a name no filter covers shows that name's plaintext (git does the same); a
filtered file that was only touched may be listed as changed, without a patch.
Other config that names commands is not reviewed one by one — the listener reads
repositories a session already works in. Strings that look like
secrets (well-known token formats, `password = …`-style assignments,
private key blocks) are masked before sealing, and the answer says how
many places were; that is best effort, not a promise.

**Reading a session's files** (`agent.diff.tree.request` and
`agent.diff.blob.request`) rides the same channel and the same seal as the
changes above (`session.diff`): sealed both ways, never answered in the clear,
the relay sees neither the path nor the listing nor any content, and the
answer carries the request id and path (a file page also its offset) inside
the seal. The two kinds share a label, so what tells a file answer from a
diff answer is the `kind` inside the seal, which both ends check; a
`tree` or `blob` request that carries a comparison is refused as
`bad_request`. What the phone may see is what git lists: the tracked files and
the untracked ones `.gitignore` does not cover. An ignored file, a path
that is not there and one outside the repository are all answered `absent`
inside the seal, so asking for a name does not tell whether it exists. The
content is the working tree, read by the listener itself, one file at a time:
a symlink is shown as the text it points to and never followed (a symlink
among the directories on the way makes the path `absent`); a submodule or a
nested repository is shown as one and never entered; a file that is not a
regular file is `absent`; a file with a hard link, one named like a secret
(`.env` and `.env.*` except `.env.example` and `.env.sample`, `*.pem`, `*.key`,
`*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `credentials*` —
fixed in the code, not a setting), and one a `filter=` attribute names are listed but
not shown. A file over 1 MiB is `too_large`; one with a NUL in its first 8,000
bytes is shown as binary and its size. Strings that look like secrets are
masked in the whole file before it is cut into 16 KiB pages, and each page says
how many places were masked in the file; that is best effort, not a promise. The
only git commands this adds are `ls-files` (twice, for the visible set) and the
`check-attr` that finds `filter=`; `git status` is not run (the app lays the
changed files of the changes view over the listing). A request that fails is
answered with an error code in the clear (`bad_path`, `file_view_off` and so on),
which the relay can read and nobody has vouched for.

A session may read 32 MiB of file text in 10 minutes; past that, file page requests
are `rate_limited` until the window ends (listings keep working). Every file view request that opened
under a key the listener admitted adds one line to its log (`~/.hwip/listener.log` for a listener started by `hwip cc` or as a service; one run in the foreground prints to its own terminal, and `hwip file-view log` then has nothing to show): when, the device,
the session, listing or file, the path, the bytes read, the places masked and
how it ended, never any content (names are written so a control character in
one cannot start or redraw a line). It stays on this computer, nothing is
pushed anywhere, and `hwip file-view log` prints the last 50 (the log rotates at 5 MB and keeps one
older copy, which `log` reads when the current one has fewer).
`hwip file-view off` stops it for the project (the repository root) and
`hwip file-view off --global` for every project; the listener answers
`file_view_off`. A switch file that cannot be read counts as off, and
`HWIP_FILE_VIEW=0` in the listener's environment switches it off for that run. It
is on until turned off. Not closed: between the checks and the open a directory
on the path could be swapped for a symlink, which the listener looks for again
after the open but cannot make atomic on macOS; and two paths that reach the
same file without a hard link (a bind mount) are not told apart.

Once the listener has pinned
a device, it stops answering
in the clear until the pins are forgotten: a stream start, snapshot request or chat
timeline watch without a key gets `e2ee_required` (a keyless stream start
is refused before it would restart the sealed stream of that session; a
stop is not checked and still ends it), a plain stream already running
ends at its next capture with the same error, and the unsolicited
snapshots after a REST key press are no longer sent, since nobody asked
and there is no key to seal them for. The app, for its part, never subscribes in the clear to a computer
it has sealed with.

What you type in the app's conversation for such a computer is sealed
too: the stored command's body is sealed for this computer and the
phone, and inside it a label names the session, this machine and a
number that only grows per phone. The listener types it only when the
phone's key checks out like a stream subscriber's, the label is for this
session on this machine, and the number is above the last one it took
from that phone — kept in `~/.hwip/trusted-devices.json`, so a command
sent again is refused after a restart too, and `hwip trust --reset`
keeps the numbers. Beside the per-id numbers the file holds, per sealing
key, the largest number taken with it (`commandKeys`, optional; an older
hwip that saves the file drops it): a number must be above both, so a
command already taken is refused under a new id, after `--reset`, and
after the phone changed its key. The key column covers the numbers this
version took, plus the id numbers of the devices pinned when `--reset` or
`hwip trust <deviceId>` drops or replaces a pin (those are written beside
the old key first); a number of an id that was not pinned at that point has
no key to go with. A key is told by the x coordinate of its
point alone, because a sealed push opens from that coordinate and a relay
can make the mirrored key (x, p − y) without any secret. A key already
pinned for one device is not taken under a second id
(`subscriber_key_in_use`): the id is stamped by the relay, so it could
otherwise hand an old command a number of its own. Nothing is forgotten to
make room: once 64 senders or 64 keys have numbers, a command from a new
one is dropped (the log names the field in `trusted-devices.json`), because
a number forgotten is a command that can be typed again. `--reset` does not
free those slots, and a device that changes its key under one id fills the
key column too (64 changes). The only way out is editing
`trusted-devices.json` by hand, and a number deleted there can be typed
again. If the
same phone really came back under a new id, `hwip trust <deviceId>`
pins it after you compare fingerprints. A file sent with it is sealed for this computer and
the phone too, and the sealed body names each attachment (by its IV, in
order), so the relay can neither drop one nor swap in another. The
command is typed only once every named attachment has come down and
opened with this machine's key — never half of it. Keys or an insert
beside a sealed body, or attachments other than the named ones, refuse it.

A listener that only seals (it pins a device: see above) does not type a plaintext `agent.command` either: a plain
`body`, `insert`, attachment or `keys` is refused whole, and the phone is told
`e2ee_required` (a code, never the text). The approve button on the phone
seals its keys instead, so it keeps working. A listener with no device list to check against, and one that pins no
device, takes plain commands as before; an unreadable
`~/.hwip/trusted-devices.json` counts as sealed-only. `hwip trust --reset`
forgets the pins, and with them goes back to taking plain commands until a
device is pinned again.

**A schedule request** — the phone making, changing or removing a scheduled session — rides
the same `agent.command` push, with a `schedule` field and no `body`. It carries
a time, a prompt and, if the phone says so, an agent and a run time — and nothing
else. The directory and the agent come from what this machine recorded for the
session the push names (the way a resume does), so the phone cannot point a
schedule at another directory; it cannot send agent arguments, a worktree or a
label either, and a request that carries one is refused rather than ignored
(`schedule_invalid`; `schedule_limit` at 20 schedules; `unknown_session` for a
session this machine never recorded; `schedule_failed` when this machine's own
files would not read or write). A change (`op: 'update'`) carries the schedule's id
and any of the time, the prompt and the run time; what it leaves out stays as it was,
and a change with none of them is refused. A schedule made on the computer with agent arguments keeps its prompt: the phone may change its time and run time, not what is typed under those arguments. A change and a remove name the schedule's own
session, so they cannot reach another. A listener of an older build refuses a change as
`schedule_invalid`. Applying a request never types into a
session. The request is sealed like any
command — the whole of it inside the body, only `op` beside it, and the sender,
label and counter checks above apply, so a replay or a swapped `op` changes
nothing — and a listener that only seals refuses a plain one (`e2ee_required`).
A sealed request refused for `schedule_invalid` or `schedule_limit` is told to
the phone as `sealed_rejected`, because those were read from text the relay
cannot see; `unknown_session`, `rate_limited` and `schedule_failed` go out as
themselves.

## CLI Usage

```bash
# Send a notification
hwip notify --title "Deploy done" --body "v2.1.0 shipped"

# Send with priority
hwip notify --title "Build failed" --priority high --url https://ci.example.com/123

# List recent pushes
hwip list
hwip list --limit 10 --type note

# Dismiss a push
hwip dismiss push_01JXY...
hwip dismiss --all

# Rename the current agent session (shows in the app's Agents list)
hwip rename "Prod deploy"
hwip rename --clear                # reset to the default name

# Type a message into another agent session, here or on another PC
hwip agent send dev_listener_ab12cd34:hwip-api "Build is green — rerun the e2e suite"
hwip agent send hwip-api "…"       # a name/alias works when it names one session
hwip agent send hwip-api - <<'EOF' # a long message on stdin; the quoted heredoc expands nothing
Build is green. `npm test` passed.
EOF

# See which agent sessions run on THIS PC, and what one did last (this machine only)
hwip agent list                    # KEY  AGENT  STATE  NAME; --json for scripts
hwip agent read hwip-api           # its last 3 turns: prompt, the agent's text, tool names
hwip agent read dev_listener_ab12cd34:hwip-api --turns 5 --json

# Drop an ended session from this machine's record (it leaves the app's past list)
hwip forget hwip-myapp-20260914-PLAN-11-32-44-pi
hwip forget --ended                # every session tmux no longer has

# Test connection
hwip test

# Run an agent in a named tmux session (so the listener can reach it)
hwip cc                       # claude
hwip codex                    # codex
hwip cursor                   # cursor-agent (Cursor CLI, not the IDE)
hwip gemini                   # gemini
hwip hermes                   # hermes
hwip kimi                     # kimi (Kimi Code)
hwip grok                     # grok (Grok Build)
hwip agy                      # agy (Antigravity; also `hwip antigravity`)
hwip qwen                     # qwen (Qwen Code)
hwip auggie                   # auggie
hwip kilo                     # kilo
hwip copilot                  # copilot (Copilot CLI)
hwip kiro-cli                 # kiro-cli (Kiro; also `hwip kiro`)
hwip droid                    # droid (Factory Droid)
hwip cc --wt feat/x           # claude in a new git worktree + branch (../<repo>-wt-feat-x)
hwip worktree                 # the worktrees --wt made, and what keeps each
hwip worktree clean --dry-run # what clean would remove (no --dry-run: removes it)

# Start an agent session on a timer (the listener starts it, so it has to be running)
hwip schedule add cc --at 09:00 --days weekdays --prompt "Triage the open issues"
hwip schedule add codex --every 2h --max-runtime 30m
hwip schedule                 # the schedules, with the next run and the last result
hwip schedule rm k3x9aq       # remove one; a session it already started keeps running

# Run the resident listener (foreground; background it as you like)
hwip listener
hwip listener --ws-url wss://...   # override config

# JSON output
hwip notify --title "Hello" --json
```

### Commands

| Command | Description |
|---------|-------------|
| `login` | Browser sign-in: auto-fetch API key + hook into `~/.hwip/config.json` over a localhost loopback (`--web-url`, `--timeout`, `--allow-host`); the key comes back in a POST body, not in a URL. No copy-paste. Over SSH it opens no browser here: it prints the URL and the `ssh -L` line that forwards its callback port, so a browser on your own machine can finish the login, and still waits for it. The callback's `baseUrl` / `wsUrl` must be `https` / `wss` on `hwip.app`, the `--web-url` host or a host already in `config.json`; `--allow-host a.example,b.example` adds hosts you name (and their subdomains) for a self-hosted API on an unrelated domain — bare host names only. `install` takes the same flag for its browser sign-in. On a Linux box with no display, or when the opener fails, it says why and points at `install --key` instead of waiting |
| `install` (alias: `setup`) | One-command setup: detect agents, save config, install rules + hooks + MCP. No saved config → opens browser login automatically (inside it, Enter skips to pasting the key). `--only claude,cursor,…` skips the picker (`cc` = `claude`; an unknown id is a usage error, exit 2). A key the API rejects is not saved (exit 3); a step marked `-`, the test push included, ends it with exit 1 (with `--key`, a missing tmux is a note, not a failed step); with no terminal for the agent picker it is a usage error (exit 2) — pass `--key` for a scripted install |
| `uninstall` | Remove Hwip from all detected agents and stop the listener (`--dry-run`, `--purge`). Asks first when stdin is a terminal — answering no exits 1; `--yes` skips the question |
| `verify` | Check installation health across detected agents (`--ping` for a live API call, with the key and API base every command resolves: `--key`, `--base-url`, then env, then config; `--json` prints the checks as one JSON object). Reports whether tmux is on PATH and whether the listener is running — both warnings, since notifications alone need neither. A settings file it cannot parse is a `!` line, not "not registered". Shows the last failed push, if any (see *Last push failure*). Also reports the resolved WebSocket URL **and where it came from** — `--ws-url`, config, the deprecated `HWIP_WS_URL`, or the built-in default — warns when the socket and the API base are on different stages, and warns when the running listener is on a different URL than the one that resolves now (it reads the config once, at startup) |
| `check-update` | Check whether a newer Hwip version is on npm |
| `notify` | Send a push notification |
| `ask` | Ask the phone a question and wait for the answer — for hooks, which cannot call the MCP `hwip_ask` tool. `--title` (required), `--body`, `--actions id:Label,…`, `--timeout <s>` (default 60), `--accepts-exit` for an agent's own ask (the phone may "send and exit" and attach files, and the answer settles REMOTE like `hwip_ask`; attached files are saved sealed-and-opened to `~/.hwip/attachments/<eventId>/`, their paths follow the text in `value` and are listed in `files`, and `missingFiles` names any not saved). Key and API base resolve like every command. Prints one JSON line — `{"answered":true,"actionId":…}` or `{"value":…}`, else `{"answered":false,"reason":"cancelled"\|"timeout"\|"error"}`; `"resumed":true` is added when the outcome is of a question an earlier run of the same command put up (see "A question cut short"). Exit 0 answered, 1 not. The question and the answer travel sealed, always (see Encryption); an answer that cannot be verified is an error, never an approval. With no app signed in to the account it prints `no app is signed in to this account` and exits 1 |
| `ask-context [status\|on\|off\|show] [--global]` | The switch for the context a sealed question carries (a git diff against HEAD and the terminal's last lines, masked, sealed on every send — see Encryption). On unless turned off: `off` for the project the current directory is in (its repository root), `off --global` for every project, `on` to undo either; `status` says which applies. It is a state file under `$XDG_STATE_HOME/hwip` (`ask-context-off-<project hash>`, `ask-context-off-default`) and never leaves this machine; `HWIP_ASK_CONTEXT=0` switches it off for one run. A switch file that cannot be read counts as off. `show` prints one JSON line, `{"context": …}` — the summary and the masked original a question asked from the current directory would carry, `null` when there is nothing, with `"off"` naming why when the switch is off — and sends nothing (the MCP `hwip_ask` tool reads it) |
| `file-view [status\|on\|off\|log] [--global]` | The switch for the phone browsing this computer's files (a session's repository — see Defense). On unless turned off: `off` for the project the current directory is in (its repository root), `off --global` for every project, `on` to undo either; `status` says which applies. A state file under `$XDG_STATE_HOME/hwip` (`file-view-off-<project hash>`, `file-view-off-default`) that never leaves this machine; a switch file that cannot be read counts as off. `log` prints the last 50 reads the phone made, from `~/.hwip/listener.log` (time, device, session, listing or file, path, bytes, secrets masked, result) |
| `list` | List recent push notifications. An end-to-end encrypted push reads `[encrypted]` — this host cannot open it |
| `dismiss <id>` | Dismiss a push (or `--all`) |
| `rename <name>` | Set the current agent session's display name in the app — run inside a `hwip cc` session, or name one with `--session <name>` (`--clear` resets). Auto-detects the tmux session + this machine's listener device id (`--device <id>` picks another machine), so the alias lands on the right device |
| `agent send <target> <message…>` | Type a message into another agent session — on this machine or another — as if the user sent it from the phone; it shows in that session's chat and puts it in remote mode. `target` is the `<deviceId>:<session>` key or a name/alias that names exactly one session (a name two machines share is refused, with both keys listed, and so is a session on a machine that is offline — its listener would never type it). The receiver reads `[from <your alias or tmux name>@<machine> · reply: <your key>]` first; outside tmux it is `[from cli@<host>]`, and from a tmux session the listener does not report, or from a subagent, it is `[from <session name>@<host>]` — neither carries a reply key. The CLI twin of the MCP `hwip_agent_send`, for agents without MCP (pi). Global flags (`--key`, `--base-url`) go before `agent` (or between `agent` and `send`); everything after the target is the message, verbatim, and a `--key` or `--base-url` placed there is refused (exit 2) rather than typed into the other session. A `-` as the message reads it from stdin: write it on a quoted heredoc (`<<'EOF'`), since inside double quotes the shell would run backticks or `$(…)` in it. The message is always sealed, for the target computer and the devices the account lists with a key (see [Sealed `hwip agent send`](#sealed-hwip-agent-send)); the target is pinned on the way, no pairing step. A target the account does not list with a key, or an unreadable command counter, is refused, never sent in the clear; an unreadable trust file only leaves the pins unchecked, and the send goes on. Exit 0 means the server stored the message, and the line it prints says so (`sent → <key> (stored; not confirmed typed)`): the target's listener can still refuse it (rate limit, a shell pane, a session gone since) and this command does not wait to hear of it. Exit 2 usage, 1 failed or refused, 3 no API key |
| `agent list [--json]` | List the agent sessions running on THIS machine: key (`<deviceId>:<session>`, what `agent send` and `agent read` take), agent, state (`working`, `blocked`, `idle`, `unknown` — the screen matches no rule; `-` / `null` only when the sweep gave none) and name. `--json` prints one object, `{"v":1,"device":…,"sessions":[…]}`. It looks at tmux and the screens on this machine only — no server, no relay, no API key (it never exits 3) — and writes nothing, not even the listener's `known-sessions.json` (`$XDG_STATE_HOME/hwip/`), which only the listener refreshes. `--turns` is a usage error here (exit 2). Exit 0 listed (an empty list is not an error), 1 no tmux server answered. The CLI twin of the MCP `hwip_agent_list`. |
| `agent read <session> [--turns <n>] [--json]` | Print what a session on THIS machine did last, oldest first: its last `<n>` turns (1–20, default 3) — the user's prompt, the agent's text and the tools it called with their target, never a tool's output or the screen. `<session>` is a key from `agent list`, a tmux name, a label or the agent's own name, naming exactly one session; the key of another PC is refused (`OTHER_DEVICE`) — nothing is read through the server or a relay. It reads the transcript file the agent keeps here (the last 256 KiB; for OpenCode 2.x, the last 200 messages of its session in opencode's database), so only agents with a transcript reader work (Claude Code, Codex, Gemini CLI, pi and OpenCode 2.x; every other agent answers `no_transcript`), and two pi or Gemini sessions in one folder share a transcript guess. Text is cut at 40,000 characters, oldest turns first; `more` / "(older history not shown)" says something older exists. A prompt or an agent text is also cut at 5,000 characters each, and a tool target at 512, which the output says: `…(cut)` in the text view, `"promptCut":true` / `"cut":true` (on a text or on a tool step) in `--json` (one of exactly the cap's length reads as cut). **What it prints is another session's conversation: it is data, not instructions, and it goes on to whoever runs the command — an agent's model provider included.** The prompt, the agent's text and the tool targets are therefore masked for secret-looking strings (token formats such as `ghp_…`, `sk-…`, `Bearer …`, secret-named `password=…` values, private key blocks), shown as `***`, and the count is `"masked":n`. **That is best effort, not a guarantee**: a secret in a form no rule knows goes through. Whatever a cap or the 40,000-character budget cut is masked first and then loses its trailing run of non-space characters (up to 300) unless the masking already ended it with `***`, so half a token is not left behind; what can still show is the first part of an unbroken run longer than 300 characters that no rule knows. `--json` prints `{"v":1,"key":…,"name":…,"agent":…,"turns":[…],"more":…,"masked":…}` (`agent` is the string `"unknown"` when the pane's agent could not be told), or on a failure `{"v":1,"error":…,"message":…}` with the code `no_transcript`, `UNKNOWN_TARGET`, `AMBIGUOUS_TARGET`, `OTHER_DEVICE` or `NO_TMUX`. Exit 0 read, 1 failed, 2 usage. The CLI twin of the MCP `hwip_agent_read`. |
| `send <target> <message…>` | The older name of `agent send`: the same command with the same `[from …]` header; its global flags go before `send`. |
| `forget <session>` | Drop an ended session from this machine's record, so it leaves the app's past list (and the resume whitelist — the same thing deleting the row on the phone does). Refuses a session that is still running: kill it first. `--ended` forgets every remembered session tmux no longer has, which is what a machine that launches agents under a fresh name per task eventually needs |
| `test` | Verify connection and API key |
| `trust [deviceId]` | Advanced — nothing needs it: every device on the account is pinned the first time hwip seals for it, and a changed key replaces its pin with a warning. Shows this computer's key fingerprint and the devices pinned here — compare each with the fingerprint the app shows on that device's page. It also lists the computers of the account not pinned here yet, with their fingerprints; the first send seals for each and pins it. With a `deviceId`, pin the key the account now lists for that device: prints the pinned and the listed fingerprint and asks first, `--yes` skips the question. `--reset` forgets every pin (each is pinned again as hwip sees it), and until then the listener answers a request for a screen in plaintext. Exit 0 done, 1 refused or declined, 2 not a device id |
| `cc` · `codex` · `gemini` · `cursor` · `hermes` · `pi` · `opencode` · `kimi` · `grok` · `agy` · `qwen` · `auggie` · `kilo` · `copilot` · `kiro-cli` · `droid` | Run the agent in a `hwip-<project>` tmux session — reattaches a detached session of that project (newest suffix first) when there is one, else auto-suffixes `-2`, `-3`, …. Auto-spawns the background listener on first invocation so the phone picker just works; when that daemon stops within a second and a half (no key, no tmux, a rejected key) it prints the daemon's last log line instead of "autostarted". Once a day it asks npm whether a newer hwip is out and prints the update line (cached in `~/.hwip/update-check.json`; skipped under `CI` or `HWIP_NO_UPDATE_CHECK`). Trailing args pass through to the agent (`hwip cc --resume "..."`). On node 22.15+ the wrapper hands its process to tmux rather than waiting on it, so a running session shows no `hwip cc` of its own in `ps` — older runtimes and Windows keep the waiting wrapper `--detach` / `--label <x>` (front of the args) create without attaching / pin the name; `--wt <name>` runs it in a git worktree made for the session — see "Run agents through the wrapper" above. |
| `worktree [clean]` | List the git worktrees `--wt` made (path, branch, and `in use` / `clean` / `never used` / what keeps it: uncommitted, untracked or ignored files, commits not pushed). `clean` removes the ones nothing keeps and prints why the others stay; `--dry-run` removes nothing and records nothing. A worktree you made by hand is never listed or removed. Exit 0, also when some stay; `clean` exits 1 when git refused a removal it had cleared or tmux could not be asked (the list still prints, without `in use`); 2 for an unknown subcommand. See "Run agents through the wrapper" for when the listener does the same on its own |
| `schedule` | Start an agent session on a timer, in the background. The listener starts it, so it has to be running (installing the listener as a login service keeps it up). A run missed while the computer slept or the listener was down is skipped, never started late, and the phone is told. At most 20 schedules and 3 scheduled sessions at once; a session is asked to end after `--max-runtime` (never killed). Schedules live in `~/.local/state/hwip/schedules`. `schedule add <agent> (--at HH:MM \| --every <N>m\|<N>h) [-- <agent args…>]` adds one: `<agent>` is an agent command above (`cc`, `codex`, …) and the project is this one. `schedule [list]` shows them, with the next run and the last result (`--json` for scripts). `schedule rm <id>` removes one; a session it already started keeps running. Options: `--days <days>` (with `--at`: `daily`, `weekdays`, or day names like `mon,wed,fri`), `--prompt <text>` (typed into the session once the agent's status rules say it is idle: Claude Code, Codex, Gemini CLI and pi only), `--label <x>`, `--wt <branch>` (a git worktree for the branch, not with `--label`), `--max-runtime <N>m\|<N>h` (default 2h, at most the `--every` period; 5m to 24h). See *Scheduled sessions* |
| `sh` | Open (or reattach) `hwip-<project>-sh`, a login shell the phone may type into — the one shell pane the listener does not refuse. `--label <x>` / `--detach` as for the agents; inside tmux it never attaches and prints a `switch-client` hint. Refuses a session of that name it did not open. Input must be addressed to this machine, is audited, and agents (`agent send`, `hwip_agent_send`) skip it — see [Defense](#defense) |
| `mcp` | Run the MCP server on stdio, in this process. What agent MCP configs launch — `hwip install` registers it and you never type it. Replaces the old `npx -y @hwip/mcp-server` registration, which left an `npm exec` launcher resident alongside the server for the life of the session. `@hwip/mcp-server` ships as a dependency now, so it updates with the CLI rather than being re-fetched by `npx` on every launch — `hwip check-update` reports the version you actually have |
| `listener` | (Usually unnecessary — `hwip cc` autospawns it.) Resident daemon: subscribes via WebSocket, reports tmux session inventory every 5 s, injects `agent.command` pushes into the matching session. Run in the foreground for SDK development; otherwise let `hwip cc` manage it |

### Notify Options

| Flag | Description |
|------|-------------|
| `--title <text>` | Push title (default: `"Task done"`) |
| `--body <text>` | Push body (default: `"<project> · <branch>"` if cwd is a git repo, else `"<project>"`) |
| `--url <url>` | URL to include |
| `--type <type>` | Push type: `note`, `link`, `file`, `hook` |
| `--priority <p>` | Priority: `low`, `normal`, `high`, `urgent` |
| `--device <id>` | Target device ID |
| `--session <id>` | AI session ID so the push threads into that session's chat (or `HWIP_SESSION_ID` env) |
| `--auto` | Apply the push gate before sending — honors the `/hwip-mode quiet` / `/hwip-mode loud` push-mode dial, per project or machine-wide (`--global`); gated-out exits silently with code 0 |
| `--pushmode-default <m>` | Mode `--auto` assumes when the project has no dial: `quiet` (built-in), `normal`, `loud`. A dial the user set always wins |
| `--marker <m>` | Push Signal marker for `--auto`: `skip`, `push`, `high` |
| `--tools <n>`, `--nonreadonly <n>` | Turn tool counts feeding `--auto`'s heuristic (defaults assume real work) |

The defaults are tuned for hook-driven invocations (e.g. Stop hooks
calling `hwip notify --title "Task done"` without a body) — you'll see
which project + branch finished without writing per-IDE wrappers. Pass
`--body ""` explicitly to suppress.

### Listener Options

| Flag | Description |
|------|-------------|
| `--ws-url <url>` | WebSocket endpoint for this run only; the lasting setting is `wsUrl` in `~/.hwip/config.json`. It has to be a `ws://` or `wss://` URL: the listener refuses to start on anything else (a bare `ws.hwip.app` included), and `hwip verify` fails the WebSocket row |
| `--key <api-key>` | API key (or set `HWIP_API_KEY` env) |
| `--base-url <url>` | REST API base URL (or set `HWIP_BASE_URL` env, or `baseUrl` in `~/.hwip/config.json`) |
| `--stop` | Stop the running daemon and clear its PID/version stamps |
| `--restart` | Stop it and relaunch detached (logs to `~/.hwip/listener.log`) |
| `--no-keep-awake` | Don't hold the Mac awake on AC power (macOS). Lasting form: `"keepAwake": false` in `~/.hwip/config.json` |
| `--no-turn-history` | Don't upload session conversations for the app's history (see [Session history](#session-history)). Lasting form: `"turnHistory": false` in `~/.hwip/config.json` |

A yes/no flag takes nothing (`--no-turn-history`), or `=true` / `=1` / `=yes` for on and `=false` / `=0` / `=no` for off; any other value stops the command with exit 2 (`--dry-run=maybe`), rather than being read as "not given". In `config.json` an option stays on only when it is absent or `true`: `"turnHistory": "false"`, `0` or `null` read as off.

The listener reconnects with exponential backoff + jitter (1 s → 30 s
cap). Keeping the link alive costs the backend a message each way, so it
is quiet on purpose: the report heartbeat (every 2 minutes) is itself the
proof of life, and a `ping` goes out only when nothing was sent for 4
minutes (API Gateway closes a WebSocket idle for 10 minutes). Two things
tell a dead socket from a quiet one. A report the server does not answer
(ack or error) within 30 s drops the socket and the new connection
reports again; and 300 s of total silence — any inbound frame counts, ack
or pong — drops it too, which catches a link with nothing to send. The
silence limit is waived while the daemon's own event loop is blocked,
because a thread that is not listening cannot tell a dead socket from its
own deafness; 360 s of wall-clock silence terminates the socket either
way. On an
authentication failure close (4001/4002/4003) the listener exits with
code 3 instead of looping forever — fix the key and restart.

**Pattern watches and detection rules** run on the daemon's one thread, so
they use RE2 ([re2js](https://github.com/le0pard/re2js)) rather than the
JavaScript engine: matching time is linear in the pane text (the last
8 KiB), where a backtracking engine freezes every stream on `(a+)+$` or
`.*.*.*x`. RE2's time also grows with the compiled pattern, so a pattern
that compiles too large — big counted repeats like `\w{1,1000}` — is
refused. RE2 has no lookaround and no backreferences, its `\s`, `\w`, `\d`
are ASCII-only (a non-breaking space is not `\s`), and `$` does not match
before `\r`. A pattern it cannot compile never matches; for a watch the log
says `! watch on <session> will never fire: its pattern does not compile (…)`
once.

**Local transfer.** Once its device keys are loaded the listener also opens a
small HTTP server on an OS-assigned port and publishes `host:port` (private
IPv4 only) on its device record, so a sender on the same Wi-Fi can hand a
file straight to this machine instead of going through the cloud. The log
says `local transfer: listening on 0.0.0.0:<port>`. Each remote address may hold at most 8
open connections to it, so one device on the network cannot use them all up. If the macOS firewall is
on, the first bind may ask *"Do you want the application node to accept
incoming network connections?"* — declining is safe; files simply keep
taking the relay. A file sent this way may be up to 16 GiB — no plan limit
applies, the bytes never reach the cloud — as long as the disk keeps 1 GiB
free after it. With several addresses it prefers a physical interface
(`en*`, `eth*`, `wlan*`) over a VPN or virtual one (`utun*`, `tailscale*`,
`docker*`, `bridge*`, …), and within one kind an RFC 1918 address over a
link-local or CGNAT (`100.64/10`) one.

**Receiving files.** A file push addressed to this machine (the MCP `hwip_file`
tool, the phone's share sheet) is saved to `~/Downloads/Hwip/`
under its own name — `name (2).ext` when that name is taken, never
overwritten, never cleaned up — and a desktop banner (`Hwip · <file>` over
the push's title and the folder, e.g. `[myproject] shot.png · ~/Downloads/Hwip`)
says where it landed. The name in the banner is the one it was saved under, so
a `(2)` shows up there. With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
installed (`brew install terminal-notifier`), clicking the banner reveals the
file in Finder; the plain macOS banner has no click action. Encrypted
files are opened with this machine's own device key on the way down; nothing
is buffered, so a 1 GB recording streams straight to disk. A sealed-only
listener saves only files sealed for this machine: a plain one is logged and
skipped, since anyone who can write a push could have chosen its bytes and
name. Bytes are fetched only from an `https` S3 address (a loopback one when
the base URL is loopback, for the local server), with redirects refused, and
a download stops past 1.25 GiB — the 1 GiB plan limit plus the padding and
tag a sealed file carries. `agent.command`
attachments are unaffected: they still go to `~/.hwip/attachments/<pushId>/`
and are swept after 24 h. A download is written to a hidden
`.hwip-<id>.part` beside its final name and moved into place once
complete; one a crash left behind is removed by the hourly sweep once it
is an hour old.
A download that sends no response, or whose link request hangs, is given
up on instead of holding the push open.

A sender on the same network can skip the cloud entirely: it pings this
machine's endpoint, then uploads the encrypted file straight to it. Every
request is authenticated with a key only a device registered on your account
can derive (ECDH with this machine's device key), so an unknown sender — or a
replayed or tampered upload — gets an empty 401 and nothing is written. File
names and the recipient list travel sealed too; someone sniffing the Wi-Fi
sees a device id and a transfer id, nothing else. The sender counts a file
delivered only on a receipt this machine alone can compute, so a host that
merely answers on this machine's address cannot swallow it — the file goes via
the cloud instead. A device removed from the
account is refused within a minute. The file waits in `~/.hwip/attachments/lan/`
until its push record arrives, then moves to `~/Downloads/Hwip/` like any
other; a transfer whose record never comes is swept after 24 h. Two uploads at
a time, 1 GB each at most — whatever the plan, since these bytes never reach
the cloud.

### List Options

| Flag | Description |
|------|-------------|
| `--limit <n>` | Number of pushes (1-20, default 5) |
| `--type <type>` | Filter by push type |

### Global Options

A flag that takes a value reads it from the next word or after `=`
(`--title=Foo`). A flag that takes a value takes the next word whatever it
looks like — `--body "--base-url=http://x"` is a body, not a base URL — so text
nobody typed (a command to approve, a model's message) cannot set a flag of
hwip's (only an exact `--help`, `-h` or `--` keeps its meaning there); the
`--title=Foo` form is one word, so no version can read it as a flag. A value that starts with a dash run (`--title "--- done"`)
stays a value, and `--` ends hwip's flags: every word after it is read as a
word, not a flag. After an agent subcommand (`hwip cc …`) the words go to
the agent untouched. A flag the command does not read (`--titel`) is
ignored with a one-line warning on stderr.

| Flag | Description |
|------|-------------|
| `--key <api-key>` | API key (or set `HWIP_API_KEY` env) |
| `--base-url <url>` | API base URL (or set `HWIP_BASE_URL` env) |
| `--json` | Output JSON format |
| `--version` | Print version |
| `--help`, `-h` | Print usage and exit without running the command. With a command (`hwip notify --help`, or `hwip help notify`) it prints that command's own short usage — its description, its options and the global ones; with none, or a word that is not a command, it prints every command. After an agent subcommand like `hwip cc` it goes to the agent (before it, hwip prints usage), and after `hwip agent send <target>` (or `hwip send <target>`) it is part of the message |

### Mute & push mode

Both live as state files under `${XDG_STATE_HOME:-~/.local/state}/hwip`,
keyed by a `cksum` hash of the project directory. Claude Code's
`/hwip-mode mute` / `/hwip-mode quiet` / `/hwip-mode loud` / `/hwip-mode normal` write them;
the CLI reads them (mute on every `notify`, push mode on `--auto`).

Notifications are silently skipped when a mute file exists for the
current project:

```bash
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hwip"
HASH=$(printf '%s' "$PROJECT_DIR" | cksum | cut -d' ' -f1)

# Mute (created by /hwip-mode mute in the Claude Code plugin)
mkdir -p "$STATE_DIR" && touch "$STATE_DIR/muted-$HASH"

# Unmute
rm -f "$STATE_DIR/muted-$HASH"
```

Push mode is a one-word file (`quiet` / `loud` / `normal`) resolved in
this order — first hit wins:

| Order | File | Set by |
|-------|------|--------|
| 1 | `$STATE_DIR/pushmode-<hash>` | `/hwip-mode quiet` · `/hwip-mode loud` · `/hwip-mode normal` |
| 2 | `/tmp/hwip-pushmode-<hash>` | older versions (honored only when you own the file) |
| 3 | `$STATE_DIR/pushmode-default` | the `--global` form of any dial — the machine-wide default |
| 4 | `--pushmode-default <mode>` | the calling hook (the installed ones pass `normal`) |
| 5 | *(nothing above)* | `quiet` |

**Row 5 changed**: an install with no dial anywhere used to be `normal`.
It is now `quiet`, so upgrading turns the routine per-turn push off until
you run `/hwip-mode normal`. Row 4 is why the hooks this CLI installs are
unaffected: they name `normal` themselves, since a hook that supplies no
`high` marker would be silent under `quiet` whenever you're at the terminal,
rather than merely quieter. Row 4 sits *below* the state files on purpose — the flag
names a default, it does not override a dial the user set.

Under `normal` the JSON hook configs push on every turn, because they see
no per-tool events and so pass no counts — the gate then assumes real
work. The Pi extension and the OpenCode plugin do see those events, so
they pass real `--tools` / `--nonreadonly` counts and go quiet where the
others cannot: a turn with no tool calls, a turn with exactly one (a
lone edit included — the gate wants two), and a turn whose calls were
all reads. `/hwip-mode loud` still pushes on all of them.

The Pi extension also pushes when pi is **waiting on you**: any blocking
extension dialog — a bash guard's Run/Abort, an ask-user tool, a
`ctx.ui.confirm` — that is still open 10 seconds after it appeared sends a
`high` push ("pi asks: <project>", body = the dialog title or the guarded
bash command). `high` gets through `quiet`; only `/hwip-mode mute` stops it.
Answering inside the 10 seconds sends nothing. It is the pi twin of the
Claude Code plugin's AskUserQuestion push, driven by pi's
`ui_prompt_start` / `ui_prompt_end` events. Only dialogs that open while a
turn is running count: a settings picker you open yourself between turns
(`/caveman config`) never pushes.

Two more end-of-turn cases differ from Claude Code:

- **Push Signal markers** — pi's rules teach the same `<!-- hwip: skip|push|high -->`
  markers, and the extension reads them from the final assistant message
  (then strips them, since pi's terminal would otherwise print the comment).
  `high` is how pi gets a "the turn ended with a question for you" push
  through `quiet`.
- **Errors and aborts** — a turn that ended on a provider error sends a
  `high` "pi stopped: <project>" push with the error text instead of
  "Task done"; a turn you aborted with Esc sends nothing.

#### Quiet while away

`quiet` silences routine pushes because you are watching the pane. When
you've walked away, nobody is, so `notify --auto` under `quiet` still sends
the push (normal priority) once it decides you're away. It reads the machine
with three signals (the first that answers wins), then asks about this
session's own pane:

1. Inside tmux and **no client attached to the tmux server** → away.
2. Not over SSH and macOS `ioreg` reports **`HIDIdleTime`** (system-wide
   input idle) → that alone decides. Inside tmux, "over SSH" follows the
   session environment tmux refreshes on each attach, not the value frozen
   at server start.
3. Inside tmux → the newest tmux **`client_activity`** (SSH and non-macOS).
4. Beyond the machine: input and a tmux client say you are at the desk, not
   which tmux session you are looking at. Inside tmux the hook also asks about
   its own pane (`$TMUX_PANE`): a session with no client attached, in a window
   that is not showing, or under another pane's zoom counts as away even while
   you type elsewhere. A tmux that will not answer, a missing `$TMUX_PANE` and
   any control-mode client (iTerm2 `tmux -CC`) leave the answer above alone.

Anything unreadable counts as present. The threshold is `HWIP_AWAY_SEC`
seconds in the hook's environment (default `300`, `0` turns detection off —
the pane check included — and a non-number falls back to the default). The probe runs only on a
quiet turn with no `high` marker. The Claude Code plugin's Stop hook
applies the same rule (`hwip_is_away` in its `hooks/gate.sh`).

A dial file that exists but reads empty resolves to `normal`, not to row
5: an empty file is a failed write, and resolving breakage to silence
leaves no symptom to debug.

Mute has no `-default` form on purpose: it is keyed on presence, not
content, so a global mute could never be lifted for a single project.

Legacy `/tmp/hwip-muted-<hash>` files are still honored when owned by the
current user (the state dir moved out of world-writable `/tmp`).

The CLI checks `CLAUDE_PROJECT_DIR`, `CURSOR_PROJECT_DIR`,
`WINDSURF_PROJECT_DIR`, and falls back to `cwd`.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error — also: `ask` got no answer, `verify` has a failed check, `install` has a step marked `-`, `uninstall` answered no |
| 2 | Quota exceeded — also a usage error: `agent send` (and `send`), `agent list`, `agent read`, `rename`, `forget`, agent-subcommand flags, `install` with no terminal for the picker |
| 3 | Authentication failed, or no API key (also: listener auth close 4001/4002/4003, `install` with a key the API rejects) |
| 127 | A required external binary (e.g. `tmux`, `claude`) was not found on PATH — for `hwip cc` / `hwip sh` a missing tmux comes with its install hint |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HWIP_API_KEY` | API key (fallback when `--key` not provided) |
| `HWIP_BASE_URL` | API base URL (default: `https://api.hwip.app/v1`). With the key from `~/.hwip/config.json` it must be on the same origin as that file's `baseUrl` (else set `HWIP_API_KEY` too) |
| `HWIP_WS_URL` | **Deprecated.** WebSocket endpoint for `hwip listener`. `wsUrl` in `~/.hwip/config.json` wins over it; read only when the file has none. It will stop being read |
| `HWIP_TMUX_SOCKET` | Explicit tmux socket path for the listener (skips auto-discovery — use when your tmux runs with `-L <name>` or a custom `-S <path>`) |
| `HWIP_SESSION_ID` | AI session ID (fallback when `--session` not provided) |
| `HWIP_ASK_CONTEXT` | `0`, `false`, `off` or `no` switches off, for that run, the context a sealed question may carry (see `ask-context`) |
| `HWIP_FILE_VIEW` | `0`, `false`, `off` or `no`, in the listener's environment, switches off for that run the phone's access to session files (see `file-view`) |
| `HWIP_NO_UPDATE_CHECK` | Set to skip `hwip cc`'s once-a-day npm check for a newer version (also skipped when `CI` is set) |
| `HTTPS_PROXY` · `HTTP_PROXY` · `NO_PROXY` | Route API calls and the listener's socket through a proxy (`http://` or `https://`, credentials allowed in the URL; lower-case names work too and win). `HTTPS_PROXY` falls back to `HTTP_PROXY` for https; `NO_PROXY` takes hosts, `.suffix`es and `host:port`s, or `*`. Works on every supported Node — `fetch` through undici's `EnvHttpProxyAgent`, the listener's websocket through a CONNECT tunnel — not only on the Nodes that have `http.setGlobalProxyFromEnv` (24.14+). An unusable value is an error naming the variable (`--version` and `--help` still answer), not a direct connection. Plain `http://` and `ws://` targets are tunnelled with CONNECT too, so a proxy that allows CONNECT only to port 443 refuses them. A lower-case variable that is set but empty wins over the upper-case one, which is how `http_proxy= hwip …` switches the proxy off for one run. A listener installed as a service (`hwip listener --install-service`) starts with launchd's own minimal environment and does not see these variables — it reads `"httpsProxy"` · `"httpProxy"` · `"noProxy"` from `~/.hwip/config.json` instead, which every `hwip` command also reads for whatever the environment leaves unset: **the environment wins, one setting at a time** (a variable that is set at all, empty included, replaces the file's value), so `HTTPS_PROXY` from the shell beats `"httpsProxy"`, while `NO_PROXY` can still come from the file. To switch the file's proxy off for one run, empty the variable of the same setting (`https_proxy= hwip …` for `"httpsProxy"`; `http_proxy=` does not reach it). An unusable `"httpsProxy"` / `"httpProxy"` (not an `http://` or `https://` address, or not text) is the same error naming the key, and a service with it exits and is retried every 30 s, not started direct |

## SDK Usage

```typescript
import { HwipHook } from '@hwip/cli';

const hook = new HwipHook({ apiKey: 'ak_...' });

// Notify
const result = await hook.notify({
  title: 'Build Complete',
  body: 'Deploy succeeded',
  url: 'https://example.com/deploy/123',
  priority: 'high',
});
console.log(result.pushId); // 'push_01JXY...'

// List
const list = await hook.list({ limit: 5 });
console.log(list.pushes);

// Dismiss
await hook.dismiss('push_01JXY...');
await hook.dismissAll();
```

### Constructor Options

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | Required — API key from Hwip settings |
| `baseUrl` | `string?` | API base URL (default: `https://api.hwip.app/v1`) |
| `timeout` | `number?` | Request timeout in ms (default: 30000) |

### Last push failure

Every installed hook runs `hwip notify … 2>/dev/null || true`, so a failed
push leaves nothing on screen. `hwip notify` (and `hwip test`, and the test
push `hwip install` sends) therefore records the last failure
itself and deletes the record once a push goes through — the last attempt to
finish wins when hooks race:

```
${XDG_STATE_HOME:-~/.local/state}/hwip/last-notify-failure.json
{"v":1,"at":"2026-10-02T00:00:00.000Z","kind":"auth","status":401,"code":"AUTHENTICATION_ERROR"}
```

`kind` is one of `no-key`, `auth`, `quota`, `rate-limit`, `client`,
`server`, `timeout`, `network`, `no-app`, `unsealed`; `status` is the HTTP
status and `code` the server's error code, both `null` when there was no HTTP
answer. A push is never sent in the clear (see Encryption): `no-app`
(`NO_APP_DEVICE`, no app is signed in to the account) and `unsealed`
(`E2E_REQUIRED`, the push could not be sealed) are refusals made on this
computer before anything was sent, so their `status` is `null` and `code`
names them. A device whose key changed is not a failure and
is not recorded here (see Encryption → key changes). No message
text, key or push content is stored. `hwip verify` shows it under
**Push delivery**, and the Claude Code plugin shows it in `/hwip-mode` and
at session start. The format is a contract with the plugin —
`src/notify-failure.ts` is the source of truth and its test pins the line
above.

### Notify Payload

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string?` | Push title |
| `body` | `string?` | Push body |
| `url` | `string?` | URL to include |
| `type` | `'note' \| 'link' \| 'file' \| 'hook'?` | Push type (default: `hook`) |
| `priority` | `'low' \| 'normal' \| 'high' \| 'urgent'?` | Priority (default: `normal`) |
| `targetDeviceId` | `string?` | Send to specific device |

### Error Handling

```typescript
import { HwipHook, AuthenticationError, QuotaExceededError, HwipError } from '@hwip/cli';

try {
  await hook.notify({ title: 'Hello' });
} catch (err) {
  if (err instanceof AuthenticationError) { /* Invalid API key */ }
  if (err instanceof QuotaExceededError) { /* Monthly limit reached */ }
  if (err instanceof HwipError) { /* Other API error */ }
}
```

## Supported Agents

`hwip install` detects and configures these agents automatically:

| Agent | What gets installed |
|-------|-------------------|
| Claude Code | Plugin (hooks + MCP server) |
| Cursor | MCP server + stop hook + rules |
| Windsurf | MCP server + response hook + rules |
| Gemini CLI | MCP server + AfterAgent hook |
| Codex CLI | MCP server + prompt/stop hooks + rules |
| Copilot CLI | Session end hook + rules |
| Cline | Rules file (`~/.cline/rules/hwip.md`) |
| Aider | Conventions file + `read:` directive in `~/.aider.conf.yml` |
| Pi | Extension (settle hook + waiting-on-you push + remote detection) + rules — no MCP (pi has none; rules map hwip tools to the CLI) |
| OpenCode | MCP server + idle-notify plugin + rules — the plugin loads on opencode 1.18.35 and 2.0.24 (checked 2026-10-10). On 2.x run `opencode reload` after installing: the background server loads plugins when it starts |

Settings files the agents share with you — Cursor `mcp.json` and `hooks.json`,
Windsurf `mcp_config.json` and `hooks.json`, Gemini `settings.json`, Codex
`hooks.json`, OpenCode `opencode.json` — are merged: your own entries stay, and
only hwip's are added or replaced. Comments and trailing commas (JSONC) are
read like the agents read them and are kept: hwip's entry is added after yours,
on its own lines, and the rest of the file is left as it was (when your file
is written compactly, on one line, the part around hwip's entry is laid out
again). A comment sitting right next to one of hwip's own entries goes when that
entry does, and `hwip uninstall` keeps a hooks file that holds a comment even
when only hwip's entries were in it. `hwip uninstall` takes out only hwip's entries, and deletes a hooks file
only when nothing else was in it. A file with a syntax error, or whose `hooks`
is not an object of lists, or whose comments an edit could not keep (an
empty or one-line section with a comment at the end of its last line), is left as it is, and the step prints why and what
to add by hand. Uninstall marks such a hooks file, and any step it could not
finish, with `!` and names it. Every write but one goes through a temp file
and a rename, so a full disk or a killed install leaves the old file whole; a
symlinked settings file stays a link. A file you made read-only is left as it is and
named, not replaced (unless hwip runs as root, which can write any file); a writable
file in a directory that takes no new files is written in place instead — not atomic,
so a killed install can cut it off; its old bytes are put back if the write fails —
and a file that is not there yet in such a directory is named and not created.
A file that is not valid UTF-8 text is left as it is and named (reading it as
text would turn its bytes into U+FFFD). A file someone else writes while hwip is
editing it is left as that writer made it: the step stops, names the file and says
to run the command again, instead of replacing their change. Uninstall of a hooks
file or rule file that is a symlink (a dotfiles repo) takes hwip's part out of what
the link points at and keeps the link, so nothing of hwip's comes back with it.

For remote-control via `hwip listener` the per-agent setup is the same
across CC/Codex/Gemini — the wrapper just spawns them in a named tmux
session.

## Encryption

End-to-end encryption is **always on**: there is no switch and nothing to
configure. A push's title, body and URL, a question, an answer and a message to
another computer leave this host as ciphertext, on every plan.
The one exception is a push to a channel's subscribers (`--channel`), which the
server fans out as plain text.

A push needs an app to read it. When no iPhone or Android app is signed in to
the account, `hwip notify` and `hwip ask` send nothing and say so —
`no app is signed in to this account: sign in to the Hwip app on an iPhone or
Android phone, then send again` (`NO_APP_DEVICE`). When an app is signed in but
this send cannot be sealed — the device list does not load, this computer's
keys do not, no device lists a key, encryption throws — the push is refused with
`E2E_REQUIRED` and the reason. The push-delivery file below records the two as
`no-app` and `unsealed`. There is no plaintext fallback, no line on stderr about one, and
nothing to turn off.

Push bodies and long-body attachments are encrypted with
AES-256-GCM. This host holds its own ECDH P-256 keypair in
`~/.hwip/device-keys.json` — generated on first use, and the private
half never leaves the machine; the backend stores public keys only and
rejects a private-key upload. Each push is encrypted once, and its AES
key is wrapped separately for every device the account lists with a key
(`GET /devices`), using ECDH against that device's public key. The title and
URL move inside the ciphertext with the body. Every listed device is pinned in
`~/.hwip/trusted-devices.json` the first time it is seen; a device that lists
another key than the one pinned gets the new key — the pin is replaced, one line
on stderr says `hwip: trust: <deviceId> changed its key — now pinned to the new
one` (`… could not record the new pin` when the trust file could not be
written), and the change is recorded for a person. Nothing is refused for it.

**Key changes are shown once, wherever they happened.** That stderr line often
reaches nobody — a hook throws it away, the listener writes it to its log, the
MCP server's stderr is not on any screen — and once the pin holds the new key
no one sees the change again. So whoever replaces a pin (`hwip notify`,
`hwip ask`, `hwip agent send`, the listener, the MCP server) also writes it to
`~/.hwip/key-changes.json`, under the trust file's lock:

```
{"v":1,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z","name":"iPhone"}]}
```

One entry per device, at most 64. The next surface a person reads shows each one
once and deletes the file: `hwip verify`, `hwip trust`, `hwip test`, and
`hwip notify` / `hwip ask` when stderr is a terminal print
`hwip: <name> changed its encryption key — the new key is trusted. Not expecting
that (app reinstalled?) Check it: hwip trust`; the Claude Code plugin shows it at
session start and in `/hwip-mode`, the MCP server at the end of a tool result.
A hook's `hwip notify … 2>/dev/null` neither reads nor deletes it. The format is
a contract with the MCP server and the plugin — `src/key-changes.ts` is the
source of truth.

**Threat model:** against a passive backend — a leaked snapshot, an
operator reading the table — the stored ciphertext and wrapped keys are
useless, so push contents stay private. Four limits worth knowing:

- **No protection from an active malicious operator.** Recipient public keys
  come from `GET /devices` on that same server, unsigned. A backend that
  injects a device record carrying its own key, or lists another key for a
  device you know, gets the message key wrapped for it and reads what is sent
  after that — the pin is replaced and one line says so, nothing stops it.
  Comparing a device's fingerprint (`hwip trust`) with the one the app shows
  is the check, by eye, and a changed-key line on stderr is the signal to do
  it. The Hwip app's verified-device strict mode is per browser profile and is
  not consulted here.
- **No forward secrecy.** The ECDH secret for a given sender/device pair
  is static, so compromising either private key opens every past push
  wrapped for that pair.
- **`senderPublicKey` is unsigned**, so a swapped one makes a push
  undecryptable — that direction fails closed rather than leaking.
- **Two OS users on one computer share its device id** (it comes from the
  machine; the key is each user's `~/.hwip`). With a `push:read` API key each
  user's notify or ask puts its own key back on the list, and the app warns of
  a changed key each time.

A device that has not registered a per-device public key cannot be sent
to; it is skipped, and if no device qualifies nothing is sent.

**`hwip ask` seals both ways.** The question's title,
body and button wording go to the phone inside the envelope, with a random
128-bit id the answer has to echo; the server keeps only each button's id,
the timeout, the `hookType` and `acceptsExit` flags, the session fields, the
envelope's `senderPublicKey` and `deviceKeyMap` (so, the ids of the devices
it is sealed for), the push priority (the hook's setting) and, once
answered, which device answered. The phone seals its answer for this
computer, and `hwip ask` opens it only if the answering device's key is
the one the account's device list registers for it, the envelope was sealed
with that key, and it holds an `answer` for this question's id. An answer
from a device whose key changed since it was pinned opens too (the pin is
replaced and the line above is printed); an answer from a device the list
does not hold with a key is refused. This path never falls back to plaintext:
if the question cannot be sealed (no app signed in, no device to seal for, keys
that do not load, a device list that does not load, this computer's key that
cannot be put on the list), nothing is sent and the JSON says why. A button id over 64 characters, a label over 100 or more than 10
buttons is refused with its own message. The device list is read before the send
and counted against the `--timeout` window: if it uses it all up, nothing is
sent and the ask ends as a timeout. Otherwise the server is told what is left
of the window, rounded up to a whole second and never less than one. Plaintext
fields the server returns for a sealed question are ignored.

**A sealed question carries its context.** What the asking session has
changed (`git diff` against HEAD with new files, never a `.gitignore`d one)
and the last 60 lines of its terminal (the tmux pane `hwip ask` runs in;
none outside tmux) go with the question, masked for secret-looking text
first — best effort: a secret in a form the masking does not know stays. A
summary (files, lines, at most 20 paths; 4 KiB at most) rides inside the
sealed body; the text itself (64 KiB at most, cut at a line with a mark) is
one attachment sealed for the same devices, which the phone fetches when the
summary is opened. The server sees that attachment the same way on every
sealed question: named `file`, `application/octet-stream`, 64 KiB — also when
there is nothing to carry or `hwip ask-context off` is set, where it is sent
with nothing in it — so neither whether a question has context nor how much
changed shows. It is kept as long as any attachment (30 days). The
context never holds a question back: if it cannot be gathered or stored the
question goes without the attachment (which the server can tell), a
summary that would take the envelope over the server's 48 KiB limit is left
out — and the attachment too if that is still not enough — and with less than 20 seconds of `--timeout` left nothing is gathered.

**A question goes up once.** The send carries an `Idempotency-Key`, a new
random one per question, so sending it again cannot open a second question:
the server answers a repeat with the first one's ids. A send that fails in a
way that may pass — no connection, no answer in 10 seconds, a 5xx, 408 or
429 — is sent again with the same key and the same bytes, after 1, 2 and 4
seconds (four tries). While the server says the first request is still
running under the key (409 `IDEMPOTENCY_IN_PROGRESS`), the send is repeated
every 5 seconds instead, for up to 35 seconds from the first such answer: a
request the server lost to its own timeout holds the key for 30. No try is
made that would start after the `--timeout` window has ended, and none is
waited on more than a second past its end (a try gets what is left of the
window when that is under 10 seconds, and a second at the least). Any other
refusal (a bad key, a key that cannot be sent as a header, a hook that is
gone, a redirect, a base URL that is not an address) ends the ask at once. The
server counts the question's timeout from the try it took, so a question that
went up on a late try stays on the phone that much longer than this command
waits, and an answer given in that tail is not read. A repeat the server had
already taken is answered with the question's ids alone, which do not say
whether the phone was notified — that was the first request's to say. So
when a question went up on a retry and the answer does not say the phone was
notified, `hwip ask` says so on stderr, and again as `error` in its JSON if
the ask ends as a timeout: the question is in the app either way, but nobody
may have been pinged. When the tries run out and one of them may have
reached the server all the same — it was slow to answer, answered
unreadably or with a 5xx, still held the first send as running, or the
connection dropped once made — the
`error` ends with "the question may have gone up all the same", whatever the
last try said. A try that never connected (nothing listening, no route, a
name that does not resolve) or was answered 429 does not count: when every
try ended so, the error is plain. One
case still opens a second
question: a first request that wrote the question and died before it marked
the key is taken over after those 30 seconds.

**A question cut short is taken up again.** `hwip ask` blocks, and what runs
it does not always wait: an agent's tool call times out, a shell is closed.
The question is still on the phone then, with nobody reading its answer. So
each question that went up leaves a record under `~/.local/state/hwip/`
(`ask-pending-<hash>.<pid>.<nonce>`, mode 0600), and the same command run again — the same
title, body and actions, from the same directory, agent session and machine
— waits on that question instead of sending a second one. Its JSON then
carries `"resumed": true`. The record holds the event id, the id the answer
has to echo and the question's deadline, and nothing of the wording, which
is matched by a hash. It is taken up only once the process that asked has
exited (two that run side by side each ask their own), by one process only,
and within the first question's own window: `--timeout` of the second run
bounds its wait but does not extend the question. When the first question
timed out with nobody having answered and the second run has window left, it
asks anew with what is left; one the user cancelled stays cancelled. A read
that fails or is refused (a key that was rotated), or an answer that cannot
be opened because the device list did not load, ends the run with the error
and keeps the record: the question is still there for the next run. The
record is removed before an answer is handed over, so an answer is used
once — if it cannot be removed, stderr says that the next run would be given
the answer again — and one past its deadline is cleared by the next
`hwip ask`. An approval gate goes the same
way: a command blocked while its question was open and tried again within
that window gets the answer given to the first, for that same command in
that same place only.

This host becomes a device others can encrypt for once its public key is on
the account's device list. `hwip listener` puts it there each time it connects
to Hwip; without a listener, the first `hwip ask`, `hwip agent send` or
`hwip notify` that finds this computer missing from the list, or listed under
another key, puts it there itself (one `PUT /devices/{id}/public-key`, no
second read of the list) — so `hwip ask` works on a computer that never ran
the listener. Only an API key with `push:read` may replace a key the list
already holds: with another, the old key stays, and `hwip ask` and
`hwip agent send` refuse, saying so on stderr (`hwip ask` in its JSON too). A notify whose key cannot be registered
still goes, with one line on stderr — the app reads it either way.

The `hwip listener` opens encrypted file pushes addressed to it and
sealed `agent.command` pushes from a device whose key checks out (see
Defense above); it ignores every other `isEncrypted` push — it does not
try to decrypt them. A sealed command names its sender inside the seal
(`cmd.from`), because a send made with an API key is stamped `api_<keyId>`
by the server, which says nothing about the machine. The key must be the
one the account's device list registers for that device. The first such
command from a device pins it, and — like any first sealed request — makes
this listener sealed-only from then on; a changed key replaces the pin.
Command numbers are counted per sender (`cmd.from`, else the stamped
device). A command sealed by another session of this same computer is
checked against this computer's own key, not the account's list. Stop-hook auto-pushes and `hwip_ask` responses are
not part of the `@<session>` injection path, so this doesn't affect
normal use.

### Sealed `hwip agent send`

`hwip agent send` (and `hwip send`) always seals the
message for the target computer instead of posting its text: the push carries only ciphertext, the label inside names the
session, the target, this computer as the sender and a number, and the
target's listener types it by the same checks as a command from the phone
(above). The senders on one computer draw theirs from one counter,
`~/.hwip/command-seq`, under a lock (`~/.hwip/command-seq.lock`); the number
is the larger of the last one plus one and the clock in milliseconds, so a
sender that starts later is never behind.

**No pairing.** Two computers on one account need nothing set up beyond
`hwip listener` running on the target (or `hwip cc`), which types the
message; the sender puts its own key on the account's list when it sends. A send pins every device the account lists on the
way, the target included; the target pins the sender on the first sealed
command it opens, like any first sealed request. To compare fingerprints
before that, `hwip trust` prints this computer's and lists the account's
other computers that are not pinned yet, and `hwip trust <deviceId>` pins one
on purpose — nothing requires it.

**What it refuses.** Sealing is not a preference: a message
that cannot be sealed is not sent, and there is no plaintext branch.
Each refusal says what to do — this computer's key could not be put on the
account's device list (and why), or the target has no key listed (run `hwip listener` on it
once), the device list could not be fetched, the keys did not load, the trust
file or the counter cannot be read, or another process holds the counter lock
(try again). A target whose key changed since it was pinned is not a refusal:
the pin is replaced, one line on stderr says so, and the message goes.

**Who can read it.** The target computer, and every other device the account
lists with a key (a send to another session of this same computer reaches
it with this computer's own key). The phone's chat bubble for the message opens by the phone's own slot in
`deviceKeyMap`; it does not need the sender pinned.

**What stays in the clear and what repeats.** The relay needs
`agentSessionName` and `targetDeviceId` to route the push, so they are
plaintext; so are `senderPublicKey` and the ids of the devices the message
is sealed for (the keys of `deviceKeyMap`) — the relay sees which devices
can read it, not what it says. A send that failed on
the way and is typed again takes a new number; if the first request had in
fact arrived, the session receives the message twice.

The receiving listener, once it only seals, refuses a plaintext `agent.command`
(see Defense above); a sender that still posts plaintext gets nothing typed.

**App version.** An iOS build from before hwip #318 sends the conversation
input in plaintext to a computer it has no pin for, and one from before
hwip #322 shows `e2ee_required` as a refusal without a reason. Against a
sealed-only listener of this version, the first gets nothing typed. The
buttons of a blocked prompt (in the app and on its notification) seal named
`keys` with `ifPrompt` since the sealed-answer-keys iOS build; an older
build's approve button sends plain `keys`, which this version refuses with
`e2ee_required`. This version is to be published only after an iOS build
that includes #318, #322 and the sealed answer keys is out.

A file the app seals goes up padded to its Padmé length, under a record
that says only `file`, `application/octet-stream` and the padded size; the
sealed message names it (by IV) with its real name, type and size, and the
listener saves it under that name, cut back to that size. Files from
senders that do not do this (this cli, the MCP server) keep their names
in the record as before.

A file too large to seal in one piece is sealed in 1 MiB chunks instead
(`file-chunk-v1`): each chunk under the file key with its own nonce, which
carries the chunk's number and whether it is the last, so chunks that are
reordered, repeated, missing or cut short do not open and nothing is saved.
The sealed message says which format a file is in. The listener tells the
account's devices that it opens this format, and a sender uses it only for a
machine that says so; a listener from before it keeps getting files sealed
whole.

Pushes and files use the envelope above. The live path — stream frames
and input, snapshots, history pages, diffs and chat timeline batches —
uses envelope v2 instead, sealed for one device key at a time
(Defense above).

## Requirements

- **Node.js ^20.17, ^22.13 or >= 23.5** (uses native `fetch`). That is what the dependencies already required (the prompt library asks for it); `package.json` `engines` said `>= 18` until now. CI runs the suite on 20.19, 22.13 and 24 (the test tooling needs 20.19, so 20.17 itself is declared by the dependencies but not exercised).
- **tmux** — required for `hwip cc` / `codex` / `gemini` and `hwip listener`.
- The `HwipHook` SDK has no runtime dependencies. The CLI depends on
  `@inquirer/prompts` for the interactive `hwip install` picker, on
  `ws` for the listener's WebSocket subscription, and on `jsonc-parser`
  (Microsoft's, the parser VS Code reads its settings with; MIT, no
  dependencies of its own) to edit agent settings that hold comments.

## License

Apache-2.0

Contributions are welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md). Report security issues as described in [SECURITY.md](./SECURITY.md).
