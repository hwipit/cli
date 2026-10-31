import { describe, expect, it, vi } from 'vitest';
import { listLocalAgents, runAgentList, runAgentListAll, type AllAgentDeps, type ListedSession, type LocalAgentDeps } from './agent-list.js';
import { resolveAgentTarget } from './agent-target.js';

const row = (name: string, extra: Partial<ListedSession> = {}): ListedSession => ({
    name,
    attached: false,
    agentKind: 'claude',
    project: 'proj',
    ...extra,
});

const makeDeps = (sessions: ListedSession[], extra: Partial<LocalAgentDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: LocalAgentDeps = {
        collect: () => sessions,
        deviceId: () => 'dev_mac',
        selfKey: () => null,
        tmuxVisible: () => true,
        out: (text) => {
            out.push(text);
        },
        err: (line) => {
            err.push(line);
        },
        ...extra,
    };
    return { deps, out, err };
};

describe('listLocalAgents', () => {
    it('keeps the top-level agent sessions only and keys them like agent send', () => {
        const { deps } = makeDeps([
            row('hwip-b', { label: 'worker', providerSessionName: 'hwipit-95', state: 'idle', lastActivityAt: '2026-10-09T01:00:00.000Z', attached: true }),
            row('hwip-a', { agentKind: 'pi', state: 'working' }),
            row('hwip-a.48', { parentName: 'hwip-a' }),
            row('hwip-sh', { agentKind: 'shell' }),
        ]);

        const result = listLocalAgents(deps);

        expect(result).toEqual({
            ok: true,
            v: 1,
            device: 'dev_mac',
            sessions: [
                { key: 'dev_mac:hwip-a', name: 'hwip-a', agent: 'pi', project: 'proj', label: null, providerName: null, handle: null, state: 'working', attached: false, lastActivityAt: null, self: false },
                { key: 'dev_mac:hwip-b', name: 'hwip-b', agent: 'claude', project: 'proj', label: 'worker', providerName: 'hwipit-95', handle: null, state: 'idle', attached: true, lastActivityAt: '2026-10-09T01:00:00.000Z', self: false },
            ],
        });
    });

    // The name Claude Code shows for the session (`ko-qmd-70`): what the user calls it, and a target agent send takes.
    it('lists each session with its handle', () => {
        const { deps } = makeDeps([row('hwip-a', { providerSessionHandle: 'ko-qmd-70' }), row('hwip-b')]);

        const result = listLocalAgents(deps);

        expect(result.ok && result.sessions.map((s) => [s.name, s.handle])).toEqual([
            ['hwip-a', 'ko-qmd-70'],
            ['hwip-b', null],
        ]);
    });

    it('marks self on the row whose key is this process session', () => {
        const { deps } = makeDeps([row('hwip-a'), row('hwip-b')], { selfKey: () => 'dev_mac:hwip-b' });

        const result = listLocalAgents(deps);

        expect(result.ok && result.sessions.map((s) => [s.name, s.self])).toEqual([
            ['hwip-a', false],
            ['hwip-b', true],
        ]);
    });

    it('reports a null state for a session whose screen was not read', () => {
        const { deps } = makeDeps([row('hwip-a')]);

        const result = listLocalAgents(deps);

        expect(result.ok && result.sessions[0]?.state).toBeNull();
    });

    it('answers an empty list when tmux answered but no agent runs', () => {
        const { deps } = makeDeps([]);

        expect(listLocalAgents(deps)).toEqual({ ok: true, v: 1, device: 'dev_mac', sessions: [] });
    });

    it('answers NO_TMUX when nothing is listed and tmux was not visible', () => {
        const { deps } = makeDeps([], { tmuxVisible: () => false });

        expect(listLocalAgents(deps)).toEqual({ ok: false, code: 'NO_TMUX', message: expect.stringContaining('tmux') });
    });

    it('does not ask whether tmux is visible while there are sessions', () => {
        const tmuxVisible = vi.fn(() => false);
        const { deps } = makeDeps([row('hwip-a')], { tmuxVisible });

        expect(listLocalAgents(deps).ok).toBe(true);
        expect(tmuxVisible).not.toHaveBeenCalled();
    });

    it('lists keys that agent send resolves to the same session', () => {
        const { deps } = makeDeps([row('hwip-a'), row('hwip-b')]);
        const result = listLocalAgents(deps);
        if (!result.ok) throw new Error('expected a list');

        for (const s of result.sessions) {
            const target = resolveAgentTarget(
                [{ deviceId: result.device, agentSessions: result.sessions.map((x) => ({ name: x.name })) }],
                s.key,
            );
            expect(target.name).toBe(s.name);
        }
    });
});

describe('runAgentList', () => {
    it('prints the contract as one JSON line with --json', async () => {
        const { deps, out } = makeDeps([row('hwip-a', { state: 'idle' })]);

        const code = await runAgentList({ json: true }, deps);

        expect(code).toBe(0);
        expect(out).toHaveLength(1);
        expect(JSON.parse(out[0]!)).toEqual({
            v: 1,
            device: 'dev_mac',
            sessions: [
                { key: 'dev_mac:hwip-a', name: 'hwip-a', agent: 'claude', project: 'proj', label: null, providerName: null, handle: null, state: 'idle', attached: false, lastActivityAt: null, self: false },
            ],
        });
        expect(out[0]).not.toContain('\n');
    });

    it('prints a table with the key, agent, state and name, and marks this session', async () => {
        const { deps, out } = makeDeps(
            [row('hwip-a', { state: 'working', providerSessionName: 'hwipit-95' }), row('hwip-b', { agentKind: 'codex' })],
            { selfKey: () => 'dev_mac:hwip-b' },
        );

        const code = await runAgentList({ json: false }, deps);

        expect(code).toBe(0);
        const lines = out.join('\n').split('\n');
        expect(lines[0]).toMatch(/^KEY\s+AGENT\s+STATE\s+NAME$/);
        expect(lines[1]).toMatch(/^dev_mac:hwip-a\s+claude\s+working\s+hwipit-95$/);
        expect(lines[2]).toMatch(/^dev_mac:hwip-b\s+codex\s+-\s+-\s+\(this session\)$/);
    });

    it('strips control characters from a name the agent chose before it reaches the terminal', async () => {
        const { deps, out } = makeDeps([row('hwip-a', { providerSessionName: 'evil\u001b]0;pwned\u0007name' })]);

        await runAgentList({ json: false }, deps);

        expect(out.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
        expect(out.join('\n')).toContain('name');
    });

    it('says so when there are no sessions, exit 0', async () => {
        const { deps, out } = makeDeps([]);

        expect(await runAgentList({ json: false }, deps)).toBe(0);
        expect(out.join('\n')).toContain('no agent sessions');
    });

    it('exits 1 with a NO_TMUX json object on stdout under --json', async () => {
        const { deps, out, err } = makeDeps([], { tmuxVisible: () => false });

        const code = await runAgentList({ json: true }, deps);

        expect(code).toBe(1);
        expect(JSON.parse(out[0]!)).toEqual({ v: 1, error: 'NO_TMUX', message: expect.any(String) });
        expect(err).toEqual([]);
    });

    it('exits 1 with the message on stderr in text mode', async () => {
        const { deps, out, err } = makeDeps([], { tmuxVisible: () => false });

        expect(await runAgentList({ json: false }, deps)).toBe(1);
        expect(out).toEqual([]);
        expect(err.join('\n')).toContain('tmux');
    });

    it('waits for an async sink before it returns', async () => {
        let flushed = false;
        const { deps } = makeDeps([row('hwip-a')], {
            out: async () => {
                await new Promise((r) => setTimeout(r, 5));
                flushed = true;
            },
        });

        await runAgentList({ json: true }, deps);

        expect(flushed).toBe(true);
    });
});

describe('runAgentListAll — every machine', () => {
    const allDeps = (listDevices: AllAgentDeps['listDevices']) => {
        const out: string[] = [];
        const err: string[] = [];
        const deps: AllAgentDeps = {
            listDevices,
            selfKey: () => 'dev_mac:hwip-a',
            out: (text) => {
                out.push(text);
            },
            err: (line) => {
                err.push(line);
            },
        };
        return { deps, out, err };
    };
    const devices = [
        { deviceId: 'dev_mac', nickname: 'mac', agentSessions: [{ name: 'hwip-a', project: 'a', agentKind: 'claude' }] },
        { deviceId: 'dev_win', nickname: 'takui', agentSessions: [{ name: 'hwip-b', project: 'b', agentKind: 'claude', providerSessionHandle: 'b-\u001b[31m70', state: 'idle' }] },
    ];

    it('prints every machine as one JSON object', async () => {
        const { deps, out } = allDeps(async () => devices);

        expect(await runAgentListAll({ json: true }, deps)).toBe(0);

        const body = JSON.parse(out[0]!);
        expect(body).toMatchObject({ v: 1, all: true });
        expect(body.sessions.map((s: { key: string; self: boolean; host: string }) => [s.key, s.host, s.self])).toEqual([
            ['dev_mac:hwip-a', 'mac', true],
            ['dev_win:hwip-b', 'takui', false],
        ]);
    });

    it('prints every machine as a table with no control characters from a name', async () => {
        const { deps, out } = allDeps(async () => devices);

        await runAgentListAll({ json: false }, deps);

        expect(out[0]).toContain('takui');
        expect(out[0]).toContain('b- [31m70');
        expect(out[0]).not.toContain('\u001b');
    });

    // Every cell of the table is another machine's report: the key and agent kind as much as the name.
    it('prints every machine with no control characters in its key, agent or state either', async () => {
        const { deps, out } = allDeps(async () => [
            { deviceId: 'dev_win', agentSessions: [{ name: 'hwip-\u001b]0;x\u0007', project: 'p', agentKind: 'cl\u001baude', state: 'id\u001ble' }] },
        ]);

        await runAgentListAll({ json: false }, deps);

        expect(out[0]).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
    });

    it('fails with exit 1 when every machine cannot be listed, as JSON too', async () => {
        const text = allDeps(async () => {
            throw new Error('401 Unauthorized');
        });
        const json = allDeps(async () => {
            throw new Error('401 Unauthorized');
        });

        expect(await runAgentListAll({ json: false }, text.deps)).toBe(1);
        expect(text.err[0]).toContain('401 Unauthorized');
        expect(await runAgentListAll({ json: true }, json.deps)).toBe(1);
        expect(JSON.parse(json.out[0]!)).toMatchObject({ v: 1, error: 'LIST_FAILED', message: expect.stringContaining('401') });
    });
});
