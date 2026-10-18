import { readFileSync } from 'node:fs';
import { flagOn } from './args.js';
import { LISTENER_LOG_FILE } from './listener-process.js';
import { projectDirOf, projectSwitch, type SwitchOffBy } from './project-switch.js';
import { repoRootOf } from './session-diff.js';

/**
 * The switch for the phone's file view (V13): one state file per project (`file-view-off-<hash>`) and one for
 * every project (`file-view-off-default`), local to this machine. On unless turned off — the default is on (D10).
 * `HWIP_FILE_VIEW=0` in the listener's environment turns it off for that run. The listener asks with the
 * repository root of the session the request names, which is the directory `hwip file-view off` writes under.
 */
const fileView = projectSwitch('file-view', 'HWIP_FILE_VIEW');

/** Why the file view is off for the project at `dir`, or `null` when it is on. A switch file that cannot be read counts as off. */
export const fileViewOffBy = fileView.offBy;

export const setFileView = fileView.set;

const REASON: Record<SwitchOffBy, string> = {
    env: 'HWIP_FILE_VIEW is set to off here; a running listener reads its own environment',
    project: 'turned off for this project',
    global: 'turned off for every project',
    unreadable: 'the switch file cannot be read, so it is treated as off',
};

export const describeFileView = (offBy: SwitchOffBy | null): string =>
    offBy === null ? 'file view: on' : `file view: off (${REASON[offBy]})`;

const USAGE = 'Usage: hwip file-view [status | on | off | log] [--global]';

/** How many reads `log` shows: the most recent. */
export const FILE_VIEW_LOG_LINES = 50;

/**
 * What a terminal or a reader obeys that must not reach a log line as itself: control characters (ESC, CR), DEL, C1
 * controls (U+009B is CSI), zero-width and direction marks, line and paragraph separators, bidi overrides and isolates,
 * the byte-order mark, interlinear annotation marks and the tag characters. Written by the listener after JSON quoting
 * and applied again when the line is read back: a log is a file other lines also land in.
 */
const LOG_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

export const escapeLogUnsafe = (text: string): string =>
    text.replace(LOG_UNSAFE, (c) => {
        const code = c.codePointAt(0) as number;
        return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
    });

/**
 * The log line a read leaves (`listener.ts`, `logFileView`): the stamp, then `file-view: ` and the fields, in that
 * shape. A line that only starts like one is not a read — the log also holds lines that carry names a relay chose.
 */
const READ_LINE = /^\[[^\]]*\] file-view: (at=\S+ device=".*" session=".*" op=(?:tree|blob) path=".*" bytes=\d+ masked=\d+ result=[a-z_]+)$/;

/**
 * The most recent reads in a listener log, oldest first, without the stamp (the line carries its own date).
 * `older` is the log the listener keeps when it rotates; it is read only when the current one has too few.
 */
export const recentFileViewReads = (current: string, older: string, limit: number = FILE_VIEW_LOG_LINES): string[] => {
    const reads = (text: string): string[] =>
        text.split('\n').flatMap((line) => {
            const match = READ_LINE.exec(line);
            return match ? [escapeLogUnsafe(match[1])] : [];
        });
    const now = reads(current);
    return (now.length >= limit ? now : [...reads(older), ...now]).slice(-limit);
};

/** A log that is not there is empty; one that is there and cannot be read is an error, not "no reads". */
const readIfThere = (path: string): string => {
    try {
        return readFileSync(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw err;
    }
};

export interface FileViewCommandDeps {
    cwd: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    env: NodeJS.ProcessEnv;
    repoRoot: (cwd: string) => string | null;
    /** The listener log and the one it rotated out, as text; '' for a log that is not there. Throws for one that cannot be read. */
    readLogs: () => { current: string; older: string };
}

export const runFileView = (sub: string | undefined, global: boolean, deps: FileViewCommandDeps): number => {
    const word = sub ?? 'status';
    if (word !== 'status' && word !== 'on' && word !== 'off' && word !== 'log') {
        deps.err(`hwip file-view: unknown subcommand '${word}'. ${USAGE}`);
        return 2;
    }
    if (global && (word === 'status' || word === 'log')) {
        deps.err(`hwip file-view: --global goes with on or off. ${USAGE}`);
        return 2;
    }
    if (word === 'log') {
        let reads: string[];
        try {
            const { current, older } = deps.readLogs();
            reads = recentFileViewReads(current, older);
        } catch (err) {
            deps.err(`hwip file-view: could not read the listener log: ${(err as Error).message}`);
            return 1;
        }
        if (reads.length === 0) {
            deps.out('file view: no reads on record');
            // A listener run in the foreground writes to its terminal, so an empty log proves nothing about it.
            deps.out('(only a listener started by hwip cc or as a service writes ~/.hwip/listener.log; one run in the foreground prints to its own terminal)');
        }
        for (const read of reads) deps.out(read);
        return 0;
    }
    const dir = projectDirOf(deps.cwd(), deps.repoRoot);
    if (word !== 'status') {
        try {
            setFileView(dir, word === 'on', global ? 'global' : 'project');
        } catch (err) {
            deps.err(`hwip file-view: could not change the switch: ${(err as Error).message}`);
            return 1;
        }
    }
    deps.out(describeFileView(fileViewOffBy(dir, deps.env)));
    return 0;
};

export const handleFileView = async (args: Record<string, string | boolean>): Promise<number> =>
    runFileView(typeof args._arg1 === 'string' && args._arg1 ? args._arg1 : undefined, flagOn(args, 'global'), {
        cwd: () => process.cwd(),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        env: process.env,
        repoRoot: repoRootOf,
        readLogs: () => ({ current: readIfThere(LISTENER_LOG_FILE), older: readIfThere(`${LISTENER_LOG_FILE}.old`) }),
    });
