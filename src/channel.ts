import type { NotifyPayload } from './types.js';

/**
 * The part of a channel `GET /channels` returns that this CLI shows. The record
 * also carries fields that are not for a terminal or a `--json` pipe (a
 * webhook secret, the index tag), so the list is rebuilt from these and
 * nothing else is passed along.
 */
export interface ChannelSummary {
  channelId: string;
  name: string;
  description?: string;
  isPublic: boolean;
  subscriberCount: number;
  ownerId: string;
  /** Whether the account owns it, as the server says. Absent from a server that does not send it yet. */
  isOwner?: boolean;
  createdAt?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The channels in a `GET /channels` answer; a row without an id or a name is dropped, not guessed. */
export const parseChannels = (data: unknown): ChannelSummary[] => {
  if (!Array.isArray(data)) return [];
  const channels: ChannelSummary[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const channelId = text(row.channelId);
    const name = text(row.name);
    if (!channelId || !name) continue;
    const description = text(row.description);
    const createdAt = text(row.createdAt);
    channels.push({
      channelId,
      name,
      ...(description && { description }),
      isPublic: row.isPublic === true,
      subscriberCount: typeof row.subscriberCount === 'number' ? row.subscriberCount : 0,
      ownerId: text(row.ownerId) ?? '',
      ...(typeof row.isOwner === 'boolean' && { isOwner: row.isOwner }),
      ...(createdAt && { createdAt }),
    });
  }
  return channels;
};

/**
 * What `hwip channel list` prints. The server says per channel whether the
 * account owns it (`isOwner`), and answers with the owned ones first. A server
 * that does not send the field yet gives the rows no way to say so — an API key
 * cannot learn its own user id — so such a row shows its owner and leaves the
 * comparison to the person (the server refuses `notify --channel` for a channel
 * the account does not own).
 */
export const channelLines = (channels: readonly ChannelSummary[]): string[] => {
  if (channels.length === 0) return ['No channels.'];
  const idWidth = Math.max(...channels.map((c) => c.channelId.length));
  const nameWidth = Math.max(...channels.map((c) => c.name.length));
  const lines = channels.map((c) => {
    const subs = `${c.subscriberCount} ${c.subscriberCount === 1 ? 'subscriber' : 'subscribers'}`;
    const role = c.isOwner === true ? 'yours' : c.isOwner === false ? 'following' : c.ownerId ? `owner ${c.ownerId.slice(0, 8)}` : 'owner unknown';
    return `  ${c.channelId.padEnd(idWidth)}  ${c.name.padEnd(nameWidth)}  ${c.isPublic ? 'public ' : 'private'}  ${subs}  ${role}`;
  });
  lines.push('', 'Only an owner can send to a channel.');
  return lines;
};

export type ChannelRef = { channelId: string; name?: string } | { error: string };

/**
 * Which channel `--channel <ref>` means. An id in the list wins; otherwise the
 * name must match exactly one channel *the account owns* — a channel it only
 * follows with the same name does not make the name ambiguous, and is never
 * the target. Two owned channels with one name are refused rather than picked:
 * a push to the wrong channel reaches strangers. An id the list does not hold is
 * passed on as it is — the server decides whether it exists and is the account's.
 *
 * A server that does not say who owns what (`isOwner` absent on any row) leaves
 * every name match a candidate, as before: ambiguity is then refused, and a
 * channel the account does not own is refused by the server.
 */
export const resolveChannel = (channels: readonly ChannelSummary[], ref: string): ChannelRef => {
  const known = channels.every((c) => typeof c.isOwner === 'boolean');
  const byId = channels.find((c) => c.channelId === ref);
  if (byId) {
    if (known && !byId.isOwner) return { error: `you follow "${byId.name}" (${byId.channelId}) but do not own it — only the owner can send to a channel` };
    return { channelId: byId.channelId, name: byId.name };
  }
  const named = channels.filter((c) => c.name === ref);
  const byName = known ? named.filter((c) => c.isOwner) : named;
  if (byName.length === 1) return { channelId: byName[0]!.channelId, name: byName[0]!.name };
  if (byName.length > 1) {
    const ids = byName.map((c) => c.channelId).join(', ');
    return { error: `${byName.length} channels are named "${ref}" (${ids}) — use the channelId` };
  }
  if (known && named.length > 0) {
    return { error: `you follow "${ref}" (${named.map((c) => c.channelId).join(', ')}) but do not own a channel by that name — only the owner can send to a channel` };
  }
  if (/^ch_/.test(ref)) return { channelId: ref };
  return { error: `no channel named "${ref}" — 'hwip channel list' shows the channels; use a channelId or an exact name` };
};

export interface ChannelNotify {
  ref: string;
  payload: Omit<NotifyPayload, 'channelId'>;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TYPES = ['note', 'link', 'file', 'hook'] as const;

/**
 * The flags of `hwip notify --channel`, or what is wrong with them.
 *
 * A channel push is not the agent hook's push: the gate (`--auto`), the device
 * and the session flags mean "this agent session", and none of them go to a
 * channel — refusing them is better than dropping them silently, and the
 * default title and body a hook gets from the branch name would publish a
 * project name to subscribers.
 */
export const parseChannelNotify = (args: Readonly<Record<string, string | boolean>>): ChannelNotify | { error: string } => {
  const ref = args.channel;
  if (typeof ref !== 'string' || !ref.trim()) return { error: '--channel needs a channelId or a channel name' };
  for (const flag of ['auto', 'device', 'session']) {
    if (args[flag] !== undefined) return { error: `--${flag} is for agent sessions and cannot be combined with --channel` };
  }
  const title = typeof args.title === 'string' ? args.title : undefined;
  const body = typeof args.body === 'string' ? args.body : undefined;
  if (!title && !body) return { error: 'a channel push needs --title or --body' };
  const type = typeof args.type === 'string' ? args.type : 'hook';
  if (!(TYPES as readonly string[]).includes(type)) return { error: `--type must be one of ${TYPES.join(', ')}` };
  const priority = typeof args.priority === 'string' ? args.priority : undefined;
  if (priority && !(PRIORITIES as readonly string[]).includes(priority)) {
    return { error: `--priority must be one of ${PRIORITIES.join(', ')}` };
  }
  const url = typeof args.url === 'string' ? args.url : undefined;
  return {
    ref: ref.trim(),
    payload: {
      ...(title && { title }),
      ...(body && { body }),
      ...(url && { url }),
      type: type as NonNullable<NotifyPayload['type']>,
      ...(priority && { priority: priority as NonNullable<NotifyPayload['priority']> }),
    },
  };
};

/** Printed to stderr on every channel push: whatever the account's end-to-end setting, this one is readable by the server. */
export const PLAINTEXT_NOTE =
  'Channel pushes are sent as plain text, not sealed — the server can read this one even with end-to-end encryption on.';
