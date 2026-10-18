/**
 * `hwip listener` — resident daemon that watches the user's Hwip feed
 * over a persistent WebSocket and injects matching messages into a
 * named tmux session via `tmux send-keys`.
 *
 * Solves the MCP polling-window problem: an `hwip_ask` polling cycle
 * times out (120–600 s) and the CC/Codex session becomes unaddressable
 * from the phone. The listener stays subscribed indefinitely and can
 * deliver to any named tmux session at any time.
 *
 * Wire format: pushes with `type='agent.command'` carry the tmux
 * session name in `agentSessionName` and the message in `body`. The
 * "AI Agent에게 명령" sheet on the phone builds these structured
 * pushes from the listener-reported session inventory. Other push
 * types (Stop-hook auto-pushes, hwip_ask responses, channel
 * broadcasts) are ignored.
 *
 * Transport: WebSocket against the Hwip $connect endpoint with
 * `?apiKey=<key>`. The server fan-out pushes `{ type: 'push.new', data }`
 * messages as new pushes are created. Reconnects with exponential
 * backoff on transient failures; gives up on auth failures (4001/4002/4003).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants, copyFileSync, existsSync, linkSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'fs';
import { handBackToSudoUser, mkdirHandedBack } from './private-files.js';
import { homedir, hostname } from 'os';
import { join, basename, dirname, isAbsolute, resolve, sep } from 'path';
import WebSocket from 'ws';
import { checkoutOf, configIgnoredBecause, groupOf, keyIsFromFile, loadConfig, resolveBaseUrl, resolvedEnv, type HwipConfig, SESSION_LABEL_OPTION, SESSION_PROJECT_OPTION, SESSION_SHELL_OPTION, TRUST_FILE, VERSION, type Checkout } from './config.js';
import { apiFetch, apiUrl } from './api.js';
import { appendShellAudit, type ShellAuditEntry } from './shell-audit.js';
import { downloadUrlProblem, warnInsecureUrl } from './insecure-url.js';
import { redactSecrets } from './redact.js';
import { createByteBudget, FILE_VIEW_WINDOW_BYTES, FILE_VIEW_WINDOW_MS } from './file-view-budget.js';
import { escapeLogUnsafe, fileViewOffBy } from './file-view-switch.js';
import { listTree, readBlob } from './file-view.js';
import { collectDiffFiles, collectFilePatch, DIFF_PAGE_MAX_BYTES, pagePatch, repoRootOf, type DiffBase } from './session-diff.js';
import { legacyWsEnvNotice, resolveWsUrlDetailed, socketUrlWith, wsUrlProblem } from './ws-url.js';
import {
    awaitServiceListener,
    clearListenerRuntime,
    clearStaleListenerRuntime,
    LISTENER_LOG_FILE,
    LISTENER_PID_FILE,
    listenerLogSize,
    otherListenerNote,
    otherListenerPid,
    rotateListenerLogIfLarge,
    runningListenerPid,
    startFailure,
    startListenerDetached,
    stopListener,
    writeListenerRuntime,
    type ListenerStart,
} from './listener-process.js';
import { projectHash, remoteDigest, remoteMarkerPath, stateDir } from './gate.js';
import {
    forgetSession,
    knownSessions,
    recallRun,
    runKey,
    recallSession,
    rememberSessions,
    sessionDirectoryExists,
} from './session-registry.js';
import { foregroundAgentFor, REMOTE_AGENTS, type AgentKind, type RegisteredRemoteAgent } from './remote-agents.js';
import {
    initialSubagentScanState,
    SUBAGENT_CATCH_UP_BYTES,
    scanSubagents,
    type SubagentScanState,
} from './subagent-transcripts.js';
import { projectTranscriptEntries, type TranscriptSource } from './transcript-tail.js';
import {
    installService,
    restartService,
    SERVICE_LABEL,
    serviceInstalled,
    serviceStatus,
    stopService,
    uninstallService,
} from './listener-service.js';
import { advanceState, evaluateState, findPatternMatch, patternError, type AgentState, type EvaluationResult, type StateTracker } from './agent-state.js';
import { startInventoryOffload, type InventoryOffload } from './inventory-offload.js';
import { planSessionsReport, sendSessionsReport, SESSIONS_ACK_TIMEOUT_MS, SESSIONS_REPORT_MAX_BYTES } from './sessions-report.js';
import { getActiveManifest, loadManifestFromCache, refreshManifest, RULES_REFRESH_INTERVAL_MS } from './agent-rules-fetch.js';
import { decryptPushBodyForDevice, deriveLanSharedSecret, getDevicePublicKey, initDeviceCrypto, isSealedV2, keyFingerprint, openV2, samePublicKey, sealV2, unwrapDeviceKey, type SealedFileMeta, type SealedV2 } from './crypto.js';
import { createDeviceDirectory, type DeviceDirectory } from './device-directory.js';
import { createTurnRecorder, type RecordableSession, type TurnRecorder } from './turn-recorder.js';
import { accountRecipients, createChunkUploader, createLatestSeqReader, sealChunk } from './turn-recorder-wire.js';
import { isPromptId } from './blocked-prompt.js';
import { createPromptSealer, promptStillShown, type BlockedPromptWire, type PromptSealer } from './blocked-prompt-seal.js';
import {
    createRefusalLimiter,
    createRefusalReporter,
    isSessionStateRefusal,
    reasonForPhone,
    REFUSAL_FRAMES_PER_MINUTE,
    REFUSAL_WINDOW_MS,
    type CommandRefusal,
} from './command-refusal.js';
import { optionalFeatures } from './optional-features.js';
import { createSubscriberTrust, type Admission, type RefusalCode, type SubscriberTrust } from './subscriber-trust.js';
import { isTransferId } from './lan-auth.js';
import { downloadsDir, resolveDownloadPath, safeFileName, sweepStaleParts } from './downloads.js';
import { webSocketProxyOptions } from './http-failure.js';
import { notifyDesktop, type DesktopNotification } from './desktop-notify.js';
import { createWorktreeCleanup } from './listener-worktree-cleanup.js';
import { tmuxRun } from './worktree.js';
import { chunkOf, createFileDecryptStream, DOWNLOAD_MAX_BYTES, saveStream, withIdleTimeout } from './file-crypto.js';
import { createTurnWatchers, type SendTurnFrame, type TurnWatchControl } from './turn-watch.js';
import { diskTurnRing } from './turn-ring.js';
import { createInputSequencer, type InputSequencer, type SequencedInput } from './input-sequencer.js';
import { startKeepAwake } from './keep-awake.js';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { createLanPublisher } from './lan-endpoint.js';
import { LAN_LANDED_IV, startLanReceiver } from './lan-receiver.js';
import { createLanTransfer, type LanTransfer } from './lan-transfer.js';
import { createDeviceKeyRegistration, type DeviceKeyRegistration } from './device-presence.js';
import { PAYLOAD_LIMIT_BYTES, scanAgentCommands, type AgentCommandCatalog, type ScanResult } from './command-scan.js';
import { hashListenerId, readMachineId, readStickyListenerId, rememberListenerId } from './listener-device-id.js';
import { createPaneFitter, releaseStaleFits } from './pane-fit.js';
import { log, silenceListenerLog } from './listener-log.js';
import { invalidateTmuxSocketCache, tmuxArgs } from './tmux-socket.js';
import {
    detectRemoteAgent, FIELD_SEP, isSubagentSessionName, readPaneInfo, recordSubagentTranscripts, recordTargets,
    subagentTranscriptFor, tmuxTargetFor, type PaneInfo,
} from './tmux-pane.js';
import { liveSessionNames, sessionExists, sessionLiveness } from './tmux-liveness.js';
import { FlagValueError, flagOn } from './args.js';
import { listSchedules, readScheduleState, writeScheduleState } from './schedule.js';
import { launchHwip } from './schedule-launch.js';
import { applyPhoneSchedule, livePhoneScheduleDeps, scheduleAnswer, type PhoneScheduleDeps } from './schedule-remote.js';
import { createScheduleRunner, notifyFailureOutcome, PROMPT_POLL_MS, TICK_MS as SCHEDULE_TICK_MS, type NotifyOutcome, type ScheduleRunnerDeps } from './schedule-runner.js';
import { canPromptKind, createReadyCheck, scheduleScreenState } from './schedule-ready.js';
import { HwipHook } from './hwip-hook.js';
import { sleepSync } from './trust-lock.js';

// A ping goes out only when this listener has said nothing for PING_IDLE_MS: the report heartbeat
// (SESSION_REPORT_HEARTBEAT_MS) is itself traffic the server answers, so while it flows a ping would be
// a second message for the same proof of life. Under API Gateway's 10 minute idle limit (not raisable)
// with room for one lost ping; PING_CHECK_MS is only how often that is looked at (a local timer).
export const PING_IDLE_MS = 240_000;
const PING_CHECK_MS = 30_000;

/** Whether the socket has been quiet on our side long enough that a ping is due. */
export const pingDue = (lastSentAtMs: number, nowMs: number, idleMs: number = PING_IDLE_MS): boolean =>
    nowMs - lastSentAtMs >= idleMs;
// Shutdown cap for releasing the local-transfer port. The retract itself is
// one frame on the socket that is already closing, not a round trip; what
// this waits for is the receiver's own close. `stopListener`
// (listener-process.ts) SIGKILLs the daemon 3 s after SIGTERM on --stop /
// --restart / service install, so the cap stays under that. A retract the
// kill cuts off is harmless: senders also require `isOnline`, which the dead
// WebSocket no longer satisfies.
const LAN_RETRACT_WAIT_MS = 2_500;
// How long the server may say nothing at all — any inbound frame counts, ack
// or pong — before the socket is presumed dead. Not "how slow may a pong be":
// the watchdog measures silence since the last frame, not a deadline it armed.
//
// It was 10 s, which a working socket loses on a busy link: a listener
// carrying live-mirror frames (30 KB each) alongside its own reports was
// measured on 2026-09-18 delivering a message to the server 9 s after
// sending it, and its ack 12 s after. The client then killed a connection
// that was merely late, reconnected, restarted the streams, and did it
// again every 1-3 minutes. 30 s lets a whole ping cycle be missed.
//
// Now 300 s: the heartbeat that keeps the link alive is 120 s apart, so two minutes of silence is
// normal and 30 s would have the watchdog cut a healthy socket on every beat. A half-open socket
// is no longer caught by this alone — a report that gets no answer in REPORT_ACK_TIMEOUT_MS is
// (`createReportAckWatch`); this is the backstop for a link with nothing to send.
const PONG_TIMEOUT_MS = 300_000;
// How often the event-loop stall meter samples itself, and how much of a
// silence has to be this thread's own absence before the silence stops being
// evidence about the socket.
//
// The watchdog runs on the thread that also reads inbound frames, so a blocked
// thread cannot tell a dead socket from its own blindness — and left to itself
// it reads its own blindness as the socket's death. Measured 2026-09-18: a
// blocking inventory sweep held this thread long enough that a
// `setInterval(5_000)` fired at a median of 28.5 s, and the heartbeat tore down
// a healthy connection every 1-3 minutes. The meter is what lets the watchdog
// subtract itself from the measurement; WS_STALL_TIMEOUT_MS below is the
// ceiling past which even a blocked thread stops being an excuse.
const LOOP_SAMPLE_MS = 1_000;
const PONG_BLOCKED_GRACE_MS = PONG_TIMEOUT_MS / 3;
// How often the heartbeat asks whether the socket is still worth keeping.
// Short enough that a dead socket dies near PONG_TIMEOUT_MS rather than a
// check interval later.
const HEARTBEAT_CHECK_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.15;

// Hard ceiling on WebSocket connection open time. `ws` has no default
// timeout; without this an unreachable backend (NAT drop, suspended
// laptop network) can hang forever in CONNECTING state and the listener
// quietly stops reporting.
const WS_CONNECT_TIMEOUT_MS = 20_000;

// If no successful round-trip (server-persisted ack) is observed within
// this window, the socket is presumed half-open — TCP says alive but the
// peer never replies. macOS App Nap / Wi-Fi handoff / VPN flap all
// surface this way. Force-terminate so the reconnect loop runs.
const WS_STALL_TIMEOUT_MS = 360_000;

/** What the heartbeat concludes from one look at the socket. */
export type HeartbeatVerdict = 'alive' | 'dead' | 'blocked';

/**
 * Is this socket still worth keeping, given how long the server has said
 * nothing (`silentMs`) and how long this thread was unavailable to hear it
 * (`blockedMs`)?
 *
 * Both questions are needed because only one of them is about the socket. The
 * deadline used to be a per-ping `setTimeout`, which asked neither: it was
 * cancelled by the next ping before it could ever fire on a quiet link, so a
 * genuinely dead socket slipped past it, while a thread blocked long enough to
 * delay its own ping fired it against a connection that was fine. Making the
 * judgment a function of silence and of the judge's own availability is what
 * lets the fast path (`dead` at PONG_TIMEOUT_MS) stay real while a stalled
 * daemon is still forgiven up to the wall-clock ceiling.
 *
 * `blocked` is not a reprieve without end: past WS_STALL_TIMEOUT_MS the socket
 * dies whatever this thread was doing, because at that point we cannot tell the
 * two apart and a reconnect is cheap.
 */
export const heartbeatVerdict = (
    silentMs: number,
    blockedMs: number,
    pongTimeoutMs: number = PONG_TIMEOUT_MS,
    stallTimeoutMs: number = WS_STALL_TIMEOUT_MS,
    blockedGraceMs: number = PONG_BLOCKED_GRACE_MS,
): HeartbeatVerdict => {
    if (silentMs > stallTimeoutMs) return 'dead';
    if (silentMs <= pongTimeoutMs) return 'alive';
    return blockedMs >= blockedGraceMs ? 'blocked' : 'dead';
};

// How often the listener POLLS its local tmux session inventory (and
// immediately on $connect). Cheap — tmux runs locally, so a change is
// still detected (and sent) within a few seconds.
export const SESSION_REPORT_INTERVAL_MS = 5_000;

// How often an UNCHANGED inventory is re-sent. Every send costs the
// backend a Lambda invocation + several DynamoDB reads + a WS round
// trip, and an idle listener's reports are ~95% no-ops — the dominant
// per-user variable cost. A changed inventory still goes out on the
// next 5 s poll (no latency loss); this only throttles the no-ops.
// Kept above the server's 50 s write-through window
// (AGENT_SESSIONS_REFRESH_MS) so each heartbeat also refreshes
// agentSessionsUpdatedAt, and under half the server's 300 s staleness
// limit (STALE_AGENT_SESSIONS_MS, docs/keepalive.md D1) so one lost beat
// does not blank the phone's list. Side effect: the ack (which carries
// pattern watches) arrives at this cadence while idle, so a newly-created
// watch can take up to 2 minutes to reach an idle listener.
export const SESSION_REPORT_HEARTBEAT_MS = 120_000;

/** How long a report may go unanswered before the socket is presumed dead and re-opened. */
export const REPORT_ACK_TIMEOUT_MS = 30_000;

/**
 * Whether what was sent is being answered. Every `listener.sessions` report gets an ack (or an error)
 * back, so the oldest report still waiting for one says how long the server has been deaf to us —
 * which a quiet link cannot tell from a dead one, and which the long silence limit
 * (PONG_TIMEOUT_MS) no longer catches in time. Time this thread could not hear anything (its own
 * blocking, as `loopStallMs` measures) is not counted against the server.
 */
export const createReportAckWatch = (timeoutMs: number = REPORT_ACK_TIMEOUT_MS) => {
    let waiting: { at: number; stallMs: number } | null = null;
    return {
        /** A report went out. The oldest one still unanswered is the one that counts. */
        sent: (nowMs: number, stallMs = 0): void => { waiting ??= { at: nowMs, stallMs }; },
        /** An ack or an error came back: the server heard us. */
        answered: (): void => { waiting = null; },
        overdue: (nowMs: number, stallMs = 0): boolean =>
            waiting !== null && nowMs - waiting.at - Math.max(0, stallMs - waiting.stallMs) > timeoutMs,
    };
};

/** What a reported session runs: a registered agent, or a `hwip sh` shell. */
export type SessionKind = AgentKind | 'shell';

interface AgentSession {
    name: string;
    attached: boolean;
    agentKind: SessionKind;
    /** Set when this session is a SUBAGENT — an extra pane of the parent
     *  session `parentName` (`hwip-hwip.48` belongs to `hwip-hwip`). Subagent
     *  sessions are view-only: input, keys, exit, resume and forget are
     *  refused, and the server never pushes agent.state transitions for them. */
    parentName?: string;
    /** Calls a subagent has made so far, from its own transcript. Only a
     *  transcript subagent has one: a pane subagent is watched as a screen, and
     *  nothing counts what happens on it. */
    toolCount?: number;
    /** Set on a subagent with no pane at all (Claude Code's `Agent` tool): there
     *  is no screen to stream, only its transcript. Absent on a pane subagent —
     *  which can run Claude Code too, so the kind cannot stand in for this. */
    inProcess?: true;
    agentSessionId?: string | null;
    project: string;
    label?: string | null;
    /**
     * The name the agent itself calls this session by, when its registry
     * exposes one (Claude Code's `hwipit-95`). A live read, not user intent —
     * the phone's rename still wins over it. Null where the agent has no name
     * concept, where the pane's session could not be identified, or where the
     * name is blank.
     *
     * Deliberately NOT `sessionName`: everywhere else in this file and on the
     * wire that word means the tmux session name (`agentSessionName` in a
     * push, `AgentWatchRecord.sessionName` on the server). Two names for a
     * session is already the problem this field exists to solve; reusing the
     * word for both would put the ambiguity in the type.
     */
    providerSessionName?: string | null;
    createdAt?: string;
    /**
     * Which run of the name this is (hwip docs/session-runs.md): tmux
     * `session_created` in epoch seconds, as a decimal string — the same
     * instant as `createdAt`. A name is handed out again when an agent starts
     * in the same folder; this is what tells the two apart. Absent on subagent
     * rows, which are panes of their parent's run.
     */
    runId?: string;
    lastActivityAt?: string;
    /**
     * Detected agent state (wire contract — flows to the server and the
     * phone's Agents tab). Absent when the pane can't be captured or
     * detection is unavailable. `done` never appears here: it's derived
     * client-side (SPEC-AGENT-AWARENESS §S1/§S6).
     */
    state?: AgentState;
    stateChangedAt?: string;
    stateRuleId?: string;
    /**
     * What a `blocked` session is waiting for, sealed for the trusted devices
     * (hwip SERVER-API.md `blockedPrompt`). Only on a main session in a dialog
     * this listener can read; absent otherwise, and the state alone is reported
     * as before.
     */
    blockedPrompt?: BlockedPromptWire;
}

/**
 * Change-fingerprint for the report gate. Mirrors the server's
 * REPORTED_SESSION_FIELDS comparison (hwip ws.ts sameReportedSessions):
 * same fields, order-independent, undefined/null collapsed — so the
 * client-side skip can never suppress a report the server would have
 * treated as a change. Keep the field list in sync with the server.
 */
/**
 * Sessions this machine has run and is not running now, as the phone's "past
 * sessions" list.
 *
 * The list used to be derived on the phone from a page of recent pushes, which
 * answered a different question than the one being asked: not "which sessions
 * existed on this machine" but "what is in the newest fifty pushes". A busy day
 * pushed real sessions out of that window while sessions the daemon had never
 * recorded stayed in it — so the list and the resume button disagreed in both
 * directions, offering rows that could not start and hiding rows that could.
 *
 * The registry is the machine's own answer to that question, and the same
 * record resume reads, so a row that appears here is a row that can start.
 *
 * `cwd` is deliberately left behind. The registry keeps it because resume needs
 * somewhere to start the agent; nothing off this machine needs a filesystem
 * path, and sending one would hand the relay a map of the user's disk for no
 * behaviour in return.
 *
 * Live sessions are excluded, which the phone would do anyway — but doing it
 * here also keeps the payload still. Their `lastSeenAt` moves every sweep, and
 * a field that changes every five seconds would defeat the report's
 * unchanged-inventory gate and write to the device record all day.
 */
/**
 * Sockets dropped in a row because the server did not know them, reset by the
 * first report that lands. The cap is what keeps a server-side "reconnect"
 * that reconnecting cannot fix from turning into a connect loop.
 */
export const MAX_STALE_CONNECTION_DROPS = 3;
let staleConnectionDrops = 0;

/**
 * Whether a `listener.sessions.error` is the server telling us this connection
 * is not registered. Keyed on the instruction rather than the wording of the
 * diagnosis: the server says what it wants the client to DO, and every other
 * rejection (a malformed report, a payload too large) is not fixed by
 * reconnecting and must not cause one.
 */
export const askedToReconnect = (message: unknown): boolean =>
    typeof message === 'string' && /reconnect/i.test(message);

/** What to do about one `listener.sessions.error`. */
export type StaleConnectionAction =
    /** Drop the socket; the reconnect loop registers a fresh connection. */
    | 'drop'
    /** Not a connection problem — reconnecting would not fix it. */
    | 'ignore'
    /** Dropped this many times already and the reports still bounce. */
    | 'exhausted';

/**
 * The policy, separated from the socket it acts on so it can be read and
 * tested as what it is: two guards around one lever.
 */
export const staleConnectionAction = (message: unknown, drops: number): StaleConnectionAction => {
    if (!askedToReconnect(message)) return 'ignore';
    return drops < MAX_STALE_CONNECTION_DROPS ? 'drop' : 'exhausted';
};

export const KNOWN_SESSIONS_REPORTED = 50;

export interface ReportedKnownSession {
    name: string;
    agentKind: string;
    project?: string;
    label?: string;
    /** The run's id and start (hwip docs/session-runs.md); absent for entries recorded before runs. */
    runId?: string;
    startedAt?: string;
    lastSeenAt: string;
}

export const knownSessionsToReport = (
    live: readonly AgentSession[],
    now: number = Date.now(),
): ReportedKnownSession[] => {
    // By name, kind AND run: a slot that is live under claude may still hold an
    // ended pi run — or an ended claude run before this one — and that run is a
    // past session. Excluding the whole name would drop it from the report
    // exactly the way the registry used to drop it from disk. The live run
    // itself stays out for the reason below.
    const running = new Set(live.map((s) => runKey(s.name, s.agentKind, s.runId)));
    return knownSessions(now)
        .filter((e) => !running.has(runKey(e.name, e.agentKind, e.runId)))
        .slice(0, KNOWN_SESSIONS_REPORTED)
        .map((e) => ({
            name: e.name,
            agentKind: e.agentKind,
            ...(e.project ? { project: e.project } : {}),
            ...(e.label ? { label: e.label } : {}),
            ...(e.runId ? { runId: e.runId } : {}),
            ...(e.startedAt ? { startedAt: e.startedAt } : {}),
            lastSeenAt: e.lastSeenAt,
        }));
};

export const knownSessionsFingerprint = (known: ReportedKnownSession[]): string =>
    known.map((k) => `${k.name} ${k.agentKind} ${k.runId ?? ''} ${k.lastSeenAt}`).sort().join('|');

export const sessionsFingerprint = (sessions: AgentSession[]): string =>
    sessions
        .map((s) => JSON.stringify([
            s.name, s.attached, s.agentKind, s.agentSessionId ?? null,
            s.project, s.label ?? null, s.providerSessionName ?? null, s.createdAt ?? null, s.runId ?? null,
            s.lastActivityAt ?? null, s.state ?? null,
            s.stateChangedAt ?? null, s.stateRuleId ?? null,
            s.blockedPrompt?.id ?? null, s.blockedPrompt?.at ?? null,
        ]))
        .sort()
        .join('|');

/** True when this cycle's inventory must be sent: it changed, or the
 *  idle heartbeat is due. */
export const sessionsReportDue = (
    fingerprint: string,
    lastSentFingerprint: string | null,
    lastSentAtMs: number,
    nowMs: number,
): boolean =>
    fingerprint !== lastSentFingerprint ||
    nowMs - lastSentAtMs >= SESSION_REPORT_HEARTBEAT_MS;

/** How often the skill catalog is rescanned for changes. Deliberately far
 *  slower than the session poll: this cycle reads the filesystem, and the
 *  5 s session loop must never do that. */
export const COMMAND_SCAN_INTERVAL_MS = 60_000;

export const commandsFingerprint = (catalog: AgentCommandCatalog): string =>
    JSON.stringify(catalog);

/** Skill catalogs have no idle heartbeat — the server persists them, so an
 *  unchanged machine has nothing to say until a skill is installed or removed. */
export const commandsReportDue = (
    fingerprint: string,
    lastSentFingerprint: string | null,
): boolean => fingerprint !== lastSentFingerprint;

// Per-session token bucket — caps a runaway/compromised sender.
//
// Weighted rather than flat, because the two things that pass through it are
// not the same size. A command submit is one whole instruction to the agent;
// 30 a minute has always been the ceiling for that, and it stays exactly that
// (120 / SUBMIT_COST). A named key is a keystroke — arrowing through a menu or
// holding Backspace is ordinary human speed, and charging it as if it were an
// instruction made the phone's key row refuse a normal burst of taps after a
// couple of seconds.
const RATE_LIMIT_TOKENS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** What one command submit costs, keeping its ceiling at the old 30/min. */
const SUBMIT_COST = 4;

// Shells are refused: a shell prompt + send-keys = arbitrary command exec.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']);

// Auth-failure close codes: retrying with the same bad credentials hammers
// the server forever, so the listener exits instead.
export const AUTH_FAILURE_CODES: ReadonlySet<number> = new Set([4001, 4002, 4003]);

const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();

// Evict idle buckets older than this so the Map can't grow without bound
// under attack. Two refill windows past full refill = bucket is at cap
// anyway and recreating it on next hit is free.
const BUCKET_IDLE_TTL_MS = RATE_LIMIT_WINDOW_MS * 2;

/** Refusal frames to the phone (command-refusal.ts), per session: a flood of refused commands answers a bounded number. */
const refusalFrameLimit = createRefusalLimiter(REFUSAL_FRAMES_PER_MINUTE, REFUSAL_WINDOW_MS);

const pruneStaleBuckets = (now: number): void => {
    for (const [key, b] of buckets) {
        if (now - b.lastRefillAt > BUCKET_IDLE_TTL_MS) buckets.delete(key);
    }
};

export const checkRateLimit = (
    session: string,
    now: number = Date.now(),
    cost: number = 1,
): boolean => {
    pruneStaleBuckets(now);
    const b = buckets.get(session) ?? { tokens: RATE_LIMIT_TOKENS, lastRefillAt: now };
    const elapsed = Math.max(0, now - b.lastRefillAt);
    // Fractional refill is intentional: smooths the boundary so a session
    // hitting the cap doesn't have to wait a full window for the next slot.
    const refilled = Math.min(
        RATE_LIMIT_TOKENS,
        b.tokens + (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_TOKENS,
    );
    if (refilled < cost) {
        buckets.set(session, { tokens: refilled, lastRefillAt: now });
        return false;
    }
    buckets.set(session, { tokens: refilled - cost, lastRefillAt: now });
    return true;
};

/** What the inject guard learns from one probe of a session's pinned pane. */
export interface PaneProbe {
    /** `pane_current_command` — the foreground program. */
    command: string;
    /** The session carries `@hwip_shell` naming itself (`hwip sh`): a shell here may be typed into. */
    shellMarked: boolean;
}

/**
 * Read the foreground command on the named session's PINNED pane, verifying
 * the pane still belongs to that session. A pane id is stable across restarts
 * only within one tmux server: after a restart the same `%N` can name a pane
 * in a different session, and typing into that pane would be RCE into someone
 * else's shell. The owning session and its shell marker ride along in the same
 * display-message — one spawn, no second probe — and a mismatch answers null
 * ("no such session"), which refuses the inject until the next sweep re-pins.
 * An unset option formats as the empty string, so an unmarked pane reads as
 * `shellMarked: false`, never as an error. The marker must name this very
 * session: a format reads a user option through pane → window → session →
 * global inheritance, so a stray `set -g @hwip_shell 1` would otherwise mark
 * every session on the server.
 */
export const probePane = (session: string): PaneProbe | null => {
    const target = tmuxTargetFor(session);
    if (target === null) return null; // unresolvable subagent — never spawn
    const result = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', target,
        `#{pane_current_command}${FIELD_SEP}#{session_name}${FIELD_SEP}#{${SESSION_SHELL_OPTION}}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const parts = (result.stdout ?? '').trim().split(FIELD_SEP);
    if (parts.length !== 3 || parts[1] !== session || !parts[0]) return null;
    return { command: parts[0], shellMarked: parts[2] === session };
};

const isShellPane = (command: string | null): boolean => {
    if (!command) return false;
    return SHELL_COMMANDS.has(command);
};

/** Where a message is parked between `set-buffer` and `paste-buffer`. Named,
 *  so the user's own paste stack is never pushed onto, and `-d` drops it
 *  again the moment it has been delivered. */
const INJECT_BUFFER = 'hwip-inject';

const sendLiteral = (session: string, text: string): boolean => {
    const target = tmuxTargetFor(session);
    if (target === null) return false; // unresolvable subagent — never spawn
    return spawnSync('tmux', tmuxArgs(['send-keys', '-l', '-t', target, text]), { stdio: ['ignore', 'ignore', 'pipe'] })
        .status === 0;
};

/**
 * Put the message in the pane as a PASTE rather than as typing.
 *
 * `send-keys -l` hands the whole string to the application as if it had been
 * typed at once, and a TUI that re-renders per character has to keep up with a
 * burst it never sees from a human. With Hangul — three bytes and two columns
 * per character — it does not: characters go missing and the wrapped line is
 * painted twice. A phone message is a paste, so send it as one.
 *
 * `paste-buffer -p` brackets it only when the application has actually asked
 * for bracketed paste (DECSET 2004); against one that has not, tmux sends the
 * plain text and nothing changes. That gating is why this is safe to do
 * unconditionally — the markers can never leak into an app that would show
 * them as literal `[200~`.
 *
 * Falls back to the old path if either tmux call fails, because a message
 * delivered imperfectly still beats one not delivered.
 */
const pasteText = (session: string, text: string): boolean => {
    // `--` so a message that begins with a dash is data, not an option. The
    // buffer contents are data to paste-buffer as well, which preserves the
    // property `send-keys -l` had: no escape sequence inside a message can
    // drive another tmux command.
    const set = spawnSync('tmux', tmuxArgs(['set-buffer', '-b', INJECT_BUFFER, '--', text]), { stdio: ['ignore', 'ignore', 'pipe'] });
    if (set.status !== 0) return sendLiteral(session, text);
    const pasteTarget = tmuxTargetFor(session);
    if (pasteTarget === null) return false; // unresolvable subagent — never spawn
    const paste = spawnSync('tmux', tmuxArgs(['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', pasteTarget]), { stdio: ['ignore', 'ignore', 'pipe'] });
    if (paste.status === 0) return true;
    // `-d` never ran, so the buffer is still there holding the message.
    spawnSync('tmux', tmuxArgs(['delete-buffer', '-b', INJECT_BUFFER]), { stdio: ['ignore', 'ignore', 'pipe'] });
    return sendLiteral(session, text);
};

/**
 * Inject text into a tmux session: the message as a paste, then a separate
 * `Enter` to submit it. The two stay separate because a bracketed paste is
 * text and only text — newlines inside it must not submit early, and the
 * submit has to be a real key press.
 *
 * Delivering text WITHOUT the submit is `pasteText` on its own — see the
 * `insert` wire field and tryInject's `submit` parameter.
 */
const injectKeys = (session: string, text: string): boolean => {
    if (!pasteText(session, text)) return false;
    const enterTarget = tmuxTargetFor(session);
    if (enterTarget === null) return false; // unresolvable subagent — never spawn
    // Blocking on purpose: nothing else may reach the pane between this paste
    // and its Enter (a second push would be glued onto it, and the Enter would
    // land on whatever came next), and a failed Enter still fails the inject.
    sleepSync(SUBMIT_SETTLE_MS);
    const b = spawnSync('tmux', tmuxArgs(['send-keys', '-t', enterTarget, 'Enter']), { stdio: ['ignore', 'ignore', 'pipe'] });
    return b.status === 0;
};

/**
 * How long a paste is given before its Enter. An agent still taking the paste
 * in drops an Enter that arrives meanwhile, and the message sits in its input
 * unsent (measured 2026-10-13 over tmux, immediate Enter vs 300 ms): Gemini CLI
 * dropped it on every paste, plain text included (10/10; 100-300 ms went
 * 9/9), and Claude Code on a paste naming image paths, which it reads as they
 * land (1 of 3; 50 ms and later went every time). Codex, OpenCode, pi, Hermes
 * and Copilot took the immediate Enter.
 */
const SUBMIT_SETTLE_MS = 300;

// Named keys the phone may inject to drive a full-screen Claude Code pane
// (a `/usage` modal captures text input — only a real Escape/arrow gets out).
// Maps a lowercase wire name to the exact tmux key token. Whitelist-ONLY:
// anything outside this map is refused so a compromised sender can't smuggle
// `C-c`, `M-x`, or a shell command through send-keys' key-name syntax.
// A Map, not a plain object: object indexing leaks the prototype chain, so
// `keys: ['constructor']` resolved to a function that spawnSync happily
// stringified into the pane. Map lookups know only what was put in.
const ALLOWED_KEYS = new Map<string, string>([
    ['escape', 'Escape'],
    ['up', 'Up'],
    ['down', 'Down'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['enter', 'Enter'],
    ['tab', 'Tab'],
    ['backtab', 'BTab'],
    ['backspace', 'BSpace'],
    ['delete', 'DC'],
    ['space', 'Space'],
    // Control keys, added one at a time and only where the phone has no other
    // way to do the thing: interrupt what the agent is doing, toggle its
    // verbose output, clear the screen. The whitelist property is unchanged —
    // naming three does not open send-keys' key-name syntax to a fourth.
    //
    // `ctrl-d` is deliberately absent. At an empty prompt it is EOF: the agent
    // exits, the pane falls back to a shell, and isShellPane then refuses
    // everything — correctly, but the phone has no way to start it again.
    ['ctrl-c', 'C-c'],
    ['ctrl-r', 'C-r'],
    ['ctrl-l', 'C-l'],
    // One letter, under the same rule: `r` retries after a permission prompt
    // is allowed. Typed in the composer it arrives with an Enter attached;
    // this sends the bare key. Letters are otherwise absent — naming `r` does
    // not open the keyboard to `y`/`n`.
    ['r', 'r'],
]);

/**
 * Translate a phone-supplied key list to tmux tokens. Returns null if ANY
 * key is unknown — a partial injection (some keys land, one is dropped)
 * leaves the pane in a worse mid-state than none, so the whole batch is
 * rejected.
 */
export const resolveKeys = (keys: string[]): string[] | null => {
    const out: string[] = [];
    for (const k of keys) {
        const token = ALLOWED_KEYS.get(k.toLowerCase().trim());
        if (!token) return null;
        out.push(token);
    }
    return out.length ? out : null;
};

/**
 * Send named keys as keys (NOT `-l`), so tmux interprets Escape/Up/Enter as
 * key presses rather than literal text. One send-keys call carries the
 * whole sequence in order.
 */
const injectNamedKeys = (session: string, tokens: string[]): boolean => {
    const target = tmuxTargetFor(session);
    if (target === null) return false; // unresolvable subagent — never spawn
    const r = spawnSync('tmux', tmuxArgs(['send-keys', '-t', target, ...tokens]), { stdio: ['ignore', 'ignore', 'pipe'] });
    return r.status === 0;
};

export { invalidateTmuxSocketCache, silenceListenerLog, tmuxArgs };
export { liveSessionNames, sessionExists, sessionLiveness };
export { detectRemoteAgent, isSubagentSessionName, recordSubagentTranscripts, recordTargets, subagentTranscriptFor, tmuxTargetFor };

const runTmux = (args: string[]): { status: number | null; stdout: string } => {
    const r = spawnSync('tmux', tmuxArgs(args), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: r.status, stdout: r.stdout ?? '' };
};

/** Takes back the worktrees `--wt` made once their session is over (listener-worktree-cleanup.ts). */
const worktreeCleanup = createWorktreeCleanup({
    log,
    notify: notifyDesktop,
    tmux: (args, timeoutMs) => tmuxRun(tmuxArgs(args), timeoutMs),
});

/** Sizes a watched detached window to its viewer (pane-fit.ts). */
const paneFitter = createPaneFitter(runTmux);

// ─── Session inventory ──────────────────────────────────────────────

/**
 * Parse a `hwip-*` tmux session name into `{project, label}`. The wrapper
 * emits `hwip-<project>` and, with `--label <x>`, `hwip-<project>-<x>`; the
 * name alone cannot tell where the project ends, so the whole tail is the
 * project. A labelled or worktree session also carries the answer in session
 * options (`@hwip_project`, `@hwip_session_label` — wrapper
 * `sessionSidecarArgs`), which win: the phone groups cards by project, and
 * the tail would open a card per label and per worktree.
 */
export const parseSessionName = (
    name: string,
    sidecar: { project?: string; label?: string } = {},
): { project: string; label: string | null } | null => {
    if (!name.startsWith('hwip-')) return null;
    const rest = name.slice('hwip-'.length);
    if (!rest) return null;
    return { project: sidecar.project || rest, label: sidecar.label || null };
};

/**
 * `checkoutOf` per pane cwd, remembered for the life of the sweep worker —
 * a directory's repo does not change under a running session, and the sweep
 * sees the same few cwds every cycle. Outside-git answers are kept too, or
 * every non-repo session would cost a git spawn per sweep. Size = distinct
 * pane cwds ever seen, which tracks sessions started, not time.
 */
const checkoutCache = new Map<string, Checkout | null>();
const checkoutOfCached = (cwd: string): Checkout | null => {
    if (!checkoutCache.has(cwd)) checkoutCache.set(cwd, checkoutOf(cwd));
    return checkoutCache.get(cwd) ?? null;
};
/** Test seam: how many directories have been looked up. */
export const __checkoutCacheSize = (): number => checkoutCache.size;

const epochToIso = (epoch: string | undefined): string | undefined => {
    if (!epoch) return undefined;
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n * 1000).toISOString();
};

/**
 * A run's id from tmux's `session_created` (hwip docs/session-runs.md): the
 * whole epoch seconds as a decimal string. The server derives the same string
 * from `createdAt` for listeners that do not send one (`runIdOf`), so the two
 * must agree: `epochToIso` keeps whole seconds and this floors them.
 */
export const runIdOfEpoch = (epoch: string | undefined): string | undefined => {
    const iso = epochToIso(epoch);
    return iso ? String(Math.floor(Date.parse(iso) / 1000)) : undefined;
};

// ─── Agent state detection (SPEC-AGENT-AWARENESS §S1) ──────────────

// How many pane lines the state rules see. The live status area every
// agent renders sits in the last handful of lines; 40 leaves margin for
// tall dialogs without hauling whole scrollbacks through regex.
const STATE_CAPTURE_LINES = 40;

interface SessionStateEntry {
    tracker: StateTracker;
    /** Last raw evaluation — replayed on hash-equal cycles so a pending
     *  candidate still collects its second sighting on a static screen. */
    lastObserved: EvaluationResult;
    contentHash: string;
}

const sessionStates = new Map<string, SessionStateEntry>();

/** Test hook. */
export const resetSessionStates = (): void => {
    sessionStates.clear();
};

const capturePaneText = (session: string, target?: string, escapes = false): string | null => {
    // Explicit target for the sweep (subagent rows aren't in the recorded
    // target map yet); otherwise resolve through it.
    const resolved = target ?? tmuxTargetFor(session);
    if (resolved === null) return null; // unresolvable subagent — never spawn
    const r = spawnSync('tmux', tmuxArgs(['capture-pane', '-p', ...(escapes ? ['-e'] : []), '-t', resolved, '-S', `-${STATE_CAPTURE_LINES}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    return r.stdout ?? '';
};

/**
 * Fold one pane capture into the per-session state machine and return
 * the wire fields for this report cycle. Exported (with `paneText`
 * injected) so tests can drive it without tmux.
 *
 * Hash short-circuit: an unchanged screen skips rule evaluation but
 * still replays the previous observation through the debounce — cheap
 * cycles stay cheap without wedging candidate promotion.
 */
export const deriveSessionState = (
    name: string,
    agentKind: AgentKind,
    paneText: string | null,
    now: number = Date.now(),
): Pick<AgentSession, 'state' | 'stateChangedAt' | 'stateRuleId'> => {
    if (paneText === null) {
        // Pane unreadable this cycle (session racing shutdown, tmux
        // hiccup) — report nothing rather than a stale confident state.
        sessionStates.delete(name);
        return {};
    }
    const contentHash = createHash('sha1').update(paneText).digest('hex');
    const entry = sessionStates.get(name);
    const observed = entry && entry.contentHash === contentHash
        ? entry.lastObserved
        : evaluateState(paneText, agentKind, getActiveManifest(), entry?.tracker.confirmed ?? 'unknown');
    const tracker = advanceState(entry?.tracker, observed, now);
    sessionStates.set(name, { tracker, lastObserved: observed, contentHash });
    return {
        state: tracker.confirmed,
        stateChangedAt: new Date(tracker.confirmedAt).toISOString(),
        stateRuleId: tracker.ruleId,
    };
};

/** Set while turn history is on: the same trusted devices that may read a conversation may read a prompt. */
let promptSealer: PromptSealer | null = null;

/** Test hook. */
export const setPromptSealer = (sealer: PromptSealer | null): void => {
    promptSealer = sealer;
};

/**
 * The sealed prompt of each main session blocked in a dialog this listener can
 * read, added to a sweep's sessions before they are published. Here and not in
 * the sweep: the sweep runs on the inventory worker (inventory-offload.ts), a
 * module instance of its own where no sealer is ever set, so a prompt sealed
 * there would never be. A blocked session's pane is captured once more for it;
 * the others pass no pane, which forgets any prompt they showed. Subagent rows
 * and shells are left alone: nothing on the phone answers for them.
 */
export const withBlockedPrompts = ({ sessions, targets }: Pick<CollectResult, 'sessions' | 'targets'>): AgentSession[] => {
    const sealer = promptSealer;
    if (!sealer) return sessions;
    const shown = sessions.map((session) => {
        const target = targets[session.name];
        if (session.parentName !== undefined || session.agentKind === 'shell' || target === undefined) return session;
        // With escapes: OpenCode draws its chosen button as a background colour only. `deliverInput` captures the same way.
        const pane = session.state === 'blocked' ? capturePaneText(session.name, target, true) : null;
        const blockedPrompt = sealer.observe(session.name, session.agentKind, session.state, pane);
        return blockedPrompt ? { ...session, blockedPrompt } : session;
    });
    sealer.prune(new Set(sessions.map((s) => s.name)));
    return shown;
};

/** How long a report waits for a prompt seal that started on it. Seals take milliseconds; this bounds a stuck key lookup. */
export const PROMPT_SEAL_WAIT_MS = 3_000;

/**
 * `withBlockedPrompts`, held until the seals it started are done (at most `PROMPT_SEAL_WAIT_MS`), then read again. The
 * server pushes on the first report that says blocked and the phone fetches the prompt for the push's buttons right
 * then: a prompt that rides only the next report, five seconds on, comes after the notification was drawn without them.
 */
export const withSettledPrompts = async (inventory: Pick<CollectResult, 'sessions' | 'targets'>): Promise<AgentSession[]> => {
    const first = withBlockedPrompts(inventory);
    const sealing = promptSealer?.sealing();
    if (!sealing) return first;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([sealing, new Promise<void>((resolve) => { timer = setTimeout(resolve, PROMPT_SEAL_WAIT_MS); })]);
    clearTimeout(timer);
    return withBlockedPrompts(inventory);
};

/** Drop per-session entries for sessions gone from the inventory. */
const pruneToLive = (bySession: Map<string, unknown>, liveNames: Set<string>): void => {
    for (const name of bySession.keys()) {
        if (!liveNames.has(name)) bySession.delete(name);
    }
};

// ─── Pattern watches (SPEC-AGENT-AWARENESS §S5 v2) ─────────────────

export interface PatternWatch {
    sessionName: string;
    pattern: string;
}

let patternWatches: PatternWatch[] = [];
// One-shot: after a hit we stop re-evaluating that watch locally. The
// server deletes the record on hit, and the next ack prunes it here —
// the fired-set only bridges the gap between hit and ack.
const firedWatchKeys = new Set<string>();
const refusedWatchKeys = new Set<string>();
const patternWatchKey = (w: PatternWatch): string => `${w.sessionName}${w.pattern}`;

/** Ack payload → active watch list. Prunes fired-markers for dead watches. */
export const setPatternWatches = (raw: unknown): void => {
    patternWatches = Array.isArray(raw)
        ? raw.filter((w): w is PatternWatch =>
            typeof w === 'object' && w !== null
            && typeof (w as PatternWatch).sessionName === 'string'
            && typeof (w as PatternWatch).pattern === 'string')
        : [];
    const live = new Set(patternWatches.map(patternWatchKey));
    for (const key of firedWatchKeys) {
        if (!live.has(key)) firedWatchKeys.delete(key);
    }
    for (const key of refusedWatchKeys) {
        if (!live.has(key)) refusedWatchKeys.delete(key);
    }
    // A pattern that does not compile never fires; say so once per watch
    // rather than leave the phone waiting on a watch that is inert.
    for (const w of patternWatches) {
        const key = patternWatchKey(w);
        const why = patternError(w.pattern);
        if (why === null || refusedWatchKeys.has(key)) continue;
        refusedWatchKeys.add(key);
        log(`! watch on ${w.sessionName} will never fire: its pattern does not compile (${why})`);
    }
};

/** Test hook. */
export const resetPatternWatches = (): void => {
    patternWatches = [];
    firedWatchKeys.clear();
    refusedWatchKeys.clear();
};

export interface WatchHit {
    sessionName: string;
    pattern: string;
    matchedLine: string;
}

/**
 * Probe every un-fired watch whose session is live. `capture` is
 * injectable for tests; production passes capturePaneText.
 */
export const collectWatchHits = (
    liveNames: ReadonlySet<string>,
    capture: (session: string) => string | null = capturePaneText,
): WatchHit[] => {
    const hits: WatchHit[] = [];
    const textCache = new Map<string, string | null>();
    for (const w of patternWatches) {
        if (!liveNames.has(w.sessionName)) continue;
        const key = patternWatchKey(w);
        if (firedWatchKeys.has(key)) continue;
        if (!textCache.has(w.sessionName)) textCache.set(w.sessionName, capture(w.sessionName));
        const text = textCache.get(w.sessionName);
        if (text === null || text === undefined) continue;
        const match = findPatternMatch(w.pattern, text);
        if (!match) continue;
        firedWatchKeys.add(key);
        hits.push({ sessionName: w.sessionName, pattern: w.pattern, matchedLine: match.line });
    }
    return hits;
};

// ─── Screen peek (SPEC-AGENT-AWARENESS §S4) ────────────────────────

// Pane lines returned to the phone. Taller than the state-detection
// capture — the user wants to READ this, not regex it.
const SCREEN_PEEK_LINES = 60;
// Ephemeral frames ride API Gateway WS (32KB frame limit); stay well
// under it after JSON envelope overhead.
const SCREEN_PEEK_MAX_BYTES = 24 * 1024;

export interface ScreenRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
    /** The requesting device, stamped by the relay from the sending connection
     *  (server ws.ts, `ephemeral.send`) — which device's registered key
     *  `subscriberPublicKey` has to be. Relay JSON like the rest. */
    deviceId?: string;
    /** Asks for a sealed snapshot: the requester's device public key. */
    subscriberPublicKey?: string;
    /** The requester's nonce for this request, sealed with the pane. */
    subscriberNonce?: string;
}

type ScreenSnapshotHead = {
    subtype: 'agent.screen.snapshot';
    requestId: string;
    sessionName: string;
    capturedAt: string;
};

/**
 * One answer to a screen request: the pane in the clear, the pane sealed, or
 * why there is none. Each arm rules the other arms' fields out (`?: never`),
 * so a reply carrying both a sealed pane and a plaintext one does not
 * type-check — `ScreenSnapshotIsOneWay` below is that claim, compiled.
 */
export type ScreenSnapshot = ScreenSnapshotHead & (
    | { content: string; truncated: boolean; encrypted?: never; error?: never }
    /** Envelope of a SealedScreenSnapshot. */
    | { encrypted: SealedV2; truncated: boolean; content?: never; error?: never }
    | { error: string; content?: never; truncated?: never; encrypted?: never }
);

type MustBeTrue<T extends true> = T;
/** Fails to compile the day a snapshot may carry the pane both ways, or beside an error. */
export type ScreenSnapshotIsOneWay = MustBeTrue<
    | (ScreenSnapshotHead & { content: string; truncated: boolean; encrypted: SealedV2 } extends ScreenSnapshot ? false : true)
    | (ScreenSnapshotHead & { error: string; content: string; truncated: boolean } extends ScreenSnapshot ? false : true)
    | (ScreenSnapshotHead & { error: string; encrypted: SealedV2; truncated: boolean } extends ScreenSnapshot ? false : true)
>;

/** What a sealed snapshot's envelope holds (JSON): the pane, the request it
 *  answers and when it was read — so a snapshot moved onto another request,
 *  or another session's, or held back and delivered late, is not taken for
 *  this one. */
export type SealedScreenSnapshot = {
    requestId: string;
    sessionName: string;
    nonce?: string;
    capturedAt: string;
    content: string;
    truncated: boolean;
};

/** Longest request id answered. A viewer's is a UUID; the bound keeps a
 *  relay-sized one out of the reply and out of the sealed frame's size budget. */
const MAX_REQUEST_ID_LENGTH = 128;

// Who gets pane content, and how (subscriber-trust.ts). Set by handleListener.
// null in a process that never started the daemon — a test, mostly — where
// there is no device list to check a key against: nothing is sealed there, and
// plaintext stays as it was.
let subscriberTrust: SubscriberTrust | null = null;

export const setSubscriberTrust = (trust: SubscriberTrust | null): void => {
    subscriberTrust = trust;
};

/** How a request for pane content is answered. The fields are relay JSON: an
 *  empty or ill-typed key is no key, which is what a relay stripping one sends. */
const admitRequester = (req: Pick<ScreenRequest, 'deviceId' | 'subscriberPublicKey'>): Promise<Admission> => {
    const publicKey = typeof req.subscriberPublicKey === 'string' && req.subscriberPublicKey ? req.subscriberPublicKey : undefined;
    const deviceId = typeof req.deviceId === 'string' && req.deviceId ? req.deviceId : undefined;
    if (subscriberTrust) return subscriberTrust.admit({ deviceId, publicKey });
    return Promise.resolve(publicKey ? { kind: 'refuse', reason: 'subscriber_unverified' } : { kind: 'plain' });
};

/**
 * Whether a request asked for sealed content: its key field holds something.
 * Anything, not only a string — a relay can send an array or an object there,
 * and code further down that only asks "is there a key" would then seal for
 * whatever Base64 decoding makes of it. Such a request asked for a seal and
 * gets a refusal; only an absent or empty key is a plaintext request.
 */
const asksForSeal = (req: { subscriberPublicKey?: unknown }): boolean => Boolean(req.subscriberPublicKey);

/** Why a request that asked for plaintext gets none, or null when it may have it. */
const plainRefusal = (): RefusalCode | null => (subscriberTrust?.sealedOnly() ? 'e2ee_required' : null);

/**
 * Run `sealed` with the key of a request that asked for a seal once that key
 * checked out, or `refused` with the reason it did not. A request that asked
 * for a seal is never answered in the clear, and a throw on either path is a
 * refusal too: nothing here may reject into the daemon's message handler.
 */
const whenSealAdmitted = (
    req: Pick<ScreenRequest, 'deviceId' | 'subscriberPublicKey'>,
    sealed: (publicKey: string) => void,
    refused: (reason: RefusalCode) => void,
): void => {
    admitRequester(req)
        .then((admission) => {
            if (admission.kind === 'seal') return sealed(admission.publicKey);
            return refused(admission.kind === 'refuse' ? admission.reason : 'subscriber_unverified');
        })
        .catch((err) => {
            log(`! trust: admission failed (${err instanceof Error ? err.message : err})`);
            try {
                refused('subscriber_unverified');
            } catch (again) {
                log(`! trust: the refusal could not be sent (${again instanceof Error ? again.message : again})`);
            }
        });
};

/**
 * Answer a phone's screen-peek request for one of OUR sessions.
 * Returns null when the message isn't addressed to this machine (other
 * ephemeral traffic — clipboard, mirrors — flows through constantly).
 *
 * Security posture: only sessions the inventory already exposes are
 * readable — the phone can see exactly the panes it can already send
 * commands into, nothing else. Rate-limited with the same per-session
 * token bucket as command injection.
 *
 * A request carrying a key gets the pane sealed for that key, and only when
 * the key checks out (subscriber-trust.ts); a request without one gets it in
 * the clear only while this listener has never sealed. Either refusal answers
 * with an error and no pane, decided before the pane is read.
 */
export const handleScreenRequest = async (req: ScreenRequest): Promise<ScreenSnapshot | null> => {
    if (req.subtype !== 'agent.screen.request') return null;
    const { requestId, sessionName } = req;
    if (typeof requestId !== 'string' || !requestId || requestId.length > MAX_REQUEST_ID_LENGTH) return null;
    if (typeof sessionName !== 'string' || !sessionName) return null;
    if (req.targetDeviceId !== computeListenerDeviceId()) return null;

    const capturedAt = new Date().toISOString();
    const base = { subtype: 'agent.screen.snapshot' as const, requestId, sessionName, capturedAt };

    if (!checkRateLimit(`screen:${sessionName}`)) {
        return { ...base, error: 'rate_limited' };
    }
    if (!isInventoried(sessionName)) {
        return { ...base, error: 'unknown_session' };
    }
    const admission = await admitRequester(req);
    if (admission.kind === 'refuse') {
        return { ...base, error: admission.reason };
    }
    // A key field that held no usable key asked for a seal all the same.
    if (admission.kind === 'plain' && asksForSeal(req)) {
        return { ...base, error: 'subscriber_unverified' };
    }
    const captured = capturePane(sessionName);
    if (!captured) {
        return { ...base, error: 'capture_failed' };
    }
    if (admission.kind === 'plain') {
        return { ...base, ...captured };
    }
    // Sized as a stream frame is: the same pane text under the same transport limit.
    const nonce = subscriptionNonce(req.subscriberNonce);
    const pane = fitSealedFrame({ sessionName, ...(nonce ? { nonce } : {}), ...captured });
    const sealed: SealedScreenSnapshot = { requestId, capturedAt, ...pane };
    try {
        await initDeviceCrypto();
        const encrypted = await sealV2('screen.snapshot', JSON.stringify(sealed), admission.publicKey, sessionName);
        return { ...base, truncated: sealed.truncated, encrypted };
    } catch (err) {
        log(`⧉ screen ${sessionName}: seal failed (${err instanceof Error ? err.message : err}) — snapshot dropped`);
        return { ...base, error: 'encrypt_failed' };
    }
};

// ─── Diff: reading a session's changes from the phone ──────────────
//
// The loop the phone could not close: it can drive an agent but not look at
// what the agent did. This reads the working tree of the repository the session
// runs in — read-only, fixed commands, no revision and no repository path from
// the wire.
//
// Why nothing caller-supplied reaches argv: `git diff <ref>` parses a ref
// beginning with `-` as a flag, so a "validate the string" defence has to be
// perfect to work at all. Instead the commands are constant, the repo comes
// from the registry this machine wrote itself, and the one caller-supplied
// value — a file path — is resolved against the repo root, checked through
// symlinks, and passed after `--` where git can only read it as a path.

/** What a diff request carries in the clear: the routing fields a relay needs,
 *  and the key the answer is sealed for. What it ASKS — which base, which file,
 *  which page — is inside `encrypted`, so the relay sees none of it. */
export interface DiffRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
    /** The phone's device public key: the answer is sealed for it once it checked out. */
    subscriberPublicKey?: string;
    /** The asking device, stamped by the relay: whose registered key the one above has to be. */
    deviceId?: string;
    /** The request, sealed by the phone for this listener (purpose `session.diff`). */
    encrypted?: unknown;
}

/**
 * A repo-relative path resolved to somewhere genuinely inside the repo, or null.
 *
 * Checks the real path, not the lexical one: `resolve()` alone accepts a
 * symlink whose string stays inside the repo and whose target does not, which
 * is the whole trick. An unresolvable path (the file was deleted) falls back to
 * the lexical check — a deleted file still has a diff worth reading.
 */
const resolveInRepo = (root: string, rel: string): string | null => {
    if (isAbsolute(rel)) return null;
    const lexical = resolve(root, rel);
    const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
    if (!inside(lexical)) return null;
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(lexical);
        return real === realRoot || real.startsWith(realRoot + sep) ? lexical : null;
    } catch {
        return lexical;
    }
};

/** Session name → the repository it works in, with every refusal named. */
const repoForSession = (sessionName: string): { root: string } | { error: string } => {
    const known = recallSession(sessionName);
    if (!known) return { error: 'unknown_session' };
    if (!sessionDirectoryExists(known)) return { error: 'missing_directory' };
    const root = repoRootOf(known.cwd);
    if (!root) return { error: 'not_a_repo' };
    return { root };
};

/** Most bytes of plaintext one sealed diff answer carries — a frame budget the
 *  relay accepts with room left for the envelope. */
const DIFF_SEALED_MAX_BYTES = 24 * 1024;
/** Below this a page cannot shrink further, so the answer is "too large". */
const DIFF_PAGE_MIN_BYTES = 64;

type DiffKind = 'files' | 'file' | 'tree' | 'blob';

/** The request as the phone sealed it. Every field is untrusted until checked. */
interface OpenedDiffRequest {
    v?: unknown;
    kind?: unknown;
    requestId?: unknown;
    base?: unknown;
    path?: unknown;
    offset?: unknown;
    cursor?: unknown;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf-8');

/** The sealed answer to a file-list request: what changed, cut to fit the frame. */
const filesAnswer = (root: string, requestId: string, base: DiffBase): { sealed: object } | { error: string } => {
    const collected = collectDiffFiles(root, base);
    if (!collected.ok) return { error: collected.error };
    let { files, truncated } = collected;
    const answer = () => ({
        v: 1, kind: 'files.result', requestId, base,
        ...(collected.baseName ? { baseName: collected.baseName } : {}),
        ...(collected.branch ? { branch: collected.branch } : {}),
        files, truncated,
    });
    while (files.length > 0 && jsonBytes(answer()) > DIFF_SEALED_MAX_BYTES) {
        files = files.slice(0, Math.floor(files.length / 2));
        truncated = true;
    }
    return { sealed: answer() };
};

/** The sealed answer to a file request: one page of the masked patch, bound to the request. */
const fileAnswer = (
    root: string,
    requestId: string,
    base: DiffBase,
    path: string,
    offset: number,
): { sealed: object } | { error: string } => {
    if (!resolveInRepo(root, path)) {
        log(`✗ diff: ${JSON.stringify(path.slice(0, 200))} is outside ${root}`);
        return { error: 'path_outside_repo' };
    }
    const patch = collectFilePatch(root, base, path);
    if (!patch.ok) return { error: patch.error };
    // Escaping can make the JSON several times the page; halve the page until it fits.
    for (let max = DIFF_PAGE_MAX_BYTES; ; max = Math.floor(max / 2)) {
        const page = pagePatch(patch.text, offset, max);
        if (!page.ok) return { error: page.error };
        const answer = { v: 1, kind: 'file.result', requestId, base, path, masked: patch.masked, ...page };
        if (jsonBytes(answer) <= DIFF_SEALED_MAX_BYTES) return { sealed: answer };
        if (max <= DIFF_PAGE_MIN_BYTES) return { error: 'too_large' };
    }
};

/**
 * The sealed answer to a directory request: one page of entries, cut to fit the frame. The
 * `cursor` it carries is the next page's start and only when the page is cut — never the one
 * the request carried (D-L1), so the request is bound by its id and path alone.
 */
const treeAnswer = (root: string, requestId: string, path: string, cursor: string | undefined, audit: FileViewAudit): { sealed: object } | { error: string } => {
    const listed = listTree(root, path, cursor);
    if (!listed.ok) return { error: listed.error };
    // Outside the visible set, ignored and gone look the same (V6). `entries` stays so a reader of the
    // listing shape sees an empty directory; `body` is the design's word for "not there".
    if (listed.body === 'absent') {
        audit.nothing = 'absent';
        return { sealed: { v: 1, kind: 'tree.result', requestId, path, entries: [], body: 'absent' } };
    }
    let { entries, truncated } = listed;
    const answer = () => ({
        v: 1, kind: 'tree.result', requestId, path, entries,
        ...(truncated ? { truncated, cursor: entries[entries.length - 1].name } : {}),
    });
    // 500 long names outgrow a frame: halve the page; the cursor then follows the last entry kept.
    while (entries.length > 1 && jsonBytes(answer()) > DIFF_SEALED_MAX_BYTES) {
        entries = entries.slice(0, Math.floor(entries.length / 2));
        truncated = true;
    }
    if (jsonBytes(answer()) > DIFF_SEALED_MAX_BYTES) return { error: 'too_large' };
    return { sealed: answer() };
};

/** The sealed answer to a file request: one page of the masked text, or what the file is instead, bound to the request. */
const blobAnswer = (root: string, requestId: string, path: string, offset: number, audit: FileViewAudit): { sealed: object } | { error: string } => {
    const read = readBlob(root, path);
    if (!read.ok) return { error: read.error };
    const { ok: _ok, ...found } = read;
    const bound = { v: 1, kind: 'blob.result', requestId, path, offset };
    if (found.body !== 'text') {
        // A symlink target is as long as the file system allows, so this answer can outgrow a frame too.
        const answer = { ...bound, ...found };
        if (jsonBytes(answer) > DIFF_SEALED_MAX_BYTES) return { error: 'too_large' };
        if (found.body === 'absent' || found.body === 'filtered') audit.nothing = found.body;
        return { sealed: answer };
    }
    // Masking was done on the whole text; only now is it cut. Escaping can make the JSON several
    // times the page, so halve the page until it fits.
    for (let max = DIFF_PAGE_MAX_BYTES; ; max = Math.floor(max / 2)) {
        const page = pagePatch(found.text, offset, max);
        if (!page.ok) return { error: page.error };
        const { ok: _pageOk, ...chunk } = page;
        const answer = { ...bound, body: 'text', ...chunk, masked: found.masked };
        if (jsonBytes(answer) <= DIFF_SEALED_MAX_BYTES) {
            audit.bytes = page.length;
            audit.masked = found.masked;
            return { sealed: answer };
        }
        if (max <= DIFF_PAGE_MIN_BYTES) return { error: 'too_large' };
    }
};

/** D6: how much file content each session has read in the current window (blob text pages only). */
export const fileViewBytes = createByteBudget(FILE_VIEW_WINDOW_BYTES, FILE_VIEW_WINDOW_MS);

/** What V12 writes down about one file-view request. Filled in as the request is checked and read; the log line is cut from it when it is answered. */
interface FileViewAudit {
    op: 'tree' | 'blob';
    deviceId: string;
    session: string;
    path: string;
    /** Bytes of text the answer carried (a blob page). */
    bytes: number;
    /** Secrets masked in the file the page came from. */
    masked: number;
    /** What a request that read nothing was told: a sealed "nothing for you" is not an error code but is what a reader of the log looks for. */
    nothing?: 'absent' | 'filtered';
    /** The request opened under a key this listener admitted: only such a request is written down. */
    opened: boolean;
}

/** Longest stretch of a name written to the log: the log is for a person reading it, and a request can name anything. */
const FILE_VIEW_LOG_NAME_CHARS = 200;

/**
 * V12: one line per request in the listener's log — when, which device, which session, what was asked, how much
 * was read, how much was masked, how it ended. Names are written as JSON strings, with what JSON leaves alone
 * escaped too, so a control character in a path (or a made-up session or device) cannot start a second line or
 * redraw this one. Never the content.
 */
const logFileView = (audit: FileViewAudit, outcome: string): void => {
    const name = (value: string): string => escapeLogUnsafe(JSON.stringify(value.slice(0, FILE_VIEW_LOG_NAME_CHARS)));
    const result = outcome === 'ok' && audit.nothing ? audit.nothing : outcome;
    log(`file-view: at=${new Date().toISOString()} device=${name(audit.deviceId)} session=${name(audit.session)} op=${audit.op} path=${name(audit.path)} bytes=${audit.bytes} masked=${audit.masked} result=${result}`);
};

/**
 * What a file-view request (`tree` or `blob`) asks, checked and answered. It has no `base`: the
 * content is the working tree. A path that merely breaks the string rules is `bad_path` here or
 * in `listTree`/`readBlob`; one outside the visible set is a sealed `absent`, never an error.
 */
const fileViewAnswer = (
    kind: 'tree' | 'blob',
    asked: OpenedDiffRequest,
    requestId: string,
    sessionName: string,
    audit: FileViewAudit,
): { sealed: object } | { error: string } => {
    if (asked.base !== undefined) return { error: 'bad_request' };
    if (typeof asked.path !== 'string') return { error: 'bad_path' };
    const path = asked.path;
    audit.path = path;
    let cursor: string | undefined;
    let offset = 0;
    if (kind === 'tree') {
        if (asked.cursor !== undefined && typeof asked.cursor !== 'string') return { error: 'bad_request' };
        cursor = asked.cursor;
    } else {
        if (!path) return { error: 'bad_path' };
        const wanted = asked.offset === undefined ? 0 : asked.offset;
        if (!isPageOffset(wanted)) return { error: 'bad_range' };
        offset = wanted;
    }

    const repo = repoForSession(sessionName);
    if ('error' in repo) return repo;
    // V13, right after the session's repository is known and before the path is judged or anything is read from the working tree.
    if (fileViewOffBy(repo.root, process.env)) return { error: 'file_view_off' };
    if (kind === 'tree') return treeAnswer(repo.root, requestId, path, cursor, audit);
    // D6: a session that has read its share for this window waits it out; a page already begun is not cut short.
    if (fileViewBytes.spent(sessionName)) return { error: 'rate_limited' };
    const answer = blobAnswer(repo.root, requestId, path, offset, audit);
    if ('sealed' in answer) fileViewBytes.charge(sessionName, audit.bytes);
    return answer;
};

/**
 * Answer "what changed in this session's repo", sealed both ways.
 *
 * The check order is part of the contract, and git runs only after all of it:
 * the frame's shape, the rate limit, a key at all (a request without one is
 * refused, sealed-only or not), a sealed request, the key
 * checking out, the request opening under that key and agreeing with its frame.
 * Then the only things that reach git are the session name's directory, one of
 * two enumerated bases, and a path resolved inside the repo. The file view (`tree`,
 * `blob`) has no base: it reads the working tree, and `file-view.ts` decides what of
 * it may be opened.
 */
const serveDiff = (req: DiffRequest, send: (data: Record<string, unknown>) => void, kind: DiffKind): boolean => {
    if (req.subtype !== `agent.diff.${kind}.request`) return false;
    if (typeof req.requestId !== 'string' || !req.requestId || req.requestId.length > MAX_REQUEST_ID_LENGTH) return false;
    if (typeof req.sessionName !== 'string' || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;
    const { requestId, sessionName } = req;

    // The question and its answer are sealed; in the clear go only routing fields and, when
    // a request fails, its error code (never the path, base, file list or patch).
    const frame = {
        subtype: `agent.diff.${kind}.result`,
        requestId,
        sessionName,
        // The relay stamped the asking device; saying so lets a relay that wants to route the answer there do so.
        ...(typeof req.deviceId === 'string' && req.deviceId ? { targetDeviceId: req.deviceId } : {}),
        at: new Date().toISOString(),
    };
    // V12: a file-view request is written down however it ends, once it has opened under an admitted key. What
    // comes before that — no key, an unadmitted one, the rate limit — read nothing, and a relay can repeat it
    // under made-up session names for free, which would write the log as fast as it came.
    const audit: FileViewAudit = { op: kind === 'tree' ? 'tree' : 'blob', deviceId: typeof req.deviceId === 'string' ? req.deviceId : '', session: sessionName, path: '', bytes: 0, masked: 0, opened: false };
    const audited = kind === 'tree' || kind === 'blob';
    const reply = (fields: { error: string } | { encrypted: SealedV2 }, written = audited): true => {
        if (written && audit.opened) logFileView(audit, 'error' in fields ? fields.error : 'ok');
        send({ ...frame, ...fields });
        return true;
    };

    if (!checkRateLimit(`diff:${sessionName}`)) return reply({ error: 'rate_limited' }, false);
    if (!asksForSeal(req)) return reply({ error: 'e2ee_required' });
    const sealedRequest = req.encrypted;
    if (!isSealedV2(sealedRequest)) return reply({ error: 'bad_request' });

    const answer = async (phoneKey: string): Promise<{ sealed: object } | { error: string }> => {
        let asked: OpenedDiffRequest | null;
        try {
            // Untrusted until the checks below: every field is `unknown`.
            asked = JSON.parse(await openV2('session.diff', sealedRequest, phoneKey, sessionName)) as OpenedDiffRequest | null;
        } catch {
            return { error: 'bad_request' };
        }
        audit.opened = true;
        // The seal binds the session, not this request: the request inside must be the one the frame names.
        if (typeof asked !== 'object' || asked === null) return { error: 'bad_request' };
        if (asked.v !== 1 || asked.kind !== `${kind}.request` || asked.requestId !== requestId) return { error: 'bad_request' };
        if (kind === 'tree' || kind === 'blob') return fileViewAnswer(kind, asked, requestId, sessionName, audit);
        if (asked.base !== 'head' && asked.base !== 'default') return { error: 'bad_request' };
        const base: DiffBase = asked.base;

        let path = '';
        let offset = 0;
        if (kind === 'file') {
            if (typeof asked.path !== 'string' || !asked.path) return { error: 'bad_path' };
            path = asked.path;
            const wanted = asked.offset === undefined ? 0 : asked.offset;
            if (!isPageOffset(wanted)) return { error: 'bad_range' };
            offset = wanted;
        }

        const repo = repoForSession(sessionName);
        if ('error' in repo) return repo;
        return kind === 'files' ? filesAnswer(repo.root, requestId, base) : fileAnswer(repo.root, requestId, base, path, offset);
    };

    whenSealAdmitted(
        req,
        (phoneKey) => {
            answer(phoneKey)
                .then(async (result) => {
                    if ('error' in result) return reply({ error: result.error });
                    // A seal that fails is an error, never a plaintext answer.
                    try {
                        return reply({ encrypted: await sealV2('session.diff', JSON.stringify(result.sealed), phoneKey, sessionName) });
                    } catch (err) {
                        log(`⧉ diff: seal failed (${err instanceof Error ? err.message : err})`);
                        return reply({ error: 'encrypt_failed' });
                    }
                })
                .catch((err) => {
                    log(`⧉ diff ${sessionName}: ${err instanceof Error ? err.message : err}`);
                    reply({ error: 'git_failed' });
                });
        },
        (reason) => { reply({ error: reason }); },
    );
    return true;
};

export const handleDiffFilesRequest = (req: DiffRequest, send: (data: Record<string, unknown>) => void): boolean =>
    serveDiff(req, send, 'files');

export const handleDiffFileRequest = (req: DiffRequest, send: (data: Record<string, unknown>) => void): boolean =>
    serveDiff(req, send, 'file');

export const handleFileTreeRequest = (req: DiffRequest, send: (data: Record<string, unknown>) => void): boolean =>
    serveDiff(req, send, 'tree');

export const handleFileBlobRequest = (req: DiffRequest, send: (data: Record<string, unknown>) => void): boolean =>
    serveDiff(req, send, 'blob');

// ─── Schedules: the phone reads the list ───────────────────────────

/** What a list request carries: routing and the key the answer is sealed for. It asks for nothing else, so there is nothing to seal. */
export interface ScheduleListRequest {
    subtype?: string;
    targetDeviceId?: string;
    requestId?: string;
    subscriberPublicKey?: string;
    /** The asking device, stamped by the relay: whose registered key the one above has to be. */
    deviceId?: string;
}

/** Why a list request got no list: a refusal of the requester (`RefusalCode`), or one of these. */
type ScheduleListError = RefusalCode | 'rate_limited' | 'encrypt_failed' | 'read_failed' | 'too_large';

/**
 * Answer a phone's request for the schedules on this machine (F8). The list holds prompts, so it
 * follows the screen's rule: a request with a key gets it sealed once the key checks out (the seal
 * is bound to this machine's device id), one without gets it in the clear only while this listener
 * has never sealed, and any other outcome is an error and no schedule. A request that asked for a
 * seal is never answered in the clear. Directories and agent arguments are not in the list at all.
 */
export const handleScheduleListRequest = (req: ScheduleListRequest, send: (data: Record<string, unknown>) => void): boolean => {
    if (req.subtype !== 'agent.schedule.list.request') return false;
    if (typeof req.requestId !== 'string' || !req.requestId || req.requestId.length > MAX_REQUEST_ID_LENGTH) return false;
    const me = computeListenerDeviceId();
    if (req.targetDeviceId !== me) return false;
    const { requestId } = req;

    const frame = {
        subtype: 'agent.schedule.list.result',
        requestId,
        ...(typeof req.deviceId === 'string' && req.deviceId ? { targetDeviceId: req.deviceId } : {}),
        at: new Date().toISOString(),
    };
    const reply = (fields: { error: ScheduleListError } | { schedules: string; unreadable?: number } | { encrypted: SealedV2 }): true => {
        send({ ...frame, ...fields });
        return true;
    };

    // One budget per asking device, so a relay forging requests cannot use up the real phone's. An id that is not shaped like one shares a budget.
    const asker = typeof req.deviceId === 'string' && /^[\w-]{1,64}$/.test(req.deviceId) ? req.deviceId : '';
    if (!checkRateLimit(`schedule:list:${asker}`)) return reply({ error: 'rate_limited' });

    const answer = async (admission: Admission): Promise<true> => {
        if (admission.kind === 'refuse') return reply({ error: admission.reason });
        // A key field that held no usable key asked for a seal all the same.
        if (admission.kind === 'plain' && asksForSeal(req)) return reply({ error: 'subscriber_unverified' });
        const refused = admission.kind === 'plain' ? plainRefusal() : null;
        if (refused) return reply({ error: refused });
        const found = scheduleAnswer(Date.now(), requestId, frame.at);
        if (!found.ok) {
            log(`! schedule list: no list to send (${found.error})`);
            return reply({ error: found.error });
        }
        if (admission.kind === 'plain') {
            const { schedules, unreadable } = found.listing;
            return reply({ schedules: JSON.stringify(schedules), ...(unreadable > 0 ? { unreadable } : {}) });
        }
        let encrypted: SealedV2;
        try {
            await initDeviceCrypto();
            encrypted = await sealV2('schedule.list', found.sealed, admission.publicKey, me);
        } catch (err) {
            // A seal that fails is an error, never a plaintext list.
            log(`⧉ schedule list: seal failed (${err instanceof Error ? err.message : err})`);
            return reply({ error: 'encrypt_failed' });
        }
        return reply({ encrypted });
    };

    admitRequester(req).then(
        (admission) => answer(admission).catch((err) => {
            log(`! schedule list: ${err instanceof Error ? err.message : err}`);
            return reply({ error: 'read_failed' });
        }),
        (err) => {
            log(`! trust: admission failed (${err instanceof Error ? err.message : err})`);
            return reply({ error: 'subscriber_unverified' });
        },
    ).catch((err) => log(`! schedule list: the answer could not be sent (${err instanceof Error ? err.message : err})`));
    return true;
};

// ─── Resume: starting a session that has ended ─────────────────────
//
// Every other remote path types into a process that already exists. This one
// creates one, which is a different kind of authority, so the request is built
// to carry as little of it as possible: a session NAME and nothing else.
// Where to start and what to start are read back from the registry this machine
// wrote while the session was alive (session-registry.ts) — a phone, or a relay
// posing as one, cannot name a directory, a binary, or an argument.

export interface SessionResumeRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /**
     * Which run of that name to start, when the slot has held more than one
     * agent. Not authority the phone gains: it selects among runs THIS machine
     * recorded, and a kind that matches nothing falls back to the newest run —
     * the same answer a phone too old to send it gets.
     */
    agentKind?: string;
    requestId?: string;
}

export interface SessionResumeResult {
    subtype: 'agent.session.resume.result';
    requestId: string;
    sessionName: string;
    resumed?: true;
    error?: string;
    at: string;
}

/**
 * Start a remembered session again, detached, and tell the phone what happened.
 * Returns true when the message was ours to answer.
 *
 * The refusals are the design. Unknown name: not in the registry, so there is
 * nothing to start and nothing to guess from. Missing directory: the project
 * moved or was deleted, and starting an agent in the wrong place is worse than
 * not starting one. Unknown agent kind: the record names an agent this build
 * has no binary for — a wire enum outlives installs, and a guess here would be
 * a command nobody chose. Already running: the session is live and the phone
 * should be watching it, not replacing it.
 */
export const handleSessionResumeRequest = (
    req: SessionResumeRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.resume.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const base = {
        subtype: 'agent.session.resume.result' as const,
        requestId: req.requestId,
        sessionName,
        at: new Date().toISOString(),
    };
    const reply = (fields: Partial<SessionResumeResult>): true => {
        send({ ...base, ...fields });
        return true;
    };

    // A subagent is a pane OF a live session, not a session to start — and
    // before the rate bucket, so refused subagent traffic costs nothing.
    if (isSubagentSessionName(sessionName)) return reply({ error: 'subagent_view_only' });

    // Charged like a submitted command, not like a keystroke: this starts a
    // process, and the two share one budget so a flood cannot be laundered
    // through whichever path is cheaper.
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return reply({ error: 'rate_limited' });

    // A named agent is answered with that run or not at all. Falling back to the
    // newest run would start claude for a phone that asked for pi — silently,
    // which is the exact failure this path exists to remove. A phone that names
    // nothing still means the newest run.
    const known =
        typeof req.agentKind === 'string'
            ? recallRun(sessionName, req.agentKind)
            : recallSession(sessionName);
    if (!known) {
        log(`✗ resume ${sessionName}: never seen on this machine`);
        return reply({ error: 'unknown_session' });
    }
    if (sessionExists(sessionName)) return reply({ error: 'already_running' });
    if (!sessionDirectoryExists(known)) {
        log(`✗ resume ${sessionName}: ${known.cwd} is gone`);
        return reply({ error: 'missing_directory' });
    }
    const agent = REMOTE_AGENTS.find((a) => a.kind === known.agentKind);
    if (!agent) {
        log(`✗ resume ${sessionName}: no binary for agent kind ${known.agentKind}`);
        return reply({ error: 'unknown_agent' });
    }

    // argv, never a shell string: the binary comes from the agent table and the
    // directory from our own record, and neither is concatenated into anything
    // a shell would re-parse. A recorded label means the session carried
    // sidecar options (wrapper `sessionSidecarArgs`) or the sweep inferred them
    // from its checkout (config `groupOf`); a new tmux session starts without
    // them, so they go on or it returns in a card of its own.
    const sidecar = known.label && known.project
        ? [';', 'set-option', SESSION_PROJECT_OPTION, known.project, ';', 'set-option', SESSION_LABEL_OPTION, known.label]
        : [];
    const started = spawnSync(
        'tmux',
        tmuxArgs(['new-session', '-d', '-s', sessionName, '-c', known.cwd, agent.binary, ...sidecar]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (started.status !== 0) {
        log(`✗ resume ${sessionName}: tmux refused (${(started.stderr ?? '').trim() || 'no detail'})`);
        return reply({ error: 'start_failed' });
    }
    log(`⟲ resume ${sessionName}: ${agent.binary} in ${known.cwd}`);
    return reply({ resumed: true });
};

export interface SessionExitRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
}

export interface SessionExitResult {
    subtype: 'agent.session.exit.result';
    requestId: string;
    sessionName: string;
    exited?: true;
    error?: string;
    at: string;
}

/**
 * What an ending session is asked to act on, in order.
 *
 * `C-c` first, to interrupt whatever is running and clear the input line —
 * without it a quit command typed next would land after whatever was already
 * half-typed there.
 *
 * Then the agent's own quit command, when it has one. This is the step the
 * first version lacked and the reason it did not work: Claude Code holds its
 * prompt through `C-c` and through `C-d` alike, so a session driven only by
 * key presses stayed exactly where it was and had to be reported as still
 * running. An agent that knows how to quit should be asked in its own words.
 *
 * `C-d` last, twice. End-of-input closes a REPL that has no quit command, and
 * closes the shell the agent leaves behind — a session whose last pane exits
 * is over. Harmless where it is not needed: the sequence stops the moment the
 * session is gone.
 *
 * Deliberately no `kill-session` at the end. A forced kill would make this
 * always succeed, at the cost of taking the choice away from an agent that was
 * mid-write.
 */
const EXIT_SIGNALS_BEFORE_QUIT: readonly string[][] = [['C-c']];
const EXIT_SIGNALS_AFTER_QUIT: readonly string[][] = [['C-d'], ['C-d']];
/** Time given to each signal before the next one is tried. */
export const SESSION_EXIT_STEP_MS = 1_500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a session to end, in the order that gives the agent every chance to wind itself down, and say whether it is
 * gone afterwards. Never forces it: nothing here kills the tmux session. Shared by a phone's exit request and by a
 * scheduled session that ran past its cap.
 */
const endBySignals = async (sessionName: string): Promise<boolean> => {
    // The agent's own quit command, if this machine recorded which agent it is
    // and that agent has one. A session the registry never saw still gets the
    // signals — less likely to work, but nothing here depends on the record.
    const quitCommand = REMOTE_AGENTS.find(
        (a) => a.kind === recallSession(sessionName)?.agentKind,
    )?.quitCommand;
    // Stop as soon as it worked — anything sent after the session is gone
    // lands in whatever tmux gives that name next.
    const stillThere = () => sessionExists(sessionName);
    for (const tokens of EXIT_SIGNALS_BEFORE_QUIT) {
        if (!stillThere()) break;
        injectNamedKeys(sessionName, tokens);
        await wait(SESSION_EXIT_STEP_MS);
    }
    if (quitCommand && stillThere()) {
        injectKeys(sessionName, quitCommand);
        await wait(SESSION_EXIT_STEP_MS);
    }
    for (const tokens of EXIT_SIGNALS_AFTER_QUIT) {
        if (!stillThere()) break;
        injectNamedKeys(sessionName, tokens);
        await wait(SESSION_EXIT_STEP_MS);
    }
    return !stillThere();
};

/**
 * Ask a session to end, and report whether it did.
 *
 * Answers late on purpose: the whole point is to let the agent wind itself
 * down, so the reply has to wait long enough to know whether it did. A session
 * that is still there when the signals run out is reported as still there
 * rather than forced — "I asked and it refused" is a true answer, and a phone
 * that can silently destroy a working agent is a worse thing to have built.
 */
export const handleSessionExitRequest = (
    req: SessionExitRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.exit.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const requestId = req.requestId;
    const answer = (fields: Partial<SessionExitResult>): true => {
        send({
            subtype: 'agent.session.exit.result',
            requestId,
            sessionName,
            at: new Date().toISOString(),
            ...fields,
        });
        return true;
    };

    // Same budget as resume and as a submitted command: ending a session is a
    // session-lifecycle action, and pricing it like a keystroke would let a
    // flood through the cheaper door.
    // Subagent refusal first, though — outside the bucket, like resume's:
    // ending a subagent pane is a kill(2) on the parent's child, not a
    // lifecycle action the phone is ever offered.
    if (isSubagentSessionName(sessionName)) return answer({ error: 'subagent_view_only' });
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return answer({ error: 'rate_limited' });
    if (!sessionExists(sessionName)) return answer({ error: 'unknown_session' });

    void (async () => {
        if (await endBySignals(sessionName)) {
            log(`⏻ exit ${sessionName}: ended`);
            answer({ exited: true });
            return;
        }
        log(`✗ exit ${sessionName}: still running after the exit signals`);
        answer({ error: 'still_running' });
    })();
    return true;
};

export interface SessionForgetRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /** Which run of that name to delete. A name can hold one run per agent, and
     *  the phone deletes the row it is looking at. Absent (older phone) deletes
     *  every run under the name, which is what the request used to mean. */
    agentKind?: string;
    /** With `agentKind`, the one run of it to delete (hwip docs/session-runs.md). Absent: every run of that agent. */
    runId?: string;
    requestId?: string;
}

export interface SessionForgetResult {
    subtype: 'agent.session.forget.result';
    requestId: string;
    sessionName: string;
    forgotten?: true;
    /**
     * Set when the record went but the chat scrollback file would not delete.
     * The session is no longer resumable either way; this says the prompts and
     * tool targets it collected are still on the machine, which a flat
     * `forgotten: true` would have claimed otherwise.
     */
    scrollbackKept?: true;
    error?: string;
    at: string;
}

/**
 * Delete one ended session from this machine's record, and say what happened.
 * Returns true when the message was ours to answer.
 *
 * The mirror of resume, and destructive where that one is constructive: it
 * takes the entry out of the registry, which is the same file resume reads its
 * whitelist from. After this the session is neither offered nor startable, and
 * nothing puts it back — `rememberSessions` only writes down sessions that are
 * running, so only actually running that name again restores it.
 *
 * The refusals: unknown name is nothing to delete rather than something to
 * guess at. Still running means it is not a past session at all — the phone is
 * looking at a live one, and ending it is a different request that this must
 * not quietly stand in for.
 */
export const handleSessionForgetRequest = (
    req: SessionForgetRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.forget.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const reply = (fields: Partial<SessionForgetResult>): true => {
        send({
            subtype: 'agent.session.forget.result' as const,
            requestId: req.requestId,
            sessionName,
            at: new Date().toISOString(),
            ...fields,
        });
        return true;
    };

    // Charged like a submitted command: it writes to disk and is irreversible,
    // so it shares the budget with the paths that start and stop processes.
    // Subagent refusal before the bucket: a subagent has no registry record
    // to forget (the sweep never remembers panes), so the honest answer is
    // the view-only one, not unknown_session.
    if (isSubagentSessionName(sessionName)) return reply({ error: 'subagent_view_only' });
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return reply({ error: 'rate_limited' });

    // `unknown` — no tmux answered at all — is refused with the running answer
    // rather than allowed through: the phone already renders that one, and the
    // alternative is an irreversible delete (registry AND scrollback) justified
    // by a question that failed to be asked. It says so in the log, because
    // from the phone the two refusals are the same sentence.
    const liveness = sessionLiveness(sessionName);
    if (liveness === 'unknown') {
        log(`✗ forget ${sessionName}: no tmux answered, so nothing was deleted`);
        return reply({ error: 'still_running' });
    }
    if (liveness === 'running') return reply({ error: 'still_running' });
    const outcome = forgetSession(
        sessionName,
        typeof req.agentKind === 'string' ? req.agentKind : undefined,
        typeof req.runId === 'string' && /^\d{1,12}$/.test(req.runId) ? req.runId : undefined,
    );
    if (outcome === 'unknown') {
        log(`✗ forget ${sessionName}: never seen on this machine`);
        return reply({ error: 'unknown_session' });
    }
    if (outcome === 'scrollback_kept') {
        // The registry entry is gone, so the session is no longer resumable —
        // but its chat scrollback would not delete, and answering a flat
        // "forgotten" would overstate what actually happened.
        log(`🗑 forget ${sessionName}: dropped from the record, but its chat scrollback would not delete`);
        return reply({ forgotten: true, scrollbackKept: true });
    }

    log(`🗑 forget ${sessionName}: dropped from this machine's record`);
    return reply({ forgotten: true });
};

// ─── Deep pull: scrollback above the live window ───────────────────
//
// The live stream captures a fixed window and every frame is capped at
// SCREEN_PEEK_MAX_BYTES, so output older than that window is unreachable from
// the phone. Neither cap is the lever: a deeper STREAM_CAPTURE_LINES only grows
// what each frame captures and then throws away, and SCREEN_PEEK_MAX_BYTES is
// sized for API Gateway's 32KB WS frame. So history is pulled instead of
// streamed — one page per request, walking upward.

/** Ceiling on one page. A page past the frame limit arrives truncated anyway,
 *  so let the caller ask for less rather than pay for a capture we discard. */
export const SCREEN_HISTORY_MAX_LINES = 200;
const SCREEN_HISTORY_DEFAULT_LINES = 100;

export interface ScreenHistoryRequest {
    subtype?: string;
    targetDeviceId?: string;
    /** The requesting device, stamped by the relay: which of the session's viewers is asking. */
    deviceId?: string;
    sessionName?: string;
    requestId?: string;
    /**
     * How many lines of scrollback the caller already holds above the visible
     * pane — the `historyLines` of its newest frame plus every history line it
     * has pulled since. 0 asks for the page directly above the visible pane.
     *
     * The caller says this rather than the daemon assuming STREAM_CAPTURE_LINES,
     * because the byte cap trims frames from the top and a caller holding fewer
     * lines than the capture asked for would otherwise be handed a page that
     * starts above its own content, with the gap unreachable forever after.
     * Absent falls back to the constant — the untruncated case.
     */
    before?: number;
    /** Page size. Clamped to SCREEN_HISTORY_MAX_LINES. */
    lines?: number;
}

export interface ScreenHistorySnapshot {
    subtype: 'agent.screen.history.snapshot';
    requestId: string;
    sessionName: string;
    content?: string;
    /** Echo of the request's offset, so a caller with several pages in flight
     *  can tell which one this is. */
    before?: number;
    /** Lines actually returned — what the caller adds to `before` for the next
     *  page. Smaller than asked when the payload cap trimmed the page. */
    lines?: number;
    /** Whether older lines still exist above this page. */
    hasMore?: boolean;
    truncated?: boolean;
    /** The page sealed for the stream's subscriber (envelope v2
     *  `screen.history`, bound to the session) — present INSTEAD of `content`
     *  whenever the stream it belongs to is encrypted. */
    encrypted?: SealedV2;
    error?: string;
    capturedAt: string;
}

/** These become tmux argv and page arithmetic; a fractional, negative or
 *  non-numeric one has no sensible coercion, so it is refused. */
const isPageOffset = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** How many lines of scrollback the pane is holding, or null when tmux won't
 *  say — which is also how a dead pane answers. */
const paneHistorySize = (sessionName: string): number | null => {
    const target = tmuxTargetFor(sessionName);
    if (target === null) return null;
    const r = spawnSync(
        'tmux',
        tmuxArgs(['display-message', '-p', '-t', target, '#{history_size}']),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    const size = Number((r.stdout ?? '').trim());
    return Number.isInteger(size) && size >= 0 ? size : null;
};

/** Capture one explicit range. tmux line 0 is the top of the visible pane and
 *  negative numbers reach into the history, so both bounds are negative here. */
const capturePaneRange = (
    sessionName: string,
    start: number,
    end: number,
): { content: string; truncated: boolean } | null => {
    const target = tmuxTargetFor(sessionName);
    if (target === null) return null;
    const r = spawnSync(
        'tmux',
        tmuxArgs([
            'capture-pane', '-p', '-e', '-t', target,
            '-S', String(start), '-E', String(end),
        ]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    return capToFrameLimit(r.stdout ?? '');
};

const countLines = (content: string): number =>
    content ? content.replace(/\n$/, '').split('\n').length : 0;

/**
 * Answer a phone's request for one page of scrollback above the live window.
 * Returns true when the message was ours to answer, so the caller stops routing
 * it; the reply goes out through `send`, after the seal when there is one.
 *
 * Same security posture as the one-shot peek it sits beside — addressed to this
 * machine, only for sessions the inventory already exposes, charged to the same
 * per-session token bucket, and reading the pane through tmux and nothing else —
 * plus one the peek does not have: it answers ONLY under a live stream lease.
 * That is what makes E2EE possible here. History is the same pane text the
 * frames carry, so on an encrypted stream it is sealed for the same subscriber
 * key and never falls back to plaintext; without a lease there is no key to
 * seal for, and a pull that answered anyway would be the downgrade the stream
 * half refuses.
 */
export const handleScreenHistoryRequest = (
    req: ScreenHistoryRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.screen.history.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const base = {
        subtype: 'agent.screen.history.snapshot' as const,
        requestId: req.requestId,
        sessionName: req.sessionName,
        capturedAt: new Date().toISOString(),
        // Answered to the viewer that asked, not to every device watching the session.
        ...(req.deviceId ? { targetDeviceId: req.deviceId } : {}),
    };
    /** Answer and claim the message. */
    const reply = (fields: Partial<ScreenHistorySnapshot>): true => {
        send({ ...base, ...fields });
        return true;
    };

    const before = req.before ?? STREAM_CAPTURE_LINES;
    const asked = req.lines ?? SCREEN_HISTORY_DEFAULT_LINES;
    if (!isPageOffset(before) || !isPageOffset(asked) || asked === 0) {
        return reply({ error: 'bad_range' });
    }
    const lines = Math.min(asked, SCREEN_HISTORY_MAX_LINES);

    if (!checkRateLimit(`screen:${req.sessionName}`)) return reply({ error: 'rate_limited' });
    if (!isInventoried(req.sessionName)) {
        return reply({ error: 'unknown_session' });
    }
    const stream = streamFor(req.sessionName, req.deviceId);
    // A stream whose subscriber key is still being checked is no stream yet.
    if (!stream?.admitted) return reply({ error: 'no_stream' });
    // A plain stream from before this listener first sealed: no plaintext page
    // from it either, and the stream ends here as its next renew would end it.
    const plainRefused = stream.subscriberPublicKey ? null : plainRefusal();
    if (plainRefused) {
        stopStream(req.sessionName);
        return reply({ error: plainRefused });
    }

    const depth = paneHistorySize(req.sessionName);
    if (depth === null) return reply({ error: 'capture_failed' });

    // Everything below this line the caller already has.
    const held = before;
    // Scrolled past the oldest line. An empty page rather than an error — the
    // view stops, and stopping is not a failure. Nothing to seal either.
    if (depth <= held) return reply({ before, content: '', lines: 0, hasMore: false });

    const captured = capturePaneRange(req.sessionName, -(held + lines), -(held + 1));
    if (!captured) return reply({ error: 'capture_failed' });

    const returned = countLines(captured.content);
    const page = {
        before,
        lines: returned,
        truncated: captured.truncated,
        hasMore: depth > held + returned,
    };
    if (!stream.subscriberPublicKey) return reply({ ...page, content: captured.content });

    // Encrypted stream: the page rides ONLY inside the envelope, and a failed
    // seal is an error rather than a plaintext page — the same rule the frame
    // path follows when its encrypt fails.
    sealV2('screen.history', captured.content, stream.subscriberPublicKey, req.sessionName)
        .then((encrypted) => send({ ...base, ...page, encrypted }))
        .catch((err) => {
            log(`⧉ history ${req.sessionName}: seal failed (${err instanceof Error ? err.message : err})`);
            send({ ...base, error: 'encrypt_failed' });
        });
    return true;
};

/**
 * Fit one capture into a WS frame. Cuts from the TOP: the bottom of the range
 * is the part adjacent to what the reader already has — the live pane for a
 * snapshot, the page below it for a history page — so cutting the other end
 * would leave a hole exactly where the text has to join up.
 */
const capToFrameLimit = (raw: string): { content: string; truncated: boolean } => {
    let content = raw;
    let truncated = false;
    while (Buffer.byteLength(content, 'utf-8') > SCREEN_PEEK_MAX_BYTES) {
        const cut = content.indexOf('\n', Math.floor(content.length / 8));
        content = cut > 0 ? content.slice(cut + 1) : content.slice(-SCREEN_PEEK_MAX_BYTES);
        truncated = true;
    }
    return { content, truncated };
};

/** Raw pane capture + size cap. Shared by the request path and the
 *  post-injection auto-snapshot. */
const capturePane = (
    sessionName: string,
    escapes = false,
    lines: number = SCREEN_PEEK_LINES,
): { content: string; truncated: boolean } | null => {
    // `-e` keeps the ANSI/color escapes the live mirror renders; the
    // screen-peek path leaves it off so its <pre> renderer stays plain text.
    // `lines` sets how far back the capture reaches — the live stream grabs
    // more history so the mirror has room to scroll; SCREEN_PEEK_MAX_BYTES
    // still caps the payload below.
    const target = tmuxTargetFor(sessionName);
    if (target === null) return null;
    const captureArgs = escapes
        ? ['capture-pane', '-p', '-e', '-t', target, '-S', `-${lines}`]
        : ['capture-pane', '-p', '-t', target, '-S', `-${lines}`];
    const r = spawnSync('tmux', tmuxArgs(captureArgs), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    return capToFrameLimit(r.stdout ?? '');
};

/**
 * One stream tick's read of the pane: the capture and where the cursor sits,
 * in ONE tmux spawn (C18 — the tick runs every 120–400 ms).
 *
 * `capture-pane` gives cells and colors but no cursor, so the mirror has never
 * drawn one — which makes an arrow key indistinguishable from a dropped one.
 * tmux reports the position separately; `pane_height` is what turns a
 * pane-relative row into a row of the captured text, since the capture reaches
 * back into scrollback and the visible pane is only its last `pane_height`
 * lines. `history_size` tells the viewer how deep the buffer under that window
 * is. `display-message ; capture-pane` runs the two as consecutive commands in
 * one client: the first output line is the geometry, the rest is the capture.
 */
export const STREAM_GEOMETRY_FORMAT = '#{cursor_x},#{cursor_y},#{pane_height},#{history_size}';

type StreamRead = { captured: { content: string; truncated: boolean }; geometry: PaneGeometry | null };

/**
 * The last capture of each mirrored session, kept for `STREAM_SHARE_MS`: viewers of one session tick
 * together (see the start of a stream), and the first one's capture serves the rest — a tmux spawn
 * per tick for the session, not per viewer. Dropped when a keystroke lands, so an echo never reads
 * a capture from before it.
 */
const sharedCapture = new Map<string, { at: number; read: StreamRead }>();
/** Short of the burst cadence (120 ms), long enough for viewers that tick within a few ms of each other. */
const STREAM_SHARE_MS = 40;
/** How long after a sibling's tick a joining viewer's first tick fires: inside `STREAM_SHARE_MS`. */
const STREAM_SHARE_LAG_MS = 5;

const captureStreamPane = (sessionName: string): StreamRead | null => {
    const shared = sharedCapture.get(sessionName);
    if (shared && Date.now() - shared.at < STREAM_SHARE_MS) return shared.read;
    const read = captureStreamPaneNow(sessionName);
    if (read) sharedCapture.set(sessionName, { at: Date.now(), read });
    return read;
};

const captureStreamPaneNow = (
    sessionName: string,
): StreamRead | null => {
    const target = tmuxTargetFor(sessionName);
    if (target === null) return null;
    const r = spawnSync(
        'tmux',
        tmuxArgs([
            'display-message', '-p', '-t', target, STREAM_GEOMETRY_FORMAT, ';',
            'capture-pane', '-p', '-e', '-t', target, '-S', `-${STREAM_CAPTURE_LINES}`,
        ]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    const out = r.stdout ?? '';
    const split = out.indexOf('\n');
    if (split === -1) return null;
    return { captured: capToFrameLimit(out.slice(split + 1)), geometry: parsePaneGeometry(out.slice(0, split)) };
};

export interface PaneGeometry {
    x: number;
    y: number;
    height: number;
    /** Lines of scrollback the pane holds above the visible rows. Tells the
     *  viewer where this frame's window sits in the buffer, which is what lets
     *  it record the lines that scroll past without matching text. Absent when
     *  tmux did not answer with a usable number. */
    historySize?: number;
}

/**
 * Read the one tmux answer the frame path already asks for per tick.
 *
 * The depth is parsed separately from the cursor on purpose: a tmux that does
 * not report `history_size` still reports the cursor, and refusing the whole
 * answer over the missing field would cost every frame its cursor — a
 * regression in exchange for a feature.
 */
export const parsePaneGeometry = (raw: string): PaneGeometry | null => {
    const fields = raw.trim().split(',');
    const [x, y, height] = fields.map(Number);
    if (![x, y, height].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    // An absent field is NOT a depth of zero, and `Number('')` is 0 — so the
    // raw field has to be checked before it is converted. Zero is the answer a
    // freshly cleared pane gives, and the viewer reads a drop to zero as that
    // clear; letting an empty answer arrive as one would fake the clear and
    // make the viewer re-record output it already holds.
    const depth = fields.length > 3 && fields[3] !== '' ? Number(fields[3]) : NaN;
    if (!Number.isSafeInteger(depth) || depth < 0) return { x, y, height };
    return { x, y, height, historySize: depth };
};

/**
 * Translate the cursor into an index into the lines the frame carries.
 *
 * The visible pane is the tail of the capture, so the cursor's row counts back
 * from the end — which also makes this correct after the byte cap has cut lines
 * off the top. A cursor that falls outside what the frame carries returns null
 * and simply is not drawn.
 */
export const cursorLineFor = (
    content: string,
    cursor: { x: number; y: number; height: number },
): { line: number; col: number } | null => {
    const rows = paneRowCount(content);
    const line = rows - cursor.height + cursor.y;
    if (line < 0 || line >= rows) return null;
    return { line, col: cursor.x };
};

/** capture-pane ends the last row with a newline, which split() turns into a
 *  trailing empty element that is not a pane row. */
const paneRowCount = (content: string): number => {
    const lines = content.split('\n');
    return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
};

/**
 * How many of a frame's lines are scrollback rather than the visible pane.
 *
 * This is the number the viewer hands back as `before` when it asks for
 * history. STREAM_CAPTURE_LINES is only what the capture ASKED for: the byte
 * cap trims from the top, and a coloured TUI pane hits that cap routinely, so
 * assuming the viewer holds the full window would start the first history page
 * above what it actually has — leaving a gap no later page can reach, since
 * every later page walks further up.
 */
export const historyLinesIn = (content: string, paneHeight: number): number =>
    Math.max(0, paneRowCount(content) - paneHeight);

/** Delays after a key injection at which the pane is re-captured and pushed
 *  to the phone unsolicited. The first frame lands right after most TUI
 *  redraws; the second catches slow animations and is skipped when nothing
 *  changed since the first. */
const INJECT_SNAPSHOT_DELAYS_MS = [250, 900];

const pendingInjectSnapshots = new Map<string, ReturnType<typeof setTimeout>[]>();

/**
 * After the phone injects keys, push fresh frames instead of waiting for its
 * next screen request — the phone's post-tap re-pull raced the key landing
 * (its timer starts at tap time, the key lands a REST+WS hop later), so it
 * often re-captured the pre-keypress screen and the next update was a full
 * auto-refresh period away. Unsolicited frames carry no requestId; the phone
 * matches them by deviceId + sessionName. A newer tap cancels pending
 * captures so a burst of arrow presses yields frames after the LAST press.
 */
export const scheduleInjectSnapshots = (
    sessionName: string,
    send: (data: Record<string, unknown>) => void,
    delays: number[] = INJECT_SNAPSHOT_DELAYS_MS,
): void => {
    // These snapshots exist to show the phone what a keystroke did when nobody
    // is mirroring the pane. A live stream already repaints it at the burst
    // cadence, so scheduling them there is two extra blocking captures and two
    // extra sends per keystroke — outside the stream's own send budget, which
    // is exactly the cost the budget exists to bound.
    if (hasStream(sessionName)) return;
    // Nobody asked for these, so there is no key to seal them for: a listener
    // that only seals sends none.
    if (subscriberTrust?.sealedOnly()) return;
    for (const t of pendingInjectSnapshots.get(sessionName) ?? []) clearTimeout(t);
    let lastContent: string | null = null;
    const timers = delays.map((delay) =>
        setTimeout(() => {
            // Asked again here: a first seal can land between the key press
            // and this timer.
            if (subscriberTrust?.sealedOnly()) return;
            const captured = capturePane(sessionName);
            if (!captured || captured.content === lastContent) return;
            lastContent = captured.content;
            send({
                subtype: 'agent.screen.snapshot',
                sessionName,
                capturedAt: new Date().toISOString(),
                ...captured,
            });
        }, delay),
    );
    pendingInjectSnapshots.set(sessionName, timers);
};

// ─── Live mirror: continuous pane streaming ──────────────────
// Extends screen-peek from pull (one snapshot per request) to a subscribed
// stream over the same ephemeral relay, same security posture (only
// inventory-visible sessions, addressed by deviceId, same rate-limit bucket).
//
// E2EE: when the subscriber sends its device public key with stream.start
// (and the key checks out — subscriber-trust.ts), every frame's pane content
// rides inside envelope v2 (crypto.ts sealV2, purpose `stream.frame`, bound to
// the session) only that phone can open, sealed together with its session,
// capture stamp and the subscriber's nonce (SealedStreamFrame), so the phone
// can tell a frame moved from another stream or replayed from an earlier
// subscription. The relay stays pass-through. Without a key frames are plain
// only until this listener first seals, or the account turns E2E on; after
// that a keyless start is refused (e2ee_required). Once a stream is encrypted an encrypt failure DROPS the
// frame; it never downgrades to plaintext mid-stream.
export interface StreamControl {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /** Subscriber's device public key (Base64 SPKI) — presence turns on E2EE. */
    subscriberPublicKey?: string;
    /** The subscribing device, stamped by the relay: whose registered key the
     *  one above has to be before a frame is sealed for it. */
    deviceId?: string;
    /**
     * Subscriber's nonce for this subscription, sealed into every frame with
     * the session and the capture stamp. The viewer checks all of them, so a
     * relay cannot move a sealed frame to another stream or replay one from an
     * earlier subscription. Ignored unless a short string (MAX_NONCE_LENGTH).
     */
    subscriberNonce?: string;
    /**
     * On a renew: the viewer's fresh random word, sealed back in the answer
     * with the last frame sent (`agent.stream.renew.ok` `encrypted`). A relay
     * cannot make that answer, or replay an old one, so a "live" badge kept
     * up by renews says the listener is there — and its `seq` says whether
     * frames were dropped on the way. Ignored unless a short string.
     */
    challenge?: unknown;
    /**
     * Subscriber promises to send `agent.stream.renew` while it's watching.
     * Only such a subscriber gets the short lease; clients that predate the
     * renew protocol keep the 5-minute orphan guard (see STREAM_LEASE_MS).
     */
    renew?: boolean;
    /**
     * How many terminal columns the viewer shows (on start and every renew).
     * A detached, unsplit window is resized to it while watched — see
     * pane-fit.ts. Absent from viewers that predate it: nothing is resized.
     */
    cols?: number;
}

// ~2.5 fps idle ceiling. Cadence + diff-gating + the per-second send budget
// are the ONLY bound on API Gateway WS cost (the $default route has no
// per-message limit), so keep it modest and let unchanged frames drop.
// How far back the live-stream capture reaches — more than the screen-peek
// window so the mirror has scrollback to scroll through. SCREEN_PEEK_MAX_BYTES
// still caps the actual payload, so very wide panes get top-truncated.
export const STREAM_CAPTURE_LINES = 200;
export const STREAM_INTERVAL_MS = 400;
// Burst cadence: right after a keystroke lands, the pane IS what the user is
// staring at, so captures tighten for BURST_WINDOW_MS and then fall back to
// the idle cadence. The window is what keeps this affordable — one keypress
// costs a bounded number of extra frames instead of raising the steady rate.
export const BURST_INTERVAL_MS = 120;
export const BURST_WINDOW_MS = 2_500;
// Cost bound the burst must not break: MAX_CONCURRENT_STREAMS × 8 = 24 msg/s
// worst case, under half of the API Gateway WS stage throttle (50 rps) that is
// SHARED across every user, so a bursting host still leaves headroom for push
// delivery and presence. At BURST_INTERVAL_MS the chain tops out at 8.3 fps,
// so this budget bites only in the last fraction of a fully bursting second —
// it is what holds the line if the burst cadence is ever tightened further.
export const MAX_FRAMES_PER_SEC = 8;

/**
 * Delay before the next capture: burst while the last input is still echoing,
 * idle otherwise. Exclusive at the boundary — exactly BURST_WINDOW_MS after
 * the input is already idle, so the window can't stretch. A lastInputAt in the
 * future (wall-clock jump) reads as fresh input rather than as an expired
 * window: bursting is the recoverable side of that.
 */
export const streamCadence = (lastInputAt: number | null, now: number): number =>
    lastInputAt !== null && now - lastInputAt < BURST_WINDOW_MS ? BURST_INTERVAL_MS : STREAM_INTERVAL_MS;

/** Rolling one-second send budget for a single stream. */
export interface FrameBudget {
    windowStartedAt: number;
    sent: number;
}

/**
 * Claim one send from the budget, rolling the window over when the second has
 * passed. False means this tick must skip WITHOUT marking the frame as sent —
 * the diff-gate would otherwise swallow that content for good.
 */
/** Is there budget left this second? A peek, so a tick can decline to pay for a
 *  blocking capture it could not send anyway — spending the token here instead
 *  would burn budget on ticks the diff-gate goes on to skip. */
export const hasFrameBudget = (budget: FrameBudget, now: number): boolean =>
    now - budget.windowStartedAt >= 1_000 || now < budget.windowStartedAt
        ? true
        : budget.sent < MAX_FRAMES_PER_SEC;

export const claimFrameSend = (budget: FrameBudget, now: number): boolean => {
    // `now < windowStartedAt` = the clock ran backwards (NTP step, resume).
    // Without the guard the window never rolls again and a spent budget
    // freezes the mirror for the whole regression — same failure streamCadence
    // already defends against, so the two must agree.
    if (now - budget.windowStartedAt >= 1_000 || now < budget.windowStartedAt) {
        budget.windowStartedAt = now;
        budget.sent = 0;
    }
    if (budget.sent >= MAX_FRAMES_PER_SEC) return false;
    budget.sent++;
    return true;
};
// Orphan guard for subscribers that can't renew (clients older than the renew
// protocol): a phone that dies without sending agent.stream.stop must not leak
// an interval forever. Auto-stop after this long; the phone re-subscribes on
// reopen.
const STREAM_MAX_MS = 5 * 60_000;
// Lease for a renewal-capable subscriber (`start` carried `renew: true`).
// stream.stop is NOT a reliable slot-release signal: the native terminal runs
// in its own WebView that the OS destroys on swipe-back, killing the page mid-
// flight — no unmount, no stop, and the relay is pass-through so we never see
// the phone's socket drop either. Three such opens used to wedge
// MAX_CONCURRENT_STREAMS for a full STREAM_MAX_MS with every retry answering
// stream_limit. A lease inverts the burden: the viewer must keep proving it's
// there.
//
// This is also the worst-case wait before a vanished viewer's slot comes back,
// so it wants to be short — but a lease can only be as tight as the proof is
// frequent. At the web's 5s renew cadence this tolerates 3 consecutive dropped
// renews, the same margin as before, while cutting the wedge from 5 minutes to
// 15 seconds. A viewer that loses the race gets its stream reaped and re-
// subscribes on the next renew (see the stream_gone reply below).
export const STREAM_LEASE_MS = 15_000;
// How recent a renew must be for a slot-holder to count as provably watched
// when the cap needs a victim. Deliberately tighter than the lease: the lease
// is the self-reap deadline and wants slack for dropped renews, but at the cap
// that slack is exactly the window in which a swiped-away WebView's ghost
// answers every new subscriber with stream_limit. One renew beat (the web's
// 5s cadence) plus jitter is proof enough under contention; a live viewer
// evicted over a single dropped renew learns via stream_gone on its next
// renew and re-subscribes.
export const STREAM_RENEW_FRESH_MS = 8_000;
// Per-listener concurrency guard: the API Gateway WS stage throttle (50 rps)
// is SHARED across every user, so a runaway machine (many sessions, or a
// client re-subscribe bug) streaming at 2.5 fps each can starve push delivery
// and presence for everyone. One phone watches one session at a time; 3 leaves
// headroom for multiple devices while capping the blast radius of one host.
export const MAX_CONCURRENT_STREAMS = 3;
// Fail-closed guard: consecutive encrypt failures (malformed subscriber key)
// stop the stream with an error frame instead of retrying forever.
const STREAM_MAX_ENCRYPT_FAILURES = 3;

// R2 instrumentation: the daemon's outbound send() IS the API Gateway $default
// inbound message (1 Lambda + DDB ops + N PostToConnection each), so counting
// frames/bytes HERE measures the real cloud cost of a live stream. Rolled up to
// the log every STREAM_LOG_INTERVAL_MS and summarized on stop — the data that
// decides cloud-throttled (B-lite) vs direct/Tailscale (B-full).
const STREAM_LOG_INTERVAL_MS = 5_000;

interface StreamStats {
    startedAt: number;
    frames: number; // frames actually sent (post diff-gate)
    bytes: number; // payload bytes sent
    /** The burst phase's share of frames/bytes, and the wall time spent at the
     *  burst cadence — burst vs idle cost is the question B-full turns on, and
     *  a single blended fps hides it. Idle is the remainder. */
    framesBurst: number;
    bytesBurst: number;
    burstMs: number;
    skipped: number; // ticks that sent nothing (diff-gate, or the send budget)
    rateCapped: number; // subset of `skipped` refused by MAX_FRAMES_PER_SEC
    lastLogAt: number;
    lastLogFrames: number;
    lastLogBytes: number;
    lastLogFramesBurst: number;
    lastLogBurstMs: number;
}

interface ActiveStream {
    /** The session this stream mirrors, and the device watching it (relay-stamped; a web tab has none).
     *  A session can have one stream per viewing device — see `streamKey`. */
    sessionName: string;
    deviceId?: string;
    /** When the armed tick fires. A viewer that joins a session already being mirrored lines its first
     *  tick up with this one, so the two share a capture (`captureStreamPane`). */
    nextFireAt: number;
    /** The width this viewer last asked the pane to take (start, or a renew that changed it). */
    cols?: number;
    /** Handle of the ONE armed tick. The capture loop re-arms itself every
     *  tick (the cadence changes between ticks), so this is replaced each
     *  time — stopping a stream means clearing whatever is current. */
    timer: ReturnType<typeof setTimeout>;
    stats: StreamStats;
    /** When input last landed in this pane, or null if none has. Drives the
     *  burst cadence; set by noteStreamInput from the shared inject path. */
    lastInputAt: number | null;
    /** Wall-clock deadline; the capture tick reaps the stream once it passes. */
    expiresAt: number;
    /** Subscriber renews — i.e. its silence is proof it's gone, not just quiet. */
    renewing: boolean;
    /** Last proof of watching (start or renew). Eviction freshness reads this;
     *  the lease above stays the reaping deadline. */
    renewedAt: number;
    /** Set when the subscriber handed over an E2EE key at start. Outbound
     *  frames are encrypted for it, so inbound plaintext input is refused
     *  rather than typed — the inbound half must not be the one leg in clear. */
    subscriberPublicKey?: string;
    /** The subscription's nonce, sealed into its frames and its alive answers. */
    nonce?: string;
    /** The device whose key was admitted for this sealed stream (relay-stamped at start). */
    subscriberDeviceId?: string;
    /** This incarnation's epoch (`stats.startedAt`), the frames' stamp. */
    epoch: number;
    /** Highest seq of a frame that went out — the one a sealed renew answer names. */
    lastSentSeq: number;
    /** Whether frames may go out. False while a subscriber key is being checked
     *  (subscriber-trust.ts): until then nothing is captured for it, and no
     *  sealed input or history request is taken. A stream without a key is
     *  admitted from the start. */
    admitted: boolean;
    /** Consecutive failed decrypts of sealed input on THIS incarnation. The
     *  subscriber-key binding gates who may enqueue an ECDH derive, not how
     *  many can fail, so this is what stops a flood; a successful decrypt
     *  clears it, and a re-subscribe mints a fresh entry. */
    inputDecryptFailures: number;
    /** Replace an IDLE-armed tick with an immediate burst tick. Input landing
     *  just after an idle tick must not wait out the remaining ~400ms gap —
     *  that gap IS the latency the burst exists to remove. No-op while a
     *  burst tick is armed, so a keystroke flurry can't starve the chain. */
    wake: () => void;
}

/** How far a start (and each renew) pushes the deadline out. */
const leaseFor = (renewing: boolean): number => (renewing ? STREAM_LEASE_MS : STREAM_MAX_MS);

/**
 * Live mirrors, one per (session, viewing device): every viewer keeps the whole of the machinery a
 * single viewer had — its own capture loop state, lease, nonce, epoch and seq, sealed frames — so
 * two devices watching one pane do not take each other's stream over. A viewer with no device id
 * (a web tab) shares the empty slot, one at a time, as before. The tmux pane is shared: its width
 * is whatever the last viewer to send input or `cols` asked for (pane-fit.ts), and every viewer
 * receives the pane at that width.
 */
const activeStreams = new Map<string, ActiveStream>();

const streamKey = (sessionName: string, deviceId: string | undefined): string =>
    `${sessionName}\u0000${typeof deviceId === 'string' ? deviceId : ''}`;

const streamsOf = (sessionName: string): ActiveStream[] =>
    [...activeStreams.values()].filter((entry) => entry.sessionName === sessionName);

const hasStream = (sessionName: string): boolean => streamsOf(sessionName).length > 0;

/**
 * The stream a control message from `deviceId` is about. The relay stamps the sending device on
 * every message, so the slot is exact; a message that arrives with no stamp (a relay that predates
 * it, which only fills a missing value in) can only mean the session's one viewer, and means
 * nothing when there are several.
 */
const streamFor = (sessionName: string, deviceId: string | undefined): ActiveStream | undefined => {
    const exact = activeStreams.get(streamKey(sessionName, deviceId));
    if (exact || (typeof deviceId === 'string' && deviceId)) return exact;
    const all = streamsOf(sessionName);
    return all.length === 1 ? all[0] : undefined;
};

/** Sessions with at least one viewer: what the concurrency cap counts. */
const mirroredSessionCount = (): number => new Set([...activeStreams.values()].map((entry) => entry.sessionName)).size;

/**
 * The transcript a live chat watch should follow for one session name.
 *
 * Exported because the two branches here are where a subagent watch lives or
 * dies, and a test that only reached the module's maps would pass while this
 * asked tmux about a name tmux cannot parse.
 */
export const resolveWatchTranscript = (
    sessionName: string,
    onMiss?: (reason: string) => void,
): TranscriptSource | null => {
    // Why this returned nothing, for the caller that has a viewer waiting. Only
    // this function can tell "the row has no resolver" from "the resolver ran
    // and found nothing", and on the phone those two are the same sentence.
    const miss = (reason: string): null => {
        onMiss?.(reason);
        return null;
    };
    // In-process subagents first: they have no pane, and asking tmux about
    // `hwip-x.3` makes it read the `.3` as a pane index and answer for some
    // other pane entirely — the parent's, whose transcript is NOT this one.
    // Claude Code is the only agent with in-process subagents, so the format is
    // known without asking the table.
    const subagentTranscript = subagentTranscriptFor(sessionName);
    if (subagentTranscript) return { path: subagentTranscript, project: projectTranscriptEntries };
    const info = readPaneInfo(sessionName);
    if (!info.currentPath) return miss('tmux reported no working directory for this session');
    // Ask the agent actually running in the pane, through the same detector the
    // session sweep uses — start_command first, because the foreground process
    // is usually the interpreter, and quote-stripped, because a leading `"`
    // once made this exact check miss every wrapped session. An agent whose row
    // carries no resolver answers null, which the watcher reports as
    // `no_transcript` — the EXTENSION POINT rule the session-id and
    // session-name resolvers already follow.
    //
    // One lookup answers both halves: `readPaneInfo` above is an uncached tmux
    // spawn, and resolving path and projector separately would pay for it twice
    // on a path that runs every TRANSCRIPT_RECHECK_MS per watcher.
    const agent = detectRemoteAgent(info);
    if (!agent) return miss('no known agent running in the pane');
    if (!agent.resolveTranscript) return miss(`${agent.kind} has no transcript resolver`);
    const path = agent.resolveTranscript(info.currentPath, info.panePid ?? undefined);
    if (!path) return miss(`${agent.kind} resolver found no transcript under ${info.currentPath}`);
    // Unreachable for every row in the table as it stands: `remote-agents.test.ts`
    // ("a row resolves a transcript and reads it, or does neither") rejects a
    // row that sets one without the other, which is why this branch has no test
    // of its own. It stays as the fail-closed answer if that invariant ever
    // drifts — handing the watcher a path nothing can parse would reach the
    // phone as an empty timeline, which reads as a hung agent.
    if (!agent.projectTranscript) return miss(`${agent.kind} resolves a transcript but has no projector`);
    return { path, project: agent.projectTranscript, ...(agent.readTranscript ? { read: agent.readTranscript } : {}) };
};

/**
 * The always-on conversation recorder (`turn-recorder.ts`), for the app's session
 * history. A module-level singleton like `turnWatchers`: one per daemon, fed by
 * every inventory sweep, ended with the process. `--no-turn-history` or
 * `"turnHistory": false` leave it off.
 */
let turnRecorder: TurnRecorder | null = null;

const startTurnRecorder = (
    features: { turnHistory: boolean },
    apiKey: string,
    baseUrl: string,
    devices: DeviceDirectory['devices'],
): void => {
    if (turnRecorder) return;
    if (!features.turnHistory) {
        log('turn history: off (--no-turn-history / "turnHistory": false / config.json unreadable) — conversations are not uploaded');
        return;
    }
    const deviceId = computeListenerDeviceId();
    const recipients = accountRecipients({ trustFile: TRUST_FILE, deviceId, devices, log: (message) => log(message) });
    turnRecorder = createTurnRecorder({
        dir: join(stateDir(), 'turn-recorder'),
        deviceId: () => deviceId,
        projectorFor: (kind) => REMOTE_AGENTS.find((a) => a.kind === kind)?.projectTranscript ?? null,
        readerFor: (kind) => REMOTE_AGENTS.find((a) => a.kind === kind)?.readTranscript ?? null,
        recipients,
        seal: sealChunk,
        upload: createChunkUploader({ baseUrl, apiKey }),
        uploadReady: () => deviceKeyRegistered,
        devicePublicKey: getDevicePublicKey,
        latestSeq: createLatestSeqReader({ baseUrl, apiKey }),
        log: (message) => log(message),
    });
    turnRecorder.start();
    process.on('exit', () => turnRecorder?.stop());
    promptSealer = createPromptSealer({
        deviceId: () => deviceId,
        recipients,
        seal: sealChunk,
        log: (message) => log(message),
    });
};

/** One chat-timeline batch, sealed for the watcher and bound to its session. */
export const sealTurnBatch = (plaintext: string, subscriberPublicKey: string, sessionName: string): Promise<SealedV2> =>
    sealV2('turn.batch', plaintext, subscriberPublicKey, sessionName);

/**
 * The live agent-chat timeline (`turn-watch.ts`), kept beside `activeStreams`
 * rather than inside it: both are per-session and both end on socket close, but
 * their lifetimes are driven by different things — a tmux pane for one, a
 * viewer's lease over a growing file for the other — and merging them would tie
 * a terminal mirror's death to a chat tab's.
 */
const turnWatchers = createTurnWatchers({
    deviceId: () => computeListenerDeviceId(),
    resolveTranscript: resolveWatchTranscript,
    sessionExists: (sessionName) => sessionExists(sessionName),
    initCrypto: async () => { await initDeviceCrypto(); },
    seal: sealTurnBatch,
    ring: diskTurnRing,
    log: (message) => log(message),
});

/** The latest chat-timeline start per session, by a number every start takes
 *  from one counter, so a start whose key was still being checked can tell
 *  that a stop or a newer start overtook it. A stop removes the entry (the
 *  map holds only sessions with a start in play); a renew keeps the watch it
 *  renews, so it does not count. */
const turnWatchTurns = new Map<string, number>();
let turnWatchCount = 0;

/**
 * Route a chat-timeline control message. A start is a request for the
 * transcript, so it passes the same door as every other request for content
 * (subscriber-trust.ts): one that asks for sealed batches waits for its key to
 * check out, like a stream start, and one without a key is refused once this
 * listener only seals. Everything else goes straight to the watchers.
 */
export const handleTurnWatch = (
    req: TurnWatchControl & { deviceId?: string },
    send: SendTurnFrame,
): boolean => {
    const { sessionName } = req;
    const addressedHere = req.targetDeviceId === computeListenerDeviceId() && typeof sessionName === 'string' && sessionName !== '';
    if (!addressedHere || !req.subtype?.startsWith('agent.turn.watch.')) return turnWatchers.handle(req, send);
    if (req.subtype === 'agent.turn.watch.renew') return turnWatchers.handle(req, send);
    if (req.subtype !== 'agent.turn.watch.start') {
        turnWatchTurns.delete(sessionName);
        return turnWatchers.handle(req, send);
    }
    const turn = ++turnWatchCount;
    turnWatchTurns.set(sessionName, turn);

    // A stop, or a newer start, arrived while the key was being checked: the
    // answer, either way, belongs to a start the viewer already left.
    const overtaken = (): boolean => turnWatchTurns.get(sessionName) !== turn;
    const refuse = (reason: RefusalCode): void => {
        if (overtaken()) return;
        send({ subtype: 'agent.turn.watch.error', sessionName, error: reason });
    };
    if (!asksForSeal(req)) {
        const refusal = plainRefusal();
        if (!refusal) return turnWatchers.handle(req, send);
        refuse(refusal);
        return true;
    }
    whenSealAdmitted(
        req,
        (publicKey) => {
            if (overtaken()) return;
            turnWatchers.handle({ ...req, subscriberPublicKey: publicKey }, send);
        },
        refuse,
    );
    return true;
};

/** Inbound key ordering, one per (streamed session, sender device) — see the
 *  `agent.command.input` section below. Lives here so stopStream can drop them
 *  with the lease they belong to. Keyed `<session>#<deviceId>`, or the bare
 *  session name from a relay too old to stamp the sender. */
const inputSequencers = new Map<string, InputSequencer<PendingInput>>();

/** Frames per second for one cadence phase. A phase that got no wall time in
 *  the window (a stream that never bursted) reads 0.0, never NaN. */
const phaseFps = (frames: number, ms: number): string => (ms > 0 ? (frames / (ms / 1000)).toFixed(1) : '0.0');

const maybeLogStreamStats = (sessionName: string, stats: StreamStats): void => {
    const elapsed = Date.now() - stats.lastLogAt;
    if (elapsed < STREAM_LOG_INTERVAL_MS) return;
    const secs = elapsed / 1000;
    const frames = stats.frames - stats.lastLogFrames;
    const fps = frames / secs;
    const kbps = (stats.bytes - stats.lastLogBytes) / 1024 / secs;
    // burstMs is charged when a burst tick is armed, so it can overshoot the
    // window by at most one interval — phaseFps clamps the idle remainder.
    const burstMs = stats.burstMs - stats.lastLogBurstMs;
    const burstFrames = stats.framesBurst - stats.lastLogFramesBurst;
    log(
        `⧉ stream ${sessionName}: ${fps.toFixed(1)} fps, ${kbps.toFixed(1)} KB/s ` +
            `(${stats.frames} sent, ${stats.skipped} skipped incl. ${stats.rateCapped} rate-capped) ` +
            `[burst ${phaseFps(burstFrames, burstMs)} fps · idle ${phaseFps(frames - burstFrames, elapsed - burstMs)} fps]`,
    );
    stats.lastLogAt = Date.now();
    stats.lastLogFrames = stats.frames;
    stats.lastLogBytes = stats.bytes;
    stats.lastLogFramesBurst = stats.framesBurst;
    stats.lastLogBurstMs = stats.burstMs;
};

/** A keystroke landed in this pane, so the next captures run at the burst
 *  cadence and the echo is visible instead of up to STREAM_INTERVAL_MS late.
 *  Called from the shared inject helpers, which is what both the ephemeral
 *  (agent.command.input) and the REST (agent.command) paths funnel through. */
const noteStreamInput = (sessionName: string): void => {
    const streams = streamsOf(sessionName);
    if (streams.length === 0) return;
    // The echo must not come from a capture taken before the keystroke landed.
    sharedCapture.delete(sessionName);
    for (const entry of streams) {
        entry.lastInputAt = Date.now();
        entry.wake();
    }
};

/**
 * Stop one viewer's stream: the (session, device) slot. The session's pane is handed back (width,
 * input counters) only when it was the last viewer.
 *
 * `keepFit` is for the restart inside a start: the same viewer is subscribing
 * again, and handing the window back only to shrink it a moment later would
 * make the program redraw twice.
 */
export const stopStreamOf = (sessionName: string, deviceId: string | undefined, { keepFit = false }: { keepFit?: boolean } = {}): void => {
    const key = streamKey(sessionName, deviceId);
    const entry = activeStreams.get(key);
    if (!entry) {
        if (!keepFit && !hasStream(sessionName)) paneFitter.release(sessionName);
        return;
    }
    clearTimeout(entry.timer);
    activeStreams.delete(key);
    if (!hasStream(sessionName)) {
        if (!keepFit) paneFitter.release(sessionName);
        sharedCapture.delete(sessionName);
        // The next stream is a new run: a sequencer carrying this one's high-water
        // mark would swallow its first keys if the sender restarts its counter.
        // Every sender that typed into this session holds its own, so drop the
        // whole `<session>#…` family, not just the bare-name key.
        for (const [inputKey, sequencer] of inputSequencers) {
            if (inputKey !== sessionName && !inputKey.startsWith(`${sessionName}#`)) continue;
            sequencer.reset();
            inputSequencers.delete(inputKey);
        }
    }
    const { stats } = entry;
    const secs = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
    log(
        `⧉ stream ${sessionName} stopped: ${stats.frames} frames / ` +
            `${(stats.bytes / 1024).toFixed(1)} KB over ${secs.toFixed(1)}s ` +
            `(${(stats.frames / secs).toFixed(1)} fps avg, ${stats.skipped} skipped incl. ${stats.rateCapped} rate-capped) ` +
            `[burst ${stats.framesBurst} frames / ${(stats.bytesBurst / 1024).toFixed(1)} KB ` +
            `over ${(stats.burstMs / 1000).toFixed(1)}s = ${phaseFps(stats.framesBurst, stats.burstMs)} fps]`,
    );
};


/** Stop every viewer of a session. */
export const stopStream = (sessionName: string, opts: { keepFit?: boolean } = {}): void => {
    const streams = streamsOf(sessionName);
    if (streams.length === 0) {
        if (!opts.keepFit) paneFitter.release(sessionName);
        return;
    }
    for (const entry of streams) stopStreamOf(sessionName, entry.deviceId, opts);
};

export const stopAllStreams = (): void => {
    // Route through stopStream so each stream emits its summary line.
    for (const entry of [...activeStreams.values()]) stopStreamOf(entry.sessionName, entry.deviceId);
};

/** Wire shape of one live-mirror data frame (before the relay's ephemeral wrap). */
export type StreamFramePayload = {
    subtype: 'agent.stream.frame';
    sessionName: string;
    capturedAt: string;
    truncated: boolean;
    /** Capture-order stamp — attached at send time; a sealed frame gets it from
     *  buildStreamFrame too, and inside its envelope (SealedStreamFrame). */
    seq?: number;
    /** Stream incarnation (stats.startedAt) — lets the receiver reset its
     *  seq high-water mark when the daemon restarts the stream. */
    epoch?: number;
    /** Where to draw the cursor: a 0-based index into the lines this frame
     *  carries, and a 0-based CELL column (not a string index — a wide glyph
     *  spans two cells, which is what the viewer positions by). Absent when the
     *  cursor is outside the captured region. Kept in the clear for unsealed
     *  streams and routing; a sealed frame carries the same values inside its
     *  envelope (SealedStreamFrame), and a viewer of a sealed stream draws the
     *  cursor, like the lines, only from there — the relay can rewrite these. */
    cursorLine?: number;
    cursorCol?: number;
    /** How many of this frame's lines are scrollback rather than the visible
     *  pane — what the viewer sends back as `before` when it pulls history.
     *  Fewer than STREAM_CAPTURE_LINES whenever the byte cap trimmed the frame,
     *  which is exactly the case a constant would get wrong. Absent when the
     *  pane geometry could not be read; the viewer then falls back to the
     *  constant. In the clear as the cursor is, and sealed the same way. */
    historyLines?: number;
    /** How much scrollback the PANE holds above its visible rows — the depth
     *  this frame's window sits in, where `historyLines` is only the slice of
     *  it the frame carries. Together they place the frame's top edge in the
     *  buffer, which is what lets a viewer record the lines that scroll past
     *  without matching text (a redrawing TUI defeats text matching), and lets
     *  it see the buffer being cleared as the depth dropping. Absent when tmux
     *  would not say. In the clear as the cursor is, and sealed the same way. */
    historySize?: number;
    /** Plaintext pane content — only on unencrypted streams. */
    content?: string;
    /** Envelope v2 (`stream.frame`, context = session) of a SealedStreamFrame —
     *  replaces `content` on encrypted streams. */
    encrypted?: SealedV2;
};

/**
 * What a sealed frame's envelope holds (as JSON): the pane with everything a
 * viewer draws from it, and the stamps the relay also sees in the clear plus
 * the subscriber's nonce. The cleartext fields stay for routing and ordering;
 * a viewer of a sealed stream trusts only these. What it is (a frame, not
 * input or a snapshot) is the envelope's purpose, part of its key.
 */
export type SealedStreamFrame = {
    sessionName: string;
    seq?: number;
    epoch?: number;
    nonce?: string;
    content: string;
    truncated: boolean;
    cursorLine?: number;
    cursorCol?: number;
    historyLines?: number;
    historySize?: number;
};

/** Longest subscriber nonce taken; a viewer's is 16 random bytes in Base64 (24). */
const MAX_NONCE_LENGTH = 64;

const subscriptionNonce = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_NONCE_LENGTH ? value : undefined;

/** A renew's challenge (StreamControl.challenge): same bound as a nonce. */
const streamChallenge = subscriptionNonce;

/** What a sealed renew answer says, inside its `stream.alive` envelope. */
interface StreamAlive {
    sessionName: string;
    nonce?: string;
    challenge: string;
    epoch: number;
    seq: number;
}

/**
 * Answer a renew. A sealed stream whose key checked out, asked with a
 * challenge, gets it back sealed with the last frame sent; anything else gets
 * the bare answer, which a sealed viewer does not count as a sign of life.
 * A seal that fails sends nothing — the viewer's silence check says so.
 */
const answerRenew = (
    sessionName: string,
    entry: ActiveStream,
    challenge: string | undefined,
    send: (data: Record<string, unknown>) => void,
): void => {
    const recipient = entry.subscriberPublicKey;
    if (!recipient || !entry.admitted || !challenge) {
        send({ subtype: 'agent.stream.renew.ok', sessionName });
        return;
    }
    const alive: StreamAlive = { sessionName, nonce: entry.nonce, challenge, epoch: entry.epoch, seq: entry.lastSentSeq };
    const { stats } = entry;
    sealV2('stream.alive', JSON.stringify(alive), recipient, sessionName)
        .then((encrypted) => {
            if (activeStreams.get(streamKey(sessionName, entry.deviceId))?.stats !== stats) return;
            send({ subtype: 'agent.stream.renew.ok', sessionName, encrypted });
        })
        .catch((err) => {
            log(`⧉ stream ${sessionName}: could not seal the renew answer (${err instanceof Error ? err.message : err})`);
        });
};

/**
 * Plaintext bytes of a sealed frame's JSON. Sealing base64-expands it by 4/3
 * and the envelope and cleartext fields add about 1KB, so 20KB stays under API
 * Gateway's 32KB WebSocket frame. Tighter than SCREEN_PEEK_MAX_BYTES because
 * JSON escapes a `-e` capture's ESC bytes six-fold (`\u001b`).
 */
export const SEALED_FRAME_MAX_BYTES = 20 * 1024;

/**
 * Trim a sealed frame from the TOP until its JSON fits SEALED_FRAME_MAX_BYTES,
 * as capToFrameLimit does for the capture. The cursor line and the scrollback
 * count both count from the frame's first line, so each drops by the lines cut.
 */
export const fitSealedFrame = (frame: SealedStreamFrame, maxBytes = SEALED_FRAME_MAX_BYTES): SealedStreamFrame => {
    let fitted = frame;
    let size = Buffer.byteLength(JSON.stringify(fitted), 'utf-8');
    while (size > maxBytes && fitted.content.length > 0) {
        const { content } = fitted;
        // Cut about the share that is over, at the next row break: a frame
        // twice the budget is measured twice, not a dozen times, and one just
        // over loses only its top row.
        const cut = content.indexOf('\n', Math.floor(content.length * (1 - maxBytes / size)));
        // No row break past that point: one runaway row. Keep its second half,
        // never splitting a surrogate pair.
        let start = cut === -1 ? Math.ceil(content.length / 2) : cut + 1;
        if (cut === -1 && /[\uDC00-\uDFFF]/.test(content.charAt(start))) start += 1;
        const kept = content.slice(start);
        const removed = content.slice(0, start).split('\n').length - 1;
        const { cursorLine, cursorCol, historyLines, ...rest } = fitted;
        const line = cursorLine === undefined ? undefined : cursorLine - removed;
        fitted = {
            ...rest,
            content: kept,
            truncated: true,
            ...(line !== undefined && line >= 0 && cursorCol !== undefined ? { cursorLine: line, cursorCol } : {}),
            ...(historyLines === undefined ? {} : { historyLines: Math.max(0, historyLines - removed) }),
        };
        size = Buffer.byteLength(JSON.stringify(fitted), 'utf-8');
    }
    return fitted;
};

/** Wire shape of a live-mirror error frame — same subtype, no pane data.
 *  `input_rejected` refuses an ephemeral `agent.command.input`; it rides this
 *  frame so a viewer already handling stream errors can fall back to the REST
 *  push path without a second error channel. */
export type StreamErrorFrame = {
    subtype: 'agent.stream.frame';
    sessionName: string;
    error: 'unknown_session' | 'e2ee_unavailable' | 'encrypt_failed' | 'stream_limit' | 'stream_gone' | 'input_rejected' | RefusalCode;
    /** `input_rejected` only: the refused message's ordering stamp echoed back.
     *  A sender with several keystrokes in flight can't tell which one was
     *  refused without it. Absent when the message carried no usable stamp. */
    seq?: number;
    epoch?: number;
    /** `input_rejected` only: the refused sender's deviceId, echoed so a second
     *  device whose (seq, epoch) happens to collide doesn't claim the refusal
     *  and fire a REST resend for an input that was never refused. */
    inputDeviceId?: string;
    /** `input_rejected` only, and only when one of this listener's checks refused
     *  the input (command-refusal.ts codes). Absent when the lease was simply
     *  gone or the message never got that far. A sealed sender never falls back to
     *  REST, so this is the only place it hears why. */
    reason?: CommandRefusal;
};

/**
 * Per-listener concurrency guard, as a pure predicate so the boundary is
 * unit-testable without touching the module-scope `activeStreams` map.
 */
export const isStreamCapReached = (activeCount: number): boolean =>
    activeCount >= MAX_CONCURRENT_STREAMS;

/**
 * At the cap, hand the slot to the new subscriber when the stalest holder
 * can't prove it's still watching — a renew gone stale (STREAM_RENEW_FRESH_MS),
 * an expired lease, or a client too old to renew at all (those hold a slot for
 * STREAM_MAX_MS on nothing but hope, and a cached web build can keep producing
 * them long after a deploy). Three actively-renewing viewers are all real, so
 * that case still refuses.
 * Returns the evicted session name, or null when every holder is live.
 */
const evictStalestStream = (now: number): string | null => {
    // A session is a slot however many devices watch it: provably watched if any viewer is, and as
    // stale as its freshest lease.
    const bySession = new Map<string, { watched: boolean; expiresAt: number }>();
    for (const entry of activeStreams.values()) {
        const seen = bySession.get(entry.sessionName) ?? { watched: false, expiresAt: 0 };
        if (entry.renewing && now - entry.renewedAt < STREAM_RENEW_FRESH_MS) seen.watched = true; // provably watched
        seen.expiresAt = Math.max(seen.expiresAt, entry.expiresAt);
        bySession.set(entry.sessionName, seen);
    }
    let victim: { name: string; expiresAt: number } | null = null;
    for (const [name, seen] of bySession) {
        if (seen.watched) continue;
        if (!victim || seen.expiresAt < victim.expiresAt) victim = { name, expiresAt: seen.expiresAt };
    }
    if (!victim) return null;
    log(`⧉ stream ${victim.name}: evicted — slot handed to a newer subscriber (no fresh renew)`);
    stopStream(victim.name);
    return victim.name;
};

const streamErrorFrame = (
    sessionName: string,
    error: StreamErrorFrame['error'],
    /** The message being refused, when there is one to echo. */
    echo?: { seq?: unknown; epoch?: unknown; deviceId?: unknown },
    reason?: CommandRefusal,
): StreamErrorFrame => {
    const frame: StreamErrorFrame = { subtype: 'agent.stream.frame', sessionName, error };
    if (reason) frame.reason = reason;
    // A malformed message may carry no stamp at all, or garbage — omitting the
    // field beats echoing something the sender can't match.
    if (isSeqNumber(echo?.seq)) frame.seq = echo.seq;
    if (isSeqNumber(echo?.epoch)) frame.epoch = echo.epoch;
    if (typeof echo?.deviceId === 'string' && echo.deviceId) frame.inputDeviceId = echo.deviceId;
    return frame;
};

/**
 * Build the wire payload for one stream frame. With a subscriber public key
 * the pane content rides ONLY inside the E2EE envelope; an encrypt failure
 * (bad key, crypto not ready on the first tick) returns null so the caller
 * drops the frame — an encrypted stream never leaks a plaintext frame.
 */
export const buildStreamFrame = async (
    captured: { content: string; truncated: boolean },
    sessionName: string,
    subscriberPublicKey?: string,
    meta?: {
        cursor?: { line: number; col: number } | null;
        historyLines?: number;
        historySize?: number;
    },
    /** Capture stamp and subscription nonce, sealed with the pane. A sealed
     *  frame without it is dropped: the viewer could not check it. */
    stamp?: { seq: number; epoch: number; nonce?: string },
): Promise<StreamFramePayload | null> => {
    const cursor = meta?.cursor;
    const view = {
        truncated: captured.truncated,
        ...(cursor ? { cursorLine: cursor.line, cursorCol: cursor.col } : {}),
        ...(meta?.historyLines === undefined ? {} : { historyLines: meta.historyLines }),
        ...(meta?.historySize === undefined ? {} : { historySize: meta.historySize }),
    };
    const head = { subtype: 'agent.stream.frame' as const, sessionName, capturedAt: new Date().toISOString() };
    if (!subscriberPublicKey) return { ...head, ...view, content: captured.content };
    if (!stamp) {
        log(`⧉ stream ${sessionName}: sealed frame without a stamp — frame dropped`);
        return null;
    }
    const sealed = fitSealedFrame({
        sessionName,
        seq: stamp.seq,
        epoch: stamp.epoch,
        ...(stamp.nonce ? { nonce: stamp.nonce } : {}),
        content: captured.content,
        ...view,
    });
    // The cleartext copies follow the fitted frame, so both say the same.
    const { content: _content, nonce: _nonce, ...cleartext } = sealed;
    try {
        const encrypted = await sealV2('stream.frame', JSON.stringify(sealed), subscriberPublicKey, sessionName);
        return { ...head, ...cleartext, encrypted };
    } catch (err) {
        log(`⧉ stream ${sessionName}: frame encrypt failed (${err instanceof Error ? err.message : err}) — frame dropped`);
        return null;
    }
};

/**
 * Handle agent.stream.start / agent.stream.stop. Returns true when the message
 * was a stream-control message (so the caller skips the one-shot screen-peek
 * path). start is idempotent — a repeat restarts the loop.
 */
// deep: over the body-length limit on purpose. Everything past the guards is
// one capture loop whose state (lastContent, wireSeq, encryptFailures, budget,
// and `stats` as the incarnation token) is only correct while it stays private
// to a single start. Hoisting it into a factory would turn those five into
// parameters and expose the incarnation invariant — the one that keeps an
// orphaned chain from capturing forever — to callers that have no reason to
// know it exists. Nothing outside needs the internals; deleting this deletes
// the live mirror whole.
export const handleStreamControl = (
    req: StreamControl,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.stream.start' && req.subtype !== 'agent.stream.stop' && req.subtype !== 'agent.stream.renew') {
        return false;
    }
    // Every stream-control message names one machine, and the relay fans them
    // out to all of this user's connections — so decide addressing once, here.
    // Two machines can run the same tmux session name, and stop/renew carry no
    // other identity: without this gate a stop meant for one listener would
    // reach into the other's stream of that name (and a renew would refresh it).
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;
    if (req.subtype === 'agent.stream.stop') {
        // That viewer's stream only: the others watching the session go on.
        if (req.sessionName) {
            const target = streamFor(req.sessionName, req.deviceId);
            if (target) stopStreamOf(req.sessionName, target.deviceId);
            else if (!hasStream(req.sessionName)) paneFitter.release(req.sessionName);
        }
        return true;
    }
    // Everything this device is told about its own stream carries its id, so the relay delivers it to
    // that viewer and not to every device watching the session. A viewer with no id is told as before.
    const sendTo = (data: Record<string, unknown>): void =>
        send(typeof req.deviceId === 'string' && req.deviceId ? { ...data, targetDeviceId: req.deviceId } : data);
    // Lease renewal — the subscriber is still watching.
    if (req.subtype === 'agent.stream.renew') {
        if (!req.sessionName) return true;
        const entry = streamFor(req.sessionName, req.deviceId);
        if (entry) {
            entry.renewedAt = Date.now();
            entry.expiresAt = entry.renewedAt + leaseFor(entry.renewing);
            // Answer it. The renew used to succeed in silence, which left the
            // viewer with no way to tell a healthy quiet stream from a dead
            // one: the capture loop drops unchanged frames, so an agent that
            // stops to think and a daemon that stopped existing both produce
            // exactly nothing. This reply is the difference — it says the
            // daemon is here and still holds this lease, whatever the pane is
            // or is not doing.
            //
            // A plain stream gets a bare answer: no pane content rides on it.
            // A sealed stream's viewer cannot take a bare one, since the relay
            // could make it up to cover frames it drops — so when the renew
            // carries a challenge, the answer comes back sealed with it and
            // with the last frame sent (answerRenew).
            answerRenew(req.sessionName, entry, streamChallenge(req.challenge), sendTo);
            // After the answer: the viewer may have rotated, and a client may
            // have attached since the last renew.
            // With other viewers on the session, only a width this viewer just CHANGED counts: an app
            // re-sends its `cols` on every renew, and two viewers of different widths would otherwise
            // flip the pane between them every few seconds. A lone viewer re-fits each renew as before.
            const colsChanged = req.cols !== entry.cols;
            entry.cols = req.cols;
            const renewTarget = tmuxTargetFor(req.sessionName);
            if (renewTarget !== null && (colsChanged || streamsOf(req.sessionName).length === 1)) paneFitter.fit(req.sessionName, renewTarget, req.cols);
            return true;
        }
        // Addressed to us but we hold no such stream: it was reaped (lost
        // renews), evicted, or dropped when our socket last reconnected. The
        // viewer has no other way to learn that — it just keeps painting a
        // frozen pane under a LIVE badge — so tell it to re-subscribe. Renew
        // carries no subscriber key, so restarting it here would silently
        // downgrade an E2EE stream to plaintext; only the client can redo the
        // handshake.
        sendTo(streamErrorFrame(req.sessionName, 'stream_gone'));
        return true;
    }
    const sessionName = req.sessionName;
    if (!sessionName) return true;
    if (!isInventoried(sessionName)) {
        send(streamErrorFrame(sessionName, 'unknown_session'));
        return true;
    }
    // A listener that has sealed streams only sealed: a start without a key is
    // the shape a key-stripping relay produces. Refused before the restart
    // below, so it cannot end the phone's sealed stream of the same session.
    const plainRefused = asksForSeal(req) ? null : plainRefusal();
    if (plainRefused) {
        log(`⧉ stream ${sessionName}: refused a start without a key — this listener only seals`);
        sendTo(streamErrorFrame(sessionName, plainRefused));
        return true;
    }
    const key = streamKey(sessionName, req.deviceId);
    stopStreamOf(sessionName, req.deviceId, { keepFit: true }); // idempotent restart (frees this viewer's slot first)
    // Concurrency guard AFTER the restart-stop: re-subscribing to an already
    // active session — or a second device joining one — doesn't count against
    // the cap, only a genuinely new session does. Refuse the new stream instead
    // of adding to the shared-throttle load.
    if (!hasStream(sessionName) && isStreamCapReached(mirroredSessionCount()) && !evictStalestStream(Date.now())) {
        log(`⧉ stream ${sessionName}: refused — ${mirroredSessionCount()}/${MAX_CONCURRENT_STREAMS} streams already active on this listener`);
        sendTo(streamErrorFrame(sessionName, 'stream_limit'));
        paneFitter.release(sessionName);
        return true;
    }
    const fitTarget = tmuxTargetFor(sessionName);
    if (fitTarget !== null) paneFitter.fit(sessionName, fitTarget, req.cols);
    let lastContent: string | null = null;
    // The cursor's last reported place, as `line,col`. Part of the diff-gate
    // because moving the cursor is a change the CAPTURE cannot show: an arrow
    // key inside a prompt leaves every character where it was, so gating on the
    // text alone means the mirror's cursor never moves — which is precisely the
    // feedback the cursor exists to give.
    let lastCursor: string | null = null;
    const stats: StreamStats = {
        startedAt: Date.now(),
        frames: 0,
        bytes: 0,
        framesBurst: 0,
        bytesBurst: 0,
        burstMs: 0,
        skipped: 0,
        rateCapped: 0,
        lastLogAt: Date.now(),
        lastLogFrames: 0,
        lastLogBytes: 0,
        lastLogFramesBurst: 0,
        lastLogBurstMs: 0,
    };
    // E2EE handshake: load-or-create this device's keypair up front. The
    // subscriber asked for encryption, so key failure is FAIL-CLOSED: refuse
    // to stream rather than downgrade to plaintext — a silent downgrade is
    // exactly the signal a key-stripping relay would produce. The phone sees
    // the error frame and can choose to re-subscribe without a key.
    const subscriberPublicKey = req.subscriberPublicKey;
    const nonce = subscriptionNonce(req.subscriberNonce);
    if (subscriberPublicKey) {
        // The key on the request is the relay's word. Frames wait until it is
        // the key the account registered for that device and the one pinned
        // for it; anything else ends the stream with the reason, and never
        // with plaintext.
        // Stopped or replaced meanwhile: the answer belongs to the old incarnation.
        const current = (): ActiveStream | undefined => {
            const entry = activeStreams.get(key);
            return entry?.stats === stats ? entry : undefined;
        };
        whenSealAdmitted(
            req,
            (publicKey) => {
                const entry = current();
                if (!entry) return;
                entry.admitted = true;
                // The sealed start answer: this listener seals v2 for this
                // subscription. A viewer that sees it (or a v2 frame) records
                // the version and takes no older envelope from this machine.
                const started = { sessionName, ...(nonce ? { nonce } : {}), epoch: stats.startedAt, v: 2 };
                // After this device's key is loaded: the admission can answer first.
                initDeviceCrypto()
                    .then(() => sealV2('stream.started', JSON.stringify(started), publicKey, sessionName))
                    .then((encrypted) => {
                        if (current()) sendTo({ subtype: 'agent.stream.start.ok', sessionName, sealVersion: 2, encrypted });
                    })
                    .catch((err) => log(`⧉ stream ${sessionName}: could not seal the start answer (${err instanceof Error ? err.message : err})`));
            },
            (reason) => {
                if (!current()) return;
                sendTo(streamErrorFrame(sessionName, reason));
                stopStreamOf(sessionName, req.deviceId);
            },
        );
        initDeviceCrypto().catch((err) => {
            // Stream stopped or replaced while init was in flight — the
            // failure belongs to the old incarnation, not the current one.
            if (activeStreams.get(key)?.stats !== stats) return;
            log(`⧉ stream ${sessionName}: device crypto init failed (${err instanceof Error ? err.message : err}) — refusing to stream (fail-closed)`);
            sendTo(streamErrorFrame(sessionName, 'e2ee_unavailable'));
            stopStreamOf(sessionName, req.deviceId);
        });
    }
    let wireSeq = 0;
    let encryptFailures = 0;
    const budget: FrameBudget = { windowStartedAt: Date.now(), sent: 0 };
    /**
     * One capture. Returns false only when the stream is gone and the chain
     * must NOT re-arm — every other outcome re-arms at the single call site in
     * runTick, so no early return can silently freeze the mirror.
     */
    const captureTick = (entry: ActiveStream): boolean => {
        // Lease check rides the capture tick: one deadline field, no second
        // timer to leak. (The previous per-start expiry setTimeout was never
        // cleared on stop, so a restart left the old one armed to kill the new
        // incarnation.) Reaping here is what frees the slot for everyone whose
        // stop never arrived.
        if (Date.now() >= entry.expiresAt) {
            stopStreamOf(sessionName, req.deviceId);
            return false;
        }
        // Nothing is read off the pane for a subscriber still being checked.
        if (!entry.admitted) return true;
        // A plain stream started before this listener first sealed ends here:
        // renewing, it would go on reading the pane in the clear for whoever
        // opened it — the relay, in the window before the first seal.
        const plainRefused = entry.subscriberPublicKey ? null : plainRefusal();
        if (plainRefused) {
            log(`⧉ stream ${sessionName}: ended a plaintext stream — this listener only seals now`);
            sendTo(streamErrorFrame(sessionName, plainRefused));
            stopStreamOf(sessionName, req.deviceId);
            return false;
        }
        // capturePane is a blocking tmux spawn. Asking the budget first means a
        // second that is already full costs nothing rather than paying for a
        // capture whose frame could not go out — a peek, not a claim, so a tick
        // the diff-gate goes on to skip does not spend the token.
        if (!hasFrameBudget(budget, Date.now())) {
            stats.skipped++;
            stats.rateCapped++;
            return true;
        }
        // Cursor read per tick, not per sent frame: the gate below has to know
        // whether the cursor moved, and by the time a frame is being built the
        // tick that would have carried the move has already been skipped. It
        // rides in the capture's own tmux spawn.
        const read = captureStreamPane(sessionName);
        if (!read) {
            stats.skipped++;
            return true;
        }
        const { captured, geometry: cursorAt } = read;
        const cursor = cursorAt ? cursorLineFor(captured.content, cursorAt) : null;
        // Same read gives the pane height, which is what separates this frame's
        // scrollback from its visible rows — the offset a history pull starts at —
        // and the pane's total scrollback depth, which places that window in the
        // buffer for a viewer recording the lines that scroll past it.
        const historyLines = cursorAt
            ? historyLinesIn(captured.content, cursorAt.height)
            : undefined;
        const historySize = cursorAt?.historySize;
        const cursorKey = cursor ? `${cursor.line},${cursor.col}` : '';
        if (captured.content === lastContent && cursorKey === lastCursor) {
            stats.skipped++;
            return true; // diff-gate
        }
        const now = Date.now();
        // Send budget BEFORE the diff-gate is marked: a frame refused here has
        // to stay "changed" so a later tick retries it, or this content is
        // never sent at all — the next tick would diff-skip it as unchanged.
        if (!claimFrameSend(budget, now)) {
            stats.skipped++;
            stats.rateCapped++;
            return true;
        }
        // Phase = the gap that PRODUCED this tick (armedDelay), matching how
        // burstMs is charged in arm() — deciding by wall-clock here instead
        // made the last burst-armed frame count idle, under-reporting burst
        // fps by one frame per episode in the R2 numbers.
        const inBurst = armedDelay === BURST_INTERVAL_MS;
        lastContent = captured.content;
        lastCursor = cursorKey;
        // Stamp the sequence in CAPTURE order, synchronously — frame assembly
        // is async (encryption) and fire-and-forget, so resolve order is not
        // guaranteed under load; the receiver drops any seq it has already
        // painted past.
        const seq = ++wireSeq;
        const stamp = { seq, epoch: stats.startedAt, nonce };
        void buildStreamFrame(captured, sessionName, subscriberPublicKey, { cursor, historyLines, historySize }, stamp).then((frame) => {
            // Stream stopped or restarted while this frame was in flight —
            // `stats` is unique per start, so it doubles as the identity
            // token. Don't send into a dead/replaced stream or skew its stats.
            if (activeStreams.get(key)?.stats !== stats) return;
            if (!frame) {
                // Encrypt failure — frame dropped, diff-gate un-marked so the
                // next tick retries. A key that keeps failing (malformed
                // subscriber key) never recovers: fail closed after a few
                // strikes instead of retrying every tick for 5 minutes.
                lastContent = null;
                lastCursor = null;
                // Init still in flight (or failed — its own path fail-closes):
                // a not-yet-ready key is not a malformed key, don't strike.
                if (getDevicePublicKey() === null) return;
                encryptFailures++;
                if (encryptFailures >= STREAM_MAX_ENCRYPT_FAILURES) {
                    sendTo(streamErrorFrame(sessionName, 'encrypt_failed'));
                    stopStreamOf(sessionName, req.deviceId);
                }
                return;
            }
            encryptFailures = 0;
            stats.frames++;
            // Measure the actual wire payload (the encrypted envelope is
            // ~1.4× the plaintext; base fields now count too, so plaintext
            // streams read slightly higher than the pre-E2EE content-only
            // metric) — this feeds the R2 cost instrumentation.
            const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf-8');
            stats.bytes += bytes;
            if (inBurst) {
                stats.framesBurst++;
                stats.bytesBurst += bytes;
            }
            const live = activeStreams.get(key);
            if (live) live.lastSentSeq = Math.max(live.lastSentSeq, stamp.seq);
            // seq = capture order; epoch = this stream incarnation, so the
            // receiver's ordering guard resets across daemon-side restarts.
            sendTo({ ...frame, seq: stamp.seq, epoch: stamp.epoch });
            maybeLogStreamStats(sessionName, stats);
        }).catch((err) => {
            // A long-lived daemon must never crash on an unhandled rejection
            // from sendTo()/logging — report and let the next tick carry on.
            log(`⧉ stream ${sessionName}: frame send failed (${err instanceof Error ? err.message : err})`);
        });
        return true;
    };
    /** Arm the next tick. A chain that outlived its incarnation (restart, or a
     *  stop racing this tick) must die here instead of capturing forever into
     *  a stream nobody can cancel — `stats` is the incarnation token. */
    let armedDelay = STREAM_INTERVAL_MS;
    const arm = (delay: number): void => {
        const entry = activeStreams.get(key);
        if (entry?.stats !== stats) return;
        if (delay === BURST_INTERVAL_MS) stats.burstMs += delay;
        armedDelay = delay;
        const next = setTimeout(runTick, delay);
        next.unref?.();
        entry.timer = next;
        entry.nextFireAt = Date.now() + delay;
    };
    const runTick = (): void => {
        const entry = activeStreams.get(key);
        if (entry?.stats !== stats) return;
        if (!captureTick(entry)) return;
        // The cadence is re-read every tick, so input that lands mid-stream
        // tightens the NEXT gap rather than the current one.
        arm(streamCadence(entry.lastInputAt, Date.now()));
    };
    /** Swap an idle-armed tick for an immediate burst tick (see ActiveStream.wake).
     *  Only when the armed gap is the idle one: replacing an armed burst tick
     *  on every keystroke would push the next capture away indefinitely. */
    const wake = (): void => {
        const entry = activeStreams.get(key);
        if (entry?.stats !== stats) return;
        if (armedDelay === BURST_INTERVAL_MS) return;
        clearTimeout(entry.timer);
        arm(BURST_INTERVAL_MS);
    };
    // A viewer joining a session that is already mirrored fires its first tick just after the sibling's
    // next one, so both read the one capture that tick takes (`captureStreamPane`) — and, with the same
    // cadence from then on, they stay in step.
    const sibling = streamsOf(sessionName)[0];
    const firstDelay = sibling ? Math.max(sibling.nextFireAt - Date.now(), 0) + STREAM_SHARE_LAG_MS : STREAM_INTERVAL_MS;
    const timer = setTimeout(runTick, firstDelay);
    timer.unref?.();
    // A renewing subscriber gets the short lease; anything older keeps the
    // 5-minute orphan guard so a version-skewed client isn't cut off mid-view.
    const renewing = !!req.renew;
    activeStreams.set(key, {
        sessionName,
        deviceId: typeof req.deviceId === 'string' && req.deviceId ? req.deviceId : undefined,
        nextFireAt: Date.now() + firstDelay,
        cols: req.cols,
        timer,
        stats,
        lastInputAt: null,
        inputDecryptFailures: 0,
        expiresAt: Date.now() + leaseFor(renewing),
        renewing,
        renewedAt: Date.now(),
        subscriberPublicKey,
        subscriberDeviceId: subscriberPublicKey ? req.deviceId : undefined,
        nonce,
        epoch: stats.startedAt,
        lastSentSeq: 0,
        admitted: !subscriberPublicKey,
        wake,
    });
    if (!subscriberPublicKey) sendTo({ subtype: 'agent.stream.start.ok', sessionName, sealVersion: 2 });
    return true;
};

// ─── Ephemeral key input (agent.command.input) ───────────────────────
// Same end result as an `agent.command` push — keys or text into a tmux pane
// — but carried on the ephemeral relay instead of REST, which is one
// persisted hop shorter. Latency is the only reason it exists, so it must not
// buy that with a weaker posture: the tmux-side guards are the SAME code as
// the REST path (passesInjectGuards → shell-pane refusal + the one per-session
// token bucket, ALLOWED_KEYS via resolveKeys). A private counter here would
// double the effective 30/min cap.

/** Wire shape of one inbound injection. Every field is optional, and none of
 *  them is proven: this shape is an unchecked cast over relay JSON, so
 *  validateInputMessage re-checks the types it acts on rather than trusting
 *  the declaration. */
export interface AgentCommandInput {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /** Which device's seq/epoch run this is. Current relays stamp it from the
     *  sending connection unconditionally; relays older than that overwrite
     *  only a missing value, so a sender there can claim another device's id.
     *  Treat it as an ordering namespace, never as authentication — the worst
     *  a forged id buys is a different reorder lane for its own keystrokes. */
    deviceId?: string;
    /** Named keys, ALLOWED_KEYS-validated. Mutually exclusive with `body`/`insert`. */
    keys?: string[];
    /** Literal text; the injector appends the Enter, as on the REST path. */
    body?: string;
    /**
     * Literal text delivered WITHOUT the submitting Enter — the phone
     * answering a y/n prompt, or typing half a command so a TUI menu opens.
     *
     * A separate field rather than a `submit: false` flag on `body`, and that
     * is the whole point: a daemon too old to know this field sees no `body`
     * either, so it injects nothing. The flag spelling would have had the old
     * daemon submit text the user never meant to send.
     */
    insert?: string;
    /** Sender's monotonic counter, and the incarnation it counts within. */
    seq?: number;
    epoch?: number;
    /** Type this only while the pane still shows the blocked prompt with this
     *  id (`blockedPrompt.id` in the session report); otherwise refuse with
     *  `prompt_changed`. A sealed message reads it from inside the envelope: this
     *  plaintext field is not looked at beside one. */
    ifPrompt?: string;
    /** E2EE envelope sealing `{ keys | body }` plus a copy of the
     *  `sessionName`/`seq`/`epoch` stamp as JSON — the only way in on an
     *  encrypted stream, where `keys`/`body` above are refused. Present means
     *  the plaintext pair is ignored entirely: on a message the relay can
     *  append to, only the ciphertext decides what gets typed, and the sealed
     *  stamp is what proves the plaintext one was not re-written for a replay. */
    encrypted?: unknown;
}

/** Parity with the REST path, which refuses more than MAX_KEYS_PER_COMMAND per
 *  agent.command (hwip apps/server/src/functions/pushes.ts). The lower-latency
 *  door into the same pane must not also be the wider one. */
export const MAX_INPUT_KEYS = 10;
/** The REST path caps no body length, so this bound is ours alone: an
 *  unbounded body is one tmux send-keys argv of unbounded size, and what it
 *  lands in is an agent prompt, not a paste buffer. */
export const MAX_INPUT_BODY_CHARS = 4096;

/** The relay socket a message arrived on, and the only way back to its sender. */
type SendEphemeral = (data: Record<string, unknown>) => void;

/** One validated injection. */
type ValidatedInput = SequencedInput & {
    sessionName: string;
    /** The blocked prompt this input answers; checked against a fresh capture at delivery. */
    ifPrompt?: string;
    /** Sender's device, when the relay stamped one — rides along so a refusal
     *  frame can name whose input was refused (inputDeviceId). */
    deviceId?: string;
    /** Exactly one of these is set. */
    tokens: string[] | null;
    text: string | null;
    /** Whether `text` carries its own submit. False for `insert` (and, vacuously,
     *  for a key batch — the keys say for themselves what they are). */
    submit: boolean;
};

/** A validated injection queued for delivery in seq order, carrying the socket
 *  it arrived on: the reorder hold outlives the call that accepted it, and a
 *  refusal at delivery time still has to reach the sender that is waiting. */
type PendingInput = ValidatedInput & { send: SendEphemeral };

type InputCheck = { ok: true; input: ValidatedInput } | { ok: false; reason: string };

// Both fields are relay JSON, so both are attacker-shaped. Number.isFinite
// admits 1e21 — which parks the high-water mark past anything a sender can
// count back to — and 1.5, which no later integer can ever equal, so every
// following key would sit out the hold before being typed out of order.
const isSeqNumber = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// A malformed `keys` would throw where it is consumed (resolveKeys iterates
// it, tmux args must be strings), and a throw inside the WebSocket message
// handler takes the whole daemon down. Type-check before acting.
const isKeyList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string');

/** The decrypted payload, under the same stance as the outer message: an
 *  unchecked cast that validateInputMessage re-checks field by field. Only the
 *  envelope's authenticity is proven at this point, never its contents —
 *  a subscriber can seal anything, including 400 keys. */
type SealedInputPayload = Pick<AgentCommandInput, 'keys' | 'body' | 'insert' | 'ifPrompt' | 'seq' | 'epoch' | 'sessionName'> & {
    /** The stream epoch this listener sealed to the phone (frames, start answer). */
    streamEpoch?: unknown;
    /** The phone's own device id. */
    deviceId?: unknown;
};

const parseSealedInput = (
    json: string,
): SealedInputPayload | null => {
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return parsed as SealedInputPayload;
    } catch {
        return null;
    }
};

/**
 * Parse and whitelist an inbound input message. Pure — the lease gate and the
 * tmux-side guards stay in the caller, so this is testable on its own.
 */
export const validateInputMessage = (msg: AgentCommandInput): InputCheck => {
    const { sessionName, seq, epoch } = msg;
    if (typeof sessionName !== 'string' || !sessionName) return { ok: false, reason: 'no sessionName' };
    // This function reads plaintext `keys`/`body` and nothing else, so it must
    // never see a message that still carries an envelope: the encrypted path
    // opens one and hands the decrypted fields back through here with the
    // envelope stripped. A message arriving with both would otherwise get the
    // plaintext half injected while its sender believed the sealed half was
    // what landed. Fail closed instead.
    if (msg.encrypted !== undefined) return { ok: false, reason: 'envelope reached the plaintext validator' };
    if (!isSeqNumber(seq) || !isSeqNumber(epoch)) return { ok: false, reason: 'missing seq/epoch' };
    const base: Pick<ValidatedInput, 'sessionName' | 'seq' | 'epoch' | 'deviceId' | 'ifPrompt'> = {
        sessionName,
        seq,
        epoch,
        ...(typeof msg.deviceId === 'string' && msg.deviceId ? { deviceId: msg.deviceId } : {}),
    };
    // A bound input that cannot say which prompt it is bound to must not type: dropping the
    // field would turn "only for this prompt" into "whatever is on screen".
    if (msg.ifPrompt !== undefined) {
        if (!isPromptId(msg.ifPrompt)) return { ok: false, reason: 'malformed ifPrompt' };
        base.ifPrompt = msg.ifPrompt;
    }
    if (msg.keys !== undefined) {
        if (!isKeyList(msg.keys)) return { ok: false, reason: 'malformed keys' };
        if (msg.keys.length > MAX_INPUT_KEYS) return { ok: false, reason: `too many keys (${msg.keys.length})` };
        if (msg.body !== undefined || msg.insert !== undefined) {
            return { ok: false, reason: 'keys are mutually exclusive with body/insert' };
        }
        const tokens = resolveKeys(msg.keys);
        if (!tokens) return { ok: false, reason: `unknown key(s) [${msg.keys.join(' ')}]` };
        return { ok: true, input: { ...base, tokens, text: null, submit: false } };
    }
    // Submitting and not-submitting the same text are opposite instructions,
    // so a message carrying both means nothing — refuse rather than pick one.
    if (msg.insert !== undefined) {
        if (msg.body !== undefined) return { ok: false, reason: 'insert and body are mutually exclusive' };
        if (typeof msg.insert !== 'string' || !msg.insert) return { ok: false, reason: 'empty input' };
        if (msg.insert.length > MAX_INPUT_BODY_CHARS) return { ok: false, reason: `insert too long (${msg.insert.length})` };
        return { ok: true, input: { ...base, tokens: null, text: msg.insert, submit: false } };
    }
    if (typeof msg.body !== 'string' || !msg.body) return { ok: false, reason: 'empty input' };
    if (msg.body.length > MAX_INPUT_BODY_CHARS) return { ok: false, reason: `body too long (${msg.body.length})` };
    return { ok: true, input: { ...base, tokens: null, text: msg.body, submit: true } };
};

/**
 * Type one ordered message into the pane. Unlike the REST key path this
 * schedules no follow-up snapshot: the message only got this far because a
 * live stream is already repainting the pane at frame rate.
 */
const deliverInput = (input: PendingInput): void => {
    // The reorder hold can outlive the lease that admitted the message.
    let reason: CommandRefusal | undefined;
    const deps: HandlePushDeps = { noteRefusal: (r) => { reason ??= r; } };
    // Before anything is spent on it: a key bound to a prompt that is gone must not
    // take a rate-limit token, and must not land on whatever is on screen now.
    const bound = input.ifPrompt === undefined || promptStillShown(input.ifPrompt, capturePaneText(input.sessionName, undefined, true));
    if (!bound) reason = 'prompt_changed';
    const injected = bound && hasStream(input.sessionName)
        // Stream input arrives on this listener's own subscription: addressed.
        && (input.tokens
            ? tryInjectKeys(input.sessionName, input.tokens, deps, true)
            : tryInject(input.sessionName, input.text ?? '', deps, { submit: input.submit, addressed: true }));
    // Every refusal reachable from here — dead lease, shell pane, rate limit,
    // a failed send-keys — used to be silent, which contradicts the contract
    // above: the sender would keep waiting on a keystroke that never lands
    // instead of falling back to the REST push path.
    // Only a reason that does not depend on the text: this input may be sealed.
    if (!injected) input.send(streamErrorFrame(input.sessionName, 'input_rejected', input, reason && isSessionStateRefusal(reason) ? reason : undefined));
};

/** Ceiling on concurrent sender lanes. The lane key includes a relay-stamped
 *  deviceId, but a relay older than the unconditional stamp lets a sender vary
 *  it per message — without a cap that grows the map for the lease's whole
 *  life. Real senders are one per device; 16 is generous. */
export const MAX_INPUT_LANES = 16;

const inputSequencerFor = (key: string): InputSequencer<PendingInput> | null => {
    const existing = inputSequencers.get(key);
    if (existing) return existing;
    if (inputSequencers.size >= MAX_INPUT_LANES) return null;
    const created = createInputSequencer<PendingInput>(deliverInput, {
        // Held keys swept out by an epoch change or stream stop are keystrokes
        // their sender still waits on — refuse them so it can fall back.
        onDiscard: (input) => input.send(streamErrorFrame(input.sessionName, 'input_rejected', input)),
    });
    inputSequencers.set(key, created);
    return created;
};

/** Hand a validated injection to its sender's ordering lane. Shared by both
 *  inbound paths — plaintext and decrypted input order against each other. */
const enqueueInput = (input: ValidatedInput, send: SendEphemeral): void => {
    // One ordering run per sender, not per session: two devices typing into
    // the same pane each carry their own seq/epoch, and a shared sequencer
    // would let the higher epoch supersede the other and silence it.
    const senderKey = input.deviceId ? `${input.sessionName}#${input.deviceId}` : input.sessionName;
    const sequencer = inputSequencerFor(senderKey);
    if (!sequencer) return refuseInput(input, send, 'sender lane cap reached');
    const accepted = sequencer.accept({ ...input, send });
    if (accepted !== 'ok') {
        // overflow / superseded / stale — the message was dropped, and the
        // sender must hear so instead of waiting on a keystroke that never
        // lands (the sequencer reports swept HELD messages via onDiscard).
        refuseInput(input, send, accepted);
    }
};

/**
 * Tail of the encrypted-input decrypt chain.
 *
 * Encrypted inputs are opened one at a time rather than concurrently. That
 * bounds the ECDH work one socket can have in flight, and it keeps arrival
 * order into the sequencer — two keystrokes whose decrypts race would
 * otherwise reach it in whichever order WebCrypto finished, turning an
 * in-order pair into a gap and a 500 ms hold.
 */
let inputDecryptChain: Promise<void> = Promise.resolve();
let inputDecryptDepth = 0;

/** Ceiling on queued decrypts. The subscriber-key binding is a string compare
 *  against a public key the relay fanned out to every same-account connection,
 *  so it gates WHO can enqueue an ECDH derive, not how many — a flooding
 *  client would otherwise grow the chain without bound. Mirrors
 *  MAX_PENDING_INPUTS' role on the plaintext side. */
export const MAX_PENDING_DECRYPTS = 32;

/** Resolves once every encrypted input accepted so far has been routed. */
export const pendingInputDecrypts = (): Promise<void> => inputDecryptChain;

/**
 * Open an E2EE input envelope and route what was inside it.
 *
 * Every cheap guard runs synchronously, before any crypto: an envelope from
 * anyone but the subscriber costs a string compare, not an ECDH derive. What
 * comes out of the decrypt is then re-validated by exactly the checks the
 * plaintext path runs — the envelope hides the payload from the relay, never
 * from the whitelist or the caps.
 */
/**
 * Refuse one input message: log why here, tell the sender only THAT it was
 * refused. The reason is derived from plaintext the relay must not learn, so it
 * never rides the frame; a message with no sessionName gets no frame at all,
 * since the sender would have nothing to match it against.
 */
const refuseInput = (msg: AgentCommandInput, send: SendEphemeral, reason: string): void => {
    log(`! input ${msg.sessionName ?? '(no session)'}: ${reason} — drop`);
    if (typeof msg.sessionName === 'string' && msg.sessionName) {
        const frame = streamErrorFrame(msg.sessionName, 'input_rejected', msg);
        // To the device that typed it, not to every viewer of the session.
        send(typeof msg.deviceId === 'string' && msg.deviceId ? { ...frame, targetDeviceId: msg.deviceId } : frame);
    }
};

const handleEncryptedInput = (msg: AgentCommandInput, send: SendEphemeral): void => {
    const { sessionName } = msg;
    const refuse = (reason: string): void => refuseInput(msg, send, reason);
    if (typeof sessionName !== 'string' || !sessionName) return refuse('no sessionName');
    // The viewer's own slot: the key below is that viewer's, and only its input is admitted by it.
    const stream = streamFor(sessionName, msg.deviceId);
    if (!stream) return refuse('encrypted input with no live stream');
    const streamId = streamKey(sessionName, stream.deviceId);
    // A stream that handshook no subscriber key has no key to bind this
    // envelope against — and its own frames go out in the clear, so there is
    // nothing here worth protecting and no way to prove who sent it.
    const { subscriberPublicKey } = stream;
    if (!subscriberPublicKey) return refuse('encrypted input on a plaintext stream');
    // The binding below compares against this key, which is only the
    // subscriber's once it checked out.
    if (!stream.admitted) return refuse('encrypted input before the subscriber key was verified');
    // Envelope v2 only: a v1 one (or anything else) is not this stream's input.
    if (!isSealedV2(msg.encrypted)) return refuse('not a v2 envelope');
    // THE binding. Opening an envelope proves only that its sender holds some
    // private key; it is this comparison that makes it the key the subscriber
    // handshook with, and so makes ephemeral input exclusive to the device
    // actually watching the pane. Without it, anyone who learned this host's
    // public key could type into it.
    const envelope = msg.encrypted;
    if (envelope.senderPublicKey !== subscriberPublicKey) {
        return refuse('envelope not sealed by the stream subscriber');
    }
    // The incarnation this message was admitted under. A stream can stop and
    // restart — with a different subscriber key — while the decrypt is in
    // flight, and the lease check inside deliverInput only asks whether SOME
    // stream of this name exists.
    const incarnation = stream.stats;
    if (inputDecryptDepth >= MAX_PENDING_DECRYPTS) {
        return refuse('decrypt queue full');
    }
    // The binding compares against a public key the relay has seen, so it says
    // who MAY enqueue an ECDH derive, not that they can produce an openable
    // envelope. Sustained garbage would otherwise spend the one shared decrypt
    // chain on every stream at once. Same fail-closed shape as the outbound
    // half (STREAM_MAX_ENCRYPT_FAILURES): after a few consecutive failures this
    // stream takes no more sealed input until it is re-subscribed.
    if (stream.inputDecryptFailures >= STREAM_MAX_ENCRYPT_FAILURES) {
        return refuse('too many failed decrypts on this stream');
    }
    inputDecryptDepth++;
    inputDecryptChain = inputDecryptChain.then(async () => {
        inputDecryptDepth--;
        let opened: string;
        try {
            // The purpose and the session are part of the key: a frame, a
            // snapshot or another stream's input handed back here does not open.
            opened = await openV2('stream.input', envelope, subscriberPublicKey, sessionName);
        } catch (err) {
            // AES-GCM is authenticated, so this is a forged, truncated or
            // misaddressed envelope — never a partially readable one.
            const live = activeStreams.get(streamId);
            if (live?.stats === incarnation) live.inputDecryptFailures++;
            return refuse(`decrypt failed (${err instanceof Error ? err.message : err})`);
        }
        // A real envelope clears the strikes: the cap is there to stop a flood,
        // not to retire a stream that saw one corrupted message.
        const live = activeStreams.get(streamId);
        if (live?.stats !== incarnation) {
            return refuse('stream replaced while decrypting');
        }
        live.inputDecryptFailures = 0;
        const payload = parseSealedInput(opened);
        if (!payload) return refuse('sealed payload is not an input object');
        // Replay binding: the ciphertext must vouch for the plaintext stamps.
        // AES-GCM stops the relay from forging content, but without this check
        // it could replay a captured envelope under a fresh seq and type a
        // real keystroke twice — the relay is exactly the party E2EE distrusts.
        if (payload.seq !== msg.seq || payload.epoch !== msg.epoch || payload.sessionName !== sessionName) {
            return refuse('sealed stamps do not match the plaintext ones (replay?)');
        }
        // Bound to this stream incarnation and this phone: the stream epoch is
        // this listener's (new on every start, sealed to the phone with every
        // frame), and the device is the one whose key was admitted. A captured
        // envelope replayed after a forged restart, or under another device's
        // input lane, does not match either.
        if (payload.streamEpoch !== live.epoch) return refuse('sealed for another start of this stream (replay?)');
        if (payload.deviceId !== live.subscriberDeviceId || msg.deviceId !== payload.deviceId) {
            return refuse('sealed by another device than the one admitted (replay?)');
        }
        const checked = validateInputMessage({
            sessionName,
            seq: msg.seq,
            epoch: msg.epoch,
            deviceId: msg.deviceId,
            keys: payload.keys,
            body: payload.body,
            insert: payload.insert,
            ifPrompt: payload.ifPrompt,
        });
        if (!checked.ok) return refuse(checked.reason);
        enqueueInput(checked.input, send);
    }).catch((err) => {
        // Nothing above should throw outside the decrypt, but one broken link
        // must not stall every keystroke queued behind it.
        log(`! input ${sessionName}: encrypted routing failed (${err instanceof Error ? err.message : err})`);
    });
};

/**
 * Handle agent.command.input. Returns true when the message was ours to
 * answer, so the caller stops routing it. Encrypted messages finish
 * asynchronously — the return value reports routing, not delivery, exactly as
 * it already did for a message the sequencer holds.
 */
export const handleCommandInput = (
    msg: AgentCommandInput,
    send: SendEphemeral,
): boolean => {
    if (msg.subtype !== 'agent.command.input') return false;
    // Addressing gate, as on stream control: the relay fans every ephemeral
    // message out to all of this user's connections, and two machines can run
    // the same tmux session name — an unaddressed inject would type into both.
    if (msg.targetDeviceId !== computeListenerDeviceId()) return false;
    // An envelope decides the message on its own. Branching here rather than
    // inside the validator is what keeps the plaintext `keys`/`body` a relay
    // could staple alongside it out of reach.
    if (msg.encrypted !== undefined) {
        handleEncryptedInput(msg, send);
        return true;
    }
    const checked = validateInputMessage(msg);
    if (!checked.ok) {
        refuseInput(msg, send, checked.reason);
        return true;
    }
    const { input } = checked;
    // Input rides the stream lease: without one, nobody is watching the pane
    // this would type into, and seq/epoch have no incarnation to order
    // against. The sender learns in one hop and falls back to a REST push.
    const streams = streamsOf(input.sessionName);
    if (streams.length === 0) {
        refuseInput(input, send, 'no live stream');
        return true;
    }
    // A stream's outbound half is E2EE for its subscriber, so accepting a
    // plaintext keystroke would leave the inbound leg the only one in clear —
    // and nothing about it proves the subscriber sent it. A session with an
    // encrypted viewer takes sealed input (above) or none, whoever the plaintext
    // claims to come from.
    if (streams.some((stream) => stream.subscriberPublicKey)) {
        refuseInput(input, send, 'stream is E2EE, plaintext input refused');
        return true;
    }
    enqueueInput(input, send);
    return true;
};

export interface CollectResult {
    sessions: AgentSession[];
    /** Diagnostic notes per rejected session — surfaced under `--verbose`. */
    rejected: Array<{ name: string; reason: string }>;
    /** Local knowledge, NOT on the wire: every live session/subagent name →
     *  the pane id every `-t` call for it must use (`tmuxTargetFor`). The main
     *  thread stores it beside the snapshot (`recordTargets`). */
    targets: Record<string, string>;
    /** Also local: in-process subagent name → its transcript file. The sweep may
     *  run on a worker, so a map built there has to travel back like `targets`
     *  rather than live in module state the main thread cannot see. */
    subagentTranscripts: Record<string, string>;
    /** Also local, for the always-on recorder (`turn-recorder.ts`): main session
     *  name → the transcript it writes and the agent kind whose projector reads
     *  it. Only sessions this machine can actually read; no subagent rows. */
    recordable: Record<string, RecordableSession>;
}

/**
 * Per-session subagent scan state, held across sweeps so a chip keeps the
 * number and label it was first given (`subagent-transcripts.ts`). Lives on
 * whichever thread runs the sweep; a worker restart renumbers, which costs a
 * viewer nothing but a re-render.
 */
const subagentScans = new Map<string, SubagentScanState>();

/**
 * Inventory pass that also records *why* each `hwip-*` session was
 * skipped. The verbose log uses the rejection notes to explain empty
 * pickers (most common cause: tmux pane lost its start_command after a
 * re-attach, and the current command is `node` rather than `claude`).
 */
export const collectSessionsVerbose = (): CollectResult => {
    // One read budget for every session's subagent transcripts in this sweep.
    const subagentCatchUp = { bytes: SUBAGENT_CATCH_UP_BYTES };
    // One sweep for the whole server: every pane of every session, so a
    // session's main pane is known regardless of which pane has focus, and
    // extra panes are visible to later slices. Per-pane spawns (the old
    // per-session display-message) would multiply with split panes; the worker
    // thread keeps the one blocking sweep off the event loop.
    const list = spawnSync('tmux', tmuxArgs(['list-panes', '-a', '-F',
        `#{session_name}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_created}${FIELD_SEP}#{session_activity}${FIELD_SEP}#{window_index}${FIELD_SEP}#{pane_index}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_start_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}${FIELD_SEP}#{@hwip_pane_label}${FIELD_SEP}#{@hwip_project}${FIELD_SEP}#{@hwip_session_label}${FIELD_SEP}#{${SESSION_SHELL_OPTION}}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (list.status !== 0) {
        const stderr = (list.stderr ?? '').toString().trim();
        log(`  tmux list-panes failed: status=${list.status}${stderr ? ', stderr=' + stderr : ''}`);
        // Tmux call failed against the cached socket — the server it
        // pointed at is gone (died, restarted at a different path, etc).
        // Invalidate so the next cycle re-runs full discovery instead of
        // wedging the listener at "reported 0 session(s)" forever.
        invalidateTmuxSocketCache();
        return { sessions: [], rejected: [], targets: {}, subagentTranscripts: {}, recordable: {} };
    }

    const rawLines = (list.stdout ?? '').split('\n').filter(Boolean);
    // Sanity-check that the format separator actually survived. tmux is
    // supposed to pass non-format bytes through unchanged, but if any
    // shim (login shell, security tool, terminal wrapper) mangles the
    // 0x1f byte we'd parse the line as a single un-split field and drop
    // it as "not hwip-*". Detect that explicitly so the user isn't left
    // guessing.
    if (rawLines.length > 0 && !rawLines[0].includes(FIELD_SEP)) {
        log(`  tmux list-panes output missing FIELD_SEP — likely encoding issue. Raw line: ${JSON.stringify(rawLines[0])}`);
    }

    const sessions: AgentSession[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    /** 15 fields per row; a mismatch is the mangled-separator failure the
     *  sanity log above exists for — skip the row loudly, never misparse it. */
    const PANE_FIELDS = 15;
    interface PaneRow { paneId: string; win: number; idx: number; label: string; info: PaneInfo }
    interface PaneGroup { attached: boolean; created?: string; activity?: string; project?: string; label?: string; shell: boolean; panes: PaneRow[] }
    const groups = new Map<string, PaneGroup>();
    let malformed = 0;
    for (const line of rawLines) {
        const f = line.split(FIELD_SEP);
        if (f.length !== PANE_FIELDS) { malformed += 1; continue; }
        const [name, attached, created, activity, win, idx, paneId, current, start, path, pid, label, project, sessionLabel, shellMark] = f;
        if (!parseSessionName(name)) {
            // Not noisy enough to log every plain tmux session here —
            // would clutter the verbose output on machines with many
            // non-hwip sessions.
            continue;
        }
        const numeric = (v: string): number => {
            const n = Number(v);
            return Number.isInteger(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER;
        };
        const row: PaneRow = {
            paneId,
            win: numeric(win),
            idx: numeric(idx),
            label: label ?? '',
            info: {
                currentCommand: current || null,
                startCommand: start || null,
                currentPath: path || null,
                panePid: numeric(pid) === Number.MAX_SAFE_INTEGER ? null : numeric(pid),
            },
        };
        const group = groups.get(name) ?? { attached: attached === '1', created, activity, project, label: sessionLabel, shell: shellMark === name, panes: [] };
        group.panes.push(row);
        groups.set(name, group);
    }
    if (malformed > 0) {
        log(`  tmux list-panes: skipped ${malformed} malformed row(s) — format separator may be mangled`);
    }
    // Pane cwd per session, read in the same sweep. Kept beside the wire shape
    // rather than in it: AgentSession is a server/phone contract and the
    // directory is local knowledge the registry needs, nothing the phone gets.
    const paneCwdOf = new Map<string, string>();
    const targets: Record<string, string> = {};
    const subagentTranscripts: Record<string, string> = {};
    const recordable: Record<string, RecordableSession> = {};
    for (const [name, group] of groups) {
        // Main pane = the lowest (window, pane) index that runs an agent.
        // pi-interactive-subagents splits `-d` to the RIGHT of the parent, so
        // the parent keeps the lower index; a manual left split would take the
        // main role — accepted. Focus decides nothing here, which is the point:
        // focusing a subagent pane must not move the phone's view of the main.
        group.panes.sort((a, b) => (a.win - b.win) || (a.idx - b.idx));
        // A `hwip sh` session is a shell whatever runs in it: its first pane
        // is the one the phone types into, and agent detection never applies.
        // Checked before detection so `claude` started inside it does not turn
        // it into an agent session the registry would offer to resume.
        const shellRow = group.shell ? group.panes[0] : undefined;
        if (shellRow) {
            const parsed = parseSessionName(name, group);
            if (!parsed) continue; // unreachable — groups only holds parsed names
            if (shellRow.info.currentPath) paneCwdOf.set(name, shellRow.info.currentPath);
            targets[name] = shellRow.paneId;
            sessions.push({
                name,
                attached: group.attached,
                agentKind: 'shell',
                agentSessionId: null,
                project: parsed.project,
                label: parsed.label,
                createdAt: epochToIso(group.created),
                runId: runIdOfEpoch(group.created),
                lastActivityAt: epochToIso(group.activity),
                // No `state`: the server arms its completion and `gone` pushes
                // on reported state, and a shell going idle is not news.
            });
            continue;
        }
        let main: { row: PaneRow; agent: RegisteredRemoteAgent } | null = null;
        for (const row of group.panes) {
            const agent = detectRemoteAgent(row.info);
            if (agent) { main = { row, agent }; break; }
        }
        if (!main) {
            const first = group.panes[0]?.info;
            rejected.push({
                name,
                reason: `no agent in pane (start=${first?.startCommand ?? 'null'}, current=${first?.currentCommand ?? 'null'})`,
            });
            continue;
        }
        const info = main.row.info;
        // No session options (started before the wrapper wrote them, or by an
        // older one): the pane's checkout says what the name cannot.
        const inferred = !group.project && info.currentPath
            ? groupOf(name.slice('hwip-'.length), checkoutOfCached(info.currentPath))
            : null;
        const parsed = parseSessionName(name, inferred ?? group);
        if (!parsed) continue; // unreachable — groups only holds parsed names
        const agentSessionId = info.currentPath
            ? (main.agent.resolveSessionId?.(info.currentPath, info.panePid ?? undefined) ?? null)
            : null;
        const providerSessionName = info.currentPath
            ? (main.agent.resolveSessionName?.(info.currentPath, info.panePid ?? undefined) ?? null)
            : null;
        if (info.currentPath) paneCwdOf.set(name, info.currentPath);
        targets[name] = main.row.paneId;
        sessions.push({
            name,
            attached: group.attached,
            agentKind: main.agent.kind,
            agentSessionId,
            project: parsed.project,
            label: parsed.label,
            providerSessionName,
            createdAt: epochToIso(group.created),
            runId: runIdOfEpoch(group.created),
            lastActivityAt: epochToIso(group.activity),
            ...deriveSessionState(name, main.agent.kind, capturePaneText(name, main.row.paneId)),
        });
        // Subagent panes: every OTHER pane of this session whose tty's
        // foreground process group runs a registered agent (measured:
        // pane_current_command alone says `bash` for a pi subagent — the
        // fg group's `comm` is what names it). View-only wire entities
        // named `<session>.<pane id digits>`; ordered by pane id so the
        // phone's switcher is stable across sweeps (tmux pane ids are
        // monotonic server-wide).
        const paneNum = (p: PaneRow): number => Number(p.paneId.slice(1)) || 0;
        const extras = group.panes
            .filter((p) => p !== main.row)
            .sort((a, b) => paneNum(a) - paneNum(b));
        const fallbackCounts = new Map<string, number>();
        for (const extra of extras) {
            const subAgent = foregroundAgentFor(extra.info.panePid ?? 0);
            if (!subAgent) continue; // a shell / non-agent pane — not reportable
            const subName = `${name}.${paneNum(extra)}`;
            targets[subName] = extra.paneId;
            const n = (fallbackCounts.get(subAgent.kind) ?? 0) + 1;
            fallbackCounts.set(subAgent.kind, n);
            sessions.push({
                name: subName,
                parentName: name,
                attached: group.attached,
                agentKind: subAgent.kind,
                agentSessionId: null,
                project: parsed.project,
                // The subagent names itself by setting @hwip_pane_label
                // (PI_EXTENSION); a manual `tmux set-option -p` works too.
                // Fallback names per agent kind so two subagents of the
                // same kind stay distinguishable.
                label: extra.label.trim() || `${subAgent.displayName} ${n}`,
                createdAt: epochToIso(group.created),
                lastActivityAt: epochToIso(group.activity),
                ...deriveSessionState(subName, subAgent.kind, capturePaneText(subName, extra.paneId)),
            });
        }
        // In-process subagents: the ones with no pane at all (Claude Code's
        // `Agent` tool). They are found in the parent's transcript directory
        // instead — see `subagent-transcripts.ts` — and reported as the same
        // view-only rows, numbered around the pane ids just taken above.
        //
        // Claude Code only, and the kind is checked here rather than inferred
        // from `resolveTranscript` existing: that used to mean "Claude", and
        // stopped meaning it the moment pi and Codex got resolvers of their own.
        // Without the check every pi and Codex session enters `scanSubagents`,
        // whose `launchSeen` can never flip for a format that has no launch
        // line — so it would re-read that session's transcript delta on every
        // sweep for as long as the session lived, and pay Codex's two-shard
        // header scan to produce a path it throws away one line later.
        // One resolution serves both: the recorder follows any agent with a transcript
        // reader, the subagent scan only Claude Code's.
        const mainTranscript = info.currentPath && main.agent.resolveTranscript && main.agent.projectTranscript
            ? (main.agent.resolveTranscript(info.currentPath, info.panePid ?? undefined) ?? null)
            : null;
        if (mainTranscript) {
            const runId = runIdOfEpoch(group.created);
            recordable[name] = { path: mainTranscript, kind: main.agent.kind, ...(runId ? { runId } : {}) };
        }
        const transcriptPath = main.agent.kind === 'claude' ? mainTranscript : null;
        if (transcriptPath) {
            const scan = subagentScans.get(name) ?? initialSubagentScanState();
            subagentScans.set(name, scan);
            const reserved = new Set(extras.map(paneNum));
            for (const row of scanSubagents(name, transcriptPath, scan, { reserved, log, catchUp: subagentCatchUp })) {
                // Addressable for longer than it is on the roster: a viewer
                // already reading a subagent that has gone quiet keeps reading.
                subagentTranscripts[row.name] = row.transcriptPath;
                if (!row.live) continue;
                sessions.push({
                    name: row.name,
                    parentName: name,
                    inProcess: true,
                    attached: group.attached,
                    agentKind: main.agent.kind,
                    agentSessionId: null,
                    project: parsed.project,
                    label: row.label,
                    // The subagent's own start when its transcript has one, not
                    // the tmux session's: this row is as old as the work it
                    // describes, and the phone times it from here.
                    //
                    // So this value CHANGES once — tmux's creation time until
                    // the transcript carries a stamp, the stamp after. Fine
                    // while nothing sorts subagents by it (the agents list
                    // sorts on immutable fields and does not list them); a
                    // surface that starts to would reorder itself.
                    createdAt: row.startedAt ?? epochToIso(group.created),
                    lastActivityAt: row.lastActivityAt,
                    toolCount: row.toolCount,
                    // Straight from the transcript's own clock: there is no pane
                    // to read, so the detection rules that turn a screenful of
                    // text into a state have nothing to work on here.
                    state: row.working ? 'working' : 'idle',
                    stateChangedAt: row.lastActivityAt,
                    stateRuleId: 'transcript-activity',
                });
            }
        }
    }
    pruneToLive(subagentScans, new Set(groups.keys()));
    pruneToLive(sessionStates, new Set(sessions.map((s) => s.name)));
    // Write down what each live session IS, while it still exists to be read.
    // tmux forgets a session the moment it ends, which is exactly when the
    // phone wants it back — and a resume must take its directory and its binary
    // from what this machine observed, never from the wire.
    rememberSessions(
        // Subagents are view-only panes OF a session, not resumable ones:
        // the registry records what a session IS so exit/resume can act on
        // it, and neither is ever offered for a subagent.
        // A shell is not resumable either: resume starts a registered agent
        // binary, and there is none behind a `hwip sh` session.
        sessions.filter((s) => !s.parentName && s.agentKind !== 'shell').map((s) => ({
            name: s.name,
            cwd: paneCwdOf.get(s.name) ?? null,
            agentKind: s.agentKind,
            project: s.project,
            label: s.label,
            runId: s.runId,
            startedAt: s.createdAt,
        })),
    );
    return { sessions, rejected, targets, subagentTranscripts, recordable };
};

/**
 * Snapshot the live `hwip-*` tmux sessions on this machine, enriched
 * with the running agent kind, the agent's own session id (when the
 * registry has a resolver — currently Claude Code only), project, and
 * tmux activity timestamps. Returns [] when tmux is unreachable or no
 * agent sessions exist. Sessions whose pane is at a shell or running
 * something not registered in remote-agents.ts are filtered out — the
 * phone can't usefully address them — except a `hwip sh` session, which is
 * reported as `shell`.
 */
const collectSessions = (): AgentSession[] => {
    const result = collectSessionsVerbose();
    // The membership path also refreshes the pane targets: a session younger
    // than one report cycle gets its pane id pinned here rather than falling
    // back to the (focus-following) bare session name.
    recordTargets(result.targets);
    recordSubagentTranscripts(result.subagentTranscripts);
    return result.sessions;
};

/** Names from the most recent inventory sweep; null until the first one lands —
 *  a membership check in that window (the connect burst) still sweeps in-thread. */
let inventorySnapshot: Set<string> | null = null;
let inThreadSweepLogged = false;
export const recordInventory = (sessions: ReadonlyArray<{ name: string }> | null): void => {
    inventorySnapshot = sessions && new Set(sessions.map((s) => s.name));
};
/** The daemon's sweep runner, set for the lifetime of `handleListener`. Null
 *  outside the daemon (tests, one-shot commands) — sweeps then run in-thread. */
let inventoryOffload: InventoryOffload | null = null;

/**
 * Mirror each session's provider name onto the tmux session itself, as the
 * user option `@hwip_agent_name`.
 *
 * Why: the phone shows what the agent calls this session (`hwipit-d0`) while
 * the user's own status bar shows the tmux name (`hwip-hwipit-3`), and the
 * two never agree. The phone's render precedence is already decided
 * (`alias ?? "<providerSessionName> · <Agent>" ?? computed label`, see the
 * `agentSessionAliases` comment in hwip `libs/shared/src/types/device.ts`);
 * this puts the same middle tier where a tmux config can read it:
 *
 *     #{?@hwip_agent_name,#{@hwip_agent_name},#S}
 *
 * A tmux option rather than a `#()` in the status line on purpose. The status
 * line re-renders per attached client on every status-interval, so a shell
 * there would walk a process tree several times a second across every session;
 * an option is written only when the name actually changes and costs the
 * renderer nothing.
 *
 * The tmux name is NOT renamed and must not be: it is the addressing key the
 * phone injects against, it has to exist before the agent it names does, and
 * the agent's own name rotates on resume. Display and address stay separate —
 * this only makes the display agree with the phone.
 *
 * Keyed by name AND `createdAt`, mirroring the alias anchor in hwip
 * `apps/server/src/lib/agent-session-alias.ts`: a tmux name is a slot, so the
 * cache must not let a new occupant inherit the previous one's write. tmux
 * drops session options with the session, so this is the belt to that braces —
 * what it actually prevents is the *skip*, where an unchanged key would leave
 * the new session with no write at all.
 */
const publishedTmuxNames = new Map<string, string>();

export const syncTmuxAgentNames = (sessions: ReadonlyArray<AgentSession>): void => {
    const liveKeys = new Set<string>();
    for (const s of sessions) {
        // Subagents are view-only panes of the parent; publishing a name
        // for them would run set-option against a `<session>.<pane>` name
        // that tmux parses as the PARENT session (pane index) — clobbering
        // the main pane's published name.
        if (s.parentName) continue;
        const key = `${s.name}\u241f${s.createdAt ?? ''}`;
        liveKeys.add(key);
        const value = s.providerSessionName ?? '';
        if (publishedTmuxNames.get(key) === value) continue;
        // No name to show → unset, so the format falls through to `#S` and no
        // stale value is left on a session whose agent stopped reporting one.
        const args = value
            ? ['set-option', '-t', s.name, '@hwip_agent_name', value]
            : ['set-option', '-u', '-t', s.name, '@hwip_agent_name'];
        const r = spawnSync('tmux', tmuxArgs(args), { stdio: ['ignore', 'ignore', 'ignore'] });
        // Only remember a write that landed; a failed one must be retried next
        // sweep rather than cached as done.
        if (r.status === 0) publishedTmuxNames.set(key, value);
    }
    for (const key of [...publishedTmuxNames.keys()]) {
        if (!liveKeys.has(key)) publishedTmuxNames.delete(key);
    }
};

/**
 * Is this session in the inventory? Answered from the last sweep when it can
 * be: a full sweep is two tmux spawns per session on this thread, and it used
 * to run again on every stream start and screen request (12% of daemon wall
 * time, measured 2026-08-26). A miss still sweeps, so a session
 * younger than one poll interval is not refused, and the inventory filter stays
 * the security boundary: only hwip-* panes running an agent are reachable.
 */
export const isInventoried = (sessionName: string): boolean => {
    if (inventorySnapshot?.has(sessionName)) return true;
    // Visible once, so a daemon that keeps sweeping in-thread can be seen doing it.
    if (inventorySnapshot && !inThreadSweepLogged) {
        inThreadSweepLogged = true;
        log(`inventory miss for ${sessionName} — swept in-thread (logged once)`);
    }
    return collectSessions().some((s) => s.name === sessionName);
};

// ─── Push handling ──────────────────────────────────────────────────

/**
 * One file riding on a push — `libs/shared` `PushFileAttachment`, the
 * fields this daemon reads.
 *
 * `agent.command` attachments are uploaded in *plaintext* (the phone has no
 * key for this host's scratch space); an encrypted one is skipped there. A
 * `type: 'file'` push is the opposite: encrypted per device, and this
 * machine opens its own `deviceKeyMap` slot (ADR-0007). `lanDeliveredTo`
 * marks bytes that never went to S3 — handed straight to that device over
 * the LAN (ADR-0013) — so there is no `fileKey` to fetch.
 */
interface PushFileAttachment {
    fileKey?: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv?: string;
    /** Legacy account-key wrap — nothing here can open it. */
    encryptedKey?: string;
    /** deviceId → JSON `{ encryptedKey, keyIv }` (per-device wrap). */
    deviceKeyMap?: Record<string, string>;
    lanDeliveredTo?: string;
    transferId?: string;
}

interface PushItem {
    pushId: string;
    type?: string;
    body?: string;
    title?: string;
    createdAt?: string;
    isEncrypted?: boolean;
    senderDeviceId?: string;
    targetDeviceId?: string;
    /** E2E: the sender's per-device public key, needed to open our slot. */
    senderPublicKey?: string;
    /** E2E: per-device wrapped message key for the push body. */
    deviceKeyMap?: Record<string, string>;
    /** Set when type='agent.command' — tmux session name to inject into. */
    agentSessionName?: string;
    /** Named keys (Esc/arrows/Enter) to inject instead of body text —
     *  drives full-screen modals the phone can't escape with text. */
    keys?: string[];
    /** Literal text delivered WITHOUT the submitting Enter (see the same field
     *  on AgentCommandInput for why it is a field and not a flag). */
    insert?: string;
    /** Type this only while the pane still shows the blocked prompt with this
     *  id (`blockedPrompt.id`); otherwise refuse with `prompt_changed`. */
    ifPrompt?: string;
    /** Attachments: plaintext scratch files on `agent.command`, the delivered
     *  file(s) on `type: 'file'`. */
    files?: PushFileAttachment[];
    /** A schedule request (F8): create or remove. On a sealed push the relay's copy is `{ op }` and the sealed
     *  body holds the rest; `handlePushInner` swaps the sealed one in before anything reads it. */
    schedule?: unknown;
}

interface HandlePushDeps {
    paneProbe?: (session: string) => PaneProbe | null;
    /** The pane's current text, for the `ifPrompt` check; defaults to a tmux capture. */
    capturePane?: (session: string) => string | null;
    /** Audit sink for input admitted into a marked shell; defaults to the state-dir log. */
    shellAudit?: (entry: ShellAuditEntry) => boolean;
    inject?: (session: string, text: string) => boolean;
    /** Paste-only sibling of `inject` — text without the submitting Enter. */
    insertText?: (session: string, text: string) => boolean;
    sendKeys?: (session: string, tokens: string[]) => boolean;
    rateLimit?: (session: string, now?: number, cost?: number) => boolean;
    now?: () => number;
    /** Injectable for tests; defaults to the REST-backed downloader. */
    downloadAttachments?: (pushId: string, files: PushFileAttachment[], sealed?: SealedAttachments) => Promise<string[]>;
    /** `type: 'file'` delivery: fetch, decrypt and save one attachment into
     *  `~/Downloads/Hwip/`; resolves with the path written, or null when the
     *  file was not wrapped for this device. Defaults to the streaming S3
     *  downloader. */
    /** `sealedSize`: the real size the sealed body gives (the bytes are padded
     *  to it); absent for a file whose record is all there is. */
    saveFile?: (push: PushItem, file: PushFileAttachment, sealedSize?: number, chunk?: number) => Promise<string | null>;
    /** Move a finished local transfer out of the landing zone into
     *  `~/Downloads/Hwip/`; null when it is not there. Defaults to the
     *  filesystem move under `~/.hwip/attachments/lan`. */
    claimLanFile?: (file: PushFileAttachment, sealedSize?: number) => Promise<string | null>;
    /** Desktop banner after a save. Defaults to osascript / notify-send. */
    notify?: (note: DesktopNotification) => Promise<boolean>;
    /** This machine's device id — what `targetDeviceId` and `deviceKeyMap` are keyed by. */
    deviceId?: () => string;
    /** Pane cwd lookup for the remote-origin marker (ADR-0002). */
    paneCwd?: (session: string) => string | null;
    /** Fired after a successful named-key injection so the WS loop can push
     *  fresh screen frames to the phone (scheduleInjectSnapshots). */
    onKeysInjected?: (session: string) => void;
    /** Why a command was refused — called at the refusal point, before the
     *  `false` returns. The first call wins (see `handlePush`). */
    noteRefusal?: (reason: CommandRefusal) => void;
    /** An addressed command was refused: tell the phone (command-refusal.ts). */
    reportRefusal?: (refusal: { sessionName: string; pushId: string; reason: CommandRefusal }) => void;
    /** What a schedule request reads and writes; defaults to this machine's registry and schedule files. */
    schedule?: PhoneScheduleDeps;
}

/**
 * Shared inject path: pane guard → rate limit → tmux send-keys. Both
 * the structured `agent.command` push type and the legacy `@<session>`
 * prefix path route through here so the defense layers can't diverge.
 *
 * `addressed` says the input names this machine: a REST push whose
 * `targetDeviceId` is this device, or stream input, which only ever arrives
 * on this listener's own subscription. A marked shell refuses anything else —
 * push.new fans out to every listener of the account, and two PCs with
 * `hwip sh` open in the same project share the tmux name.
 *
 * Returns what the probe saw when the input is admitted, null when refused.
 */
const passesInjectGuards = (session: string, deps: HandlePushDeps, addressed: boolean, cost = 1): PaneProbe | null => {
    // Subagent panes are view-only: the phone reads them but the agent
    // itself answers at the terminal. This sits above the rate bucket so a
    // flood of refused subagent writes costs nothing and spawns nothing —
    // with an unresolvable name every downstream tmux call is a no-op, but
    // the refusal must not depend on the pane still being mapped.
    if (isSubagentSessionName(session)) {
        log(`! ${session}: subagent pane is view-only — drop`);
        deps.noteRefusal?.('subagent_view_only');
        return null;
    }
    // Rate bucket first: the pane probe below is a blocking tmux spawnSync,
    // and the sequencer can flush several held messages back-to-back — an
    // empty bucket must refuse before paying that probe N times, not after.
    if (!(deps.rateLimit ?? checkRateLimit)(session, Date.now(), cost)) {
        log(`! ${session}: rate-limited — drop`);
        deps.noteRefusal?.('rate_limited');
        return null;
    }
    const probe = (deps.paneProbe ?? probePane)(session);
    if (probe === null) {
        log(`! ${session}: no such tmux session — drop`);
        deps.noteRefusal?.('unknown_session');
        return null;
    }
    if (probe.shellMarked && !addressed) {
        log(`! ${session}: shell session needs a push addressed to this device — refusing`);
        return null;
    }
    if (isShellPane(probe.command) && !probe.shellMarked) {
        log(`! ${session}: pane is at shell (${probe.command}) — refusing (would be RCE)`);
        deps.noteRefusal?.('shell_pane');
        return null;
    }
    return probe;
};

/** Log one input admitted into a marked shell. Best-effort, like the remote marker. */
const auditShellInput = (
    input: { session: string; probe: PaneProbe; kind: ShellAuditEntry['kind']; text: string },
    deps: HandlePushDeps,
): void => {
    const { session, probe, kind, text } = input;
    const entry: ShellAuditEntry = {
        at: new Date((deps.now ?? Date.now)()),
        session,
        target: tmuxTargetFor(session) ?? session,
        kind,
        foreground: probe.command,
        atShell: isShellPane(probe.command),
        text,
    };
    if (!(deps.shellAudit ?? appendShellAudit)(entry)) log(`! ${session}: shell audit write failed`);
};

/**
 * Record a successful phone→pane text injection so a prompt-submit hook
 * (Claude Code plugin's hwip-remote.sh, or `hwip remote-hook` for
 * Gemini/Codex) can flag the matching prompt as remote-originated and
 * enter sticky REMOTE mode (ADR-0002). One file per project dir,
 * overwritten on every inject; the hook consumes it on an exact-text match.
 * Best-effort: a write failure must never fail the injection itself.
 */
export const writeRemoteMarker = (
    paneCwd: string,
    text: string,
    now: () => number = Date.now,
): boolean => {
    const hash = projectHash(paneCwd);
    try {
        mkdirHandedBack(stateDir(), 0o700);
        writeFileSync(remoteMarkerPath(hash), `${Math.floor(now() / 1000)} ${remoteDigest(text)}\n`);
        handBackToSudoUser(remoteMarkerPath(hash));
        return true;
    } catch {
        return false;
    }
};

/** Take back a marker whose text never reached the pane. Best-effort, like the write. */
const clearRemoteMarker = (paneCwd: string): void => {
    const hash = projectHash(paneCwd);
    try {
        rmSync(remoteMarkerPath(hash), { force: true });
    } catch {
        /* a marker we can't remove just expires (15 min) — never fail the push over it */
    }
};

const defaultPaneCwd = (session: string): string | null => readPaneInfo(session).currentPath;

/**
 * Type text into a pane. `submit` false stops after the paste, leaving the
 * text in the prompt for the user to send themselves.
 *
 * The rate cost is `SUBMIT_COST` either way. An insert is not itself an
 * instruction, but it becomes one the moment the user presses Enter, and
 * charging it less would open a cheaper door into the same bucket.
 *
 * The remote-origin marker (ADR-0002) is written for an insert too: the hook
 * matches the submitted prompt against its digest, and after an insert the
 * submit is the user's own keypress. Text they edit before sending simply
 * fails the match and the marker expires, which is the best-effort contract
 * that path already has.
 *
 * The marker goes down BEFORE the keys. An idle agent submits the instant the
 * Enter lands and its prompt hook looks for the marker right then; written
 * after the inject, it lost that race and the phone message read as typed at
 * the keyboard. A failed inject takes the marker back out.
 */
const tryInject = (
    session: string,
    text: string,
    deps: HandlePushDeps,
    opts: { submit: boolean; addressed: boolean; files?: boolean },
): boolean => {
    if (!text) {
        log(`! ${session}: empty text — drop`);
        deps.noteRefusal?.('invalid_command');
        return false;
    }
    const probe = passesInjectGuards(session, deps, opts.addressed, SUBMIT_COST);
    if (!probe) return false;
    if (probe.shellMarked) {
        const refusal = shellTextRefusal(text, opts);
        if (refusal) {
            log(`! ${session}: ${refusal} — refusing for a shell session`);
            deps.noteRefusal?.('shell_input');
            return false;
        }
    }
    // No prompt hook reads a marker in a shell, and one left in that cwd could
    // flag a later identical agent prompt as sent from the phone.
    const cwd = probe.shellMarked ? null : (deps.paneCwd ?? defaultPaneCwd)(session);
    const marked = cwd !== null && writeRemoteMarker(cwd, text);
    const ok = opts.submit
        ? (deps.inject ?? injectKeys)(session, text)
        : (deps.insertText ?? pasteText)(session, text);
    // listener.log is not private: what a shell received — a `sudo` password
    // included — goes to the 0600 audit log, never here.
    const preview = probe.shellMarked
        ? `[${[...text].length} chars]`
        : text.length > 60 ? text.slice(0, 60) + '…' : text;
    log(`${ok ? (opts.submit ? '→' : '⇢') : '✗'} ${session}: ${preview}`);
    if (ok) {
        noteStreamInput(session);
        if (probe.shellMarked) auditShellInput({ session, probe, kind: opts.submit ? 'body' : 'insert', text }, deps);
    } else {
        deps.noteRefusal?.('inject_failed');
        if (marked) clearRemoteMarker(cwd);
    }
    return ok;
};

/**
 * Why text may not go into a marked shell, or null when it may. A shell runs
 * what it reads, so the rules the agent prompt never needed apply here:
 * attachment paths would arrive as lines of their own, each a command; ESC and
 * other control bytes, C1 included, can leave a bracketed paste or drive the
 * line editor;
 * and an insert must not carry a newline, which a shell without bracketed
 * paste (macOS `/bin/bash` 3.2, `dash`) would run.
 */
export const shellTextRefusal = (text: string, opts: { submit: boolean; files?: boolean }): string | null => {
    if (opts.files) return 'attachments';
    const controls = opts.submit ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/;
    if (controls.test(text)) return opts.submit ? 'control character' : 'control character or newline in an insert';
    return null;
};

/** Key-event sibling of tryInject: same pane/shell/rate guards, but sends
 *  named keys instead of literal text + Enter. */
const tryInjectKeys = (session: string, tokens: string[], deps: HandlePushDeps, addressed: boolean): boolean => {
    const probe = passesInjectGuards(session, deps, addressed);
    if (!probe) return false;
    const ok = (deps.sendKeys ?? injectNamedKeys)(session, tokens);
    if (ok) {
        noteStreamInput(session);
        if (probe.shellMarked) auditShellInput({ session, probe, kind: 'keys', text: tokens.join(' ') }, deps);
    }
    log(`${ok ? '⌨' : '✗'} ${session}: [${tokens.join(' ')}]`);
    if (!ok) deps.noteRefusal?.('inject_failed');
    return ok;
};

// ─── Attachment download (agent.command files[]) ────────────────────

const ATTACHMENTS_DIR = join(homedir(), '.hwip', 'attachments');
/** Local-transfer landing zone: `lan/<transferId>/<fileName>` until its push record arrives. */
const LAN_LANDING_DIR = join(ATTACHMENTS_DIR, 'lan');

// apiKey + baseUrl for the file-download REST calls, set once in
// handleListener. The default downloader reads it. null until the daemon
// resolves credentials (handlePush isn't called before then in the real
// flow, but the guard keeps it safe).
let attachmentCtx: { apiKey: string; baseUrl: string } | null = null;

export const setAttachmentContext = (ctx: { apiKey: string; baseUrl: string }): void => {
    attachmentCtx = ctx;
};

// Local transfer (ADR-0013). Set by handleListener; streamSession tells it
// about every WebSocket open because $connect is what makes the device record
// exist. null before the daemon starts and after stop — the relay path never
// depends on it. Lifecycle and ordering live in lan-transfer.ts.
let lanTransfer: LanTransfer | null = null;
// This machine's public key on its device record (ADR-0007), re-registered on
// every open for the same reason. Set by handleListener.
let deviceKeyRegistration: DeviceKeyRegistration | null = null;
// True once that registration frame has gone out on this process's connection. The turn
// recorder holds its uploads until then: the server takes a chunk only when it is sealed
// with the key on the device record.
let deviceKeyRegistered = false;

/**
 * Make a filesystem-safe single path segment: take the basename (drops
 * any `../` prefix), strip control chars and embedded separators, remove
 * leading dots, and cap length. Empty/dot-only names use the fallback.
 */
const safeSegment = (raw: string, fallback: string): string => {
    const cleaned = basename(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return (cleaned || fallback).slice(0, 200);
};

/**
 * How long the API may take to name an attachment's presigned URL. Unbounded,
 * a stalled call held the command that carried the file forever: it was never
 * typed, and nothing said why.
 */
const ATTACHMENT_META_TIMEOUT_MS = 15_000;

/** The bytes of one command attachment, read into memory after the metadata call. */
const ATTACHMENT_FETCH_TIMEOUT_MS = 120_000;

/** Resolve fileKey → presigned download URL. Throws on any HTTP failure. */
const resolveDownloadUrl = async (
    fileKey: string,
    ctx: { apiKey: string; baseUrl: string },
    fetchFn: typeof fetch = fetch,
    timeoutMs: number = ATTACHMENT_META_TIMEOUT_MS,
): Promise<string> => {
    const metaUrl = apiUrl(ctx.baseUrl, `/files/${encodeURIComponent(fileKey)}`);
    const meta = await apiFetch(fetchFn, metaUrl, ctx.apiKey, timeoutMs);
    if (!meta.ok) throw new Error(`metadata ${meta.status}`);
    // Server wraps responses as { data: { downloadUrl } } (see lib/response ok()).
    const body = (await meta.json()) as { data?: { downloadUrl?: string }; downloadUrl?: string };
    const downloadUrl = body.data?.downloadUrl ?? body.downloadUrl;
    if (!downloadUrl) throw new Error('response had no downloadUrl');
    const problem = downloadUrlProblem(downloadUrl, ctx.baseUrl);
    if (problem) throw new Error(`refused downloadUrl: ${problem}`);
    return downloadUrl;
};

/** A download's body, refused at the headers when it says it is over the limit. */
const cappedBody = (res: Response): NonNullable<Response['body']> => {
    if (Number(res.headers.get('content-length')) > DOWNLOAD_MAX_BYTES) {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`download is over the ${DOWNLOAD_MAX_BYTES}-byte limit`);
    }
    if (!res.body) throw new Error('download had no body');
    return res.body;
};

/** Resolve fileKey → presigned URL → bytes. Throws on any HTTP failure so
 *  the caller can isolate one file's failure from the rest of the batch. */
const fetchAttachmentBytes = async (
    fileKey: string,
    ctx: { apiKey: string; baseUrl: string },
    io: AttachmentIo,
): Promise<Buffer> => {
    const fetchFn = io.fetchFn ?? fetch;
    const timeoutMs = io.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS;
    const url = await resolveDownloadUrl(fileKey, ctx, fetchFn, Math.min(timeoutMs, ATTACHMENT_META_TIMEOUT_MS));
    // The presigned URL is self-authenticating — no API key header. A redirect
    // would take the GET wherever the answer points, past the check above.
    const bin = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!bin.ok) throw new Error(`download ${bin.status}`);
    const body = cappedBody(bin);
    // Count as it comes: a body with no length, or a false one, is not held in full.
    const chunks: Uint8Array[] = [];
    let seen = 0;
    const reader = body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.length;
        if (seen > DOWNLOAD_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`download passed the ${DOWNLOAD_MAX_BYTES}-byte limit`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
};

/** Test seam for the command-attachment downloads; production uses the defaults. */
export interface AttachmentIo {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

/** The attachments of a sealed command: opened with this device's slot of
 *  each file, from the sender whose key checked out. */
export interface SealedAttachments {
    deviceId: string;
    senderPublicKey: string;
    /** What the sealed body says each attachment is, in the same order. */
    files?: SealedFileMeta[];
}

/** Open one sealed attachment held whole in memory (ciphertext ‖ GCM tag). */
const openSealedAttachment = async (bytes: Buffer, file: PushFileAttachment, sealed: SealedAttachments): Promise<Buffer> => {
    const slot = file.deviceKeyMap?.[sealed.deviceId];
    if (!slot || !file.iv) throw new Error('not sealed for this machine');
    // Held whole in memory, so sealed whole: the app seals in chunks only a file
    // too large to be a command's attachment.
    if (sealed.files?.some((m) => m.iv === file.iv && m.chunk !== undefined)) throw new Error('sealed in chunks — a command attachment is sealed whole');
    const decipher = createFileDecryptStream(await unwrapDeviceKey(slot, sealed.senderPublicKey), Buffer.from(file.iv, 'base64'));
    const out: Buffer[] = [];
    decipher.on('data', (chunk: Buffer) => out.push(chunk));
    await new Promise<void>((resolve, reject) => {
        decipher.on('end', resolve);
        decipher.on('error', reject);
        decipher.end(bytes);
    });
    return Buffer.concat(out);
};

/**
 * Where one command's attachment is saved. The same bytes under a name already used are the same file
 * attached twice: null, so it is stored and named once (C143). Different bytes under a taken name get
 * `name-1.ext`, `name-2.ext`, … — two pasted `image.png` are two files, and neither is dropped.
 */
const attachmentPath = (taken: Map<string, string>, dir: string, segment: string, bytes: Uint8Array): string | null => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const dot = segment.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [segment.slice(0, dot), segment.slice(dot)] : [segment, ''];
    for (let n = 0; ; n++) {
        const abs = join(dir, n === 0 ? segment : `${stem}-${n}${ext}`);
        const had = taken.get(abs);
        if (had === undefined) {
            taken.set(abs, digest);
            return abs;
        }
        if (had === digest) return null;
    }
};

/**
 * Download every attachment to `~/.hwip/attachments/<pushId>/<fileName>` and
 * return absolute paths. Files are kept (not deleted) so the agent can read
 * them after injection.
 *
 * A plaintext command's attachments are best effort: an encrypted file is
 * skipped (no key) and one file's failure is logged and skipped, so a
 * partial download still injects whatever succeeded. A sealed command's
 * (`sealed`) are all or nothing: each must open with this machine's slot,
 * and the first that does not throws — half a command is not typed.
 */
export const downloadAttachments = async (
    pushId: string,
    files: PushFileAttachment[],
    ctx: { apiKey: string; baseUrl: string },
    sealed?: SealedAttachments,
    io: AttachmentIo = {},
): Promise<string[]> => {
    const dir = join(ATTACHMENTS_DIR, safeSegment(pushId, 'push'));
    const paths: string[] = [];
    const taken = new Map<string, string>();
    if (sealed) {
        try {
            for (const [i, f] of files.entries()) {
                if (!f.fileKey) throw new Error(`attachment ${i}: no fileKey`);
                const opened = await openSealedAttachment(await fetchAttachmentBytes(f.fileKey, ctx, io), f, sealed);
                // Padded before sealing: cut back to the size the sealed body gives.
                const meta = sealed.files?.[i];
                const bytes = meta && Number.isSafeInteger(meta.size) && meta.size >= 0 ? opened.subarray(0, meta.size) : opened;
                const name = meta?.name ?? f.fileName;
                mkdirHandedBack(dir);
                const abs = attachmentPath(taken, dir, safeSegment(name || `file-${i}`, `file-${i}`), bytes);
                if (abs === null) continue;
                writeFileSync(abs, bytes);
                handBackToSudoUser(abs);
                paths.push(abs);
                log(`⇣ ${name} → ${abs} (${bytes.length}B, sealed)`);
            }
        } catch (err) {
            // The command is dropped: what opened before the failure goes with it.
            rmSync(dir, { recursive: true, force: true });
            throw err;
        }
        return paths;
    }
    for (const [i, f] of files.entries()) {
        if (f.iv || f.encryptedKey) {
            log(`! attachment "${f.fileName}": encrypted (iv/encryptedKey present) — listener can't decrypt, skipping`);
            continue;
        }
        if (!f.fileKey) {
            log(`! attachment "${f.fileName}": no fileKey — nothing to fetch, skipping`);
            continue;
        }
        try {
            const bytes = await fetchAttachmentBytes(f.fileKey, ctx, io);
            mkdirHandedBack(dir);
            const abs = attachmentPath(taken, dir, safeSegment(f.fileName || `file-${i}`, `file-${i}`), bytes);
            if (abs === null) continue;
            writeFileSync(abs, bytes);
            handBackToSudoUser(abs);
            paths.push(abs);
            log(`⇣ ${f.fileName} → ${abs} (${bytes.length}B)`);
        } catch (err) {
            log(`! attachment "${f.fileName}": download failed — ${(err as Error).message}`);
        }
    }
    return paths;
};

const defaultDownloadAttachments = (pushId: string, files: PushFileAttachment[], sealed?: SealedAttachments): Promise<string[]> => {
    if (!attachmentCtx) {
        log('! attachment context not initialised — skipping files');
        return Promise.resolve([]);
    }
    return downloadAttachments(pushId, files, attachmentCtx, sealed);
};

// ─── File pushes (type: 'file') → ~/Downloads/Hwip/ ─────────────────
//
// The receive half ADR-0007 left unbuilt: until now every `type: 'file'`
// push was dropped here, so a Mac could send files but never take one.
// Bytes stream from S3 straight through the GCM decrypt to disk (no
// buffering — the Pro cap is 1 GiB), land flat in ~/Downloads/Hwip/ under
// the sender's name (` (2)` on collision, never overwritten, never GC'd),
// and a desktop banner says so. Local-transfer deliveries (`lanDeliveredTo`)
// take the same exit once the receiver lands.

/** A download that sends no bytes for this long is dead, not slow. */
const DOWNLOAD_IDLE_MS = 60_000;

export interface SaveFileDeps {
    ctx: { apiKey: string; baseUrl: string } | null;
    fetchFn: typeof fetch;
    deviceId: () => string;
    downloadsDir: () => string;
    idleTimeoutMs?: number;
}

/**
 * Fetch one attachment and save it under `~/Downloads/Hwip/`, decrypting
 * with this device's `deviceKeyMap` slot when the file is encrypted.
 * Resolves with the path written; null when the file is encrypted for
 * other devices only (a broadcast this machine is not a recipient of —
 * not a failure); throws when the bytes cannot be fetched or opened.
 * Exported with its deps so the real path is testable without S3.
 */
export const saveFileFromS3 = async (
    push: PushItem,
    file: PushFileAttachment,
    deps: SaveFileDeps,
    /** The real size from the sealed body; the only size the bytes are cut back to. */
    sealedSize?: number,
    /** What the sealed body says of the chunks (`chunkOf`): absent for a file sealed whole. */
    chunk?: number,
): Promise<string | null> => {
    if (!deps.ctx) throw new Error('attachment context not initialised');
    if (!file.fileKey) throw new Error('no fileKey');
    const said = chunkOf(chunk);
    if (!said.ok) throw new Error(`sealed in chunks of a size this build does not open (${chunk})`);
    let decrypt: { rawKey: Buffer; iv: Buffer; chunk?: number } | undefined;
    if (file.deviceKeyMap) {
        // Per-device wrap (ADR-0007). Precedence over the legacy field, as
        // libs/shared documents: a migrated sender may still write both.
        const slot = file.deviceKeyMap[deps.deviceId()];
        if (!slot) return null;
        if (!push.senderPublicKey) throw new Error('encrypted push carries no senderPublicKey');
        if (!file.iv) throw new Error('encrypted file carries no iv');
        decrypt = { rawKey: await unwrapDeviceKey(slot, push.senderPublicKey), iv: Buffer.from(file.iv, 'base64'), chunk: said.chunk };
    } else if (file.encryptedKey) {
        throw new Error('legacy account-key encryption — this device cannot open it');
    } else if (file.iv) {
        throw new Error('encrypted, but no key material on the attachment');
    }
    const controller = new AbortController();
    const idleMs = deps.idleTimeoutMs ?? DOWNLOAD_IDLE_MS;
    const url = await resolveDownloadUrl(file.fileKey, deps.ctx, deps.fetchFn, Math.min(idleMs, ATTACHMENT_META_TIMEOUT_MS));
    // The idle timer below starts with the body; until then S3 gets the same
    // budget to answer at all.
    const headerTimer = setTimeout(() => controller.abort(new Error(`download sent no response in ${idleMs} ms`)), idleMs);
    let res: Response;
    try {
        // The presigned URL is self-authenticating: no API key goes to S3.
        res = await deps.fetchFn(url, { signal: controller.signal, redirect: 'error' });
    } finally {
        clearTimeout(headerTimer);
    }
    if (!res.ok) throw new Error(`download ${res.status}`);
    const body = cappedBody(res);
    // fetch's body is typed by undici without the async-iterator members
    // node:stream/web declares; at runtime it is that same ReadableStream.
    const source = withIdleTimeout(Readable.fromWeb(body as ReadableStream), idleMs, controller, DOWNLOAD_MAX_BYTES);
    const dir = deps.downloadsDir();
    const saved = await saveStream(source, () => resolveDownloadPath(file.fileName, dir), decrypt);
    // A sealed file is padded before sealing: cut back only to the size the
    // sealed body gives, never to the record's, which the server could set to
    // cut a file short. Only a sealed command's sender is checked (admit); a
    // relay that forges a whole plain file push still names any size.
    if (decrypt && sealedSize !== undefined && statSync(saved.path).size > sealedSize) truncateSync(saved.path, sealedSize);
    return saved.path;
};

const defaultSaveFile = (push: PushItem, file: PushFileAttachment, sealedSize?: number, chunk?: number): Promise<string | null> =>
    saveFileFromS3(push, file, { ctx: attachmentCtx, fetchFn: fetch, deviceId: computeListenerDeviceId, downloadsDir }, sealedSize, chunk);

/**
 * Move a local-transfer file the receiver already decrypted into the
 * Downloads folder, now that its push record has arrived. `link` + unlink
 * keeps the never-overwrite rule (`resolveDownloadPath` picks a free name,
 * link refuses a taken one); a Downloads folder on another volume gets a
 * copy instead. Null when the transfer is not in the landing zone — already
 * claimed by a duplicated push.new, or swept as an orphan.
 *
 * The receiver wrote the bytes as they were sealed, padding included: with
 * `sealedSize` (the size the sealed body gives) the file is cut back to it
 * first, as a file from the relay is, so Downloads never holds the padded one.
 * That size was picked by the record's `iv`, and the record is the relay's
 * word: it cuts only a file that landed under that same iv (the receiver left
 * it beside the file), and a record that names another is refused whole. From
 * the relay the same check is the decrypt itself, which fails under a wrong iv.
 */
export const claimLanFile = (
    file: { fileName: string; transferId: string; sealedSize?: number; iv?: string },
    landingDir: string = LAN_LANDING_DIR,
    downloads: string = downloadsDir(),
): string | null => {
    if (!isTransferId(file.transferId)) throw new Error(`malformed transferId ${JSON.stringify(file.transferId)}`);
    const transferDir = join(landingDir, file.transferId);
    const src = join(transferDir, safeFileName(file.fileName));
    if (!existsSync(src)) return null;
    const landedIvPath = join(transferDir, LAN_LANDED_IV);
    // No iv beside it: landed under a receiver from before this, which is not cut.
    if (file.sealedSize !== undefined && existsSync(landedIvPath)) {
        if (readFileSync(landedIvPath, 'utf8') !== file.iv) throw new Error('the push record names another file than the one that landed');
        if (statSync(src).size > file.sealedSize) truncateSync(src, file.sealedSize);
    }
    mkdirHandedBack(downloads);
    const dest = resolveDownloadPath(file.fileName, downloads);
    try {
        linkSync(src, dest);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
    }
    unlinkSync(src);
    rmSync(transferDir, { recursive: true, force: true });
    return dest;
};

const defaultClaimLanFile = async (file: PushFileAttachment, sealedSize?: number): Promise<string | null> =>
    claimLanFile({ fileName: file.fileName, transferId: file.transferId ?? '', sealedSize, iv: file.iv });

/** A sealed push's body opened with this machine's slot; null when it is not
 *  sealed for this machine or does not open. */
const openPushBody = async (push: PushItem, me: string): Promise<Awaited<ReturnType<typeof decryptPushBodyForDevice>> | null> => {
    const slot = push.deviceKeyMap?.[me];
    if (!push.isEncrypted || !push.body || !slot || !push.senderPublicKey) return null;
    try {
        return await decryptPushBodyForDevice(push.body, slot, push.senderPublicKey);
    } catch (err) {
        log(`! push ${push.pushId}: sealed body unreadable — ${(err as Error).message}`);
        return null;
    }
};

/**
 * What the banner says under the file name: the sender's push title
 * (`[project] name.ext` from the MCP, or whatever the phone typed) — it is
 * inside the encrypted body, so open it with our slot when we can; otherwise
 * the plaintext title, then the sender device id. Never throws — the banner
 * is not worth a lost file.
 */
const describeSender = (push: PushItem, opened: { title?: string } | null): string =>
    `from ${opened?.title || push.title || push.senderDeviceId || 'another device'}`;

/**
 * A sealed file as it really is. Its record says `file` and a padded size
 * (M5): the sealed body names each file by its IV with the real name, type
 * and size, and the size is what the padding is cut back to. That keeps the
 * record from cutting a file short. It authenticates nothing by itself: only
 * a sealed command's sender is admitted, and a relay that forges a whole plain
 * file push names whatever size it likes. `chunk` is what the sealed body says
 * of a file sealed in chunks, as it says it — the save checks it (`chunkOf`).
 */
const shownFile = (
    file: PushFileAttachment,
    named: SealedFileMeta[] | undefined,
): { file: PushFileAttachment; sealedSize?: number; chunk?: number } => {
    const meta = file.iv ? named?.find((m) => m.iv === file.iv) : undefined;
    if (!meta) return { file };
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) return { file, chunk: meta.chunk };
    return { file: { ...file, fileName: meta.name, fileType: meta.type, fileSize: meta.size }, sealedSize: meta.size, chunk: meta.chunk };
};

/**
 * The folder a saved file is in, as a person would type it: the home prefix
 * shown as `~`. The title already carries the name — the one the file was
 * actually saved under, ` (2)` included — so the body only has to say where.
 */
export const displayFolder = (dest: string, home: string = homedir()): string => {
    const dir = dirname(dest);
    return dir === home || dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
};

/**
 * Save every attachment of a `type: 'file'` push addressed to this machine.
 * Returns true when at least one file landed. Pushes for another device,
 * and this device's own sends (never wrapped for the sender — MCP and
 * listener on one host share a device id), are left alone.
 */
const handleFilePush = async (push: PushItem, deps: HandlePushDeps): Promise<boolean> => {
    const me = deps.deviceId?.() ?? computeListenerDeviceId();
    if (push.targetDeviceId && push.targetDeviceId !== me) return false;
    if (push.senderDeviceId === me) return false;
    const files = push.files ?? [];
    if (files.length === 0) return false;
    const save = deps.saveFile ?? defaultSaveFile;
    const notify = deps.notify ?? notifyDesktop;
    const opened = await openPushBody(push, me);
    const from = describeSender(push, opened);
    let saved = 0;
    const announce = (f: PushFileAttachment, dest: string): void => {
        saved++;
        log(`⇣ ${f.fileName} → ${dest}`);
        // `notify` is an injection point; one that throws or rejects must
        // not become an unhandled rejection, nor read as a failed save.
        void Promise.resolve()
            .then(() => notify({ title: `Hwip · ${basename(dest)}`, body: `${from} · ${displayFolder(dest)}`, reveal: dest }))
            .catch((err: unknown) => log(`! banner failed — ${err instanceof Error ? err.message : String(err)}`));
    };
    for (const recorded of files) {
        const { file: f, sealedSize, chunk } = shownFile(recorded, opened?.files);
        if (!f.fileKey) {
            // No bytes in S3: handed over the LAN (`lanDeliveredTo`, ADR-0013),
            // or a malformed attachment. Ours to claim only when it was
            // delivered to this device.
            if (f.lanDeliveredTo === me && f.transferId) {
                const claim = deps.claimLanFile ?? defaultClaimLanFile;
                try {
                    const dest = await claim(f, sealedSize);
                    if (dest === null) {
                        log(`local transfer: "${f.fileName}" (${f.transferId}) is not in the landing zone — already claimed, or swept`);
                        continue;
                    }
                    announce(f, dest);
                } catch (err) {
                    log(`! local transfer: claim of "${f.fileName}" failed — ${(err as Error).message}`);
                }
                continue;
            }
            log(f.lanDeliveredTo
                ? `local transfer: "${f.fileName}" was delivered to ${f.lanDeliveredTo}, not this device — skipping`
                : `! file "${f.fileName}": no fileKey — nothing to fetch, skipping`);
            continue;
        }
        // Once this listener is sealed-only, a file in the clear is the relay's
        // to write: anyone with the push route could drop any bytes, under any
        // name, into Downloads with a banner pointing at them.
        if (plainRefusal() && (!f.deviceKeyMap?.[me] || !f.iv)) {
            log(`! file "${f.fileName}": refused — not sealed for this machine, and this listener takes sealed files only`);
            continue;
        }
        try {
            const dest = await save(push, f, sealedSize, chunk);
            if (dest === null) {
                log(`file "${f.fileName}": not wrapped for this device — skipping`);
                continue;
            }
            announce(f, dest);
        } catch (err) {
            log(`! file "${f.fileName}": save failed — ${(err as Error).message}`);
        }
    }
    return saved > 0;
};

/**
 * Combine the command body with downloaded file paths, one per line.
 * Claude Code reads local image paths from the prompt text, so appending
 * absolute paths makes the agent load them. Empty body → paths only.
 */
const composeInjection = (body: string, paths: string[]): string =>
    paths.length ? [body, ...paths].filter(Boolean).join('\n') : body;

// Downloaded attachments are kept after injection (the agent reads them
// from disk), so they accumulate. A per-push dir older than this is GC'd —
// long enough to outlive any realistic agent read, short enough that the
// directory can't grow without bound on a long-running daemon.
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Remove attachment sub-directories whose mtime is older than `ttl`.
 * Best-effort: an entry that can't be statted or removed is skipped, not
 * fatal. Returns the count removed. `dir`/`ttl` are injectable for tests.
 */
export const gcAttachments = (
    now: number = Date.now(),
    dir: string = ATTACHMENTS_DIR,
    ttl: number = ATTACHMENT_TTL_MS,
    landingDir: string = LAN_LANDING_DIR,
): number => {
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const name of entries) {
        const full = join(dir, name);
        if (full === landingDir) {
            // Local-transfer landing zone: sweep the transfers inside it,
            // never the zone itself. Matched by full path, so a transfer
            // or push that happens to be called `lan` is swept like any other.
            removed += gcAttachments(now, full, ttl, landingDir);
            continue;
        }
        try {
            if (now - statSync(full).mtimeMs <= ttl) continue;
            rmSync(full, { recursive: true, force: true });
            removed++;
        } catch { /* skip unreadable/unremovable entries */ }
    }
    return removed;
};

/**
 * The text of a sealed `agent.command` (M5 D8), or null when it is not one
 * this machine types. The sender is the device the sealed label names in
 * `from` (a send made with an API key is stamped `api_<keyId>`, which says
 * nothing about the machine), else the device the push is stamped with. Its
 * key is checked like a stream subscriber's (registered for that device, and
 * pinned) — or, for this machine itself, is this machine's own key — once the
 * label has been opened and `from` read, and before any of the text is used; the sealed label
 * must name this session and this machine; its number must be above the last
 * one taken from that sender, which is on disk before anything is typed. Its
 * attachments must be exactly the ones the sealed body names (by IV, in
 * order), each sealed for this machine — a relay can neither drop one nor
 * add or swap in another the phone sealed earlier. Keys or an insert beside
 * a sealed body are the relay's, and refuse it whole.
 */
const openSealedCommand = async (
    push: PushItem,
    deps: HandlePushDeps,
): Promise<{ text: string; sender: string; files: SealedFileMeta[]; keys?: string[]; ifPrompt?: string; schedule?: Record<string, unknown> } | null> => {
    const me = deps.deviceId?.() ?? computeListenerDeviceId();
    const session = push.agentSessionName;
    const drop = (why: string): null => {
        log(`! sealed command${session ? ` for ${session}` : ''}: ${why} — drop`);
        return null;
    };
    if (push.targetDeviceId !== me) return null;
    if (!session) return drop('no session');
    if (push.keys?.length || push.insert !== undefined) return drop('plain keys or insert beside a sealed body');
    // Every attachment must be sealed for this machine too: a plain one beside
    // a sealed body is the relay's.
    if (push.files?.some((f) => !f.deviceKeyMap?.[me] || !f.iv)) return drop('an attachment not sealed for this machine');
    const slot = push.deviceKeyMap?.[me];
    if (!push.body || !slot || !push.senderPublicKey) return drop('not sealed for this machine');
    const trust = subscriberTrust;
    if (!trust) return drop('no device list to check the sender against');
    // The sealing key is the one the push names; whose it is gets decided below, before any of the text is used.
    // A box opens only for the key that sealed it, so the label read here cannot be the relay's.
    let opened: Awaited<ReturnType<typeof decryptPushBodyForDevice>>;
    try {
        await initDeviceCrypto();
        opened = await decryptPushBodyForDevice(push.body, slot, push.senderPublicKey);
    } catch (err) {
        return drop(`would not open (${err instanceof Error ? err.message : String(err)})`);
    }
    const { cmd, keys, ifPrompt, schedule } = opened;
    if (!cmd) return drop('no command label (not a command)');
    if (keys !== undefined && !resolveKeys(keys)) return drop('sealed keys outside the whitelist');
    if (ifPrompt !== undefined && !isPromptId(ifPrompt)) return drop('sealed ifPrompt is not a prompt id');
    // A send made with an API key is stamped `api_<keyId>` by the server, so the machine that sealed it names itself in
    // the label. A device id stamped beside it has to be the same one.
    const sender = cmd.from ?? push.senderDeviceId;
    if (!sender) return drop('no sender named');
    if (cmd.from && push.senderDeviceId?.startsWith('dev_') && push.senderDeviceId !== cmd.from) return drop('stamped by one machine, sealed as another');
    // Another session on this very machine seals with this machine's own key; the account's list and the pins
    // (which a relay can write into) have no say in that.
    let senderKey: string;
    if (sender === me) {
        const own = getDevicePublicKey();
        if (!own || !samePublicKey(own, push.senderPublicKey)) return drop(`sealed as this machine, but not with its key`);
        senderKey = own;
    } else {
        const admission = await trust.admit({ deviceId: sender, publicKey: push.senderPublicKey });
        if (admission.kind !== 'seal') return drop(`the sender's key did not check out`);
        senderKey = admission.publicKey;
    }
    if (cmd.session !== session || cmd.device !== me) return drop('labelled for another session or machine');
    const attached = push.files ?? [];
    const named = opened.files ?? [];
    if (attached.length !== named.length || attached.some((f, i) => f.iv !== named[i].iv)) {
        return drop('attachments are not the ones the sealed body names');
    }
    if (schedule === undefined && push.schedule !== undefined) return drop('a schedule beside a seal that holds none');
    if (schedule !== undefined) {
        // A schedule request is the whole command: nothing to type beside it. The `op` the relay carries has to be the
        // sealed one, so a relay cannot turn a sealed create into a remove or the reverse.
        if (opened.body !== undefined || keys !== undefined || ifPrompt !== undefined || attached.length > 0) return drop('a schedule request beside text, keys or attachments');
        const outside = push.schedule as Record<string, unknown> | undefined;
        if (!outside || Object.keys(outside).length !== 1 || outside.op !== schedule.op) return drop('the op beside the seal is not the sealed one');
    } else if (!opened.body && attached.length === 0 && !keys?.length) {
        return drop('no text and no attachment');
    }
    if (!trust.acceptCommand(sender, cmd.n, senderKey)) return null;
    return { text: opened.body ?? '', sender: senderKey, files: named, keys, ifPrompt, schedule };
};

/**
 * A phone's request to make or remove a schedule (F8). The decisions are `applyPhoneSchedule`'s; this spends
 * the session's rate budget the way a typed command does and reports a refusal the way every command does.
 * Never types anything. A push no one addressed to this machine is not acted on: it changes files, and a
 * push.new reaches every listener of the account.
 */
const handleScheduleRequest = (push: PushItem, session: string, addressed: boolean, deps: HandlePushDeps): boolean => {
    if (!addressed) return false;
    if (push.body || push.keys?.length || push.insert !== undefined || push.files?.length) {
        log(`! ${session}: a schedule request beside text, keys or attachments — drop`);
        deps.noteRefusal?.('invalid_command');
        return false;
    }
    if (!(deps.rateLimit ?? checkRateLimit)(session, Date.now(), SUBMIT_COST)) {
        log(`! ${session}: schedule request over the rate limit — drop`);
        deps.noteRefusal?.('rate_limited');
        return false;
    }
    const result = applyPhoneSchedule(push.schedule, session, deps.schedule ?? livePhoneScheduleDeps);
    if (!result.ok) {
        log(`! ${session}: schedule request refused (${result.reason}): ${result.why}`);
        deps.noteRefusal?.(result.reason);
        return false;
    }
    log(`schedule request for ${session} applied`);
    return true;
};

/** `handlePush` without the refusal report: every `false` that matters to the phone calls `deps.noteRefusal` first. */
const handlePushInner = async (
    push: PushItem,
    deps: HandlePushDeps,
): Promise<boolean> => {
    if (push.type === 'file') return handleFilePush(push, deps);
    let sealedSender: string | undefined;
    let sealedFiles: SealedFileMeta[] = [];
    if (push.isEncrypted) {
        if (push.type !== 'agent.command') return false;
        const opened = await openSealedCommand(push, deps);
        if (opened === null) {
            deps.noteRefusal?.('sealed_rejected');
            return false;
        }
        // Opened and checked: from here it is the same input as a plain one,
        // its text, keys and prompt binding the sealed ones and nothing the relay
        // wrote beside it; its attachments open below with the same sender, all or nothing.
        sealedSender = opened.sender;
        sealedFiles = opened.files;
        push = { ...push, isEncrypted: false, body: opened.text, keys: opened.keys, insert: undefined, ifPrompt: opened.ifPrompt, schedule: opened.schedule };
    }
    if (push.type !== 'agent.command' || !push.agentSessionName) return false;
    // push.new fans out to every listener of the user, and two of their
    // machines routinely run a session with the same tmux name (same project
    // checked out on both). Only the addressed machine types the command;
    // the other would otherwise inject it into its own same-named session.
    const me = deps.deviceId?.() ?? computeListenerDeviceId();
    if (push.targetDeviceId && push.targetDeviceId !== me) return false;
    // An agent session still takes an unaddressed push (older senders); a
    // marked shell does not — passesInjectGuards reads this.
    const addressed = push.targetDeviceId === me;

    // A listener that only seals (it pins a device) types nothing a relay could have written: a
    // plain body, insert, attachment or keys are refused whole. The phone's approve button seals its keys instead.
    // `sealedSender` is set for a command opened above, which is plain only in form from here on.
    if (sealedSender === undefined && (push.body || push.keys?.length || push.insert !== undefined || push.files?.length || push.schedule !== undefined) && subscriberTrust?.sealedOnly()) {
        log(`! ${push.agentSessionName}: a plaintext command, and this listener only seals — drop`);
        deps.noteRefusal?.('e2ee_required');
        return false;
    }

    // A schedule request changes the schedules and types nothing, whichever way it came.
    if (push.schedule !== undefined) return handleScheduleRequest(push, push.agentSessionName, addressed, deps);

    // A command bound to a blocked prompt types only while that prompt is on screen. Checked
    // before anything is downloaded or typed, and before the rate limit is spent.
    if (push.ifPrompt !== undefined && !promptStillShown(push.ifPrompt, deps.capturePane ? deps.capturePane(push.agentSessionName) : capturePaneText(push.agentSessionName, undefined, true))) {
        log(`! ${push.agentSessionName}: the blocked prompt this command answers is gone — drop`);
        deps.noteRefusal?.('prompt_changed');
        return false;
    }

    // Key event (Esc / arrows / Enter) — no body, no attachments. Lets the
    // phone escape a full-screen modal (e.g. after `/usage`) that swallows
    // text input.
    if (push.keys?.length) {
        const tokens = resolveKeys(push.keys);
        if (!tokens) {
            log(`! ${push.agentSessionName}: unknown key(s) [${push.keys.join(' ')}] — drop`);
            deps.noteRefusal?.('unknown_key');
            return false;
        }
        const injected = tryInjectKeys(push.agentSessionName, tokens, deps, addressed);
        if (injected) deps.onKeysInjected?.(push.agentSessionName);
        return injected;
    }

    // Text without the submit — the phone answering a y/n prompt, or typing
    // half a command so a TUI menu opens. No attachments: an insert is a
    // partial line the user is still editing, and file paths appended to it on
    // their own rows would be in the way rather than useful.
    if (push.insert !== undefined) {
        if (push.body) {
            log(`! ${push.agentSessionName}: insert and body are mutually exclusive — drop`);
            deps.noteRefusal?.('invalid_command');
            return false;
        }
        return tryInject(push.agentSessionName, push.insert, deps, { submit: false, addressed });
    }

    // A shell refuses attachments (shellTextRefusal): say so before they land
    // on disk rather than after.
    if (push.files?.length && (deps.paneProbe ?? probePane)(push.agentSessionName)?.shellMarked) {
        log(`! ${push.agentSessionName}: attachments — refusing for a shell session`);
        deps.noteRefusal?.('shell_input');
        return false;
    }

    // Download any attachments BEFORE injecting so the agent can read the
    // local paths immediately. For a plain command a download-phase failure is
    // isolated: the body text still injects so the command itself isn't
    // blocked. A sealed command is typed whole or not at all.
    let paths: string[] = [];
    if (push.files?.length) {
        const download = deps.downloadAttachments ?? defaultDownloadAttachments;
        if (sealedSender) {
            // A sealed command is typed whole or not at all.
            try {
                paths = await download(push.pushId, push.files, { deviceId: me, senderPublicKey: sealedSender, files: sealedFiles });
            } catch (err) {
                log(`! ${push.agentSessionName}: a sealed attachment would not open (${(err as Error).message}) — command dropped`);
                deps.noteRefusal?.('attachment_failed');
                return false;
            }
            if (paths.length !== push.files.length) {
                log(`! ${push.agentSessionName}: ${push.files.length - paths.length} sealed attachment(s) missing — command dropped`);
                deps.noteRefusal?.('attachment_failed');
                return false;
            }
        } else {
            try {
                paths = await download(push.pushId, push.files);
            } catch (err) {
                log(`! ${push.agentSessionName}: attachment download failed — ${(err as Error).message}`);
                // With no text to type either, this is why nothing was typed.
                if (!push.body) deps.noteRefusal?.('attachment_failed');
            }
        }
    }

    return tryInject(push.agentSessionName, composeInjection(push.body ?? '', paths), deps, { submit: true, addressed, files: !!push.files?.length });
};

/**
 * Process one push. Returns true when it did something: an injection
 * fired, or a file was saved. Exported for unit testing with mocked deps.
 *
 * Two push types act here. `type='file'` addressed to this machine is saved
 * to ~/Downloads/Hwip/ (encrypted or not — this device opens its own
 * `deviceKeyMap` slot). `type='agent.command'` carrying an `agentSessionName`
 * (tmux session to inject into) and a non-empty `body` injects — in the
 * clear, or sealed for this machine with a command label (openSealedCommand,
 * M5). Everything
 * else (Stop-hook auto-pushes, hwip_ask responses, text/link notifications)
 * is ignored.
 */
/**
 * A `push.new` is whatever the relay sent, typed only by the cast at the WS
 * handler. Past this every field is read as the type `PushItem` declares: a
 * number for `keys`, a string for `files` or no `pushId` threw a TypeError out
 * of `handlePush` mid-way, and an empty `pushId` made the attachment folder the
 * one every such push shares. With no id the phone has nothing to match a
 * refusal frame to either, so a push that is not shaped like this is dropped.
 */
const hasPushShape = (push: unknown): push is PushItem => {
    if (typeof push !== 'object' || push === null) return false;
    const p = push as Record<string, unknown>;
    const text = (v: unknown): boolean => v === undefined || typeof v === 'string';
    return typeof p.pushId === 'string' && p.pushId !== ''
        && ['type', 'body', 'title', 'targetDeviceId', 'agentSessionName', 'insert'].every((k) => text(p[k]))
        && (p.keys === undefined || (Array.isArray(p.keys) && p.keys.every((k) => typeof k === 'string')))
        && (p.files === undefined || Array.isArray(p.files))
        && (p.schedule === undefined || (typeof p.schedule === 'object' && p.schedule !== null && !Array.isArray(p.schedule)));
};

export const handlePush = async (
    push: PushItem,
    deps: HandlePushDeps = {},
): Promise<boolean> => {
    if (!hasPushShape(push)) {
        log('! push.new ignored: its fields are not the shape a push has');
        return false;
    }
    let reason = null as CommandRefusal | null;
    const injected = await handlePushInner(push, {
        ...deps,
        // The first refusal is the cause; whatever follows is fallout.
        noteRefusal: (r) => { reason ??= r; },
    });
    // push.new reaches every listener of the account, and only the addressed
    // machine knows the command was meant for it: a stray machine saying
    // unknown_session would contradict the one that typed it.
    if (!injected && reason !== null && push.type === 'agent.command' && push.agentSessionName
        && push.targetDeviceId === (deps.deviceId?.() ?? computeListenerDeviceId())) {
        deps.reportRefusal?.({
            sessionName: push.agentSessionName,
            pushId: push.pushId,
            reason: reasonForPhone(reason, push.isEncrypted === true),
        });
    }
    return injected;
};

// ─── WS connect loop ─────────────────────────────────────────────────

const verifyTmux = (): void => {
    const r = spawnSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) {
        console.error('hwip listener: tmux not found on PATH. Install tmux first.');
        process.exit(127);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const computeBackoff = (attempt: number): number => {
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    const jitter = base * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(0, base + jitter);
};

interface SessionResult {
    /** Resolved with the close code if the server closed cleanly. */
    closeCode: number | null;
    /** Resolved with reason text for logging. */
    reason: string;
    /** True if the socket ever reached `open` — resets reconnect backoff. */
    connected: boolean;
}

/**
 * Stable per-host device id for the listener. We hash the OS hostname so
 * the same machine reuses the same DeviceRecord across listener restarts
 * (otherwise the phone's session inventory grows a new ghost device every
 * time `hwip listener` rebinds). `dev_listener_<sha8(hostname)>` keeps it
 * human-recognisable in dev logs without leaking the raw hostname.
 *
 * The no-arg result must identify the MACHINE, stably:
 * - NOT the hostname: macOS rewrites it on network changes (observed
 *   flip-flopping between 'Mac' and '<name>.local' within hours), which
 *   split one machine into several device rows — duplicated session lists
 *   on the phone, and screen-peek requests addressed to an id no live
 *   process answers for.
 * - NOT a file under ~/.hwip alone: users copy ~/.hwip to a new machine
 *   to carry their API key, and a copied id makes two machines answer for
 *   each other.
 * So: hash the platform machine id (IOPlatformUUID / /etc/machine-id) —
 * deterministic per machine, immune to both. The sticky file is only the
 * fallback when no machine id is readable at that moment. On macOS it holds the id of
 * the last successful read, so a start whose `ioreg` stalls still gets it (C109); where
 * no machine id can ever be read it holds the first hostname id. A machine id read always
 * wins over the file, so a copied `~/.hwip` cannot make two machines answer for each
 * other — except a Mac whose `ioreg` stalls just then, which takes the copied Mac's id.
 * Gap: a first start on macOS whose `ioreg` stalls has no file yet and runs on the
 * hostname id until it restarts.
 */
let processListenerDeviceId: string | undefined;

export const computeListenerDeviceId = (host?: string): string => {
    if (host !== undefined) return hashListenerId(host);
    if (processListenerDeviceId) return processListenerDeviceId;

    const machineId = readMachineId();
    if (machineId) {
        processListenerDeviceId = hashListenerId(machineId);
        // So a later start whose `ioreg` stalls reads this id back instead of falling to the hostname (C109).
        // macOS only: `ioreg` is the read that can stall. /etc/machine-id cannot, and a file saying the host's id
        // would be picked up by a container that shares the home but has no machine id of its own.
        if (process.platform === 'darwin') rememberListenerId(processListenerDeviceId);
        return processListenerDeviceId;
    }

    // No readable machine id — the id the last good start left in the sticky file.
    const saved = readStickyListenerId();
    if (saved) {
        processListenerDeviceId = saved;
        return saved;
    }

    // Nothing at all: the hostname hash, for this process. Where no machine id can ever be read it is
    // pinned to the file so hostname drift cannot split this machine; on macOS `ioreg` is always there and
    // not answering is a passing fault, so the hostname id is not written down — the next start recovers.
    processListenerDeviceId = hashListenerId(hostname());
    if (process.platform !== 'darwin') rememberListenerId(processListenerDeviceId);
    return processListenerDeviceId;
};

interface StreamHandle {
    done: Promise<SessionResult>;
    terminate: () => void;
    /** True once the socket reached `open` — the device record exists from then on. */
    opened: () => boolean;
    /** Send one frame; false when the socket is not open. Local transfer
     *  publishes its endpoint and this machine's public key this way
     *  (`listener.presence`) — the HTTP device route is JWT-only. */
    send: (msg: object) => boolean;
}

/**
 * Open one WebSocket and stream messages until it closes. `done` resolves
 * when the connection is gone; the outer loop decides whether to reconnect.
 * `terminate` lets a signal handler force-close from outside (otherwise
 * SIGINT during an open WS would hang the loop until the server closed).
 */
export const streamSession = (wsUrl: string, apiKey: string): StreamHandle => {
    let ws: WebSocket | null = null;
    let opened = false;
    const done = new Promise<SessionResult>((resolve) => {
        // deviceId + listenerNickname let the backend attach the connection
        // to a DeviceRecord (auto-created on first connect for apiKey auth).
        // Without these the `listener.sessions` reports are silently dropped
        // server-side and the phone's picker stays empty.
        // KNOWN TRADEOFF: apiKey rides the query string, so it can land in
        // API Gateway access logs. The $connect route can't read custom
        // headers from every WS client; moving to first-message auth needs a
        // server-side change (tracked upstream).
        const deviceId = computeListenerDeviceId();
        const nickname = hostname() || 'listener';
        const url = socketUrlWith(wsUrl, { apiKey, deviceId, listenerNickname: nickname });
        try {
            ws = new WebSocket(url, webSocketProxyOptions(url));
        } catch (err) {
            // The error quotes the URL, and the URL carries the API key.
            throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
        }
        const sock = ws;

        let pingTimer: NodeJS.Timeout | null = null;
        let sessionsTimer: NodeJS.Timeout | null = null;
        let connectTimer: NodeJS.Timeout | null = null;
        let stallTimer: NodeJS.Timeout | null = null;
        let loopMeterTimer: NodeJS.Timeout | null = null;
        // Milliseconds this thread was unavailable, and the reading taken when
        // the outstanding ping went out. The meter runs on the blocked thread
        // on purpose: its own lateness is the measurement.
        let loopStallMs = 0;
        let loopSampleAt = Date.now();
        // Reading taken the last time the server was heard from, so the
        // watchdog can ask how much of THIS silence was our own deafness.
        let loopStallAtLastTraffic = 0;
        let blockedSilenceLogged = false;
        // Updated on every server-acked round-trip (ack / pong). The
        // stall watchdog terminates the WS if this stays stale too long,
        // which lets the reconnect loop recover from half-open sockets
        // (suspended laptop, NAT drop, server unreachable but TCP alive).
        let lastRoundTripAt = Date.now();
        // When this listener last sent anything, over any path: the idle ping looks at it. Every send
        // goes through `sock.send`, so it is noted there once rather than at each of its callers.
        let lastSentAt = Date.now();
        const sendNow = sock.send.bind(sock) as (...args: unknown[]) => void;
        sock.send = ((...args: unknown[]) => { sendNow(...args); lastSentAt = Date.now(); }) as typeof sock.send;
        // Reports the server has not answered yet (REPORT_ACK_TIMEOUT_MS).
        const ackWatch = createReportAckWatch();

        const cleanup = (): void => {
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
            if (commandsTimer) { clearInterval(commandsTimer); commandsTimer = null; }
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            if (loopMeterTimer) { clearInterval(loopMeterTimer); loopMeterTimer = null; }
        };

        // If the WS doesn't reach OPEN within the timeout, kill it.
        // Otherwise an unreachable backend (DNS / route / SG drop) keeps
        // the socket in CONNECTING forever and `done` never resolves.
        connectTimer = setTimeout(() => {
            if (sock.readyState !== WebSocket.OPEN) {
                log(`! connect timeout after ${WS_CONNECT_TIMEOUT_MS / 1000}s — terminating`);
                sock.terminate();
            }
        }, WS_CONNECT_TIMEOUT_MS);

        // Report gate state — per connection on purpose: a fresh socket
        // must always send its first inventory (the server may have
        // nothing, or another listener's stale data, for this device).
        let lastSentFingerprint: string | null = null;
        let lastSentAtMs = 0;
        // A report sent in parts waits for each part's ack (sessions-report.ts): the listener's side of that wait.
        let partsInFlight = false;
        // The server echoes `reportId`/`part` in an ack: one that names another part (a late answer to a
        // report given up on) is not this wait's. An ack without them (a server that predates parts) counts.
        let ackWaiter: ((ack: { reportId?: unknown; part?: unknown }) => void) | null = null;
        const waitForSessionsAck = (reportId: string | undefined, part: number): Promise<boolean> =>
            new Promise((resolve) => {
                const timer = setTimeout(() => { ackWaiter = null; resolve(false); }, SESSIONS_ACK_TIMEOUT_MS);
                ackWaiter = (ack) => {
                    if ((ack.reportId !== undefined && ack.reportId !== reportId) || (ack.part !== undefined && ack.part !== part)) return;
                    clearTimeout(timer);
                    ackWaiter = null;
                    resolve(true);
                };
            });

        // Skill catalog (listener.commands): sent on connect, then only when a
        // rescan changes it. The rescan has its own slow timer — it reads the
        // filesystem, so it must never ride the 5 s session loop.
        let commandsTimer: ReturnType<typeof setInterval> | null = null;
        // Per connection, like the inventory gate above: `sock.send` returning
        // is not delivery, and a fingerprint that outlived the socket would let
        // one lost frame leave the server's catalog stale until the user next
        // installs a skill. Resending on reconnect costs the server one read —
        // its own `sameCommands` guard drops the write and the broadcast.
        let lastCommandsFingerprint: string | null = null;
        const reportCommands = (): void => {
            if (sock.readyState !== WebSocket.OPEN) return;
            // The scan is synchronous on the main thread. It stats one SKILL.md
            // per candidate directory and reads no skill files (132 stats here),
            // which is why it does not need the worker offload the tmux sweeps use.
            let scan: ScanResult;
            try {
                scan = scanAgentCommands(homedir());
            } catch (err) {
                // A failed scan keeps the previous catalog — an empty one sent
                // quietly would wipe the phone's menu until the next success.
                log(`! skill scan failed, keeping previous catalog: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            const fingerprint = commandsFingerprint(scan.catalog);
            if (!commandsReportDue(fingerprint, lastCommandsFingerprint)) return;
            // The frame embeds the exact serialized catalog — reuse the
            // fingerprint string instead of serializing a second time.
            sock.send(`{"type":"listener.commands","data":{"commands":${fingerprint}}}`);
            lastCommandsFingerprint = fingerprint;
            if (scan.dropped > 0) log(`! skill catalog over ${PAYLOAD_LIMIT_BYTES}B — dropped ${scan.dropped} skill(s)`);
            log(`reported skill catalog: ${Object.entries(scan.catalog).map(([k, v]) => `${k}:${v.length}`).join(', ') || '∅'}`);
        };

        let sweepInFlight = false;
        const reportSessions = async (): Promise<void> => {
            if (sock.readyState !== WebSocket.OPEN) return;
            // One sweep at a time: a slow sweep must not stack a second behind it.
            if (sweepInFlight) return;
            sweepInFlight = true;
            try {
                const inventory = inventoryOffload ? await inventoryOffload.collect() : collectSessionsVerbose();
                const sessions = await withSettledPrompts(inventory);
                if (sock.readyState === WebSocket.OPEN) publishSessions(inventory, sessions);
            } catch (err) {
                log(`! session sweep failed, skipping this cycle: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                sweepInFlight = false;
            }
        };
        const publishSessions = (inventory: CollectResult, sessions: AgentSession[]): void => {
            const { rejected, targets, subagentTranscripts, recordable } = inventory;
            recordInventory(sessions);
            worktreeCleanup.observe(sessions.map((s) => s.name));
            recordTargets(targets);
            recordSubagentTranscripts(subagentTranscripts);
            turnRecorder?.observe(recordable);
            // Let the user's own status bar say what the phone says. Change-gated
            // internally, so an unchanged sweep spawns nothing.
            syncTmuxAgentNames(sessions);
            // Watch hits are one-shot events — they go out on every poll,
            // independent of the sessions-report gate below.
            // (§S5 v2): probe watched panes and report hits; the server
            // consumes the record and the next ack prunes it locally.
            for (const hit of collectWatchHits(new Set(sessions.map((s) => s.name)))) {
                sock.send(JSON.stringify({ type: 'listener.watch.hit', data: hit }));
                log(`🔔 watch hit: ${hit.sessionName} ~ /${hit.pattern}/`);
            }
            // Unchanged inventory + heartbeat not due → skip the send.
            // The 5 s local poll above still ran, so a change is never
            // delayed; only the no-op reports (idle listener) are culled.
            // Past sessions ride the report that already exists rather than a
            // request of their own: the phone is already reading this device
            // record, and a second round trip would need its own timeout, its
            // own failure wording and its own staleness question.
            const known = knownSessionsToReport(sessions);
            const fingerprint =
                `${sessionsFingerprint(sessions)}␞${knownSessionsFingerprint(known)}`;
            if (!sessionsReportDue(fingerprint, lastSentFingerprint, lastSentAtMs, Date.now())) {
                return;
            }
            // A report in parts is still going out: the next one waits, so two never interleave.
            if (partsInFlight) return;
            // One message when it fits; past 24 KB, parts (sessions-report.ts): API Gateway closes a
            // socket on a frame over 32 KB, so an uncut report from a machine with ~100 sessions would
            // drop the connection on every send.
            const plan = planSessionsReport(sessions, known);
            if (plan.messages.length > 1) {
                log(`⧉ inventory of ${plan.sessionCount} session(s), ${Math.round(plan.wholeBytes / 1024)} KB, is over the ${SESSIONS_REPORT_MAX_BYTES / 1024} KB message limit — sent in ${plan.messages.length - 1} parts + names`);
                for (const name of plan.oversized) log(`! session ${name}: its own report entry is over the ${SESSIONS_REPORT_MAX_BYTES / 1024} KB part limit — sent alone`);
                if (plan.namesOversized) log(`! the list of ${plan.sessionCount} session names is over the ${SESSIONS_REPORT_MAX_BYTES / 1024} KB message limit — sent anyway, the connection may close`);
                // Parts wait for each other's ack, so this finishes later; the fingerprint is only recorded when it did.
                partsInFlight = true;
                ackWatch.sent(Date.now(), loopStallMs);
                void sendSessionsReport(plan.messages, (message) => sock.send(message), (part) => waitForSessionsAck(plan.reportId, part))
                    .then((sent) => {
                        if (!sent) { log('! a session report part was not acked in time — giving up on this report, retrying on the next poll'); return; }
                        lastSentFingerprint = fingerprint;
                        lastSentAtMs = Date.now();
                    })
                    .catch((err) => log(`! session report failed: ${err instanceof Error ? err.message : String(err)}`))
                    .finally(() => { partsInFlight = false; });
                return;
            }
            sock.send(plan.messages[0]!);
            ackWatch.sent(Date.now(), loopStallMs);
            lastSentFingerprint = fingerprint;
            lastSentAtMs = Date.now();
            // One line per send gives the user immediate feedback on
            // what the phone picker will see — particularly important
            // during setup, when an empty picker has no other observable
            // cause. (Skipped cycles stay quiet — same signal, less noise.)
            const names = sessions
                .map((s) => (s.state ? `${s.name}[${s.state}]` : s.name))
                .join(', ') || '∅';
            log(`reported ${sessions.length} session(s): ${names}`);
            // Explain skipped hwip-* sessions so the most common
            // confusion (pane lost its claude start_command after a
            // re-attach) shows up directly in the log.
            for (const r of rejected) log(`  skip ${r.name}: ${r.reason}`);
            // When the parsed result is empty AND nothing was rejected,
            // we likely have a tmux-visibility issue (different socket,
            // tmux server not running, etc.). Dump what tmux sees from
            // *this process's* perspective so the user can compare with
            // their interactive shell.
            if (sessions.length === 0 && rejected.length === 0) {
                const raw = spawnSync('tmux', tmuxArgs(['list-sessions', '-F', '#{session_name}']), {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                if (raw.status !== 0) {
                    const err = (raw.stderr ?? '').toString().trim() || 'no stderr';
                    log(`  diag: tmux list-sessions exit=${raw.status}, ${err}`);
                } else {
                    const all = (raw.stdout ?? '').trim().split('\n').filter(Boolean);
                    log(`  diag: tmux sees ${all.length} session(s) total: ${all.join(', ') || '∅'}`);
                    if (all.length > 0) {
                        log(`  diag: none start with "hwip-" — check wrapper output or run 'hwip cc' to verify naming`);
                    }
                }
            }
        };

        sock.on('open', () => {
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            opened = true;
            lastRoundTripAt = Date.now();
            log('connected');
            // The device record exists now — (re)publish where this machine
            // can be reached for a local transfer (lan-transfer.ts).
            lanTransfer?.onOpen();
            void deviceKeyRegistration?.onOpen().then((sent) => {
                if (sent) deviceKeyRegistered = true;
            });
            // Initial inventory so the phone's picker has something to
            // show as soon as the listener comes online.
            void reportSessions();
            sessionsTimer = setInterval(() => void reportSessions(), SESSION_REPORT_INTERVAL_MS);
            void reportCommands();
            commandsTimer = setInterval(reportCommands, COMMAND_SCAN_INTERVAL_MS);

            loopSampleAt = Date.now();
            loopMeterTimer = setInterval(() => {
                const now = Date.now();
                loopStallMs += Math.max(0, now - loopSampleAt - LOOP_SAMPLE_MS);
                loopSampleAt = now;
            }, LOOP_SAMPLE_MS);

            // Traffic, so that silence means something: an idle link would
            // otherwise look identical to a dead one.
            pingTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                if (!pingDue(lastSentAt, Date.now())) return;
                sock.send(JSON.stringify({ type: 'ping' }));
            }, PING_CHECK_MS);

            // The one watchdog. It reads wall-clock silence rather than a timer
            // it armed itself, so a suspended laptop — which pauses every JS
            // timer, including this one — is judged on how long it was actually
            // away and not on when the callback happened to run.
            stallTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                if (ackWatch.overdue(Date.now(), loopStallMs)) {
                    log(`! no answer to a report for ${REPORT_ACK_TIMEOUT_MS / 1000}s — terminating, the new connection reports again`);
                    sock.terminate();
                    return;
                }
                const silent = Date.now() - lastRoundTripAt;
                const verdict = heartbeatVerdict(silent, loopStallMs - loopStallAtLastTraffic);
                if (verdict === 'alive') return;
                if (verdict === 'blocked') {
                    if (!blockedSilenceLogged) {
                        blockedSilenceLogged = true;
                        log(`server quiet ${Math.round(silent / 1000)}s while this thread was blocked — leaving the socket alone`);
                    }
                    return;
                }
                log(`! no server traffic for ${Math.round(silent / 1000)}s — terminating`);
                sock.terminate();
            }, HEARTBEAT_CHECK_MS);
        });

        sock.on('message', (raw) => {
            lastRoundTripAt = Date.now();
            loopStallAtLastTraffic = loopStallMs;
            blockedSilenceLogged = false;
            let msg: unknown;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                return; // malformed — ignore
            }
            if (!msg || typeof msg !== 'object') return;
            const m = msg as { type?: string; data?: unknown; message?: string };
            if (m.type === 'pong') return;
            if (m.type === 'push.new' && m.data) {
                // Fire-and-forget: handlePush is async (attachment download)
                // but the WS read loop must stay responsive. Errors are
                // logged, never thrown into the socket handler.
                void handlePush(m.data as PushItem, {
                    reportRefusal: createRefusalReporter((data) => {
                        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ephemeral', data }));
                    }, refusalFrameLimit),
                    onKeysInjected: (session) =>
                        scheduleInjectSnapshots(session, (data) => {
                            if (sock.readyState === WebSocket.OPEN) {
                                sock.send(JSON.stringify({ type: 'ephemeral', data }));
                            }
                        }),
                }).catch((err) =>
                    log(`! handlePush: ${(err as Error).message}`));
            }
            if (m.type === 'ephemeral' && m.data) {
                // Screen peek (§S4): the phone asks for this machine's live
                // pane content over the ephemeral relay; the reply rides the
                // same channel. Nothing is persisted server-side.
                const sendEphemeral = (data: object) => {
                    if (sock.readyState === WebSocket.OPEN) {
                        sock.send(JSON.stringify({ type: 'ephemeral', data }));
                    }
                };
                // Live mirror (PoC): agent.stream.start/stop drives a
                // continuous, diff-gated frame loop; falls through to the
                // one-shot screen-peek when it isn't a stream-control message.
                // agent.command.input types into a streamed pane without the
                // REST round-trip; it is only accepted while that stream's
                // lease is live, so it sits behind the same routing chain.
                if (
                    !handleCommandInput(m.data as AgentCommandInput, sendEphemeral) &&
                    !handleStreamControl(m.data as StreamControl, sendEphemeral) &&
                    // The chat timeline's own control messages. Same envelope,
                    // same addressing rule, different source — a transcript file
                    // rather than the pane.
                    !handleTurnWatch(m.data as TurnWatchControl, sendEphemeral) &&
                    // A page of scrollback answers through `send` rather than by
                    // return value: on an encrypted stream it finishes after the
                    // seal, exactly like the frames it is history for.
                    !handleScreenHistoryRequest(m.data as ScreenHistoryRequest, sendEphemeral)
                    // Resume creates a process rather than typing into one, so
                    // it takes nothing from the wire but a session name — the
                    // rest comes from what this machine wrote down itself.
                    && !handleSessionResumeRequest(m.data as SessionResumeRequest, sendEphemeral)
                    && !handleSessionExitRequest(m.data as SessionExitRequest, sendEphemeral)
                    // Forget is the same envelope pointed the other way: it
                    // takes a name out of the record resume reads from.
                    && !handleSessionForgetRequest(m.data as SessionForgetRequest, sendEphemeral)
                    // Reading the session's changes: read-only git in the repo
                    // the registry recorded, never a path or command from here.
                    && !handleDiffFilesRequest(m.data as DiffRequest, sendEphemeral)
                    && !handleDiffFileRequest(m.data as DiffRequest, sendEphemeral)
                    // Reading its files: the visible set and every open are decided in file-view.ts,
                    // and the answer is sealed like the changes above.
                    && !handleFileTreeRequest(m.data as DiffRequest, sendEphemeral)
                    && !handleFileBlobRequest(m.data as DiffRequest, sendEphemeral)
                    // Reading the schedules: files this machine wrote itself, sealed for the asker.
                    && !handleScheduleListRequest(m.data as ScheduleListRequest, sendEphemeral)
                ) {
                    void handleScreenRequest(m.data as ScreenRequest)
                        .then((reply) => { if (reply) sendEphemeral(reply); })
                        .catch((err) => log(`! screen request: ${err instanceof Error ? err.message : err}`));
                }
            }
            // Surface server-side errors from listener.sessions reports.
            // Without this the daemon happily logs "reported N session(s)"
            // even when the server is silently dropping every message —
            // exactly how the picker-empty bug stayed hidden for weeks.
            if (m.type === 'listener.sessions.error') {
                ackWatch.answered(); // an answer, if not a good one: the server heard us
                log(`! server rejected listener.sessions: ${m.message ?? '(no detail)'}`);
                // A rejection that asks us to reconnect means the server has no
                // record of THIS socket — it was deleted while the socket stayed
                // open (a cleanup that fired on a transient error, a TTL sweep,
                // a redeploy). Nothing the daemon reports on this connection can
                // ever land again, and the inventory loop would go on reporting
                // into the void until a human restarted it: measured at eight
                // minutes of "reported 8 session(s)" with the phone showing no
                // agents at all. Dropping the socket is the whole recovery —
                // the reconnect loop registers a fresh connection.
                const action = staleConnectionAction(m.message, staleConnectionDrops);
                if (action === 'drop') {
                    staleConnectionDrops += 1;
                    log(`  ↻ dropping the socket to re-register (${staleConnectionDrops}/${MAX_STALE_CONNECTION_DROPS})`);
                    sock.close();
                } else if (action === 'exhausted') {
                    // Reconnecting did not help this many times in a row, so it
                    // is not the answer — and a daemon that reconnects on every
                    // report is worse than one that keeps logging.
                    log('  reconnecting did not help — leaving the socket up, reports still rejected');
                }
            }
            if (m.type === 'listener.sessions.ack') {
                const d = m.data as { count?: number; updatedAt?: string; watches?: unknown; reportId?: unknown; part?: unknown } | undefined;
                ackWaiter?.({ reportId: d?.reportId, part: d?.part });
                ackWatch.answered();
                // A report that landed proves this socket is registered.
                staleConnectionDrops = 0;
                log(`✓ server persisted ${d?.count ?? '?'} session(s)`);
                // Pattern watches ride the ack (§S5 v2) — refresh ours.
                setPatternWatches(d?.watches);
            }
            // `push.sync` (offline batch on $connect) and other types ignored.
        });

        sock.on('error', (err) => {
            log(`! ws error: ${err.message}`);
        });

        sock.on('close', (code, reasonBuf) => {
            stopAllStreams();
            // `send` is a closure over THIS socket, so a watcher that outlived it
            // would tick forever into a dead connection. Viewers re-arm with a
            // fresh watch.start after reconnecting, exactly as they re-lease a
            // terminal stream.
            turnWatchers.stopAll('socket closed');
            cleanup();
            resolve({ closeCode: code, reason: reasonBuf?.toString('utf-8') ?? '', connected: opened });
        });
    });

    return {
        done,
        terminate: () => { ws?.terminate(); },
        opened: () => opened,
        send: (msg) => {
            if (ws?.readyState !== WebSocket.OPEN) return false;
            ws.send(JSON.stringify(msg));
            return true;
        },
    };
};

// Resolution (and its precedence) lives in ws-url.ts so `hwip verify` can ask
// the same question without loading this module. Re-exported because
// listener.test.ts has always asked it here.
export { resolveWsUrl } from './ws-url.js';

// ── Singleton guard (PID file) ──────────────────────────────────────

/**
 * The live pid on record when it is not us, for `--stop` / `--restart`:
 * `stopListener` checks its command line and names a stranger to the user.
 * The startup guard asks `otherListenerPid`, which checks the command line
 * too, so a reused pid cannot make the wrapper's autostart or launchd's
 * daemon bow out to a process that is not a listener.
 *
 * Stale PID files (process gone) are treated as "no listener" so the
 * wrapper can recover from crashes without manual cleanup.
 */
const otherListenerAlive = (): number | null => {
    const pid = runningListenerPid();
    return pid === null || pid === process.pid ? null : pid;
};

const writeListenerPid = (wsUrl?: string): void => {
    try {
        // Stamp the version alongside the pid: `npm i -g` swaps the package
        // on disk without touching this already-running process, and the
        // stamp is how `hwip cc` notices the drift and restarts us. The socket
        // goes with it so `hwip verify` can say what this daemon is actually
        // connected to without reading a log that rotates out from under it.
        writeListenerRuntime(VERSION, wsUrl);
    } catch (err) {
        log(`! could not write ${LISTENER_PID_FILE}: ${(err as Error).message}`);
    }
};

const removeListenerPid = (): void => clearListenerRuntime(process.pid);

/**
 * `--stop` / `--restart`: the daemon is a background service, so the only
 * way to replace a stale one used to be hunting its pid by hand. `--restart`
 * relaunches detached (not in the caller's foreground) because restarting is
 * an ops action — the user wants their shell back, not a new daemon pinned
 * to it.
 */
const handleListenerLifecycle = async (restart: boolean): Promise<number> => {
    // launchd owns the process when the login-time service is installed:
    // signalling the pid ourselves would have launchd start a replacement
    // behind our back. `bootout` and not `disable` — see listener-service.ts.
    if (serviceInstalled()) {
        const logOffset = listenerLogSize();
        const previousPid = runningListenerPid();
        const result = restart ? restartService() : stopService();
        if (!result.ok) {
            console.error(`hwip listener: ${result.reason}`);
            return 1;
        }
        for (const note of result.notes) console.log(`hwip listener: ${note}`);
        // A restarted daemon that dies on a missing or rejected key is
        // restarted by launchd on a loop; "restarted" alone hid that.
        if (restart && reportFailedRestart(await awaitServiceListener(logOffset, previousPid))) return 1;
        return 0;
    }

    const pid = otherListenerAlive();
    if (pid) {
        const stopped = await stopListener(pid);
        if (stopped.kind === 'foreign') {
            console.log(`hwip listener: left pid ${pid} alone — the pid file pointed at another process (${stopped.program})`);
        } else if (stopped.kind === 'unchecked') {
            console.error(`hwip listener: could not check pid ${pid} (${stopped.reason}) — nothing was stopped`);
            return 1;
        } else if (stopped.kind === 'other-listener') {
            console.error(`hwip listener: ${otherListenerNote(pid, stopped.script)}`);
            return 1;
        } else if (stopped.kind === 'gone') {
            console.log(`hwip listener: pid ${pid} had already exited`);
        } else {
            console.log(`hwip listener: stopped pid ${pid}${stopped.kind === 'killed' ? ' (forced)' : ''}`);
        }
    } else {
        console.log('hwip listener: no listener running');
        // A pid file left behind by a crashed daemon would otherwise keep
        // tripping the singleton guard on the next start.
        clearStaleListenerRuntime();
    }
    if (!restart) return 0;
    const started = await startListenerDetached();
    if (started.kind === 'not-spawned') {
        console.error('hwip listener: could not resolve the cli entry to respawn — run `hwip listener` manually.');
        return 1;
    }
    if (reportFailedRestart(started)) return 1;
    console.log(`hwip listener: restarted in background (log: ${LISTENER_LOG_FILE})`);
    return 0;
};

/** Say why the restarted listener is not running; true when it is not. */
const reportFailedRestart = (started: ListenerStart): boolean => {
    const why = startFailure(started);
    if (why === null) return false;
    console.error(`hwip listener: the listener stopped right after restarting — ${why} (log: ${LISTENER_LOG_FILE})`);
    return true;
};

/**
 * `--install-service` / `--uninstall-service` / `--service-status`: the
 * LaunchAgent that starts this daemon at login. Runs before verifyTmux for the
 * same reason the lifecycle flags do — reporting or removing a service must not
 * need a healthy tmux (and installing does its own, better, tmux check).
 */
const handleServiceFlags = async (args: Record<string, string | boolean>): Promise<number> => {
    const say = (notes: readonly string[]): void => {
        for (const note of notes) console.log(`  ${note}`);
    };

    if (flagOn(args, 'install-service')) {
        const result = await installService();
        say(result.notes);
        if (!result.ok) {
            console.error(`hwip listener: ${result.reason}`);
            return 1;
        }
        console.log(`hwip listener: ${SERVICE_LABEL} installed — the listener now starts at every login.`);
        return 0;
    }

    if (flagOn(args, 'uninstall-service')) {
        const result = await uninstallService();
        say(result.notes);
        if (!result.ok) {
            console.error(`hwip listener: ${result.reason}`);
            return 1;
        }
        console.log('hwip listener: login-time service removed. `hwip cc` still autostarts the daemon.');
        return 0;
    }

    const status = serviceStatus();
    if (!status.supported) {
        // macOS keeps its wording byte for byte; Linux names what is missing
        // instead of claiming to be macOS.
        console.log(process.platform === 'darwin'
            ? 'hwip listener: login-time service is macOS-only (launchd).'
            : status.manager === 'systemd'
                ? 'hwip listener: the unit is installed but no systemd user manager answered — check `systemctl --user`.'
                : 'hwip listener: login-time service needs systemd (`systemctl --user`) or macOS launchd.');
        return 0;
    }
    if (!status.installed) {
        console.log('hwip listener: no login-time service — run `hwip listener --install-service`.');
        return 0;
    }
    console.log(`hwip listener: ${status.label} installed`);
    console.log(`  ${status.manager === 'systemd' ? 'unit' : 'plist'}: ${status.plistPath}`);
    console.log(`  node:  ${status.nodePath ?? '(unreadable)'}`);
    console.log(`  cli:   ${status.cliPath ?? '(unreadable)'}`);
    console.log(`  PATH:  ${status.pathEnv ?? '(unreadable)'}`);
    if (status.missing.length > 0) {
        console.error(`  ! missing: ${status.missing.join(', ')} — re-run \`hwip listener --install-service\``);
        return 1;
    }
    return 0;
};

/**
 * What the listener starts with that comes from the flags, the environment and `config.json`:
 * the key, where it goes, and the opt-out options. A config.json that is there and cannot be used
 * reads as every option off (`unreadableConfigDefaults`), and the listener keeps running (a clean
 * exit takes the launchd service down, an unclean one restarts it every 30 s). Its own function so a
 * test can drive it without a socket.
 */
export type ListenerSettings =
    | { exit: number; message: string }
    | { config: HwipConfig; apiKey: string; baseUrl: string; features: ReturnType<typeof optionalFeatures>; ignored: string | null };

export const listenerSettings = (args: Record<string, string | boolean>): ListenerSettings => {
    const config = loadConfig();
    const apiKey = (args.key as string) || resolvedEnv('HWIP_API_KEY') || config.apiKey;
    const ignored = configIgnoredBecause();
    // A flag typed wrong comes first, as in `main`: nothing else is worth reporting while the command is not understood.
    let features: ReturnType<typeof optionalFeatures>;
    try {
        features = optionalFeatures(args, config);
    } catch (err) {
        if (err instanceof FlagValueError) return { exit: 2, message: `hwip listener: ${err.message}` };
        throw err;
    }
    if (!apiKey) {
        return {
            exit: 3,
            message: ignored
                ? `hwip listener: no API key — ${ignored}; the key in it is not read until it is fixed or moved aside (or set HWIP_API_KEY)`
                : 'hwip listener: API key required. Run `hwip install` or set HWIP_API_KEY.',
        };
    }
    let baseUrl: string;
    try {
        // Base URL for attachment downloads (GET /v1/files/{fileKey}). Same resolution order as the rest of the CLI.
        baseUrl = resolveBaseUrl(args['base-url'], config, keyIsFromFile(args.key as string, config));
    } catch (err) {
        return { exit: 1, message: `hwip listener: ${(err as Error).message}` };
    }
    return { config, apiKey, baseUrl, features, ignored };
};

/**
 * What the schedule runner touches on this machine. A launch is `hwip <agent> --detach` run as a child of the
 * listener, in the schedule's directory with argv as an array; the project-dir env vars are dropped so the
 * child resolves its project from that directory, not from whatever shell started the listener.
 */
export const liveScheduleRunnerDeps = (notify: ScheduleRunnerDeps['notify']): ScheduleRunnerDeps => ({
    listSchedules,
    readState: readScheduleState,
    writeState: writeScheduleState,
    sessionExists,
    sessionEnded: (session) => sessionLiveness(session) === 'ended',
    directoryExists: (cwd) => {
        try {
            return statSync(cwd).isDirectory();
        } catch {
            return false;
        }
    },
    subcommandFor: (kind) => REMOTE_AGENTS.find((a) => a.kind === kind)?.subcommands[0],
    launch: launchHwip,
    sleep: wait,
    log,
    // The bundled rules only (schedule-ready.ts says why): nobody watches a scheduled prompt being typed.
    canPrompt: canPromptKind,
    ready: createReadyCheck({
        foregroundIsAgent: (session, kind) => foregroundAgentFor(readPaneInfo(session).panePid ?? 0)?.kind === kind,
        screenOf: (session) => capturePane(session, false, STATE_CAPTURE_LINES)?.content ?? null,
        stateOf: scheduleScreenState,
    }),
    // Not addressed: a scheduled session is an agent session, so the guard that keeps unaddressed input out of a `hwip sh`
    // shell stays on. Like a phone's input, the prompt leaves the remote marker, so the run's end is reported to the phone.
    inject: (session, prompt) => tryInject(session, prompt, {}, { submit: true, addressed: false }),
    endSession: (session) => {
        endBySignals(session).then(
            (gone) => log(`⏻ schedule ${session}: ${gone ? 'ended' : 'still running after the exit signals'}`),
            (e: unknown) => log(`! schedule ${session}: ending failed: ${e instanceof Error ? e.message : String(e)}`),
        );
    },
    notify,
});

export const handleListener = async (args: Record<string, string | boolean>): Promise<number> => {
    // Service flags first: they neither need nor start a daemon in this process.
    if (flagOn(args, 'install-service') || flagOn(args, 'uninstall-service') || flagOn(args, 'service-status')) {
        return handleServiceFlags(args);
    }

    // Lifecycle flags run before verifyTmux — stopping a daemon shouldn't
    // require a healthy tmux.
    if (flagOn(args, 'stop') || flagOn(args, 'restart')) return handleListenerLifecycle(flagOn(args, 'restart'));

    verifyTmux();

    // Refuse to start when another listener is already running. The
    // wrapper's autostart calls us blindly on every `hwip cc`; the user
    // running `hwip listener` directly does too. Bail with exit 0 (not
    // an error — there *is* a listener, just not us).
    const otherPid = otherListenerPid();
    if (otherPid) {
        if (process.env.HWIP_LISTENER_AUTOSTART === '1') {
            // Autostart from the wrapper — stay quiet on the happy path.
            return 0;
        }
        console.error(`hwip listener: another listener is already running (pid ${otherPid}). ` +
            `Tail \`~/.hwip/listener.log\` to follow it, or kill ${otherPid} first.`);
        return 0;
    }

    const settings = listenerSettings(args);
    if ('exit' in settings) {
        console.error(settings.message);
        return settings.exit;
    }
    const { config, apiKey, baseUrl, features, ignored } = settings;
    setAttachmentContext({ apiKey, baseUrl });
    warnInsecureUrl(baseUrl);

    const fileKey = keyIsFromFile(args.key as string, config);
    const staleWsEnv = legacyWsEnvNotice(config, process.env, fileKey ? { baseUrl } : undefined);
    if (staleWsEnv) console.error(staleWsEnv);
    const wsUrl = resolveWsUrlDetailed(args, config, baseUrl, fileKey)?.url ?? null;
    if (!wsUrl) {
        console.error(
            'hwip listener: WebSocket URL not set. Either:\n' +
            '  • add "wsUrl": "wss://..." to ~/.hwip/config.json\n' +
            '  • pass --ws-url wss://...',
        );
        return 1;
    }
    const wsProblem = wsUrlProblem(wsUrl);
    if (wsProblem) {
        console.error(`hwip listener: ${wsProblem}. Set "wsUrl" in ~/.hwip/config.json or pass --ws-url wss://...`);
        return 1;
    }

    warnInsecureUrl(wsUrl);
    writeListenerPid(wsUrl);
    process.on('exit', removeListenerPid);

    // Rotate before writing anything, so this run's first line lands in the
    // file the user tails rather than being copied straight into `.old`. The
    // daemon owns this: under the login-time LaunchAgent nothing else runs
    // first — launchd opens StandardOutPath and execs us directly.
    rotateListenerLogIfLarge();

    // A config.json that is there and cannot be used reads as every option off (`unreadableConfigDefaults`):
    // the opt-outs in it are unknown, and the safe answer to an unknown opt-out is "off". Say so where the user tails.
    if (ignored) {
        log(`! ${ignored} — running with the options off (turn history, keep-awake) until it is fixed; restart the listener after`);
    }

    // After the rotation, so its first line (on or off) lands in the log the user tails.
    const deviceDirectory = createDeviceDirectory({ apiKey, baseUrl, log });
    startTurnRecorder(features, apiKey, baseUrl, deviceDirectory.devices);

    // Version on the first line: the only way to tell which build a
    // long-lived daemon is actually running (an `npm i -g` days ago says
    // nothing about the process that's been up since before it).
    log(`hwip listener starting — v${VERSION} — ${redactSecrets(wsUrl)}`);
    log(`device=${computeListenerDeviceId()} host=${hostname()} pid=${process.pid}`);
    log("Waiting for 'agent.command' pushes from the phone picker. Ctrl-C to stop.");
    // What the app shows for this computer has to read the same (`hwip trust`).
    void initDeviceCrypto()
        .then((publicKey) => log(`key fingerprint ${keyFingerprint(publicKey) ?? '(unreadable)'}`))
        .catch((err) => log(`! device key unavailable: ${err instanceof Error ? err.message : err}`));
    const staleFits = releaseStaleFits(runTmux);
    if (staleFits > 0) log(`⧉ gave back ${staleFits} window(s) a previous listener had fitted to a phone`);

    // Idle sleep kills the socket; "Wake for network access" does not bring it
    // back (see keep-awake.ts). Flag beats config; the default is on.
    const keepAwake = startKeepAwake({
        enabled: features.keepAwake,
        log,
    });

    // Heartbeat memory log — once an hour. Lets the user (and us) spot
    // gradual growth in a long-running daemon before it gets bad enough
    // to make the host shell unresponsive. The MB counter is human-
    // readable and tiny enough not to bloat the log.
    const HEAP_LOG_INTERVAL_MS = 60 * 60 * 1000;
    const heapLogTimer = setInterval(() => {
        const m = process.memoryUsage();
        const mb = (n: number) => Math.round(n / 1024 / 1024);
        log(`heap: rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB`);
    }, HEAP_LOG_INTERVAL_MS);
    heapLogTimer.unref();

    // Sweep stale attachment dirs at startup, then hourly. Keeps
    // ~/.hwip/attachments from growing without bound over a long run. The
    // same pass drops the `.part` temps a crash mid-download left in
    // ~/Downloads/Hwip — the user's files there are never touched.
    const sweepAttachments = (): void => {
        const n = gcAttachments();
        if (n > 0) log(`gc: removed ${n} stale attachment dir(s)`);
        const parts = sweepStaleParts();
        if (parts > 0) log(`gc: removed ${parts} unfinished download(s) from ${downloadsDir()}`);
    };
    sweepAttachments();
    const gcTimer = setInterval(sweepAttachments, 60 * 60 * 1000);
    gcTimer.unref();

    // Rotate our own log. `spawnListenerDetached` rotates before it opens the
    // file, but the login-time LaunchAgent never goes through that function —
    // launchd opens StandardOutPath itself. Left alone, a daemon that survives
    // logins for weeks writes an unbounded log, so the daemon rotates itself.
    const logRotateTimer = setInterval(rotateListenerLogIfLarge, 60 * 60 * 1000);
    logRotateTimer.unref();

    // Agent detection rules: disk cache immediately (offline-safe),
    // then a background OTA refresh now and every 6 h (§S7).
    loadManifestFromCache();
    const refreshRules = (): void => {
        void refreshManifest().then((r) => {
            log(`rules: source=${r.source} outcome=${r.outcome}${r.version ? ` version=${r.version}` : ''}`);
        });
    };
    refreshRules();
    const rulesTimer = setInterval(refreshRules, RULES_REFRESH_INTERVAL_MS);
    rulesTimer.unref();

    // Scheduled sessions (F8): ticks for the daemon's whole life, whether or not the socket is up.
    const scheduleHook = new HwipHook({ apiKey, baseUrl });
    // A push that fails is tried again every tick with the same text; the desktop banner and the log line come once per text.
    let shownOnDesktop = '';
    const notifySchedules = async (title: string, body: string): Promise<NotifyOutcome> => {
        if (body !== shownOnDesktop) {
            shownOnDesktop = body;
            log(`schedules: ${title} — ${body.replace(/\n/g, ' / ')}`);
            void notifyDesktop({ title, body });
        }
        try {
            await scheduleHook.notify({ title, body, type: 'note' });
            shownOnDesktop = '';
            return 'sent';
        } catch (e) {
            log(`! schedules: push failed: ${e instanceof Error ? e.message : String(e)}`);
            // A 4xx (a daily limit among them) says no to this push itself; asking again every few minutes cannot change that.
            return notifyFailureOutcome(e);
        }
    };
    const scheduleRunner = createScheduleRunner(liveScheduleRunnerDeps(notifySchedules));
    const runScheduled = (work: (now: number) => Promise<void>): void => {
        work(Date.now()).catch((e: unknown) => log(`! schedules: ${e instanceof Error ? e.message : String(e)}`));
    };
    runScheduled(scheduleRunner.tick);
    const scheduleTimer = setInterval(() => runScheduled(scheduleRunner.tick), SCHEDULE_TICK_MS);
    scheduleTimer.unref();
    const promptTimer = setInterval(() => runScheduled(scheduleRunner.poll), PROMPT_POLL_MS);
    promptTimer.unref();

    let shuttingDown = false;
    let activeHandle: StreamHandle | null = null;
    // Resolved by stop() so the reconnect backoff sleep below can be
    // interrupted — otherwise a SIGINT during the (up to 30s) backoff waits
    // out the full delay before the loop notices shuttingDown.
    let notifyStop: () => void = () => undefined;
    let lanClearing: Promise<void> | null = null;
    const stopped = new Promise<void>((resolve) => { notifyStop = resolve; });

    // Local transfer (ADR-0013): bind once the device keypair is loaded —
    // every route the receiver grows authenticates with it — publish on WS
    // open, retract on stop. Off with one log line if keys or bind fail.
    // Both halves of `listener.presence` ride whatever socket is live right
    // now; between connections there is nothing to send on, and the next
    // open republishes.
    const sendPresence = (msg: object): boolean => activeHandle?.send(msg) ?? false;
    setSubscriberTrust(createSubscriberTrust({
        path: TRUST_FILE,
        registeredKey: deviceDirectory.publicKeyOf,
        nameOf: async (deviceId) => (await deviceDirectory.devices()).find((d) => d.deviceId === deviceId)?.nickname,
        log,
    }));
    deviceKeyRegistration = createDeviceKeyRegistration({ log, send: sendPresence, publicKey: initDeviceCrypto });
    lanTransfer = createLanTransfer({
        log,
        initCrypto: async () => { await initDeviceCrypto(); },
        startReceiver: ({ onError }) => startLanReceiver({
            log,
            onError,
            deviceId: computeListenerDeviceId,
            lookupSenderPublicKey: deviceDirectory.publicKeyOf,
            deriveSharedSecret: deriveLanSharedSecret,
            unwrapFileKey: unwrapDeviceKey,
            landingDir: () => LAN_LANDING_DIR,
        }),
        createPublisher: () => createLanPublisher({ log, send: sendPresence }),
        isOpen: () => activeHandle?.opened() ?? false,
    });

    const stop = (sig: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`received ${sig}, stopping`);
        // Force-close any open WS so the streamSession promise resolves
        // immediately instead of waiting for the server to drop us.
        activeHandle?.terminate();
        keepAwake.stop();
        // Retract the endpoint so no sender is pointed at a port about to
        // close; the loop tail waits (briefly) for this PUT before exiting.
        if (lanTransfer) {
            lanClearing = lanTransfer.stop();
            lanTransfer = null;
        }
        deviceKeyRegistration = null;
        notifyStop();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    inventoryOffload = startInventoryOffload(collectSessionsVerbose, log);
    let attempt = 0;
    while (!shuttingDown) {
        activeHandle = streamSession(wsUrl, apiKey);
        const result = await activeHandle.done;
        activeHandle = null;

        if (AUTH_FAILURE_CODES.has(result.closeCode ?? -1)) {
            console.error(`hwip listener: auth failure (${result.closeCode} ${result.reason}). Check API key.`);
            inventoryOffload.close();
            removeListenerPid();
            return 3;
        }

        if (shuttingDown) break;

        // A session that actually connected resets the backoff — otherwise a
        // long-lived daemon on a flaky link ratchets up to the 30s ceiling
        // permanently, even when every reconnect succeeds instantly.
        if (result.connected) attempt = 0;

        const delay = computeBackoff(attempt);
        log(`disconnected (code=${result.closeCode}) — reconnect in ${Math.round(delay / 1000)}s`);
        await Promise.race([sleep(delay), stopped]);
        attempt = Math.min(attempt + 1, 10);
    }

    // `main` calls process.exit right after this returns. The cap keeps
    // Ctrl-C from hanging on a receiver that will not close and keeps the
    // exit ahead of stopListener's SIGKILL (see LAN_RETRACT_WAIT_MS).
    if (lanClearing) {
        log('retracting local transfer endpoint…');
        await Promise.race([lanClearing, sleep(LAN_RETRACT_WAIT_MS)]);
    }
    inventoryOffload.close();
    removeListenerPid();
    return 0;
};
