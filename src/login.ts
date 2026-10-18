import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';
import { configWriteProblem, loadConfig, saveConfig } from './config.js';
import { callbackAddressProblem, parseAllowHosts, trustedCallbackHosts } from './login-address.js';
import { errorPage, okPage } from './login-page.js';
import { maskKey } from './redact.js';

const DEFAULT_WEB_URL = 'https://console.hwip.app';
const DEFAULT_TIMEOUT_SEC = 300;

/** Credentials returned by a completed login. apiKey is guaranteed present
 *  (parseCallback rejects a missing key with 400). Shared by handleLogin and
 *  handleInstall via runLoginFlow. */
export type LoginFlowResult = {
  apiKey: string;
  hookId?: string;
  baseUrl?: string;
  wsUrl?: string;
};

type CallbackResult =
  | { ok: true; config: LoginFlowResult }
  /** `endsLogin`: what the terminal says when this refusal ends the login. */
  | { ok: false; status: number; reason: string; endsLogin?: string };

// ── Pure helpers (unit-tested) ───────────────────────────────────

export const stripUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
};

/**
 * `post=1` tells the console this listener takes the callback as a form POST:
 * the key then travels in the request body and never in a URL (browser history,
 * autofill and session restore keep URLs). `/cb` takes no key any other way.
 */
export const buildBridgeUrl = (webUrl: string, port: number, state: string, host: string): string => {
  const base = webUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ port: String(port), state, host, post: '1' });
  return `${base}/auth/cli-bridge?${params.toString()}`;
};

export const persistConfig = (next: LoginFlowResult): void => {
  const existing = loadConfig();
  saveConfig({ ...existing, ...stripUndefined(next) });
};

/**
 * The callback's fields, from a form body (the only place the key may be). The `baseUrl` and `wsUrl` it names are
 * where `config.json` will send the key, so one that is not https/wss on a host hwip knows (`login-address.ts`) is
 * refused whole — nothing is saved — and ends the login saying which address and why (C131).
 * `extraHosts`: hosts besides `hwip.app` the callback may name (the console's, those already in the config).
 */
export const parseCallbackParams = (
  params: URLSearchParams,
  expectedState: string,
  extraHosts: readonly string[] = [],
): CallbackResult => {
  const state = params.get('state');
  if (state !== expectedState) return { ok: false, status: 403, reason: 'state mismatch' };

  const apiKey = params.get('key') ?? undefined;
  if (!apiKey) return { ok: false, status: 400, reason: 'missing key' };

  const baseUrl = params.get('baseUrl') ?? undefined;
  const wsUrl = params.get('wsUrl') ?? undefined;
  for (const [field, value] of [['baseUrl', baseUrl], ['wsUrl', wsUrl]] as const) {
    if (value === undefined) continue;
    const problem = callbackAddressProblem(field, value, extraHosts);
    if (problem) {
      return {
        ok: false,
        status: 400,
        reason: 'the console sent an address hwip will not save',
        endsLogin: `${problem}, so the sign-in was not saved. Check the console you signed in at (--web-url), or name a host you trust with --allow-host <host>, and run \`hwip login\` again`,
      };
    }
  }

  return { ok: true, config: { apiKey, hookId: params.get('hook') ?? undefined, baseUrl, wsUrl } };
};

/** Requests with a wrong state one login answers 403 and waits through, before it gives up. */
export const MAX_STATE_MISMATCHES = 5;

const KEY_IN_URL =
  'the console sent the key in a URL, which hwip refuses, so it was not saved. That URL is in the browser\'s history: ' +
  'revoke the key in the app (Settings > API Keys), update the console, and run `hwip login` again';

/**
 * A GET callback. It carries no key: the console's "cancel" is one (`?error=denied&state=…`) and answers "missing
 * key". A key in the query is refused unread (C102) and ends the login with `KEY_IN_URL`; its value is not in the
 * result, the page or the log.
 */
export const parseCallback = (reqUrl: string, expectedState: string): CallbackResult => {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  if (url.pathname !== '/cb') return { ok: false, status: 404, reason: 'not found' };
  if (url.searchParams.get('state') !== expectedState) return { ok: false, status: 403, reason: 'state mismatch' };
  if (url.searchParams.has('key')) return { ok: false, status: 400, reason: 'a key in the URL is refused', endsLogin: KEY_IN_URL };
  return { ok: false, status: 400, reason: 'missing key' };
};

/** A form with five short fields is well under this; the cap is for whatever else can reach a loopback port. */
export const MAX_CALLBACK_BODY_BYTES = 8 * 1024;
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** The body of a callback POST, or the status to refuse it with. */
const readCallbackBody = (req: IncomingMessage): Promise<{ body: string } | { status: number; reason: string }> => {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== FORM_TYPE) return Promise.resolve({ status: 415, reason: 'unsupported content type' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CALLBACK_BODY_BYTES) {
        resolve({ status: 413, reason: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8') }));
    // The browser went away before the body ended: nothing to answer, but the wait must not outlive the socket.
    req.on('close', () => resolve({ status: 400, reason: 'unreadable request' }));
  });
};

// ── Browser launch ───────────────────────────────────────────────

const browserCommand = (): { cmd: string; prefixArgs: string[] } => {
  if (process.platform === 'darwin') return { cmd: 'open', prefixArgs: [] };
  if (process.platform === 'win32') return { cmd: 'cmd', prefixArgs: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', prefixArgs: [] };
};

/**
 * Where the sign-in browser can run. `open`: here. `ssh`: on the user's own
 * machine, with the callback port forwarded — a browser opened here would
 * land on the remote box. `none`: nowhere this login can reach.
 */
export type BrowserPlan = { kind: 'open' } | { kind: 'ssh' } | { kind: 'none'; reason: string };

export const browserPlan = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserPlan => {
  // A $BROWSER helper opens it where the user is — VS Code Remote-SSH sets one
  // and forwards the loopback port — and WSL opens the Windows browser, which
  // shares localhost.
  if (env.BROWSER) return { kind: 'open' };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { kind: 'ssh' };
  if (platform !== 'darwin' && platform !== 'win32' && !env.WSL_DISTRO_NAME && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { kind: 'none', reason: 'no display (DISPLAY and WAYLAND_DISPLAY are unset)' };
  }
  return { kind: 'open' };
};

/** How long an opener has to fail before it counts as started. */
const OPENER_GRACE_MS = 1500;

/**
 * Opens `url`; resolves to why it could not, or undefined once the opener
 * started. An opener that exits non-zero inside the grace window failed —
 * `xdg-open` with no handler exits 3 — and one still running after it, or
 * done with 0, handed the URL on.
 */
export const openBrowser = (url: string, graceMs = OPENER_GRACE_MS): Promise<string | undefined> => {
  const { cmd, prefixArgs } = browserCommand();
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [...prefixArgs, url], { stdio: 'ignore', detached: true });
      // A missing `xdg-open` fails here, after spawn() returned.
      child.once('error', (err) => resolve(`${cmd} failed: ${err.message}`));
      child.once('spawn', () => {
        const grace = setTimeout(() => {
          child.unref();
          resolve(undefined);
        }, graceMs);
        child.once('exit', (code) => {
          clearTimeout(grace);
          resolve(code ? `${cmd} exited with code ${code}` : undefined);
        });
      });
    } catch (err) {
      resolve(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
};

/**
 * Inside `hwip install`, Enter skips the wait and goes to the paste prompt —
 * and a key pasted right here, before Enter, is that answer. Resolves to the
 * typed line. Null without a terminal to read it from.
 */
const enterToSkip = (): { pressed: Promise<string>; close: () => void } | null => {
  if (process.stdin.isTTY !== true) return null;
  const rl = createInterface({ input: process.stdin });
  const pressed = new Promise<string>((resolve) => rl.once('line', (line) => resolve(line.trim())));
  return { pressed, close: () => rl.close() };
};

/** A key typed while the login waited (inside install), instead of the browser's answer. */
export type PastedKey = { pastedKey: string };

// ── Loopback server ──────────────────────────────────────────────

const respond = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // The page is inline styles and an inline drawing, nothing else: let the
    // browser refuse anything more. What got here carries the new key (in the
    // body), so it is not cached and not sent on as a referrer.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
};

interface ServerHandle {
  port: number;
  /** Resolves with the validated config once the browser hits /cb. */
  done: Promise<LoginFlowResult>;
  close: () => void;
}

const startLoopbackServer = (state: string, extraHosts: readonly string[]): Promise<ServerHandle> => {
  let mismatches = 0;
  let settle!: (config: LoginFlowResult) => void;
  let fail!: (err: Error) => void;
  const done = new Promise<LoginFlowResult>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A handler that rejects would end the process; whatever slipped past the checks inside ends the login instead.
    handleCallback(req, res).catch((err: unknown) => {
      if (!res.headersSent) respond(res, 500, errorPage('The sign-in could not be completed. Return to your terminal for the reason.'));
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  });

  const handleCallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let result: CallbackResult;
    if (req.method === 'POST') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // The key is in the body: the query of a POST is not read.
      if (url.pathname !== '/cb') {
        result = { ok: false, status: 404, reason: 'not found' };
      } else {
        const read = await readCallbackBody(req);
        result = 'body' in read
          ? parseCallbackParams(new URLSearchParams(read.body), state, extraHosts)
          : { ok: false, status: read.status, reason: read.reason };
      }
    } else {
      result = parseCallback(req.url ?? '/', state);
    }
    if (!result.ok) {
      respond(res, result.status, errorPage(result.reason));
      // A request that does not hold the state is not the console's: it is answered and the wait goes on, so one stray
      // request cannot end the sign-in. A run of them can (the state is a secret only the console has).
      if (result.status === 403 && ++mismatches >= MAX_STATE_MISMATCHES) {
        fail(new Error(`state mismatch — refused after ${MAX_STATE_MISMATCHES} requests that did not hold the sign-in state`));
      } else if (result.endsLogin) fail(new Error(result.endsLogin));
      return;
    }
    // A handler that throws takes the process down with it. The file can have gone bad since `handleLogin` looked.
    try {
      persistConfig(result.config);
    } catch (err) {
      respond(res, 500, errorPage('The key could not be saved. Return to your terminal for the reason.'));
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    respond(res, 200, okPage());
    settle(result.config);
  };

  return new Promise((resolveHandle, rejectHandle) => {
    server.once('error', rejectHandle);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveHandle({ port, done, close: () => server.close() });
    });
  });
};

// ── Command ──────────────────────────────────────────────────────

// The loopback server closes with the attempt, so the bridge URL is no use
// after this: the way forward is the manual flow — or, inside `hwip install`,
// the paste prompt that follows.
const headlessHint = (reason: string, pasteNext: boolean): void => {
  console.error(`\n  Could not open a browser: ${reason}.`);
  console.error(pasteNext ? '  Paste the API key below instead.\n' : `  Use the manual flow instead:\n${MANUAL_FLOW}\n`);
};

const MANUAL_FLOW = '    npx @hwip/cli install --key ak_… --hook hook_…';

export const resolveWebUrl = (raw: string | boolean | undefined): string =>
  typeof raw === 'string' ? raw : DEFAULT_WEB_URL;

/** The hosts `--allow-host` adds to the callback's trusted ones. A bad value stops the command — it is not read as "none". */
export const resolveAllowHosts = (raw: string | boolean | undefined): string[] => {
  const parsed = parseAllowHosts(raw);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.hosts;
};

export const resolveTimeoutSec = (raw: string | boolean | undefined): number => {
  if (typeof raw !== 'string') return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  // Reject NaN / non-positive — a bad --timeout must not fire setTimeout instantly.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
};

/**
 * Core login flow shared by `handleLogin` (CLI command) and `handleInstall`
 * (auto-trigger on missing credentials). Returns the issued credentials, or
 * null when the browser can't open (headless) or the callback never arrives.
 * `deps.open` is injectable for tests; defaults to the real browser launcher.
 */
export const runLoginFlow = async (
  /** `pasteNext`: the caller (`hwip install`) prompts for the key when this returns null. */
  opts: { webUrl: string; timeoutSec: number; pasteNext?: boolean; allowHosts?: readonly string[] },
  deps: {
    open?: (url: string) => Promise<string | undefined>;
    plan?: BrowserPlan;
    skip?: () => { pressed: Promise<string>; close: () => void } | null;
  } = {},
): Promise<LoginFlowResult | PastedKey | null> => {
  const open = deps.open ?? openBrowser;
  const plan = deps.plan ?? browserPlan();
  const pasteNext = opts.pasteNext === true;
  if (plan.kind === 'none') {
    headlessHint(plan.reason, pasteNext);
    return null;
  }
  const state = randomBytes(16).toString('hex');

  let handle: ServerHandle;
  try {
    handle = await startLoopbackServer(state, [...trustedCallbackHosts(opts.webUrl, loadConfig()), ...(opts.allowHosts ?? [])]);
  } catch (err) {
    console.error(`  Error: could not start local server (${err instanceof Error ? err.message : 'unknown'})`);
    return null;
  }

  const bridgeUrl = buildBridgeUrl(opts.webUrl, handle.port, state, hostname());
  if (plan.kind === 'ssh') {
    // No browser here, but one on the user's machine can still finish the
    // login once the callback port reaches this box.
    console.log(
      `\n  This is an SSH session, so no browser opens here. To sign in from your own machine,\n` +
      `  forward the callback port and open the URL there:\n` +
      `    ssh -L ${handle.port}:127.0.0.1:${handle.port} <this host>\n` +
      `    ${bridgeUrl}\n` +
      (pasteNext ? '' : `  Otherwise press Ctrl+C and use the manual flow:\n${MANUAL_FLOW}\n`),
    );
  } else {
    const failed = await open(bridgeUrl);
    if (failed) {
      headlessHint(failed, pasteNext);
      handle.close();
      return null;
    }
    console.log(`\n  Opened the browser to sign in. If it did not appear, open:\n    ${bridgeUrl}\n`);
  }
  // Inside install Ctrl+C would end the whole install; Enter goes to the paste prompt.
  const skip = pasteNext ? (deps.skip ?? enterToSkip)() : null;
  const hint = !pasteNext ? ', Ctrl+C to cancel' : skip ? ', or press Enter to paste the API key instead' : '';
  console.log(`  Waiting for sign-in in the browser (up to ${opts.timeoutSec}s${hint})...`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no sign-in within ${opts.timeoutSec}s`)), opts.timeoutSec * 1000);
    timer.unref();
  });

  try {
    const skipped = skip
      ? skip.pressed.then((line): PastedKey | null => (line ? { pastedKey: line } : null))
      : new Promise<never>(() => {});
    return await Promise.race([handle.done, timeout, skipped]);
  } catch (err) {
    console.error(`\n  Login failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    skip?.close();
    handle.close();
  }
};

export const handleLogin = async (
  args: Record<string, string | boolean>,
  deps: Parameters<typeof runLoginFlow>[1] = {},
): Promise<number> => {
  const webUrl = resolveWebUrl(args['web-url']);
  const timeoutSec = resolveTimeoutSec(args.timeout);
  let allowHosts: string[];
  try {
    allowHosts = resolveAllowHosts(args['allow-host']);
  } catch (err) {
    console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Before a browser opens: a sign-in whose key cannot be saved is a sign-in for nothing.
  const blocked = configWriteProblem();
  if (blocked) {
    console.error(`\n  Error: ${blocked}\n`);
    return 1;
  }

  const result = await runLoginFlow({ webUrl, timeoutSec, allowHosts }, deps);
  // Without `pasteNext` there is no Enter-to-paste, so no pasted key either.
  if (!result || !('apiKey' in result)) {
    console.error('\n  Error: login did not complete\n');
    return 1;
  }

  console.log(`  + Config saved. API key: ${maskKey(result.apiKey)}`);
  if (result.hookId) console.log(`  + Hook: ${result.hookId}`);
  console.log('\n  Done! Restart your agents.\n');
  return 0;
};
