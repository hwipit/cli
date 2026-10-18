import { describe, expect, it } from 'vitest';
import { channelLines, parseChannelNotify, parseChannels, resolveChannel, type ChannelSummary } from './channel.js';

const channel = (over: Partial<ChannelSummary> & { channelId: string; name: string }): ChannelSummary => ({
    isPublic: true,
    subscriberCount: 0,
    ownerId: 'owner-aaaaaaaa-1111',
    ...over,
});

describe('parseChannels', () => {
    it('keeps what the CLI shows and drops the rest of the record', () => {
        const parsed = parseChannels([
            {
                channelId: 'ch_1', tag: 'internal-tag', name: 'Releases', description: 'news', imageUrl: 'https://x/y.png',
                ownerId: 'u1', subscriberCount: 3, isPublic: false, webhookSecret: 'whsec_do_not_print',
                createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
            },
        ]);

        expect(parsed).toEqual([
            { channelId: 'ch_1', name: 'Releases', description: 'news', isPublic: false, subscriberCount: 3, ownerId: 'u1', createdAt: '2026-10-01T00:00:00Z' },
        ]);
        expect(JSON.stringify(parsed)).not.toContain('whsec_');
    });

    it('keeps isOwner only when the server sent a boolean', () => {
        const parsed = parseChannels([
            { channelId: 'ch_1', name: 'A', isOwner: true },
            { channelId: 'ch_2', name: 'B', isOwner: 'yes' },
            { channelId: 'ch_3', name: 'C' },
        ]);

        expect(parsed.map((c) => c.isOwner)).toEqual([true, undefined, undefined]);
    });

    it('drops a row with no id or name, and reads a non-list as no channels', () => {
        expect(parseChannels([{ name: 'no id' }, { channelId: 'ch_2' }, null, 'x'])).toEqual([]);
        expect(parseChannels({ not: 'a list' })).toEqual([]);
    });
});

describe('channelLines', () => {
    it('says so when there are none', () => {
        expect(channelLines([])).toEqual(['No channels.']);
    });

    it('shows id, name, public or private, subscribers and owner', () => {
        const lines = channelLines([
            channel({ channelId: 'ch_1', name: 'Releases', subscriberCount: 1 }),
            channel({ channelId: 'ch_22', name: 'Ops', isPublic: false, subscriberCount: 12, ownerId: 'someone-else-0000' }),
        ]);

        expect(lines[0]).toContain('ch_1 ');
        expect(lines[0]).toContain('public ');
        expect(lines[0]).toContain('1 subscriber ');
        expect(lines[0]).toContain('owner owner-aa');
        expect(lines[1]).toContain('private');
        expect(lines[1]).toContain('12 subscribers');
        expect(lines[1]).toContain('owner someone-');
    });

    it('says yours or following where the server says who owns it', () => {
        const lines = channelLines([
            channel({ channelId: 'ch_1', name: 'Mine', isOwner: true }),
            channel({ channelId: 'ch_2', name: 'Theirs', isOwner: false }),
        ]);

        expect(lines[0]).toContain('yours');
        expect(lines[0]).not.toContain('owner ');
        expect(lines[1]).toContain('following');
    });
});

describe('resolveChannel', () => {
    const channels = [
        channel({ channelId: 'ch_1', name: 'Releases' }),
        channel({ channelId: 'ch_2', name: 'Ops' }),
        channel({ channelId: 'ch_3', name: 'Dup' }),
        channel({ channelId: 'ch_4', name: 'Dup' }),
    ];

    it('takes an id in the list', () => {
        expect(resolveChannel(channels, 'ch_2')).toEqual({ channelId: 'ch_2', name: 'Ops' });
    });

    it('takes a name that exactly one channel has', () => {
        expect(resolveChannel(channels, 'Releases')).toEqual({ channelId: 'ch_1', name: 'Releases' });
    });

    it('does not match a name loosely', () => {
        expect(resolveChannel(channels, 'releases')).toHaveProperty('error');
        expect(resolveChannel(channels, 'Rel')).toHaveProperty('error');
    });

    it('refuses a name two channels share and lists their ids', () => {
        const refused = resolveChannel(channels, 'Dup');

        expect(refused).toHaveProperty('error');
        expect((refused as { error: string }).error).toContain('ch_3, ch_4');
        expect((refused as { error: string }).error).toContain('use the channelId');
    });

    it('passes on an id the list does not hold, for the server to judge', () => {
        expect(resolveChannel(channels, 'ch_unknown')).toEqual({ channelId: 'ch_unknown' });
    });

    it('says no channel has an unknown name', () => {
        expect((resolveChannel(channels, 'Nope') as { error: string }).error).toContain('no channel named "Nope"');
    });
});

describe('resolveChannel — against a server that says who owns what', () => {
    const channels = [
        channel({ channelId: 'ch_1', name: 'Releases', isOwner: true }),
        channel({ channelId: 'ch_2', name: 'Same', isOwner: true }),
        channel({ channelId: 'ch_3', name: 'Same', isOwner: false }),
        channel({ channelId: 'ch_4', name: 'Theirs', isOwner: false }),
        channel({ channelId: 'ch_5', name: 'Both', isOwner: true }),
        channel({ channelId: 'ch_6', name: 'Both', isOwner: true }),
    ];

    it('prefers the owned channel over a followed one with the same name', () => {
        expect(resolveChannel(channels, 'Same')).toEqual({ channelId: 'ch_2', name: 'Same' });
    });

    it('refuses two owned channels with one name', () => {
        expect((resolveChannel(channels, 'Both') as { error: string }).error).toContain('ch_5, ch_6');
    });

    it('refuses a name or an id that is only followed, and says so', () => {
        expect((resolveChannel(channels, 'Theirs') as { error: string }).error).toContain('do not own');
        expect((resolveChannel(channels, 'ch_4') as { error: string }).error).toContain('do not own');
        expect((resolveChannel(channels, 'ch_3') as { error: string }).error).toContain('do not own');
    });

    it('still takes an owned id', () => {
        expect(resolveChannel(channels, 'ch_1')).toEqual({ channelId: 'ch_1', name: 'Releases' });
    });
});

describe('parseChannelNotify', () => {
    it('reads the channel and the push fields, with the hook type by default', () => {
        expect(parseChannelNotify({ channel: ' Releases ', title: 'v1', body: 'shipped', url: 'https://x.test', priority: 'high' })).toEqual({
            ref: 'Releases',
            payload: { title: 'v1', body: 'shipped', url: 'https://x.test', type: 'hook', priority: 'high' },
        });
    });

    it('needs a channel, and a title or a body — no default text from the branch', () => {
        expect(parseChannelNotify({ channel: true })).toHaveProperty('error');
        expect(parseChannelNotify({ channel: '' , title: 'x' })).toHaveProperty('error');
        expect((parseChannelNotify({ channel: 'ch_1' }) as { error: string }).error).toContain('--title or --body');
    });

    it.each(['auto', 'device', 'session'])('refuses --%s, which means an agent session', (flag) => {
        const refused = parseChannelNotify({ channel: 'ch_1', title: 'x', [flag]: flag === 'auto' ? true : 'v' });

        expect((refused as { error: string }).error).toContain(`--${flag}`);
    });

    it('checks the type and the priority', () => {
        expect(parseChannelNotify({ channel: 'ch_1', title: 'x', type: 'weird' })).toHaveProperty('error');
        expect(parseChannelNotify({ channel: 'ch_1', title: 'x', priority: 'asap' })).toHaveProperty('error');
    });
});
