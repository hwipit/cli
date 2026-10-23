/**
 * `hwip schedule` — add, list, edit and remove scheduled sessions (F8).
 *
 * This only writes and reads the files in `schedule.ts`. The listener starts the sessions
 * (`schedule-runner.ts`), so nothing here needs a running listener except the sessions firing.
 */

import { parseArgs } from './args.js';
import {
    addSchedule,
    ALL_DAYS,
    DAY_NAMES,
    defaultMaxRuntimeMin,
    isScheduleId,
    listSchedules,
    nextOccurrence,
    parseDuration,
    parseWhen,
    pastWhen,
    readScheduleState,
    removeSchedule,
    scheduleAnchor,
    schedulesDir,
    updateSchedule,
    validateSchedule,
    WEEKDAYS,
    type Checked,
    type Schedule,
    type ScheduleChange,
    type ScheduleWhen,
} from './schedule.js';
import { checkoutOf, VERSION } from './config.js';
import { runningListenerPid, runningListenerVersion } from './listener-process.js';
import { findAgentBySubcommand, REMOTE_AGENTS } from './remote-agents.js';
import { promptableScheduleKinds } from './schedule-ready.js';
import { detectProjectDir, ensureListenerRunning, listenerVersionDrifted, safeBasename, sanitizeLabel, tmuxSessionName } from './wrapper.js';
import { isValidBranchName, worktreeDirName } from './worktree.js';

export interface ScheduleCommandDeps {
    now: () => number;
    /** The directory the session is named for (`detectProjectDir`). */
    projectDir: () => string;
    /** The main checkout of the repo `dir` is in; null outside git. For `--wt`. */
    checkoutRoot: (dir: string) => string | null;
    /** Whether git takes `name` as a branch name. For `--wt`. */
    validBranch: (root: string, name: string) => Promise<boolean>;
    listenerRunning: () => boolean;
    /** The agent kinds a prompt can be scheduled for: those whose detection rules can say `idle` (`schedule-ready.ts`). */
    promptKinds: () => readonly string[];
    /**
     * Has a running listener of an older build replaced (`ensureListenerRunning`): an old one would skip a file it cannot read.
     * False when one still runs after it.
     */
    refreshListener: () => Promise<boolean>;
    out: (line: string) => void;
    err: (line: string) => void;
}

const USAGE = "usage: hwip schedule add <agent> (--at HH:MM [--days daily|weekdays|mon,wed,…] | --on YYYY-MM-DD --at HH:MM | --every <N>m|<N>h) [--prompt <text>] [--label <x>] [--wt <branch>] [--max-runtime <N>m|<N>h] [-- <agent args…>]\n"
    + '       hwip schedule edit <id> [--at HH:MM] [--days …] [--on YYYY-MM-DD] [--every <N>m|<N>h] [--prompt <text>] [--max-runtime <N>m|<N>h]\n'
    + '       hwip schedule [list] [--json]\n'
    + '       hwip schedule rm <id>';

const LISTENER_NOTE = "hwip: schedules start only while the listener runs ('hwip listener --install-service' keeps it running at login)";

type Flags = Record<string, string | boolean>;

/** A value flag's text: undefined when not given; an error when given without a value. */
const flagText = (flags: Flags, name: string): Checked<string | undefined> => {
    const value = flags[name];
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value !== 'string') return { ok: false, error: `--${name} needs a value` };
    return { ok: true, value };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatTime = (ms: number): string => {
    if (!Number.isFinite(new Date(ms).getTime())) return '-';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** `daily 09:00`, `weekdays 09:00`, `mon,wed 09:00`, `every 30m`, `every 2h`, `once 2026-10-24 09:00` (local time). */
export const describeWhen = (when: ScheduleWhen): string => {
    if (when.kind === 'once') return `once ${formatTime(Date.parse(when.at))}`;
    if (when.kind === 'every') return when.minutes % 60 === 0 ? `every ${when.minutes / 60}h` : `every ${when.minutes}m`;
    const days = when.days.join(',');
    const label = days === ALL_DAYS.join(',') ? 'daily' : days === WEEKDAYS.join(',') ? 'weekdays' : when.days.map((d) => DAY_NAMES[d]).join(',');
    return `${label} ${when.at}`;
};

interface Built {
    make: (id: string) => Schedule;
    agentName: string;
}

/** The schedule `hwip schedule add <words>` asks for, before it has an id. */
export const buildSchedule = async (words: string[], deps: ScheduleCommandDeps): Promise<Checked<Built>> => {
    const cut = words.indexOf('--');
    const own = cut < 0 ? words : words.slice(0, cut);
    const agentArgs = cut < 0 ? [] : words.slice(cut + 1);
    // `parseArgs` reads the words after the program name and script; the first word is the agent.
    const flags = parseArgs(['node', 'hwip', ...own]);
    const agentWord = String(flags._command);
    if (!agentWord) return { ok: false, error: 'schedule add needs an agent (hwip cc, codex, …)' };
    const agent = findAgentBySubcommand(agentWord);
    if (!agent) return { ok: false, error: `'${agentWord}' is not an agent hwip can start` };
    if (flags._arg1) return { ok: false, error: `unexpected word '${String(flags._arg1)}'` };

    const read = (name: string): Checked<string | undefined> => flagText(flags, name);
    const [at, days, every, on, prompt, label, wt, maxRuntime] = ['at', 'days', 'every', 'on', 'prompt', 'label', 'wt', 'max-runtime'].map(read);
    const bad = [at, days, every, on, prompt, label, wt, maxRuntime].find((r) => !r.ok);
    if (bad && !bad.ok) return bad;
    const value = (r: Checked<string | undefined>): string | undefined => (r.ok ? r.value : undefined);

    const when = parseWhen({ at: value(at), days: value(days), every: value(every), on: value(on) });
    if (!when.ok) return when;
    const past = pastWhen(when.value, deps.now());
    if (past) return { ok: false, error: `--on ${value(on)} --at ${value(at)}: ${past}` };
    if (value(prompt) !== undefined && value(prompt)!.trim() === '') return { ok: false, error: '--prompt must not be empty' };
    if (value(prompt) !== undefined && !deps.promptKinds().includes(agent.kind)) {
        const names = REMOTE_AGENTS.filter((a) => deps.promptKinds().includes(a.kind)).map((a) => a.subcommands[0]).join(', ');
        return {
            ok: false,
            error: `${agentWord} cannot take a scheduled --prompt: hwip has no rule that tells when it is idle, and a prompt typed into a dialog would answer it. `
                + `--prompt works with: ${names || '(none right now)'}. A schedule without --prompt is fine.`,
        };
    }
    if (value(wt) !== undefined && value(label) !== undefined) return { ok: false, error: '--wt and --label cannot be combined: a worktree session is named for its branch' };

    let runtime = defaultMaxRuntimeMin(when.value);
    if (value(maxRuntime) !== undefined) {
        const parsed = parseDuration(value(maxRuntime)!, '--max-runtime', '90m or 2h');
        if (!parsed.ok) return parsed;
        runtime = parsed.value;
    }

    const cwd = deps.projectDir();
    let project = safeBasename(cwd);
    const branch = value(wt)?.trim();
    if (branch !== undefined) {
        const root = deps.checkoutRoot(cwd);
        if (!root) return { ok: false, error: '--wt needs a git checkout with a main worktree' };
        if (!branch || branch.startsWith('-') || !(await deps.validBranch(root, branch))) {
            return { ok: false, error: `'${branch}' is not a valid branch name` };
        }
        // The worktree directory `ensureWorktree` makes, and so the name the wrapper gives the session.
        const dirName = worktreeDirName(root, branch);
        if (!dirName) return { ok: false, error: `'${branch}' is not a usable worktree name` };
        project = dirName;
    }

    const createdAt = new Date(deps.now()).toISOString();
    const text = value(prompt);
    const make = (id: string): Schedule => {
        const name = branch === undefined && value(label) !== undefined ? sanitizeLabel(value(label)!) : `sched-${id}`;
        return {
            v: 1,
            id,
            createdAt,
            source: 'cli',
            agentKind: agent.kind,
            cwd,
            label: name,
            session: `${tmuxSessionName(project)}-${name}`,
            ...(branch !== undefined ? { wt: branch } : {}),
            ...(agentArgs.length > 0 ? { agentArgs } : {}),
            ...(text !== undefined ? { prompt: text } : {}),
            when: when.value,
            maxRuntimeMin: runtime,
        };
    };
    // The checks that need no id run now, so a refusal costs no id and no file.
    const probe = validateSchedule(make('aaaaaa'));
    return probe.ok ? { ok: true, value: { make, agentName: agent.displayName } } : probe;
};

/** An ISO date, or null for a time outside what a Date holds (a damaged or hand-edited file). */
const isoOrNull = (ms: number | null): string | null => (ms !== null && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null);

const handleAdd = async (words: string[], json: boolean, deps: ScheduleCommandDeps): Promise<number> => {
    const built = await buildSchedule(words, deps);
    if (!built.ok) {
        deps.err(`hwip schedule: ${built.error}`);
        return 2;
    }
    // A listener older than `once` would skip the file, and the schedule would never run.
    const probe = built.value.make('aaaaaa');
    if (probe.when.kind === 'once' && deps.listenerRunning() && !(await deps.refreshListener())) {
        deps.err('hwip schedule: the listener running is an older hwip that could not be replaced, and it would not run this schedule: restart it, then add again');
        return 1;
    }
    const added = addSchedule(built.value.make);
    if (!added.ok) {
        deps.err(`hwip schedule: ${added.error}`);
        return 2;
    }
    const { schedule } = added;
    const next = nextOccurrence(schedule.when, deps.now(), scheduleAnchor(schedule));
    if (json) {
        deps.out(JSON.stringify({ ...schedule, nextAt: isoOrNull(next) }));
    } else {
        deps.out(`scheduled ${schedule.id}: ${built.value.agentName} in ${safeBasename(schedule.cwd)}, ${describeWhen(schedule.when)}`
            + `${next === null ? '' : `, next ${formatTime(next)}`} (session ${schedule.session}, ends after ${schedule.maxRuntimeMin}m)`);
    }
    if (!deps.listenerRunning()) deps.err(LISTENER_NOTE);
    return 0;
};

const handleList = (json: boolean, deps: ScheduleCommandDeps): number => {
    const { schedules, unreadable } = listSchedules();
    const state = readScheduleState().schedules;
    const now = deps.now();
    const rows = schedules.map((schedule) => {
        const next = nextOccurrence(schedule.when, now, scheduleAnchor(schedule));
        const last = state[schedule.id]?.last;
        return { schedule, next, last, running: state[schedule.id]?.running !== undefined };
    });
    if (json) {
        deps.out(JSON.stringify(rows.map(({ schedule, next, last, running }) => ({
            id: schedule.id,
            agent: schedule.agentKind,
            cwd: schedule.cwd,
            label: schedule.label,
            session: schedule.session,
            when: schedule.when,
            maxRuntimeMin: schedule.maxRuntimeMin,
            source: schedule.source,
            nextAt: isoOrNull(next),
            last: last ? { outcome: last.outcome, at: isoOrNull(last.at) } : null,
            running,
        }))));
    } else if (rows.length === 0) {
        deps.out("no schedules (add one with 'hwip schedule add')");
    } else {
        for (const { schedule, next, last, running } of rows) {
            deps.out([
                schedule.id,
                schedule.agentKind,
                safeBasename(schedule.cwd),
                describeWhen(schedule.when),
                `next ${next === null ? '-' : formatTime(next)}`,
                `last ${last ? `${last.outcome} ${formatTime(last.at)}` : '-'}${running ? ' (running)' : ''}`,
            ].join('  '));
        }
    }
    if (unreadable > 0) deps.err(`hwip schedule: ${unreadable} file${unreadable === 1 ? '' : 's'} in ${schedulesDir()} could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped`);
    if (rows.length > 0 && !deps.listenerRunning()) deps.err(LISTENER_NOTE);
    return 0;
};

const handleRemove = (id: string | undefined, deps: ScheduleCommandDeps): number => {
    if (!id) {
        deps.err('hwip schedule: rm needs a schedule id');
        return 2;
    }
    const removed = removeSchedule(id);
    if (removed === 'invalid') {
        deps.err(`hwip schedule: '${id}' is not a schedule id`);
        return 2;
    }
    if (removed === 'missing') {
        deps.err(`hwip schedule: no schedule ${id}`);
        return 1;
    }
    deps.out(`removed ${id}. A session it already started keeps running; end it yourself if you want it gone.`);
    return 0;
};

/**
 * Runs `work` with what it prints going to stderr: the listener refresh reports on stdout (`ensureListenerRunning`),
 * and `hwip schedule edit --json` promises one JSON line there.
 */
export const onStderr = async (work: () => Promise<void>): Promise<void> => {
    const log = console.log;
    console.log = console.error;
    try {
        await work();
    } finally {
        console.log = log;
    }
};

/** The local date (`YYYY-MM-DD`) and time (`HH:MM`) of a `once` schedule, as `--on` and `--at` take them. */
const onceParts = (when: Extract<ScheduleWhen, { kind: 'once' }>): { on: string; at: string } => {
    const d = new Date(when.at);
    return { on: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, at: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
};

/**
 * The schedule's new `when` from the flags given: what is not given is kept, so `--at` keeps the days (or, for a
 * `once`, the date), `--days` the time and `--on` the time of day.
 */
const editedWhen = (current: ScheduleWhen, input: { at?: string; days?: string; every?: string; on?: string }): Checked<ScheduleWhen | undefined> => {
    const { at, days, every, on } = input;
    if (at === undefined && days === undefined && every === undefined && on === undefined) return { ok: true, value: undefined };
    const keptOnce = current.kind === 'once' && days === undefined && every === undefined;
    if (on !== undefined || keptOnce) {
        const kept = current.kind === 'once' ? onceParts(current) : undefined;
        return parseWhen({ on: on ?? kept?.on, at: at ?? kept?.at, days, every });
    }
    if (every !== undefined || at !== undefined) {
        const keptDays = current.kind === 'daily' ? current.days.map((day) => DAY_NAMES[day]).join(',') : undefined;
        return parseWhen({ at, every, days: days ?? (every === undefined ? keptDays : undefined) });
    }
    if (current.kind !== 'daily') return { ok: false, error: `--days needs --at HH:MM for a schedule that runs ${current.kind === 'once' ? 'once' : '--every'}` };
    return parseWhen({ at: current.at, days });
};

const buildChange = (current: Schedule, flags: Flags, deps: ScheduleCommandDeps): Checked<ScheduleChange> => {
    if (flags._arg1) return { ok: false, error: `unexpected word '${String(flags._arg1)}'` };
    const fixed = ['label', 'wt'].find((name) => flags[name] !== undefined);
    if (fixed) return { ok: false, error: `--${fixed} cannot be edited: the session is named for it; remove the schedule and add it again` };
    const read = (name: string): Checked<string | undefined> => flagText(flags, name);
    const [at, days, every, on, prompt, maxRuntime] = ['at', 'days', 'every', 'on', 'prompt', 'max-runtime'].map(read);
    const bad = [at, days, every, on, prompt, maxRuntime].find((r) => !r.ok);
    if (bad && !bad.ok) return bad;
    const value = (r: Checked<string | undefined>): string | undefined => (r.ok ? r.value : undefined);

    const when = editedWhen(current.when, { at: value(at), days: value(days), every: value(every), on: value(on) });
    if (!when.ok) return when;
    const change: ScheduleChange = when.value === undefined ? {} : { when: when.value };
    const text = value(prompt);
    if (text !== undefined) {
        if (text.trim() === '') return { ok: false, error: '--prompt must not be empty' };
        if (!deps.promptKinds().includes(current.agentKind)) {
            return { ok: false, error: `${current.agentKind} cannot take a scheduled --prompt: hwip has no rule that tells when it is idle` };
        }
        change.prompt = text;
    }
    if (value(maxRuntime) !== undefined) {
        const parsed = parseDuration(value(maxRuntime)!, '--max-runtime', '90m or 2h');
        if (!parsed.ok) return parsed;
        change.maxRuntimeMin = parsed.value;
    }
    if (Object.keys(change).length === 0) return { ok: false, error: 'edit needs --at, --days, --on, --every, --prompt or --max-runtime' };
    return { ok: true, value: change };
};

const handleEdit = async (words: string[], json: boolean, deps: ScheduleCommandDeps): Promise<number> => {
    // `parseArgs` reads the words after the program name and script; the first word is the id.
    const flags = parseArgs(['node', 'hwip', ...words]);
    const id = flags._command === undefined ? '' : String(flags._command);
    if (!isScheduleId(id)) {
        deps.err(id ? `hwip schedule: '${id}' is not a schedule id` : 'hwip schedule: edit needs a schedule id');
        return 2;
    }
    const current = listSchedules().schedules.find((schedule) => schedule.id === id);
    if (!current) {
        deps.err(`hwip schedule: no schedule ${id}`);
        return 1;
    }
    const change = buildChange(current, flags, deps);
    if (!change.ok) {
        deps.err(`hwip schedule: ${change.error}`);
        return 2;
    }
    // A new time writes `updatedAt`, which an older listener does not know: it would skip the file and the schedule would stop.
    if (deps.listenerRunning() && !(await deps.refreshListener()) && change.value.when !== undefined) {
        deps.err('hwip schedule: the listener running is an older hwip that could not be replaced, and it would stop running this schedule: restart it, then edit again');
        return 1;
    }
    const updated = updateSchedule(id, change.value, deps.now());
    if (!updated.ok) {
        deps.err(`hwip schedule: ${updated.error}`);
        return updated.failure === 'missing' ? 1 : 2;
    }
    const { schedule } = updated;
    const next = nextOccurrence(schedule.when, deps.now(), scheduleAnchor(schedule));
    if (json) {
        deps.out(JSON.stringify({ ...schedule, nextAt: isoOrNull(next) }));
    } else {
        deps.out(`updated ${schedule.id}: ${describeWhen(schedule.when)}${next === null ? '' : `, next ${formatTime(next)}`} (ends after ${schedule.maxRuntimeMin}m)`);
    }
    if (!deps.listenerRunning()) deps.err(LISTENER_NOTE);
    return 0;
};

const JSON_ON = new Set(['--json', '--json=true', '--json=1', '--json=yes']);

/** `words`: argv after `schedule`. Returns the exit code. */
export const runSchedule = async (words: string[], deps: ScheduleCommandDeps): Promise<number> => {
    // `--json` is lifted out first: the flag parser would hand it the next word (`--json list`, `add --json cc`).
    const cut = words.indexOf('--');
    const head = cut < 0 ? words : words.slice(0, cut);
    const json = head.some((w) => JSON_ON.has(w));
    const plain = [...head.filter((w) => !JSON_ON.has(w)), ...(cut < 0 ? [] : words.slice(cut))];
    const sub = plain.length === 0 ? 'list' : plain[0]!;
    const rest = plain.slice(1);
    switch (sub) {
        case 'add':
            return handleAdd(rest, json, deps);
        case 'edit':
            return handleEdit(rest, json, deps);
        case 'list':
            if (rest.length > 0) break;
            return handleList(json, deps);
        case 'rm':
            if (rest.length > 1) break;
            return handleRemove(rest[0], deps);
        default:
    }
    deps.err(rest.length > 0 && (sub === 'list' || sub === 'rm')
        ? `hwip schedule: unexpected word '${rest[sub === 'list' ? 0 : 1]}'\n${USAGE}`
        : `hwip schedule: unknown subcommand '${sub}'\n${USAGE}`);
    return 2;
};

export const liveScheduleDeps = (): ScheduleCommandDeps => ({
    now: () => Date.now(),
    projectDir: detectProjectDir,
    checkoutRoot: (dir) => checkoutOf(dir)?.root ?? null,
    validBranch: (root, name) => isValidBranchName(root, name),
    listenerRunning: () => runningListenerPid() !== null,
    promptKinds: () => promptableScheduleKinds(REMOTE_AGENTS.map((a) => a.kind)),
    refreshListener: async () => {
        await onStderr(() => ensureListenerRunning(false));
        return runningListenerPid() === null || !listenerVersionDrifted(runningListenerVersion(), VERSION);
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
});

export const handleSchedule = (words: string[]): Promise<number> => runSchedule(words, liveScheduleDeps());
