/**
 * Push-gate decision — the portable half of the Hwip Stop-hook logic.
 *
 * `decidePush` is the TS twin of `plugin/hooks/gate.sh` (hwipit/plugin).
 * Both implementations are locked to the same semantics by the shared
 * vector file `src/fixtures/gate-vectors.json` (vendored from the plugin
 * repo's canonical copy via `npm run sync:plugin`): the bash side and this
 * side run the exact same cases in their CIs, so a semantic change to one
 * that isn't mirrored in the other fails a build. Edit them together.
 *
 * Ordering is contractual (encoded as named vectors):
 *   1. alreadyAsked wins over EVERYTHING — even loud (dedup beats the dial).
 *   2. priority is high iff marker === 'high', decided BEFORE the mode
 *      switch, so quiet+high and loud+high both push at high priority.
 *   3. quiet → a high marker or an away user pushes; loud → always push; normal →
 *      marker overrides the heuristic (skip → silent, push/high → push),
 *      no marker → push iff toolCount ≥ 2 AND nonReadonlyCount > 0
 *      (the B1 read-only floor).
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createdHandedBack, mkdirHandedBack } from './private-files.js';

export type GateMarker = 'skip' | 'push' | 'high' | 'none';
export type GatePushMode = 'quiet' | 'loud' | 'normal';

export interface GateInput {
  /** Total tool_use blocks this turn. */
  toolCount: number;
  /** Tools that are NOT read-only (Read/Grep/Glob). */
  nonReadonlyCount: number;
  /** A hwip_ask already notified this turn. */
  alreadyAsked: boolean;
  marker: GateMarker;
  pushMode: GatePushMode;
  /** The user is away from the terminal (presence.ts awayForGate) — lets quiet
   *  push. Optional so existing callers keep compiling; absent = present,
   *  matching the bash twin's missing 6th argument. */
  away?: boolean;
}

export interface GateVerdict {
  push: boolean;
  priority: 'high' | 'normal';
}

/**
 * "Assume real work" defaults for hooks that can't supply turn facts
 * (most non-Claude agents pass no counts): in normal mode the push still
 * fires — preserving the historical always-push behavior of the dumb
 * hooks — while quiet/loud now work everywhere.
 *
 * These defaults cannot rescue a quiet dial: quiet only lets a `high` marker
 * or an away user (presence.ts) through, and a hook with no turn facts has no
 * marker either. That is why the installed templates pass `--pushmode-default
 * normal` (see templates.ts) — for them quiet is not a lower volume, it is
 * silence while the user is at the terminal.
 */
export const GATE_DEFAULTS = {
  toolCount: 2,
  nonReadonlyCount: 1,
  alreadyAsked: false,
} as const;

export const normalizeMarker = (raw: string | undefined): GateMarker =>
  raw === 'skip' || raw === 'push' || raw === 'high' ? raw : 'none';

export const normalizePushMode = (raw: string | undefined): GatePushMode =>
  raw === 'quiet' || raw === 'loud' ? raw : 'normal';

export const decidePush = (input: GateInput): GateVerdict => {
  if (input.alreadyAsked) return { push: false, priority: 'normal' };

  const priority = input.marker === 'high' ? 'high' : 'normal';

  if (input.pushMode === 'quiet') return { push: input.marker === 'high' || input.away === true, priority };
  if (input.pushMode === 'loud') return { push: true, priority };

  if (input.marker === 'skip') return { push: false, priority };
  if (input.marker === 'push' || input.marker === 'high') return { push: true, priority };
  return { push: input.toolCount >= 2 && input.nonReadonlyCount > 0, priority };
};

// ── Per-project gate state (mute + push-mode dial) ───────────────
//
// State lives under ${XDG_STATE_HOME:-~/.local/state}/hwip — a per-user
// directory. It used to live at predictable names in world-writable /tmp,
// where any local user could pre-create a victim's mute file (and sticky
// /tmp makes that file un-deletable by the victim). Legacy /tmp files are
// still honored during the migration window, but only when owned by the
// current user, which neutralizes planted files.
//
// The plugin's bash hooks key these files off `cksum` of the project dir
// (`printf '%s' "$dir" | cksum`). `posixCksum` is that CRC computed in
// process — a notify used to spawn `cksum` up to ~8 times — and the vector
// test pins it to the real `cksum`, so every already-written file keeps its name.

export const stateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'hwip');

const ownedByCurrentUser = (path: string): boolean => {
  try {
    const st = statSync(path);
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch {
    return false;
  }
};

/**
 * Resolve a state file: current location first, then user-owned legacy /tmp,
 * then — for `pushmode` only — the machine-wide default written by
 * `/hwip-mode quiet --global`. Mirrors plugin/hooks/gate.sh hwip_state_present,
 * including the deliberate absence of a global mute (see the comment there).
 */
const findStateFile = (kind: 'muted' | 'pushmode', hash: string): string | null => {
  const current = join(stateDir(), `${kind}-${hash}`);
  if (existsSync(current)) return current;
  const legacy = `/tmp/hwip-${kind}-${hash}`;
  if (ownedByCurrentUser(legacy)) return legacy;
  if (kind !== 'pushmode') return null;
  const globalDefault = join(stateDir(), 'pushmode-default');
  return existsSync(globalDefault) ? globalDefault : null;
};

/** CRC table for POSIX `cksum`: polynomial 0x04C11DB7, most significant bit first. */
const CKSUM_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * The first field of POSIX `cksum` over `data`: the CRC of the bytes, then of
 * the length (low byte first, no trailing zero bytes), complemented.
 */
export const posixCksum = (data: Uint8Array): number => {
  let crc = 0;
  const step = (byte: number) => {
    crc = ((crc << 8) ^ CKSUM_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  };
  for (const byte of data) step(byte);
  for (let n = data.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return ~crc >>> 0;
};

/** `cksum` of the project dir as the plugin computes it. */
export const projectHash = (dir: string): string => String(posixCksum(Buffer.from(dir, 'utf-8')));

// ── Remote-origin marker (ADR-0002) ──────────────────────────────
//
// The listener records every phone→pane text injection as a one-shot
// marker file; a prompt-submit hook (Claude Code plugin's hwip-remote.sh,
// or `hwip remote-hook` for Gemini/Codex) consumes it on an exact-text
// match and flags the prompt as remote-originated. Writer and TS reader
// share these two helpers so their bytes can never diverge; the bash
// reader is held to the same semantics by the plugin's test suite.

/** Marker path for a project hash: `<stateDir>/remote-<cksum(projectDir)>`. */
export const remoteMarkerPath = (hash: string): string => join(stateDir(), `remote-${hash}`);

/**
 * sha256 over the ASCII-only-trimmed text — recorded at inject time,
 * recomputed at prompt submit. Trim strips ONLY ' \t\r\n\f\v', NOT
 * String.trim(): trim() also eats Unicode whitespace (U+00A0 etc.) that
 * the bash reader keeps, and both sides must hash identical bytes.
 */
export const remoteDigest = (text: string): string =>
  createHash('sha256')
    .update(text.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, ''))
    .digest('hex');

// ── Sticky REMOTE state ──────────────────────────────────────────
//
// The marker above is a ONE-SHOT entry signal, consumed the moment a prompt
// matches it. REMOTE outlives that turn — the user can answer from the phone
// and then type at the terminal — so the mode itself lives in
// `remote-active-<hash>`, holding the epoch second it was last confirmed.
// Keeping it in a file is also what lets it survive context compaction.
// Bash twin: plugin/hooks/gate.sh hwip_remote_active / hwip_remote_touch.
//
// Deliberately not routed through findStateFile. That helper also honors a
// legacy /tmp copy so files written by older versions keep working; this kind
// has never had a /tmp writer, so the branch could only ever match something
// stale — and since the refresh always writes the XDG path, such a file would
// never expire.

/**
 * How long REMOTE stays live without a refresh. Generous on purpose: the state
 * is refreshed on every phone prompt and every answered `hwip_ask`, so it only
 * has to outlive a working session, never an idle user. It is the backstop and
 * not the usual exit — a terminal-typed prompt, a Done-like answer and the
 * model's `<!-- hwip: exit -->` all delete the file outright. What none of them
 * covers is a session that simply died: there is no SessionEnd hook, so without
 * a TTL a crash or Ctrl-C would latch REMOTE forever.
 */
export const REMOTE_TTL_SEC = 14400;

/** State path for a project hash: `<stateDir>/remote-active-<cksum(dir)>`. */
export const remoteStatePath = (hash: string): string =>
  join(stateDir(), `remote-active-${hash}`);

/**
 * True while REMOTE is live for this project. A time ahead of the clock counts
 * as now (and is rewritten as now). State that is expired or
 * unparseable is deleted on sight — the same housekeeping a stale entry
 * marker gets, since state that can never flag again is dead weight.
 */
export const isRemoteActive = (dir: string, now: () => number = Date.now): boolean => {
  const hash = projectHash(dir);
  const file = remoteStatePath(hash);
  let raw: string;
  try {
    // The first line, without the spaces around it: what `read -r ts` hands the bash twin.
    raw = (readFileSync(file, 'utf-8').split('\n')[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
  } catch {
    return false;
  }
  // A plain number of at most 12 digits, matching the bash twin (`hwip_age_sec`): digits only
  // (Number() alone reads '1e10' as ten billion, so a file bash would sweep would live on here as a
  // far-future timestamp), and nothing longer is a time (year 33658). A leading 0 is decimal.
  const ageSec = /^\d{1,12}$/.test(raw) ? Math.floor(now() / 1000) - Number(raw) : null;
  const sweep = (): void => {
    try {
      unlinkSync(file);
    } catch {
      /* best-effort housekeeping */
    }
  };
  if (ageSec === null || ageSec > REMOTE_TTL_SEC) {
    sweep();
    return false;
  }
  if (ageSec < 0) {
    // A time ahead of the clock (it was set back, or the file is damaged) reads as now, and now is written
    // back: left alone the file would stay live until the clock caught up with it, however far ahead it is.
    // If now cannot be written (a read-only state folder) nothing would ever end it: it is not REMOTE.
    if (!writeRemoteNow(dir, now)) {
      sweep();
      return false;
    }
  }
  return true;
};

/**
 * Enter REMOTE, or push its expiry back. Best-effort by contract: the prompt
 * hooks that call this must never fail a prompt over state IO.
 */
export const touchRemoteActive = (dir: string, now: () => number = Date.now): void => {
  writeRemoteNow(dir, now);
};

/** The state file holds now; false when it could not be written. */
const writeRemoteNow = (dir: string, now: () => number): boolean => {
  const hash = projectHash(dir);
  try {
    mkdirHandedBack(stateDir());
    // Before the write, so a file root makes is the sudo user's from the start (and the write follows it).
    createdHandedBack(remoteStatePath(hash));
    writeFileSync(remoteStatePath(hash), `${Math.floor(now() / 1000)}\n`);
    return true;
  } catch {
    /* a hook must never fail on state IO */
    return false;
  }
};

/**
 * Leave REMOTE. Best-effort like its twin: an absent file is success, and the
 * caller is a hook with its own job to finish. Bash twin: gate.sh
 * hwip_remote_clear.
 */
export const clearRemoteActive = (dir: string): void => {
  const hash = projectHash(dir);
  try {
    unlinkSync(remoteStatePath(hash));
  } catch {
    /* already gone, or unwritable — the prompt still goes through */
  }
};

/** True when the user ran /hwip-mode mute for this project. */
export const isMuted = (dir: string): boolean => {
  const hash = projectHash(dir);
  return findStateFile('muted', hash) !== null;
};

/**
 * Push mode for an install that has never set a dial. The twin is
 * plugin/hooks/gate.sh's missing-5th-argument default; the shared vectors
 * never reach either one (every vector passes pushMode explicitly), so both
 * sides pin it in their own tests.
 */
export const PUSHMODE_DEFAULT: GatePushMode = 'quiet';

/**
 * `notify` flag naming the push mode to assume when the project has no dial.
 * Written by templates.ts into every hook-driven agent's completion hook and
 * read back in cli.ts — shared so the two can never drift apart.
 */
export const PUSHMODE_DEFAULT_FLAG = 'pushmode-default';

/**
 * `notify` flags carrying the turn's tool counts. Only the drop-in artifacts
 * (pi extension, opencode plugin) can supply them — they are the only installed
 * hooks that see per-tool events. Shared for the same reason as the flag above:
 * templates.ts writes them, cli.ts reads them, and a rename on one side alone
 * would send `gateCount` back to GATE_DEFAULTS with nothing to show for it.
 */
export const TOOL_COUNT_FLAG = 'tools';
export const NONREADONLY_COUNT_FLAG = 'nonreadonly';

/**
 * The user's session push-mode dial (/hwip-mode quiet | /hwip-mode loud | /hwip-mode normal).
 *
 * Three failure shapes, three answers — "no dial" is the only one that gets
 * the quiet default:
 *   - no dial file          → `fallback` (PUSHMODE_DEFAULT unless the caller
 *                             overrides it with --pushmode-default)
 *   - unusable dial file    → normal. An unreadable
 *                             file, or a garbled/empty value is a broken
 *                             setting, and resolving breakage to silence
 *                             leaves the user with no symptom to debug. The
 *                             point of the new default is quiet, not hidden
 *                             errors.
 *   - readable dial file    → whatever it says.
 */
export const readPushMode = (
  dir: string,
  fallback: GatePushMode = PUSHMODE_DEFAULT,
): GatePushMode => {
  const hash = projectHash(dir);
  const file = findStateFile('pushmode', hash);
  if (!file) return fallback;
  try {
    return normalizePushMode(readFileSync(file, 'utf-8').replace(/\s+/g, ''));
  } catch {
    return 'normal';
  }
};

/**
 * Push mode for a `--auto` notify: the user's dial if they set one, otherwise
 * the mode named by `--pushmode-default`, otherwise the built-in quiet.
 *
 * The dial outranks the flag deliberately. The flag exists so an agent whose
 * hook cannot participate in the heuristic still pushes out of the box; if it
 * outranked the dial, `/hwip-mode quiet` would silently do nothing for that agent.
 *
 * A flag value that isn't one of the three modes resolves to `normal`, not to
 * the quiet default — same rule as a garbled dial file. A caller that passes
 * nonsense has a bug, and answering a bug with silence hides it.
 */
export const autoPushMode = (dir: string, flag: string | boolean | undefined): GatePushMode =>
  readPushMode(dir, typeof flag === 'string' ? normalizePushMode(flag) : PUSHMODE_DEFAULT);
