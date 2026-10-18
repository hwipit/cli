import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTmpStateDir } from './test-state-dir.js';

/**
 * `known-sessions.json` is the listener's resume whitelist and the listener writes it in place. `hwip agent
 * list|read` sweep with the listener's own collector, which ends in `rememberSessions` — so the CLI process must
 * not write there. The collector below ends in the real `rememberSessions`, like the real sweep does.
 */

withTmpStateDir('hwip-list-registry-');

// The registry module of the current test (modules are reset between tests, the mock factory runs once).
let registry: typeof import('./session-registry.js');

vi.mock('./listener.js', () => {
    return {
        silenceListenerLog: () => {},
        liveSessionNames: () => [],
        isSubagentSessionName: () => false,
        resolveWatchTranscript: () => null,
        tmuxTargetFor: () => null,
        tmuxArgs: (args: string[]) => args,
        detectRemoteAgent: () => null,
        collectSessionsVerbose: () => {
            registry.rememberSessions([{ name: 'hwip-api', cwd: '/work/api', agentKind: 'claude', project: 'api', label: null }]);
            return { sessions: [] };
        },
    };
});
vi.mock('./agent-rules-fetch.js', () => ({ syncManifestFromCache: () => {} }));

const OLD = new Date('2026-01-01T00:00:00.000Z');

/** The file as the listener left it: other content than the sweep would write, and an old mtime. */
const seedRegistry = async (): Promise<{ path: string; content: string }> => {
    registry = await import('./session-registry.js');
    const path = registry.knownSessionsPath();
    const content = JSON.stringify([{ name: 'hwip-other', cwd: '/work/other', agentKind: 'codex', lastSeenAt: new Date().toISOString() }]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    utimesSync(path, OLD, OLD);
    return { path, content };
};

describe('the sweep behind agent list and read', () => {
    beforeEach(async () => {
        vi.resetModules();
        registry = await import('./session-registry.js');
    });

    it('would rewrite the registry if nothing held it back (the control)', async () => {
        const { path, content } = await seedRegistry();
        const { collectSessionsVerbose } = await import('./listener.js');

        collectSessionsVerbose();

        expect(readFileSync(path, 'utf-8')).not.toBe(content);
    });

    it('leaves the registry file as it was: same bytes, same mtime', async () => {
        const { path, content } = await seedRegistry();
        const { liveLocalAgentDeps } = await import('./agent-list.js');
        const deps = await liveLocalAgentDeps();

        deps.collect();

        expect(readFileSync(path, 'utf-8')).toBe(content);
        expect(statSync(path).mtimeMs).toBe(OLD.getTime());
    });

    it('does not create the registry when there is none', async () => {
        const { liveLocalAgentDeps } = await import('./agent-list.js');
        const deps = await liveLocalAgentDeps();

        deps.collect();

        expect(() => statSync(registry.knownSessionsPath())).toThrow();
    });

    it('is the same for agent read, which sweeps through the same deps', async () => {
        const { path, content } = await seedRegistry();
        const { liveAgentReadDeps } = await import('./agent-read.js');
        const deps = await liveAgentReadDeps();

        deps.inventory();

        expect(readFileSync(path, 'utf-8')).toBe(content);
        expect(statSync(path).mtimeMs).toBe(OLD.getTime());
    });
});
