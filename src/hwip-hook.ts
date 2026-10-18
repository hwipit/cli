import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentSessionContext } from './agent-session.js';
import type { AgentTargetDevice } from './agent-target.js';
import { parseChannels, type ChannelSummary } from './channel.js';
import type { HwipOptions, NotifyPayload, NotifyResult, ListParams, ListResult, PushItem, DismissOneResult, DismissAllResult, ApiErrorResponse, UploadRequestResult } from './types.js';
import { HwipError, AuthenticationError, QuotaExceededError } from './errors.js';
import { DEFAULT_API_BASE } from './ws-url.js';
import { AUTH_HINT, httpFailureMessage, isConfigFailure, networkFailureMessage, readJsonBody } from './http-failure.js';
import { warnInsecureUrl } from './insecure-url.js';
import type { AgentCommandPayload } from './command-seal.js';
import { initDeviceCrypto, isAppDevice, selectRecipients, encryptPushBodyForDevices, encryptFileForDevices, getDevicePublicKey, type DeviceRecipient } from './crypto.js';
import { listenerDeviceId } from './listener-device-id.js';
import { observeDevices } from './trust-pins.js';
import { ensureSelfListed, registerOverApi, registerWhyText } from './self-register.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_FILE_THRESHOLD = 512;
const PREVIEW_LENGTH = 200;

/**
 * The Content-Type header an upload PUT has to carry, whatever its body: the address is signed for it,
 * and S3 answers 403 to any other. It is the type as sent to `POST /files/upload-request`, with
 * `; charset=utf-8` added to `text/*` that has no charset (the hwip server's `uploadContentType`).
 * It used to follow the body's shape (a string got a charset, a Buffer none), which only held while
 * the only uploads were `response.md` text and sealed bytes.
 */
export const uploadContentType = (contentType: string): string =>
  contentType.startsWith('text/') && !contentType.includes('charset') ? `${contentType}; charset=utf-8` : contentType;

const inferMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
  return map[ext ?? ''] ?? 'text/plain';
};

/** A push this computer could not seal is not sent: never in the clear. */
const notSealed = (why: string): HwipError => new HwipError(`${why}; the push was not sent`, 'E2E_REQUIRED', 400);

/** What `GET /devices` says of a device that the seal needs. `type` is the kind of client: `ios`, `android`, `cli`, … */
interface ListedDevice {
  deviceId: string;
  publicKey?: string;
  type?: string;
  nickname?: string;
}

export class HwipHook {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** The account this hook talks as: what `hwip ask` and `hwip agent send` need to read the device list. */
  get account(): { apiKey: string; baseUrl: string } {
    return { apiKey: this.apiKey, baseUrl: this.baseUrl };
  }

  constructor(options: HwipOptions) {
    if (!options.apiKey) {
      throw new HwipError('apiKey is required', 'INVALID_OPTIONS', 400);
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
    warnInsecureUrl(this.baseUrl);
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Who this push is sealed for. Every push is sealed: when this computer's keys do not load, the device list
   * cannot be read, no phone app is signed in or no device lists a key, the push is not sent — never sent in the
   * clear. The device list is fetched per send rather than cached: a phone that registered its key a minute ago
   * must be able to read the next push. Every device it lists is pinned on the way (`observeDevices`); a pin whose
   * device now lists another key is replaced and recorded for a person (`key-changes.ts`). Returned rather than kept
   * on the instance: two concurrent sends on one SDK hook must not overwrite each other's.
   */
  private async audience(): Promise<DeviceRecipient[]> {
    try {
      await initDeviceCrypto();
    } catch {
      throw notSealed("this computer's keys did not load");
    }
    let listed: ListedDevice[] | undefined;
    try {
      listed = (await this.request<{ data?: ListedDevice[] }>('GET', '/devices')).data;
    } catch (err) {
      // A rejected key, a used-up quota, a server that is down or limiting, a connection that failed: the record
      // names those kinds, and they are not this push's to explain. What is left is the server saying no to the list.
      if (!(err instanceof HwipError) || err instanceof AuthenticationError || err instanceof QuotaExceededError
        || err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR' || err.status === 429 || err.status >= 500) {
        // A failure from the configuration (bad key, bad base URL) is said as it is, not rethrown raw.
        if (err instanceof HwipError && isConfigFailure(err)) throw notSealed(err.message);
        throw err;
      }
      throw notSealed('the device list could not be fetched');
    }
    if (!Array.isArray(listed)) throw notSealed('the device list could not be read');
    if (!listed.some(isAppDevice)) {
      throw new HwipError('no app is signed in to this account: sign in to the Hwip app on an iPhone or Android phone, then send again', 'NO_APP_DEVICE', 400);
    }
    // A computer that runs no listener puts its own key on the list here, so the app can tell who sent the push. The
    // push does not need it — the app reads it either way, and it is not sealed for this computer — so one that cannot
    // be registered still goes, with one line.
    const publicKey = getDevicePublicKey();
    if (publicKey) {
      const listing = await ensureSelfListed(listed, { deviceId: listenerDeviceId(), publicKey }, registerOverApi(this.account));
      if (!listing.ok) console.error(`hwip: could not register this computer's key (${registerWhyText(listing.why)}) — the app cannot verify who sent this push`);
    }
    // At the HOME of the moment, not config's TRUST_FILE (fixed at import): `hwip trust` and the listener change it while this runs.
    observeDevices(join(homedir(), '.hwip', 'trusted-devices.json'), listed, {
      selfId: listenerDeviceId(),
      warn: (line) => console.error(`hwip: ${line}`),
    });
    const recipients = selectRecipients(listed);
    if (recipients.length === 0) throw notSealed('no device has a key to encrypt for');
    return recipients;
  }

  /**
   * A push to a channel's subscribers. Always plain text, whatever the account
   * encrypts: the server fans a channel push out after dropping the sender's
   * device keys, so a sealed one could not be opened by any subscriber (m7.md §3).
   * It is also not an agent-session push, so no tmux session context is attached,
   * and a long body goes inline for the server's own limit to judge — the file
   * path would hand subscribers an attachment this CLI has no evidence they can open.
   */
  private async notifyChannel(payload: NotifyPayload): Promise<NotifyResult> {
    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', payload);
    const pushId = json.data?.pushId;
    if (!pushId) throw new HwipError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    return { pushId };
  }

  /** The channels this account owns and follows (`GET /channels`, scope `channel:read`). */
  async listChannels(): Promise<ChannelSummary[]> {
    const json = await this.request<{ data?: unknown }>('GET', '/channels');
    if (!Array.isArray(json.data)) throw new HwipError('Server returned no channel list', 'INVALID_RESPONSE', 500);
    return parseChannels(json.data);
  }

  async notify(payload: NotifyPayload): Promise<NotifyResult> {
    if (payload.channelId) return this.notifyChannel(payload);
    // Attach the stable session key when in a tmux agent session so the push
    // joins the agent chat. Merged into `payload` here so both the inline and
    // file-upload (notifyWithFile) paths — which each spread `...payload` —
    // carry it. Explicit caller values win.
    const agentCtx = agentSessionContext();
    if (agentCtx) payload = { ...agentCtx, ...payload };
    const recipients = await this.audience();
    const body = payload.body;
    const bodyBytes = body ? new TextEncoder().encode(body).byteLength : 0;
    const isLongBody = bodyBytes > BODY_FILE_THRESHOLD;

    if (isLongBody && body) {
      return this.notifyWithFile(payload, body, bodyBytes, recipients);
    }

    let sendPayload: Record<string, unknown>;
    try {
      const enc = await encryptPushBodyForDevices({ title: payload.title, body: payload.body, url: payload.url }, recipients);
      // `url: undefined` alongside the title: it is already sealed inside the
      // ciphertext, and on a link push it IS the payload. Spreading `payload`
      // would leave the plaintext copy at the top level, handing the server the
      // one thing `isEncrypted` promises it cannot see.
      sendPayload = { ...payload, title: undefined, url: undefined, body: enc.body, isEncrypted: true, deviceKeyMap: enc.deviceKeyMap, senderPublicKey: enc.senderPublicKey };
    } catch {
      throw notSealed('sealing the push failed');
    }

    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', sendPayload);
    const pushId = json.data?.pushId;
    if (!pushId) {
      throw new HwipError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    }
    return { pushId };
  }

  private async notifyWithFile(
    payload: NotifyPayload,
    body: string,
    fileSize: number,
    recipients: DeviceRecipient[],
  ): Promise<NotifyResult> {
    const fileName = 'response.md';
    const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;

    // Encrypt the attachment and the push body together, before anything is
    // uploaded. Doing them one at a time around the upload let a failure land
    // in between and ship ciphertext under a push with no `isEncrypted` — an
    // attachment no client would even try to open.
    let encrypted: {
      file: Awaited<ReturnType<typeof encryptFileForDevices>>;
      push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
    };
    try {
      encrypted = {
        file: await encryptFileForDevices(body, recipients),
        push: await encryptPushBodyForDevices({ title: payload.title, body: preview, url: payload.url }, recipients),
      };
    } catch {
      throw notSealed('sealing the push failed');
    }

    const upload = await this.requestUpload({ fileName, fileType: 'application/octet-stream', fileSize: encrypted.file.ciphertext.length });
    await this.uploadToS3(upload.uploadUrl, encrypted.file.ciphertext, 'application/octet-stream');

    const sendPayload: Record<string, unknown> = {
      ...payload,
      title: undefined,
      body: encrypted.push.body,
      type: payload.type ?? 'file',
      files: [{
        fileKey: upload.fileKey,
        fileName,
        fileSize,
        fileType: inferMimeType(fileName),
        iv: encrypted.file.iv,
        deviceKeyMap: encrypted.file.deviceKeyMap,
      }],
      // See notify: the url must not survive in the clear either.
      url: undefined,
      isEncrypted: true,
      deviceKeyMap: encrypted.push.deviceKeyMap,
      senderPublicKey: encrypted.push.senderPublicKey,
    };

    const json = await this.request<{ data: { pushId: string } }>('POST', '/pushes/send', sendPayload);

    const pushId = json.data?.pushId;
    if (!pushId) {
      throw new HwipError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    }
    return { pushId, fileKey: upload.fileKey, autoFile: true };
  }

  async requestUpload(params: { fileName: string; fileType: string; fileSize: number }): Promise<UploadRequestResult> {
    const json = await this.request<{ data: UploadRequestResult }>('POST', '/files/upload-request', params);
    return json.data;
  }

  async uploadToS3(url: string, content: string | Buffer, contentType: string): Promise<void> {
    const body = typeof content === 'string' ? content : new Uint8Array(content);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': uploadContentType(contentType) },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new HwipError(`S3 upload failed with status ${response.status}`, 'UPLOAD_FAILED', response.status);
    }
  }

  async list(params?: ListParams): Promise<ListResult> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    const json = await this.request<{
      data: PushItem[];
      pagination: { hasMore: boolean };
    }>('GET', `/pushes${qs ? `?${qs}` : ''}`);
    const pushes = json.data.map((p) => ({
      pushId: p.pushId,
      type: p.type,
      // An encrypted push carries no plaintext title and a JSON envelope in
      // `body`; slicing that renders `{"ciphertext":"AAAB...` as if it were the
      // message. This host cannot decrypt (send-only), so say so instead.
      title: p.isEncrypted ? undefined : p.title,
      body: p.isEncrypted ? '[encrypted]' : p.body?.slice(0, 100),
      isEncrypted: p.isEncrypted,
      createdAt: p.createdAt,
    }));
    return { pushes, count: pushes.length, hasMore: json.pagination?.hasMore ?? false };
  }

  async dismiss(pushId: string): Promise<DismissOneResult> {
    await this.request('POST', `/pushes/${encodeURIComponent(pushId)}/dismiss`);
    return { dismissed: true };
  }

  async dismissAll(): Promise<DismissAllResult> {
    const json = await this.request<{ data: { dismissed: number } }>('POST', '/pushes/dismiss-all');
    return { dismissed: json.data?.dismissed ?? 0 };
  }

  /**
   * Set (or clear, with an empty alias) the display name for an agent session,
   * keyed by its tmux `name` on `deviceId`. The alias overrides the app's
   * computed session label; it survives listener re-reports (server-side).
   */
  async renameAgentSession(deviceId: string, name: string, alias: string): Promise<{ deviceId: string }> {
    const res = await this.request<{ data: { deviceId: string } }>(
      'PATCH',
      `/devices/${encodeURIComponent(deviceId)}/agent-sessions/${encodeURIComponent(name)}`,
      { alias },
    );
    return { deviceId: res.data.deviceId };
  }

  /** The account's devices, with the agent sessions each listener reports. */
  async listDevices(): Promise<AgentTargetDevice[]> {
    const json = await this.request<{ data?: AgentTargetDevice[] }>('GET', '/devices');
    // A missing list is a bad response, not an account with no devices — the
    // latter would read as "unknown target" and hide the real failure.
    if (!Array.isArray(json.data)) throw new HwipError('Server returned no device list', 'INVALID_RESPONSE', 500);
    return json.data;
  }

  /**
   * Type `body` into the tmux session `agentSessionName` on `targetDeviceId`.
   *
   * Never through `notify`'s encryption: a sealed command is made by `sealedCommand` (command-seal.ts), which
   * decides whether to seal at all, and arrives here as its fields. No `agentDeviceId` — the server groups by
   * `agentDeviceId ?? targetDeviceId`, so it would file the push under a chat that is not the target's.
   */
  async sendAgentCommand(payload: AgentCommandPayload): Promise<{ pushId: string }> {
    const json = await this.request<{ data?: { pushId?: string } }>('POST', '/pushes/send', { type: 'agent.command', ...payload });
    const pushId = json.data?.pushId;
    if (!pushId) throw new HwipError('Server returned no pushId', 'INVALID_RESPONSE', 500);
    return { pushId };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (body) headers['Content-Type'] = 'application/json';

    const url = `${this.baseUrl}${path}`;
    let response: Response;
    let json: unknown;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // A redirect would carry the X-API-Key header to another host.
        redirect: 'error',
      });
      json = await readJsonBody(response);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new HwipError(`Request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', 408);
      }
      // fetch reports every network failure as a TypeError; anything else is
      // not "could not reach".
      if (err instanceof TypeError) throw new HwipError(networkFailureMessage(err, url), 'NETWORK_ERROR', 0);
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw this.parseError(response.status, json);
    }
    // A 2xx that is not our JSON (a captive portal, a cut-off body) is a
    // failed call, not an empty answer.
    if (json === null) {
      throw new HwipError(`the server answered ${response.status} with a page that is not the API's (a captive portal, or a proxy in the way)`, 'INVALID_RESPONSE', response.status);
    }
    return json as T;
  }

  private parseError(status: number, body: unknown): HwipError {
    const message = httpFailureMessage(status, body);
    const code = (body as ApiErrorResponse | null)?.error?.code ?? 'UNKNOWN_ERROR';

    if (status === 401) return new AuthenticationError(`${message} — ${AUTH_HINT}`);
    if (status === 403 && code === 'QUOTA_EXCEEDED') return new QuotaExceededError(message);

    return new HwipError(message, code, status);
  }
}
