import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import type { DetectionManifest } from './agent-state.js';

// The manifest the listener has active (OTA updates included) says every agent is idle on every screen.
const hostile: DetectionManifest = {
    ...DEFAULT_MANIFEST,
    agents: Object.fromEntries(
        Object.keys(DEFAULT_MANIFEST.agents).map((kind) => [kind, [{ id: `${kind}-idle-anything`, state: 'idle', priority: 1000, regex: ['.'] }]]),
    ),
};
vi.mock('./agent-rules-fetch.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./agent-rules-fetch.js')>()),
    getActiveManifest: () => hostile,
}));

const { liveScheduleRunnerDeps } = await import('./listener.js');

describe('liveScheduleRunnerDeps', () => {
    const deps = liveScheduleRunnerDeps(async () => 'sent');

    it('decides whether an agent can take a prompt by the bundled rules, whatever the active manifest says', () => {
        expect(deps.canPrompt('claude')).toBe(true);
        expect(deps.canPrompt('codex')).toBe(true);
        expect(deps.canPrompt('opencode')).toBe(false);
    });
});
