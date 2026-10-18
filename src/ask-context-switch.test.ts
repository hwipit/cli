import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectHash, stateDir } from './gate.js';
import {
    askContextEnabled,
    askContextOffBy,
    askContextProjectDir,
    runAskContext,
    setAskContext,
    type AskContextCommandDeps,
} from './ask-context-switch.js';

let home: string;
let savedState: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwip-ctx-switch-'));
    savedState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = home;
});
afterEach(() => {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
    rmSync(home, { recursive: true, force: true });
});

const A = '/work/project-a';
const B = '/work/project-b';
const NO_ENV: NodeJS.ProcessEnv = {};

describe('the ask-context switch', () => {
    it('is on until someone turns it off', () => {
        expect(askContextEnabled(A, NO_ENV)).toBe(true);
        expect(askContextOffBy(A, NO_ENV)).toBeNull();
    });

    it('turns off one project and leaves the others alone', () => {
        setAskContext(A, false, 'project');

        expect(askContextOffBy(A, NO_ENV)).toBe('project');
        expect(askContextOffBy(B, NO_ENV)).toBeNull();
    });

    it('keeps the project switch in a state file named like the mute and push-mode files', () => {
        setAskContext(A, false, 'project');

        expect(existsSync(join(stateDir(), `ask-context-off-${projectHash(A)}`))).toBe(true);
    });

    it('turns off every project with the global switch', () => {
        setAskContext(A, false, 'global');

        expect(existsSync(join(stateDir(), 'ask-context-off-default'))).toBe(true);
        expect(askContextOffBy(A, NO_ENV)).toBe('global');
        expect(askContextOffBy(B, NO_ENV)).toBe('global');
    });

    it('turns back on, and on for a project does not undo the global switch', () => {
        setAskContext(A, false, 'project');
        setAskContext(A, false, 'global');

        setAskContext(A, true, 'project');
        expect(askContextOffBy(A, NO_ENV)).toBe('global');

        setAskContext(A, true, 'global');
        expect(askContextEnabled(A, NO_ENV)).toBe(true);
    });

    it('turning on what was never off is not an error, and off twice is the same as once', () => {
        expect(() => setAskContext(A, true, 'project')).not.toThrow();
        setAskContext(A, false, 'project');
        setAskContext(A, false, 'project');

        expect(askContextOffBy(A, NO_ENV)).toBe('project');
    });

    it.each(['0', 'false', 'OFF', ' no '])('HWIP_ASK_CONTEXT=%j switches it off for the run', (value) => {
        expect(askContextOffBy(A, { HWIP_ASK_CONTEXT: value })).toBe('env');
    });

    it.each(['1', 'on', '', 'yes'])('HWIP_ASK_CONTEXT=%j leaves it on', (value) => {
        expect(askContextEnabled(A, { HWIP_ASK_CONTEXT: value })).toBe(true);
    });

    it('counts a switch it cannot read as off, so a broken state directory does not turn it back on', () => {
        // The state directory is a file: looking inside it fails with ENOTDIR, which is not "no such file".
        writeFileSync(join(home, 'hwip'), 'not a directory');

        expect(askContextOffBy(A, NO_ENV)).toBe('unreadable');
        expect(askContextEnabled(A, NO_ENV)).toBe(false);
    });

    it('throws when it cannot write the switch', () => {
        writeFileSync(join(home, 'hwip'), 'not a directory');

        expect(() => setAskContext(A, false, 'project')).toThrow();
    });
});

describe('the project a question belongs to', () => {
    it('is the repository root, else the directory itself', () => {
        expect(askContextProjectDir('/work/a/src', () => '/work/a')).toBe('/work/a');
        expect(askContextProjectDir('/tmp/loose', () => null)).toBe('/tmp/loose');
    });

    it('is the same from a subfolder of a real repository', () => {
        const repo = realpathSync(mkdtempSync(join(tmpdir(), 'hwip-ctx-repo-')));
        try {
            execFileSync('git', ['init', '-q', repo]);
            mkdirSync(join(repo, 'src', 'deep'), { recursive: true });

            expect(askContextProjectDir(join(repo, 'src', 'deep'))).toBe(repo);
            expect(askContextProjectDir(repo)).toBe(repo);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('hwip ask-context', () => {
    const run = (sub: string | undefined, global = false, over: Partial<AskContextCommandDeps> = {}) => {
        const out: string[] = [];
        const err: string[] = [];
        const status = runAskContext(sub, global, {
            cwd: () => `${A}/src`,
            repoRoot: () => A,
            env: NO_ENV,
            out: (line) => void out.push(line),
            err: (line) => void err.push(line),
            ...over,
        });
        return { status, out, err };
    };

    it('says it is on, with no subcommand or with status', () => {
        expect(run(undefined)).toEqual({ status: 0, out: ['ask context: on'], err: [] });
        expect(run('status').out).toEqual(['ask context: on']);
    });

    it('turns off the project of the repository root, whatever folder it runs in, and says so', () => {
        const off = run('off');

        expect(off).toEqual({ status: 0, out: ['ask context: off (turned off for this project)'], err: [] });
        expect(askContextOffBy(A, NO_ENV)).toBe('project');
        expect(run('status', false, { cwd: () => `${A}/other` }).out).toEqual(['ask context: off (turned off for this project)']);
    });

    it('turns it back on', () => {
        run('off');

        expect(run('on').out).toEqual(['ask context: on']);
    });

    it('says why it is still off when the other switch holds', () => {
        run('off', true);

        expect(run('on').out).toEqual(['ask context: off (turned off for every project)']);
        expect(run('on', true).out).toEqual(['ask context: on']);
    });

    it('names the environment variable when that is what holds it off', () => {
        expect(run('status', false, { env: { HWIP_ASK_CONTEXT: '0' } }).out).toEqual(['ask context: off (HWIP_ASK_CONTEXT is set to off)']);
    });

    it('refuses an unknown subcommand and --global with status, without touching the state', () => {
        const unknown = run('frobnicate');
        const withStatus = run('status', true);

        expect(unknown.status).toBe(2);
        expect(unknown.err[0]).toContain("hwip ask-context: unknown subcommand 'frobnicate'");
        expect(withStatus.status).toBe(2);
        expect(existsSync(stateDir())).toBe(false);
    });

    it('exits 1 and says so when the switch cannot be written', () => {
        writeFileSync(join(home, 'hwip'), 'not a directory');

        const result = run('off');

        expect(result.status).toBe(1);
        expect(result.err[0]).toContain('hwip ask-context: could not change the switch');
        expect(result.out).toEqual([]);
    });
});
