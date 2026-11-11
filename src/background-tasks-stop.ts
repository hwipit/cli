/**
 * Stopping a background command a Claude session runs, for the phone's Stop
 * (`agent.task.stop.request`, handled in listener.ts).
 *
 * The phone names a task by id; nothing it sends says which process to
 * signal. The target is found here, from this machine's own answers, and only
 * when every one agrees. Measured 2026-11-11 (Claude Code 2.x): Claude starts
 * each background command under a wrapper shell that leads its own process
 * group, as a child of `claude`; `lsof` on the task's output file names the
 * wrapper and its children; `kill -TERM -<pgid>` ends the whole tree, and
 * Claude then writes the task's `<task-notification>` with status `failed`.
 *
 * So the target is the one process group whose leader writes the output and
 * descends from the session's pane. Anything less certain signals nothing.
 */
import { lsofBin, runProbe, type BackgroundTask } from './background-tasks.js';
import { parseProcTable, type ProcTable } from './remote-agents.js';

/** What a stop found. Only `group` is ever signalled. */
export type StopTarget =
    | { readonly kind: 'group'; readonly pgid: number }
    /** Nobody writes the output, no writer leads a group under the pane, or `lsof`/`ps` could not say. */
    | { readonly kind: 'not_found' }
    /** More than one group qualifies: which one the task is cannot be told. */
    | { readonly kind: 'ambiguous' }
    /** The group is one a stop must never signal: this listener's, the pane shell's, claude's, or the system's. */
    | { readonly kind: 'refused' };

export type StopOutcome = 'stopped' | 'not_found' | 'ambiguous' | 'refused' | 'kill_failed';

export interface StopProbes {
    /** Pids with the file open, or null when that cannot be told. */
    readonly writerPids: (path: string) => Promise<readonly number[] | null>;
    readonly procTable: () => Promise<ProcTable | null>;
    /** This listener's pid, whose group is never signalled. */
    readonly selfPid: number;
}

/** Deepest ancestor chain walked from a group leader up to the pane. */
const MAX_ANCESTRY = 64;

/** `lsof -t -- <path>`: one pid per line. Exit 1 is "open nowhere", still an answer. */
const lsofPids = async (path: string): Promise<readonly number[] | null> => {
    const bin = lsofBin();
    if (!bin) return null;
    const out = await runProbe(bin, ['-t', '--', path], [1]);
    if (out === null) return null;
    return out.split('\n').map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
};

const psTable = async (): Promise<ProcTable | null> => {
    const out = await runProbe('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,comm='], []);
    return out === null ? null : parseProcTable(out);
};

export const defaultStopProbes: StopProbes = { writerPids: lsofPids, procTable: psTable, selfPid: process.pid };

const parentsOf = (table: ProcTable): Map<number, number> => {
    const parentOf = new Map<number, number>();
    for (const [ppid, kids] of table.children) for (const pid of kids) parentOf.set(pid, ppid);
    return parentOf;
};

/**
 * The processes from `leader`'s parent up to and including `panePid`, or null
 * when the pane is not an ancestor of the leader.
 */
const chainToPane = (leader: number, panePid: number, parentOf: ReadonlyMap<number, number>): number[] | null => {
    const chain: number[] = [];
    let pid = parentOf.get(leader);
    for (let hop = 0; pid !== undefined && pid > 0 && hop < MAX_ANCESTRY; hop++) {
        chain.push(pid);
        if (pid === panePid) return chain;
        pid = parentOf.get(pid);
    }
    return null;
};

/**
 * The process group that runs the task writing `outputPath` under the pane
 * whose shell is `panePid`: the group of a writer whose LEADER is a writer too
 * and descends from the pane. A group a stop must never end — this listener's,
 * the pane's foreground group (claude's), or any on the way from the leader up
 * to the pane — is refused even when it qualifies.
 */
export const findTaskProcessGroup = async (outputPath: string, panePid: number, probes: StopProbes = defaultStopProbes): Promise<StopTarget> => {
    if (!Number.isInteger(panePid) || panePid <= 1) return { kind: 'not_found' };
    const [writers, table] = await Promise.all([probes.writerPids(outputPath), probes.procTable()]);
    if (!writers || writers.length === 0 || !table) return { kind: 'not_found' };
    const writing = new Set(writers);
    const parentOf = parentsOf(table);
    const forbidden = new Set<number>();
    // This listener's group, the pane shell's, and the pane's foreground group:
    // the program the user sees in the pane (claude), which background
    // commands never lead.
    for (const group of [table.pgidOf.get(probes.selfPid), table.pgidOf.get(panePid), table.tpgidOf.get(panePid)]) {
        if (group !== undefined) forbidden.add(group);
    }
    const candidates = new Set<number>();
    for (const pid of writing) {
        const pgid = table.pgidOf.get(pid);
        if (pgid === undefined || !writing.has(pgid)) continue;
        const chain = chainToPane(pgid, panePid, parentOf);
        if (!chain) continue;
        for (const up of chain) {
            const upGroup = table.pgidOf.get(up);
            if (upGroup !== undefined) forbidden.add(upGroup);
        }
        candidates.add(pgid);
    }
    if (candidates.size === 0) return { kind: 'not_found' };
    if (candidates.size > 1) return { kind: 'ambiguous' };
    const pgid = candidates.values().next().value!;
    if (pgid <= 1 || forbidden.has(pgid)) return { kind: 'refused' };
    return { kind: 'group', pgid };
};

export interface StopDeps {
    readonly probes?: StopProbes;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Find the task's process group and send it SIGTERM — the group, so the command's children end with it. */
export const stopBackgroundTask = async (task: BackgroundTask, panePid: number, deps: StopDeps = {}): Promise<StopOutcome> => {
    const target = await findTaskProcessGroup(task.outputPath, panePid, deps.probes ?? defaultStopProbes);
    if (target.kind !== 'group') return target.kind;
    try {
        (deps.kill ?? process.kill)(-target.pgid, 'SIGTERM');
        return 'stopped';
    } catch {
        return 'kill_failed';
    }
};
