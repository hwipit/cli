/**
 * The addresses a sign-in callback may hand to `config.json` (C131). The console sends the key together with
 * the `baseUrl` and `wsUrl` it belongs to, and the config then sends the key wherever they point — so a callback
 * that names an address the user never chose is refused, not saved.
 *
 * Allowed: https (wss) on a host under `hwip.app`, on the console's own host (a self-hosted console and its
 * subdomains), on a host the config file already names, or on one the user named with `--allow-host` (C132); and this machine, over http or https, for local
 * development. No userinfo, query or fragment, and a socket URL that can carry the key's query.
 */
import { isLoopbackHost } from './insecure-url.js';
import { wsUrlProblem } from './ws-url.js';

/** Hosts a callback may name without the user having said so. */
export const BUILT_IN_HOSTS: readonly string[] = ['hwip.app'];
const MAX_ADDRESS_CHARS = 2048;

const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
};

/** `host` is `trusted` or one of its subdomains (an IP address has none). */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const NUMERIC = /^[\d.]+$/;
const under = (host: string, trusted: string): boolean =>
  host === trusted || (!NUMERIC.test(trusted) && host.endsWith(`.${trusted}`));

/**
 * Why `url` may not be saved as the `field` the console sent, or null. The reason names the host at most —
 * never the userinfo, path or query — because it is printed.
 */
export const callbackAddressProblem = (
  field: 'baseUrl' | 'wsUrl',
  url: string,
  extraHosts: readonly string[] = [],
): string | null => {
  if (url.length > MAX_ADDRESS_CHARS) return `the ${field} is too long`;
  if (field === 'wsUrl') {
    const problem = wsUrlProblem(url);
    if (problem) return problem;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `the ${field} is not a URL`;
  }
  const secure = field === 'baseUrl' ? 'https:' : 'wss:';
  const plain = field === 'baseUrl' ? 'http:' : 'ws:';
  const local = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== secure && !(parsed.protocol === plain && local)) {
    return `the ${field} is not ${field === 'baseUrl' ? 'https' : 'wss'} (${parsed.protocol.replace(':', '')}://${parsed.host})`;
  }
  if (parsed.username || parsed.password) return `the ${field} has a user name or password in it`;
  if (parsed.search || parsed.hash) return `the ${field} has a query or fragment, which the key's address cannot carry`;
  if (local) return null;
  const host = hostOf(url)!;
  const trusted = [...BUILT_IN_HOSTS, ...extraHosts].map((h) => h.toLowerCase());
  if (!trusted.some((t) => under(host, t))) return `the ${field} host ${host} is not one hwip knows (hwip.app, the console's host, one already in config.json, or one named with --allow-host)`;
  return null;
};

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The hosts `--allow-host a.example,b.example` names (C132), or why the value is no list of them. A bare host
 * name: a scheme, port, path or `*` is refused rather than trimmed, and so is a name with one label — it would
 * trust a whole top-level domain, and a callback host is trusted with its subdomains (a public suffix like `co.uk`
 * passes the same way — the host is the user's to name). An IP address is trusted as itself only. The value
 * not given is no hosts.
 */
export const parseAllowHosts = (raw: string | boolean | undefined): { hosts: string[] } | { error: string } => {
  if (raw === undefined) return { hosts: [] };
  if (typeof raw !== 'string') return { error: '--allow-host needs a host name (--allow-host api.example.com)' };
  const hosts: string[] = [];
  for (const entry of raw.split(',')) {
    const host = entry.trim().toLowerCase().replace(/\.$/, '');
    // A dotted name of digits only is an IPv4 address, whole or not at all: `0.5` is no host, and as a suffix it would match every `*.0.5`.
    if (!HOST_NAME.test(host) || (NUMERIC.test(host) && !IPV4.test(host))) {
      return { error: `--allow-host takes bare host names like api.example.com, comma-separated — not "${entry.trim()}"` };
    }
    hosts.push(host);
  }
  return { hosts };
};

/** The hosts besides `hwip.app` that a callback may name: the console's own, and those `config.json` already holds. */
export const trustedCallbackHosts = (webUrl: string, config: { baseUrl?: unknown; wsUrl?: unknown }): string[] =>
  [hostOf(webUrl), hostOf(config.baseUrl), hostOf(config.wsUrl)].filter((h): h is string => h !== null && h !== '');
