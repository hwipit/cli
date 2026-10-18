import { flagOn } from './args.js';
import { projectDirOf, projectSwitch, type SwitchOffBy } from './project-switch.js';
import { repoRootOf } from './session-diff.js';

/**
 * The switch for the context a sealed question may carry (`ask-context.ts`): one state file per project and one
 * for every project. Both are local files in the state directory (`gate.ts`'s, beside `muted-<hash>`) — the
 * switch never reaches the server or the wire. No file means on: the context is automatic for an account with
 * E2E on (the user's decision), and this is how a project or the whole machine opts out.
 */

export type AskContextOffBy = SwitchOffBy;

const askContext = projectSwitch('ask-context', 'HWIP_ASK_CONTEXT');

/** The project a question belongs to: the repository root, else the directory itself, so a question asked from a subfolder reads the same switch. */
export const askContextProjectDir = projectDirOf;

/** Why the context is off for this project, or `null` when it is on. `HWIP_ASK_CONTEXT=0` turns it off for one run. */
export const askContextOffBy = askContext.offBy;

export const askContextEnabled = (dir: string, env: NodeJS.ProcessEnv = process.env): boolean => askContextOffBy(dir, env) === null;

/** Turn the context on or off for this project, or for every project. Throws when the state file cannot be written or removed. */
export const setAskContext = askContext.set;

const REASON: Record<AskContextOffBy, string> = {
    env: 'HWIP_ASK_CONTEXT is set to off',
    project: 'turned off for this project',
    global: 'turned off for every project',
    unreadable: 'the switch file cannot be read, so it is treated as off',
};

export const describeAskContext = (offBy: AskContextOffBy | null): string =>
    offBy === null ? 'ask context: on' : `ask context: off (${REASON[offBy]})`;

const USAGE = 'Usage: hwip ask-context [status | on | off | show] [--global]';

export interface AskContextCommandDeps {
    cwd: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    env: NodeJS.ProcessEnv;
    repoRoot: (cwd: string) => string | null;
}

export const runAskContext = (sub: string | undefined, global: boolean, deps: AskContextCommandDeps): number => {
    const word = sub ?? 'status';
    if (word !== 'status' && word !== 'on' && word !== 'off') {
        deps.err(`hwip ask-context: unknown subcommand '${word}'. ${USAGE}`);
        return 2;
    }
    if (global && word === 'status') {
        deps.err(`hwip ask-context: --global goes with on or off. ${USAGE}`);
        return 2;
    }
    const dir = askContextProjectDir(deps.cwd(), deps.repoRoot);
    if (word !== 'status') {
        try {
            setAskContext(dir, word === 'on', global ? 'global' : 'project');
        } catch (err) {
            deps.err(`hwip ask-context: could not change the switch: ${(err as Error).message}`);
            return 1;
        }
    }
    deps.out(describeAskContext(askContextOffBy(dir, deps.env)));
    return 0;
};

/**
 * `show` prints, as one JSON line, what a question asked from this directory would carry: `{ context, off? }`
 * (`collectAskContext`). It reads the switch itself, so a caller that only seals (mcp-server's `hwip_ask`) needs
 * no switch logic of its own. Nothing is sent.
 */
export const handleAskContext = async (args: Record<string, string | boolean>): Promise<number> => {
    if (args._arg1 === 'show') {
        if (flagOn(args, 'global')) {
            console.error(`hwip ask-context: --global goes with on or off. ${USAGE}`);
            return 2;
        }
        const { collectAskContext } = await import('./ask-context-attach.js');
        const line = `${JSON.stringify(await collectAskContext(process.cwd(), process.env))}\n`;
        // The caller exits right after: a pipe on macOS is written asynchronously, and 64 KiB would be cut short.
        await new Promise<void>((resolve, reject) => process.stdout.write(line, (err) => (err ? reject(err) : resolve())));
        return 0;
    }
    return runAskContext(typeof args._arg1 === 'string' && args._arg1 ? args._arg1 : undefined, flagOn(args, 'global'), {
        cwd: () => process.cwd(),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        env: process.env,
        repoRoot: repoRootOf,
    });
};
