import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { REMOTE_AGENTS } from './remote-agents.js';
import { resumeHint, type ResumeHintDeps } from './resume-hint.js';
import type { KnownSession } from './session-registry.js';
import { withResumeHint, type SpawnTarget } from './wrapper.js';

const claude = {
    kind: 'claude',
    binary: 'claude',
    subcommands: ['cc', 'claude'],
    resumeArgs: (id: string) => ['--resume', id],
};

const LAUNCHED = Date.parse('2026-11-10T07:00:00Z');

const run = (over: Partial<KnownSession> = {}): KnownSession => ({
    name: 'hwip-gikae',
    cwd: '/work/gikae',
    agentKind: 'claude',
    lastSeenAt: '2026-11-10T07:30:00Z',
    agentSessionId: '36b1ab9f-ec6a-4234-81be-895606a059ba',
    ...over,
});

const deps = (over: Partial<ResumeHintDeps> = {}): ResumeHintDeps => ({
    recall: () => run(),
    alive: () => false,
    cwd: '/work/gikae',
    ...over,
});

describe('resumeHint', () => {
    it('names the command that picks the closed conversation back up', () => {
        expect(resumeHint('hwip-gikae', claude, LAUNCHED, deps())).toBe(
            'hwip: to resume: claude --resume 36b1ab9f-ec6a-4234-81be-895606a059ba' +
            '  (or hwip cc --resume 36b1ab9f-ec6a-4234-81be-895606a059ba)',
        );
    });

    it('names the directory when the conversation belongs to another one', () => {
        const line = resumeHint('hwip-gikae', claude, LAUNCHED, deps({ cwd: '/work/other' }));
        expect(line).toContain('to resume in /work/gikae: claude --resume');
    });

    // The same path serves every agent whose row can resume a conversation by id.
    it('uses the agent row\'s own resume arguments (opencode)', () => {
        const opencode = REMOTE_AGENTS.find((a) => a.kind === 'opencode')!;
        const line = resumeHint('hwip-gikae', opencode, LAUNCHED, deps({ recall: () => run({ agentKind: 'opencode', agentSessionId: 'ses_1' }) }));
        expect(line).toBe('hwip: to resume: opencode --session ses_1  (or hwip opencode --session ses_1)');
    });

    // `tmux new` returns on a detach too, and the session is still running then.
    it('says nothing when the session was only detached', () => {
        expect(resumeHint('hwip-gikae', claude, LAUNCHED, deps({ alive: () => true }))).toBeNull();
    });

    // A record no sweep has touched since the launch is an earlier run under the same name.
    it('says nothing for a record older than this launch', () => {
        const stale = deps({ recall: () => run({ lastSeenAt: '2026-11-10T06:59:00Z' }) });
        expect(resumeHint('hwip-gikae', claude, LAUNCHED, stale)).toBeNull();
    });

    it('says nothing when the sweep never read a conversation id', () => {
        expect(resumeHint('hwip-gikae', claude, LAUNCHED, deps({ recall: () => run({ agentSessionId: undefined }) }))).toBeNull();
        expect(resumeHint('hwip-gikae', claude, LAUNCHED, deps({ recall: () => null }))).toBeNull();
    });

    it('says nothing when the agent cannot resume that conversation', () => {
        expect(resumeHint('hwip-gikae', { ...claude, resumeArgs: () => null }, LAUNCHED, deps())).toBeNull();
    });

    it('quotes a pi session path with spaces', () => {
        const pi = { kind: 'pi', binary: 'pi', subcommands: ['pi'], resumeArgs: (id: string) => ['--session', `/Users/a b/${id}.jsonl`] };
        const line = resumeHint('hwip-gikae', pi, LAUNCHED, deps({ recall: () => run({ agentKind: 'pi', agentSessionId: 'x1' }) }));
        expect(line).toContain("pi --session '/Users/a b/x1.jsonl'");
    });
});

describe('withResumeHint', () => {
    const attached: SpawnTarget = { kind: 'tmux-new', cmd: 'tmux', args: ['new', '-A', '-s', 'hwip-gikae', 'claude'], session: 'hwip-gikae' };

    it('leaves anything but an attached tmux session as it is', () => {
        const direct: SpawnTarget = { kind: 'direct', cmd: 'claude', args: [] };
        expect(withResumeHint(direct, claude, LAUNCHED)).toBe(direct);
    });

    it('leaves an agent that cannot resume by id as it is', () => {
        expect(withResumeHint(attached, { kind: 'gemini' }, LAUNCHED)).toBe(attached);
    });

    // Run for real: tmux's exit status must come through the sh, and the hint run after it.
    it('runs tmux with its own argv, then the hint, and exits with tmux\'s status', () => {
        const wrapped = withResumeHint(attached, claude, LAUNCHED, { node: 'echo', cli: 'HINT' });
        expect(wrapped.cmd).toBe('sh');
        const script = wrapped.args[1]!.replace('tmux "$@"', 'printf "%s|" "$@"; false');
        let out = '';
        let status = 0;
        try {
            execFileSync('sh', ['-c', script, ...wrapped.args.slice(2)], { encoding: 'utf-8' });
        } catch (e) {
            const err = e as { stdout: string; status: number };
            out = err.stdout;
            status = err.status;
        }
        expect(status).toBe(1);
        expect(out).toBe(`new|-A|-s|hwip-gikae|claude|HINT resume-hint --session hwip-gikae --type claude --at ${LAUNCHED}\n`);
    });
});
