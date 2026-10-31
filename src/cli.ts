#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { HwipHook } from './hwip-hook.js';
import { AuthenticationError, QuotaExceededError, HwipError } from './errors.js';
import { asksForUsage, badFlagValue, flagOn, parseCliArgv, unknownFlags } from './args.js';
import type { SessionLiveness } from './session-registry.js';
import { detectProjectDir, keyIsFromFile, loadConfig, resolveBaseUrl, resolvedEnv, TRUST_FILE, VERSION } from './config.js';
import {
  autoPushMode, decidePush, GATE_DEFAULTS, isMuted, NONREADONLY_COUNT_FLAG, normalizeMarker,
  PUSHMODE_DEFAULT_FLAG, TOOL_COUNT_FLAG,
} from './gate.js';
import { awayForGate } from './presence.js';
import { showKeyChanges } from './key-changes.js';
import { recordNotifyFailure, withNotifyFailureRecord } from './notify-failure.js';
import { useProxyFromEnv } from './http-failure.js';
import { redactSecrets } from './redact.js';
import { commandUsage, usageTarget, usageText } from './usage.js';
import { findAgentBySubcommand } from './remote-agents.js';
import { isRemoteHookAgent, runRemoteHook } from './remote-hook.js';

// Every command module below is loaded by the case that runs it, not up
// front. The build is CommonJS, so a static import is a require at startup —
// and `notify` (every agent turn) and `remote-hook` (every prompt) would pay
// for the listener daemon (ws, LAN transfer, turn watching) they never use.
// Only what those two hot paths need stays static above; cli-lazy-load.test.ts
// holds the line.

const detectBranchAndProject = (): { branch?: string; project: string } => {
  const dir = detectProjectDir();
  const project = dir.split('/').filter(Boolean).pop() ?? 'project';
  let branch: string | undefined;
  try {
    branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch || branch === 'HEAD') branch = undefined;
  } catch { /* not a git repo */ }
  return { branch, project };
};

// ── Output ──────────────────────────────────────────────────────

const printUsage = (command?: string) => {
  console.log((command ? commandUsage(command) : null) ?? usageText());
};

const printError = (message: string, isJson: boolean) => {
  if (isJson) {
    console.error(JSON.stringify({ error: message, status: 'error' }));
  } else {
    console.error(`Error: ${message}`);
  }
};

const printJson = (data: unknown) => {
  console.log(JSON.stringify(data, null, 2));
};

// ── Commands ────────────────────────────────────────────────────

/**
 * Per-request limit when a hook runs notify (`--auto`). The agent's turn waits
 * on the hook, and its calls run in a row: the device list, then for a long
 * body an upload request and the S3 upload, then the send. Four calls at 6 s
 * stay under the 60 s the installed Gemini, Codex and Copilot hooks allow (templates.ts).
 */
const HOOK_REQUEST_TIMEOUT_MS = 6_000;

const createHook = (args: Record<string, string | boolean>, timeoutMs?: number): HwipHook | null => {
  const config = loadConfig();
  const apiKey = (args.key as string) || resolvedEnv('HWIP_API_KEY') || config.apiKey;
  const isJson = flagOn(args, 'json');

  if (!apiKey) {
    printError('API key required. Run "hwip install" or set HWIP_API_KEY', isJson);
    return null;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(args['base-url'], config, keyIsFromFile(args.key as string, config));
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), isJson);
    return null;
  }

  return new HwipHook({
    apiKey,
    baseUrl,
    ...(timeoutMs && { timeout: timeoutMs }),
  });
};

/**
 * `hwip trust [deviceId] [--reset] [--yes]` — fingerprints, and which device
 * keys the listener seals for (trust-command.ts).
 */
const handleTrust = async (args: Record<string, string | boolean>): Promise<number> => {
  const [{ initDeviceCrypto }, { createDeviceDirectory }, { flagText, parseTrustArgs, runTrust }] =
    await Promise.all([import('./crypto.js'), import('./device-directory.js'), import('./trust-command.js')]);
  const config = loadConfig();
  const apiKey = flagText(args.key) ?? resolvedEnv('HWIP_API_KEY') ?? config.apiKey ?? '';
  // The device list is asked for only when `trust` has something to say about it (a device to pin, or the listing).
  let directory: ReturnType<typeof createDeviceDirectory> | undefined;
  const directoryFor = (report: boolean) => {
    try {
      directory ??= createDeviceDirectory({ apiKey, baseUrl: resolveBaseUrl(flagText(args['base-url']), config, keyIsFromFile(flagText(args.key), config)), log: (line) => console.error(line) });
    } catch (err) {
      if (report) console.error(`hwip trust: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    return directory;
  };
  const registeredKey = async (deviceId: string): Promise<string | null> => directoryFor(true)?.publicKeyOf(deviceId) ?? null;
  // The listing is an extra: with no API key or no answer, `hwip trust` shows what it did before.
  // A broken configuration is said once instead: an empty list would read as "no devices".
  let trustConfigSaid = false;
  const devices = async () => {
    if (!apiKey) return [];
    const directory = directoryFor(false);
    if (directory) {
      try {
        return await directory.devices();
      } catch {
        return [];
      }
    }
    if (!trustConfigSaid) {
      trustConfigSaid = true;
      try {
        resolveBaseUrl(flagText(args['base-url']), config, keyIsFromFile(flagText(args.key), config));
      } catch (err) {
        console.error(`hwip trust: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return [];
  };
  const parsed = parseTrustArgs(args);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  return runTrust(
    parsed,
    {
      path: TRUST_FILE,
      devicePublicKey: initDeviceCrypto,
      registeredKey,
      devices,
      confirm: async (question) => {
        // Nobody to ask: an unanswered question is not a yes, and says why.
        if (process.stdin.isTTY !== true) {
          console.error('hwip trust: no terminal to ask on — compare the fingerprints, then run it again with --yes');
          return false;
        }
        try {
          const { confirm } = await import('@inquirer/prompts');
          return await confirm({ message: question, default: false });
        } catch (err) {
          // Ctrl-C lands here too; anything else is worth a line.
          if (!(err instanceof Error && err.name === 'ExitPromptError')) {
            console.error(`hwip trust: the question could not be asked (${err instanceof Error ? err.message : String(err)})`);
          }
          return false;
        }
      },
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
    },
  );
};

/** Current tmux session name (the rename key), or null when not inside tmux. */
const detectCurrentTmuxSession = (): string | null => {
  if (!process.env.TMUX) return null;
  try {
    const name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8' }).trim();
    return name || null;
  } catch {
    return null;
  }
};

/**
 * `hwip rename "<name>"` — set THIS agent session's display name in the app.
 * Auto-detects the current tmux session + this machine's listener device id
 * (`computeListenerDeviceId`, the same id the listener registers, so the
 * rename lands on the right device). `--clear` resets to the computed label.
 */
const handleRename = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const clearing = flagOn(args, 'clear');
  const alias = (args._arg1 as string) || '';
  if (!alias && !clearing) {
    printError('Usage: hwip rename "New name"  (or --clear to reset to default)', isJson);
    return 2;
  }

  const sessionName = (args.session as string) || detectCurrentTmuxSession();
  if (!sessionName) {
    printError('No tmux session detected. Run inside a `hwip cc` session, or pass --session <name>.', isJson);
    return 2;
  }
  const deviceId = (args.device as string) || (await import('./listener.js')).computeListenerDeviceId();

  const hook = createHook(args);
  if (!hook) return 3;

  try {
    await hook.renameAgentSession(deviceId, sessionName, clearing ? '' : alias);
    if (isJson) printJson({ session: sessionName, alias: clearing ? null : alias, status: 'ok' });
    else console.log(clearing ? `Reset name for ${sessionName}` : `Renamed ${sessionName} → ${alias}`);
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

/**
 * `hwip forget <session>` — drop an ended session from this machine's record,
 * which is what takes it out of the app's past list (and out of the resume
 * whitelist, the same pair the phone's row-delete means).
 *
 * `--ended` does it for every remembered name tmux no longer has: a machine
 * that launches agents under a fresh name per task collects rows nothing ever
 * deletes, and naming each one by hand is not the answer to fifty of them.
 *
 * The order mirrors the listener's own delete handler (`listener.ts:1701-1721`)
 * so the two ways to forget a session cannot disagree about what is allowed.
 */
const handleForget = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const { isSubagentSessionName, sessionLiveness, silenceListenerLog } = await import('./listener.js');
  const { forgetSession } = await import('./session-registry.js');
  // The tmux socket discovery under `sessionLiveness` logs for a daemon with a
  // redirected stdout, not for this command. A person reading the output wants
  // those lines — a failed probe is the only explanation for an "unknown" — but
  // in a --json line they break the parse.
  if (isJson) silenceListenerLog();
  const name = typeof args._arg1 === 'string' ? args._arg1 : '';
  const sweeping = flagOn(args, 'ended');

  if (name && sweeping) {
    printError('Usage: hwip forget <session>  (or --ended, not both)', isJson);
    return 2;
  }
  if (sweeping) return forgetEveryEndedSession(isJson, isSubagentSessionName);
  if (!name) {
    printError('Usage: hwip forget <session>  (or --ended to drop every session tmux no longer has)', isJson);
    return 2;
  }

  // A subagent pane has no registry row — the sweep never remembers panes — so
  // "never seen" would be a true answer to the wrong question.
  if (isSubagentSessionName(name)) {
    printError(`${name} is a subagent pane — those have no record to forget`, isJson);
    return 1;
  }
  const state = sessionLiveness(name);
  if (state === 'running') {
    printError(`${name} is still running — 'tmux kill-session -t ${name}' first`, isJson);
    return 1;
  }
  // Not the same as "it ended": tmux answered nothing. Deleting on that would
  // take a live session's record and chat history on the strength of a failed
  // question.
  if (state === 'unknown') {
    printError(`could not ask tmux whether ${name} is running — nothing was forgotten`, isJson);
    return 1;
  }

  const outcome = forgetSession(name);
  if (outcome === 'unknown') {
    printError(`${name}: never seen on this machine`, isJson);
    return 1;
  }
  if (isJson) printJson({ session: name, status: outcome });
  else if (outcome === 'scrollback_kept') {
    console.log(`Forgot ${name} — dropped from the record, but its chat scrollback would not delete`);
  } else {
    console.log(`Forgot ${name}`);
  }
  return 0;
};

/**
 * `hwip worktree` lists the worktrees `--wt` made and what keeps each;
 * `hwip worktree clean` removes the ones nothing keeps (`--dry-run`: only says).
 * The same judgement the listener makes when a session ends (`worktree.ts`),
 * run on demand for the ones it left, or never saw end.
 */
const handleWorktree = async (args: Record<string, string | boolean>): Promise<number> => {
  const sub = typeof args._arg1 === 'string' ? args._arg1 : '';
  if (sub && sub !== 'list' && sub !== 'clean') {
    console.error(`hwip worktree: unknown subcommand '${sub}' (list, clean)`);
    return 2;
  }
  const dryRun = flagOn(args, 'dry-run');
  if (dryRun && sub !== 'clean') {
    console.error("hwip worktree: --dry-run belongs to 'hwip worktree clean'");
    return 2;
  }
  const { readPaneCwds, reconcileWorktrees, tmuxRun, worktreeStatuses } = await import('./worktree.js');
  // The daemon's tmux socket, not only the default one: a pane read from the wrong server is a session read as over.
  const { tmuxArgs } = await import('./listener.js');
  const panes = await readPaneCwds((tmuxCmd, timeout) => tmuxRun(tmuxArgs(tmuxCmd), timeout));
  if (sub !== 'clean') {
    // The list only reads: without tmux it still says what holds each worktree, just not which are in use.
    if (!panes) console.error('hwip worktree: could not ask tmux which sessions are running — "in use" is not shown');
    const statuses = await worktreeStatuses(panes ?? []);
    if (statuses.length === 0) console.log('No worktrees made by hwip --wt. (`git worktree list` shows every worktree.)');
    for (const { row, state } of statuses) console.log(`${row.path}  (${row.branch})  ${state}`);
    return 0;
  }

  if (!panes) {
    console.error('hwip worktree: could not ask tmux which sessions are running — nothing was judged');
    return 1;
  }
  const report = await reconcileWorktrees({ paneCwds: panes, manual: true, dryRun });
  for (const r of report.removed) {
    console.log(`${dryRun ? 'Would remove' : 'Removed'} ${r.path}${r.branchDeleted ? ` (branch ${r.branch} deleted)` : ''}`);
  }
  for (const path of report.gone) console.log(`${dryRun ? 'Would forget' : 'Forgot'} ${path} (directory already gone)`);
  for (const k of report.kept) console.log(`Kept ${k.path} — ${k.reasons.join(', ')}`);
  for (const path of report.inUse) console.log(`In use ${path}`);
  const total = report.removed.length + report.kept.length + report.inUse.length + report.gone.length;
  if (total === 0) console.log('No worktrees made by hwip --wt.');
  // A refusal is the judgement working; a removal git turned down after the check passed is not.
  return report.kept.some((k) => k.removeFailed) ? 1 : 0;
};

const forgetEveryEndedSession = async (
  isJson: boolean,
  isSubagentSessionName: (name: string) => boolean,
): Promise<number> => {
  const { liveSessionNames } = await import('./listener.js');
  const { forgetEnded } = await import('./session-registry.js');
  // One question for the whole sweep, asked before anything is deleted: a
  // per-name probe would let tmux go away halfway through and turn the rest of
  // the registry into "ended".
  const running = liveSessionNames();
  if (running === null) {
    printError('no tmux server answered — nothing was forgotten', isJson);
    return 1;
  }
  const live = new Set(running);
  // A subagent pane is not in that list and never will be: panes are mapped by
  // the daemon's sweep, and this process has no such map. Unknown is the honest
  // answer, and it is the one that leaves the row alone — a guard against a
  // pane name reaching the registry, not something today's registry contains
  // (`listener.ts`: the sweep never remembers panes), so the lines below that
  // report it stay unprinted until that changes.
  const liveness = (name: string): SessionLiveness => {
    if (isSubagentSessionName(name)) return 'unknown';
    return live.has(name) ? 'running' : 'ended';
  };

  const sweep = forgetEnded(liveness);
  if (isJson) {
    printJson(sweep);
    return 0;
  }
  const { forgotten, scrollbackKept, kept, unreachable } = sweep;
  for (const name of forgotten) {
    const note = scrollbackKept.includes(name) ? ' — chat scrollback would not delete' : '';
    console.log(`Forgot ${name}${note}`);
  }
  for (const name of unreachable) console.log(`Left ${name} alone — could not tell whether it is running`);
  const tail = unreachable.length > 0 ? `, left ${unreachable.length} undecided` : '';
  if (forgotten.length === 0) console.log(`Nothing to forget — ${kept.length} running${tail}`);
  else console.log(`Forgot ${forgotten.length} ended session(s), kept ${kept.length} running${tail}`);
  return 0;
};

/** Parse a gate count flag; garbage input falls back to the default (never accidentally silences). */
const gateCount = (raw: string | boolean | undefined, fallback: number): number => {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const readStdin = async (): Promise<string> => {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  return stdin;
};

/**
 * Internal — invoked by the Gemini/Codex prompt-submit hooks that
 * `hwip setup` registers, never typed by users (hence absent from help).
 * Reads the hook JSON on stdin; prints additionalContext JSON on a match
 * (remote-origin detection, ADR-0002). Always exits 0: the hook only adds
 * context and must never block a prompt.
 */
const handleRemoteHook = async (args: Record<string, string | boolean>): Promise<number> => {
  const agent = args._arg1 as string;
  if (!isRemoteHookAgent(agent)) return 0;
  try {
    const out = runRemoteHook(agent, await readStdin());
    if (out) console.log(out);
  } catch {
    /* never block a prompt */
  }
  return 0;
};

/**
 * `hwip notify --channel <channelId|name> …` — push to a channel this account owns.
 *
 * Not the agent hook's path: it skips the project mute and the push gate (a person
 * typed this), sends plain text, and never fills a
 * title or body from the branch name. The server decides ownership; a name is
 * resolved against `GET /channels` first (channel.ts).
 */
const handleChannelNotify = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const { parseChannelNotify, PLAINTEXT_NOTE, resolveChannel } = await import('./channel.js');
  const parsed = parseChannelNotify(args);
  if ('error' in parsed) {
    printError(parsed.error, isJson);
    return 2;
  }
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const target = resolveChannel(await hook.listChannels(), parsed.ref);
    if ('error' in target) {
      printError(target.error, isJson);
      return 2;
    }
    console.error(PLAINTEXT_NOTE);
    let result;
    try {
      result = await hook.notify({ ...parsed.payload, channelId: target.channelId });
    } catch (err) {
      if (err instanceof HwipError && err.status === 403 && !(err instanceof QuotaExceededError)) {
        printError(`${err.message} — only the channel's owner can send to it`, isJson);
        return 1;
      }
      throw err;
    }
    if (isJson) {
      printJson({ pushId: result.pushId, channelId: target.channelId, encrypted: false, status: 'ok' });
    } else {
      console.log(`Push sent to ${target.name ? `"${target.name}" ` : ''}(${target.channelId}): ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

/** `hwip channel list` — the channels this account owns and follows. */
const handleChannel = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  if (args._arg1 !== 'list') {
    printError('Usage: hwip channel list', isJson);
    return 2;
  }
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const { channelLines } = await import('./channel.js');
    const channels = await hook.listChannels();
    if (isJson) printJson(channels);
    else for (const line of channelLines(channels)) console.log(line);
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleNotify = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  if (args.channel !== undefined) return handleChannelNotify(args);
  const projectDir = detectProjectDir();
  if (isMuted(projectDir)) return 0;

  // --auto: apply the shared push-gate before sending. Inputs default to
  // GATE_DEFAULTS ("assume real work") so dumb hooks keep their historical
  // always-push behavior in normal mode, while the /hwip-mode quiet | /hwip-mode loud
  // dial now works for every hook-driven agent. Gated-out → silent success.
  // With no dial the mode falls back to --pushmode-default, then to quiet.
  // Quiet still pushes when the user has left the terminal (presence.ts).
  if (flagOn(args, 'auto')) {
    const marker = normalizeMarker(typeof args.marker === 'string' ? args.marker : undefined);
    const pushMode = autoPushMode(projectDir, args[PUSHMODE_DEFAULT_FLAG]);
    const verdict = decidePush({
      toolCount: gateCount(args[TOOL_COUNT_FLAG], GATE_DEFAULTS.toolCount),
      nonReadonlyCount: gateCount(args[NONREADONLY_COUNT_FLAG], GATE_DEFAULTS.nonReadonlyCount),
      alreadyAsked: GATE_DEFAULTS.alreadyAsked,
      marker,
      pushMode,
      away: awayForGate(pushMode, marker),
    });
    if (!verdict.push) return 0;
    if (verdict.priority === 'high' && !args.priority) args.priority = 'high';
  }

  // Past the gates, this IS a push attempt — its outcome is recorded for
  // `hwip verify` and the plugin (notify-failure.ts), since hooks discard stderr.
  const hook = createHook(args, flagOn(args, 'auto') ? HOOK_REQUEST_TIMEOUT_MS : undefined);
  if (!hook) {
    recordNotifyFailure({ kind: 'no-key', status: null, code: null });
    return 3;
  }

  try {
    const sessionId = (args.session as string | undefined) || resolvedEnv('HWIP_SESSION_ID') || undefined;

    // When body isn't supplied (common case for hook-driven invocations like
    // `hwip notify --title "Task done"`), auto-fill with branch + project so
    // the user can tell which session finished without opening the app.
    let title = args.title as string | undefined;
    let body = args.body as string | undefined;
    if (!body) {
      const { branch, project } = detectBranchAndProject();
      body = branch ? `${project} · ${branch}` : project;
    }
    if (!title) title = 'Task done';

    const result = await withNotifyFailureRecord(() => hook.notify({
      title,
      body,
      url: args.url as string | undefined,
      type: (args.type as 'note' | 'link' | 'file' | 'hook') || 'hook',
      priority: (args.priority as 'low' | 'normal' | 'high' | 'urgent') || undefined,
      targetDeviceId: args.device as string | undefined,
      sessionId,
    }));

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok' });
    } else {
      console.log(`Push sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleList = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    // Clamp to the documented 1-20 range; a non-numeric value falls back to
    // the server default instead of sending limit=NaN in the query string.
    const rawLimit = args.limit ? Number(args.limit) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.floor(rawLimit))) : undefined;
    const result = await hook.list({
      limit,
      type: args.type as 'note' | 'link' | 'file' | 'clipboard' | 'hook' | undefined,
    });

    if (isJson) {
      printJson(result);
    } else {
      if (result.pushes.length === 0) {
        console.log('No pushes found.');
      } else {
        for (const p of result.pushes) {
          // Sealed for the phone: this host holds no key to open it.
          const title = p.isEncrypted ? '[encrypted]' : (p.title ?? '(no title)');
          const time = new Date(p.createdAt).toLocaleString();
          console.log(`  ${p.pushId}  [${p.type}]  ${title}  (${time})`);
        }
        if (result.hasMore) console.log(`  ... more available (use --limit to increase)`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleDismiss = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    if (flagOn(args, 'all')) {
      const result = await hook.dismissAll();
      if (isJson) {
        printJson({ dismissed: result.dismissed, status: 'ok' });
      } else {
        console.log(`Dismissed ${result.dismissed} pushes.`);
      }
    } else {
      const pushId = args._arg1 as string;
      if (!pushId) {
        printError('Push ID required. Usage: hwip dismiss <push-id> or hwip dismiss --all', isJson);
        return 1;
      }
      await hook.dismiss(pushId);
      if (isJson) {
        printJson({ dismissed: true, pushId, status: 'ok' });
      } else {
        console.log(`Dismissed: ${pushId}`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleTest = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = flagOn(args, 'json');
  const hook = createHook(args);
  if (!hook) {
    recordNotifyFailure({ kind: 'no-key', status: null, code: null });
    return 3;
  }

  try {
    const result = await withNotifyFailureRecord(() => hook.notify({
      title: 'Hwip Test',
      body: `CLI connected successfully (v${VERSION})`,
    }));

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok', message: 'Test notification sent' });
    } else {
      console.log(`Test notification sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

// ── Error Handler ───────────────────────────────────────────────

const handleError = (err: unknown, isJson: boolean): number => {
  if (err instanceof QuotaExceededError) {
    printError(err.message, isJson);
    return 2;
  }
  if (err instanceof AuthenticationError) {
    printError(err.message, isJson);
    return 3;
  }
  if (err instanceof HwipError) {
    printError(err.message, isJson);
    return 1;
  }
  printError(err instanceof Error ? err.message : 'Unknown error', isJson);
  return 1;
};

// ── Passthrough ─────────────────────────────────────────────────

/**
 * Collect raw argv after the given subcommand token so flags like
 * `--resume` reach the wrapped agent verbatim instead of being swallowed
 * by `parseArgs`. Returns [] when the command isn't found.
 */
const collectPassthrough = (argv: string[], cmd: string): string[] => {
  const idx = argv.indexOf(cmd, 2);
  return idx >= 0 ? argv.slice(idx + 1) : [];
};

// ── Main ────────────────────────────────────────────────────────

/** The commands that show, and clear, the recorded key changes. */
const KEY_CHANGE_SURFACES = new Set(['verify', 'trust', 'test', 'notify', 'ask']);

const main = async (): Promise<number> => {
  const { args, sendArgv } = parseCliArgv(process.argv);
  const command = args._command as string;

  if (flagOn(args, 'version', true)) {
    console.log(VERSION);
    return 0;
  }

  // Remote-control subcommands (`hwip cc` / `hwip codex` / …) come from the
  // registry — one table row per agent, no hardcoded cases. Pass the typed
  // command token to collectPassthrough (aliases map to the same agent).
  const remote = findAgentBySubcommand(command);

  // Before any command runs.
  if (asksForUsage(process.argv, args, remote !== undefined)) {
    // `hwip notify --help` and `hwip help notify` print that command's usage;
    // no command, or a word that is not one, prints all of them.
    printUsage(usageTarget(args));
    return 0;
  }

  // Before any request, the listener's socket included — but after `--version`
  // and usage, which must answer whatever the environment holds.
  try {
    await useProxyFromEnv(process.env, loadConfig());
  } catch (err) {
    // A hook's stderr is thrown away; leave the reason where `hwip-mode` reads
    // it. `network`: nothing was sent, and that is why.
    if (command === 'notify') recordNotifyFailure({ kind: 'network', status: null, code: 'PROXY_CONFIG' });
    throw err;
  }

  if (remote) {
    const { handleAgentSession, splitAgentOptions } = await import('./wrapper.js');
    const { opts, rest, error } = splitAgentOptions(collectPassthrough(process.argv, command));
    if (error) {
      console.error(`hwip: ${error}`);
      return 2;
    }
    return handleAgentSession(remote, rest, opts);
  }

  for (const flag of unknownFlags(args)) console.error(`hwip ${command}: unknown flag --${flag} (ignored)`);

  // A yes/no flag with a value that is neither (`--dry-run=maybe`) stops the command before it does anything.
  const badValue = badFlagValue(args);
  if (badValue) {
    // The value is whatever was typed (a key pasted after a yes/no flag is possible): cleaned like the error path below.
    console.error(redactSecrets(`hwip ${command}: ${badValue}`));
    return 2;
  }

  // A device whose key changed waits beside the pins until a person is shown it (key-changes.ts): these are the commands
  // a person types. At a terminal only — a hook's `hwip notify … 2>/dev/null` would take it unseen.
  if (KEY_CHANGE_SURFACES.has(command)) showKeyChanges(TRUST_FILE, process.stderr);

  switch (command) {
    case 'install':
    case 'setup':
      return (await import('./installer.js')).handleInstall(args);
    case 'login':
      return (await import('./login.js')).handleLogin(args);
    case 'uninstall':
      return (await import('./uninstall.js')).handleUninstall(args);
    case 'verify':
      return (await import('./verify.js')).handleVerify(args);
    case 'check-update':
      return (await import('./check-update.js')).handleCheckUpdate(args);
    case 'notify':
      return handleNotify(args);
    case 'channel':
      return handleChannel(args);
    case 'ask':
      return (await import('./ask.js')).handleAsk(args);
    case 'ask-context':
      return (await import('./ask-context-switch.js')).handleAskContext(args);
    case 'file-view':
      return (await import('./file-view-switch.js')).handleFileView(args);
    // `hwip agent send` is the name (C82); `hwip send` is the older one for the same command.
    case 'agent':
    case 'send': {
      if (command === 'agent' && args._arg1 === 'list' && flagOn(args, 'all')) {
        // Every machine is the server's device list: this one needs the API key.
        const hook = createHook(args);
        if (!hook) return 3;
        return (await import('./agent-list.js')).handleAgentListAll(args, hook);
      }
      // Read-only and local: before `createHook`, so no API key is needed (no exit 3).
      if (command === 'agent' && args._arg1 === 'list') return (await import('./agent-list.js')).handleAgentList(args);
      if (command === 'agent' && args._arg1 === 'read') return (await import('./agent-read.js')).handleAgentRead(args);
      const { agentSubcommandError, liveSendDeps, parseSendArgs, runSend, sendReadsStdin } = await import('./send.js');
      const named = command === 'agent' ? 'agent send' : 'send';
      const unknown = command === 'agent' ? agentSubcommandError(String(args._arg1)) : null;
      if (unknown) {
        console.error(unknown);
        return 2;
      }
      // `--all` and `--turns` are agent list's and agent read's: the `agent` flag table is shared, so send refuses them rather than ignore them.
      if (command === 'agent' && (flagOn(args, 'all') || args.turns !== undefined)) {
        console.error(`hwip ${named}: --all and --turns are for agent list / agent read`);
        return 2;
      }
      const send = parseSendArgs(sendArgv, sendReadsStdin(sendArgv) ? await readStdin() : undefined, named);
      if ('error' in send) {
        console.error(send.error);
        return 2;
      }
      const hook = createHook(args);
      if (!hook) return 3;
      return runSend(send, liveSendDeps(hook), named);
    }
    case 'list':
      return handleList(args);
    case 'dismiss':
      return handleDismiss(args);
    case 'rename':
      return handleRename(args);
    case 'forget':
      return handleForget(args);
    case 'worktree':
      return handleWorktree(args);
    case 'test':
      return handleTest(args);
    case 'trust':
      return handleTrust(args);
    case 'schedule':
      return (await import('./schedule-command.js')).handleSchedule(collectPassthrough(process.argv, command));
    case 'sh': {
      const { handleShellSession, splitAgentOptions } = await import('./wrapper.js');
      const { opts, rest, error } = splitAgentOptions(collectPassthrough(process.argv, command));
      if (error || rest.length || opts.worktree) {
        console.error(`hwip: ${error ?? "'hwip sh' takes only --label <x> and --detach"}`);
        return 2;
      }
      return handleShellSession(opts);
    }
    case 'mcp':
      return (await import('./mcp.js')).handleMcp();
    case 'listener':
      return (await import('./listener.js')).handleListener(args);
    case 'remote-hook':
      return handleRemoteHook(args);
    default:
      printError(`Unknown command: ${command}`, flagOn(args, 'json', true));
      printUsage();
      return 1;
  }
};

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
