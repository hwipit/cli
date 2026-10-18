import { execSync } from 'child_process';
import { existsSync, lstatSync, rmSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, sep } from 'path';
import { detectAgents } from './agents.js';
import { checkListenerPid, otherListenerNote, runningListenerPid, stopListener, type ListenerStop } from './listener-process.js';
import { SERVICE_LABEL, serviceInstalled, uninstallService } from './listener-service.js';
import { isHwipHookGroup, removeManagedBlock } from './templates.js';
import { CONFIG_FILE, VERSION } from './config.js';
import { removeHwipMcpTable } from './codex-config.js';
import { NotUtf8Error, readText, removeFile, replaceFile } from './replace-file.js';
import { JsoncDoc, JsoncEditError } from './jsonc-doc.js';
import { flagOn } from './args.js';

const HOME = homedir();

const ok = (msg: string) => console.log(`    + ${msg}`);
const skip = (msg: string) => console.log(`    - ${msg}`);

/** A step line that is not a change made: a `note` is for information, an
 *  `attention` line is something only the user can finish. */
export type Notice = { readonly notice: 'note' | 'attention'; readonly text: string };
type StepLine = string | Notice;

let attentionLines = 0;

const report = (line: StepLine): void => {
    if (typeof line === 'string') return ok(line);
    if (line.notice === 'note') return skip(line.text);
    attentionLines += 1;
    console.log(`    ! ${line.text}`);
};

// ── Removal primitives ───────────────────────────────────────────
// Each primitive returns a short human description of what it did (or
// would do, in dry-run), or null when there was nothing to remove. A JSON
// file it could not read gets an `attention` line (`unreadable`), so the user
// knows to look at it: whatever of hwip's is in there stays and keeps working.

/** Past/conditional verb so dry-run output reads honestly. */
const verb = (dry: boolean): string => (dry ? 'would remove' : 'removed');

/** Delete a file Hwip fully owns. */
const rmFile = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    if (!dry) rmSync(filePath, { force: true });
    return `${verb(dry)} ${filePath}`;
};

/**
 * Is the file reached through a symlink — itself, or a folder on the way from the home folder (`~/.cursor`
 * linked into a dotfiles repo)? Folders above the home folder are not looked at: a home folder under a
 * linked parent (macOS's /var) says nothing about where the user keeps their files.
 */
const isLinked = (filePath: string): boolean => {
    const rel = relative(HOME, filePath);
    const parts = rel.startsWith('..') || isAbsolute(rel) ? [''] : rel.split(sep);
    let at = rel.startsWith('..') || isAbsolute(rel) ? filePath : HOME;
    for (const part of parts) {
        at = part ? join(at, part) : at;
        if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true) return true;
    }
    return false;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A settings file opened as the installer opens it (comments and trailing
 *  commas allowed, an empty or BOM-led file read the same way), or null when it
 *  does not parse or parses to something else (`null`, an array) that has no
 *  entries to look in. */
const openSettings = (filePath: string): JsoncDoc | null => {
    let text: string;
    try {
        text = readText(filePath);
    } catch (err) {
        // Bytes that are not text are named as that (the step runner prints the throw), not as "not a JSON object".
        if (err instanceof NotUtf8Error) throw err;
        return null;
    }
    try {
        return new JsoncDoc(text);
    } catch {
        return null;
    }
};

/** The `!` line for an edit that would lose a comment of the user's: the file is left as it is. */
const uneditable = (filePath: string, what: string): StepLine => ({
    notice: 'attention',
    text: `could not edit ${filePath} without risking its comments — remove hwip's ${what} by hand`,
});

/** Run an edit of a settings file; a `JsoncEditError` becomes the `!` line that names the file. */
const editing = (filePath: string, what: string, edit: () => StepLine | null): StepLine | null => {
    try {
        return edit();
    } catch (err) {
        if (err instanceof JsoncEditError) return uneditable(filePath, what);
        throw err;
    }
};

/** The `!` line for a settings file that exists but is not a JSON object. */
const unreadable = (filePath: string, what: string): StepLine => ({
    notice: 'attention',
    text: `could not read ${filePath} as a JSON object — if hwip's ${what} is in it, remove it by hand`,
});

/** Remove just the `hwip` entry from an MCP registry JSON file. `key` is the
 *  container: `mcpServers` for Cursor/Windsurf, top-level `mcp` for
 *  opencode.json (opencode's own schema). Exported for tests. */
export const rmMcpEntry = (filePath: string, dry: boolean, key = 'mcpServers'): StepLine | null => {
    if (!existsSync(filePath)) return null;
    const doc = openSettings(filePath);
    if (!doc) return unreadable(filePath, 'MCP entry');
    const servers = doc.data[key];
    if (!isPlainObject(servers) || !('hwip' in servers)) return null;
    return editing(filePath, 'MCP entry', () => {
        if (!dry) {
            doc.remove([key, 'hwip']);
            replaceFile(filePath, doc.text(), doc.expected);
        }
        return `${verb(dry)} hwip from ${filePath}`;
    });
};

/** Remove `[mcp_servers.hwip]` from codex's TOML config, leaving the rest of
 *  the user's file byte-for-byte. Exported for tests. */
export const rmCodexMcpEntry = (filePath: string, dry: boolean): StepLine | null => {
    if (!existsSync(filePath)) return null;
    let config: string;
    try {
        config = readText(filePath);
    } catch (err) {
        // A table left in a file hwip cannot read keeps launching its server: say so.
        if (err instanceof NotUtf8Error) return { notice: 'attention', text: `${err.message} — if hwip's MCP table is in it, remove it by hand` };
        return null;
    }
    const stripped = removeHwipMcpTable(config);
    if (stripped === null) return null;
    if (!dry) replaceFile(filePath, stripped, config);
    return `${verb(dry)} hwip from ${filePath}`;
};

/** Strip the <!-- HWIP:START/END --> block from a shared rule file. Exported for tests. */
export const stripManagedRule = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    const existing = readText(filePath);
    const stripped = removeManagedBlock(existing);
    if (stripped === existing) return null; // no Hwip block present
    if (!dry) {
        // A file that was ours alone goes — but a symlink into a dotfiles repo is not ours to delete: the block comes out of what it points at.
        if (stripped.trim() === '' && !isLinked(filePath)) {
            removeFile(filePath, existing);
        } else {
            replaceFile(filePath, stripped, existing);
        }
    }
    return `${verb(dry)} Hwip block from ${filePath}`;
};

/** Drop the Hwip `read:` directive from ~/.aider.conf.yml. */
/** Exported for tests. */
export const rmAiderReadDirective = (confPath: string, dry: boolean): string | null => {
    if (!existsSync(confPath)) return null;
    const conf = readText(confPath);
    if (!conf.includes('# Added by Hwip')) return null;
    // Drop the "# Added by Hwip" line and the "read:" line that follows it.
    const lines = conf.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '# Added by Hwip') {
            if (lines[i + 1]?.trimStart().startsWith('read:')) i++; // skip read: too
            continue;
        }
        out.push(lines[i]);
    }
    if (!dry) replaceFile(confPath, out.join('\n').replace(/\n{3,}/g, '\n\n'), conf);
    return `${verb(dry)} Hwip read: directive from ${confPath}`;
};

/**
 * Take hwip-written entries — matcher groups or flat handlers — out of the
 * document's `hooks` (all events).
 * Edits `doc` unless dry; returns true when anything of ours was found.
 * Empty events are deleted so a clean file stays clean (an event that holds a
 * comment of the user's stays, emptied). The rest of the file,
 * comments included, is left as it is (a comment right next to one of hwip's
 * entries goes with it).
 */
const stripHwipHookGroups = (doc: JsoncDoc, dry: boolean): boolean => {
    const hooks = doc.data.hooks;
    if (!isPlainObject(hooks)) return false;
    let removed = false;
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event];
        if (!Array.isArray(groups)) continue;
        const ours = groups.flatMap((group, i) => (isHwipHookGroup(group) ? [i] : []));
        if (ours.length === 0) continue; // nothing of ours
        removed = true;
        if (dry) continue;
        // The whole event goes only when that takes no comment with it; otherwise its groups go one by one and the key stays.
        if (ours.length === groups.length && !doc.removalTakesComment(['hooks', event])) doc.remove(['hooks', event]);
        else for (const i of ours.reverse()) doc.remove(['hooks', event, i]);
    }
    return removed;
};

/** Remove just the hwip-written entries from Gemini's settings.json.
 *  Exported for tests (gemini is PATH-detected, so the full-uninstall
 *  suite can't reach this deterministically). */
export const rmGeminiHook = (filePath: string, dry: boolean): StepLine | null => {
    if (!existsSync(filePath)) return null;
    const doc = openSettings(filePath);
    if (!doc) return unreadable(filePath, 'hook');
    return editing(filePath, 'hook', () => {
        if (!stripHwipHookGroups(doc, dry)) return null;
        if (!dry) replaceFile(filePath, doc.text(), doc.expected);
        return `${verb(dry)} hwip hooks from ${filePath}`;
    });
};

/** Remove the hwip-written entries from a hooks.json (Codex, Cursor,
 *  Windsurf). The file is usually hwip-born, so it is deleted outright when
 *  nothing but hwip's entries and Cursor's `version` was in it — hooks and keys
 *  the user added survive. Exported for tests (codex is PATH-detected, same as
 *  gemini). */
export const rmHwipHooks = (filePath: string, dry: boolean): StepLine | null => {
    if (!existsSync(filePath)) return null;
    const doc = openSettings(filePath);
    // Not silent: a hook left in an unreadable file keeps firing after
    // uninstall, and the user is the only one who can take it out.
    if (!doc) return unreadable(filePath, 'hook');
    return editing(filePath, 'hook', () => {
        if (!stripHwipHookGroups(doc, dry)) return null;
        if (!dry) {
            const data = doc.data;
            const hooks = isPlainObject(data.hooks) ? data.hooks : {};
            const userKeys = Object.keys(data).filter((key) => key !== 'hooks' && key !== 'version');
            // A comment is the user's too: a file that holds one is kept.
            const onlyHwip = Object.keys(hooks).length === 0 && userKeys.length === 0 && !doc.hasComments();
            // A symlink into a dotfiles repo is not ours to delete: hwip's hooks come out of what it points at,
            // or they come back, and run, when the link is made again.
            if (onlyHwip && !isLinked(filePath) && doc.expected !== null) removeFile(filePath, doc.expected);
            else replaceFile(filePath, doc.text(), doc.expected);
        }
        return `${verb(dry)} hwip hooks from ${filePath}`;
    });
};

// ── Per-agent uninstallers ───────────────────────────────────────

type Step = () => StepLine | null;

// A step that throws (a write the directory refuses) is one line, not the end
// of the uninstall: the steps after it still have hwip's parts to take out.
const runStep = (step: Step): StepLine | null => {
    try {
        return step();
    } catch (err) {
        return { notice: 'attention', text: `could not finish: ${err instanceof Error ? err.message : String(err)}` };
    }
};

const runSteps = (steps: Step[]): void => {
    let did = false;
    for (const step of steps) {
        const result = runStep(step);
        if (result) { report(result); did = true; }
    }
    if (!did) skip('nothing to remove');
};

const AGENT_UNINSTALLERS: Record<string, (dry: boolean) => void> = {
    claude: (dry) => {
        if (dry) { skip('would run: claude plugin uninstall hwip@hwip'); return; }
        try {
            execSync('claude plugin uninstall hwip@hwip', { stdio: 'pipe' });
            ok('plugin uninstalled');
        } catch {
            skip('plugin not installed (or claude CLI unavailable)');
        }
    },
    cursor: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.cursor', 'mcp.json'), dry),
        () => rmHwipHooks(join(HOME, '.cursor', 'hooks.json'), dry),
        () => rmFile(join(HOME, '.cursor', 'rules', 'hwip.mdc'), dry),
    ]),
    windsurf: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), dry),
        () => rmHwipHooks(join(HOME, '.codeium', 'windsurf', 'hooks.json'), dry),
        () => stripManagedRule(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'), dry),
    ]),
    gemini: (dry) => {
        if (!dry) {
            // user scope first (where the ≥0.26 installer adds it), then the
            // legacy scope-less form for entries created by older installs.
            try { execSync('gemini mcp remove -s user hwip', { stdio: 'pipe' }); ok('MCP server removed'); }
            catch {
                try { execSync('gemini mcp remove hwip', { stdio: 'pipe' }); ok('MCP server removed'); }
                catch { skip('gemini MCP entry not found'); }
            }
        } else {
            skip('would run: gemini mcp remove -s user hwip');
        }
        runSteps([
            () => rmGeminiHook(join(HOME, '.gemini', 'settings.json'), dry),
            () => stripManagedRule(join(HOME, '.gemini', 'GEMINI.md'), dry),
        ]);
    },
    codex: (dry) => runSteps([
        () => rmHwipHooks(join(HOME, '.codex', 'hooks.json'), dry),
        () => stripManagedRule(join(HOME, '.codex', 'AGENTS.md'), dry),
        () => rmCodexMcpEntry(join(HOME, '.codex', 'config.toml'), dry),
    ]),
    copilot: (dry) => runSteps([
        () => rmFile(join(HOME, '.copilot', 'hooks', 'hwip.json'), dry),
        () => rmFile(join(HOME, '.copilot', 'instructions', 'hwip.instructions.md'), dry),
    ]),
    cline: (dry) => runSteps([
        () => rmFile(join(HOME, '.cline', 'rules', 'hwip.md'), dry),
    ]),
    aider: (dry) => runSteps([
        () => rmFile(join(HOME, '.hwip', 'aider-conventions.md'), dry),
        () => rmAiderReadDirective(join(HOME, '.aider.conf.yml'), dry),
    ]),
    pi: (dry) => runSteps([
        () => rmFile(join(HOME, '.pi', 'agent', 'extensions', 'hwip.ts'), dry),
        () => stripManagedRule(join(HOME, '.pi', 'agent', 'AGENTS.md'), dry),
    ]),
    opencode: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.config', 'opencode', 'opencode.json'), dry, 'mcp'),
        () => rmFile(join(HOME, '.config', 'opencode', 'plugins', 'hwip.ts'), dry),
        () => stripManagedRule(join(HOME, '.config', 'opencode', 'AGENTS.md'), dry),
    ]),
};

/**
 * Remove the login-time service (LaunchAgent or systemd user unit), if one is installed.
 *
 * Async, so it does not fit the sync `Step` shape the per-agent uninstallers
 * use — the service manager has to be waited on. Returns the same "one line or null"
 * contract those steps do.
 */
export const removeServiceStep = async (dry: boolean): Promise<StepLine | null> => {
    if (!serviceInstalled()) return null;
    if (dry) return `would remove the login-time service (${SERVICE_LABEL})`;
    const result = await uninstallService();
    if (!result.ok) return { notice: 'attention', text: `could not remove the login-time service: ${result.reason}` };
    return `removed the login-time service (${SERVICE_LABEL})`;
};

export interface ListenerStopDeps {
    readonly runningListenerPid: () => number | null;
    readonly checkListenerPid: typeof checkListenerPid;
    readonly stopListener: (pid: number) => Promise<ListenerStop>;
}

export const defaultListenerStopDeps: ListenerStopDeps = {
    runningListenerPid,
    checkListenerPid: (pid) => checkListenerPid(pid),
    stopListener: (pid) => stopListener(pid),
};

/**
 * Stop the listener daemon. `hwip cc` starts it without the login-time
 * service, so removing the service alone leaves it running — and it is what
 * carries phone input into tmux. `stopListener` only stops a process whose
 * command line is hwip's listener; this turns what it found into one line.
 * Same "one line or null" contract as the removal primitives.
 */
export const stopListenerStep = async (
    dry: boolean,
    deps: ListenerStopDeps = defaultListenerStopDeps,
): Promise<StepLine | null> => {
    const pid = deps.runningListenerPid();
    if (pid === null) return null;
    const outcome = dry ? deps.checkListenerPid(pid) : await deps.stopListener(pid);
    switch (outcome.kind) {
        case 'gone':
            return null;
        case 'unchecked':
            return {
                notice: 'attention',
                text: `could not check pid ${pid} (${outcome.reason}) — if it is the listener, run: hwip listener --stop`,
            };
        case 'foreign':
            return { notice: 'note', text: `left pid ${pid} alone: the listener's pid file points at another process (${outcome.program})` };
        case 'other-listener':
            return { notice: 'attention', text: otherListenerNote(pid, outcome.script) };
        case 'ours':
            return `would stop the listener (pid ${pid})`;
        case 'stopped':
            return `stopped the listener (pid ${pid})`;
        case 'killed':
            return `stopped the listener (pid ${pid}) with SIGKILL`;
    }
};

// ── Entry point ──────────────────────────────────────────────────

const closingLine = (dry: boolean, attention: number): string => {
    const lines = attention === 1 ? '1 line marked "!" needs' : `${attention} lines marked "!" need`;
    if (dry) {
        const tail = attention === 0 ? '' : ` ${lines} you.`;
        return `\n  Dry-run complete — nothing was changed.${tail}\n`;
    }
    if (attention === 0) return '\n  Uninstall complete. Restart your agents.\n';
    return `\n  Uninstall finished, but ${lines} you. Then restart your agents.\n`;
};

/** Yes/no at the terminal; Ctrl-C is a no. */
const askConfirm = async (message: string): Promise<boolean> => {
    try {
        const { confirm } = await import('@inquirer/prompts');
        return await confirm({ message, default: false });
    } catch {
        return false;
    }
};

export const handleUninstall = async (
    args: Record<string, string | boolean>,
    listenerDeps: ListenerStopDeps = defaultListenerStopDeps,
    confirm: (message: string) => Promise<boolean> = askConfirm,
): Promise<number> => {
    const dry = flagOn(args, 'dry-run');
    const purge = flagOn(args, 'purge');
    attentionLines = 0;

    console.log(`\n  Hwip uninstall${dry ? ' (dry-run)' : ''} — v${VERSION}\n`);

    const detected = detectAgents().filter((a) => a.detected);

    // A real removal asks first when someone is at the terminal. `--yes`
    // skips the question; a script has no terminal to ask on and runs as it
    // always did. `--dry-run` changes nothing, so it never asks.
    if (!dry && !flagOn(args, 'yes') && process.stdin.isTTY === true) {
        const agents = detected.map((a) => a.name).join(', ') || 'no detected agents';
        const go = await confirm(`Remove Hwip from ${agents} and stop the listener? (--dry-run previews it)`);
        if (!go) {
            console.log('\n  Cancelled — nothing was changed.\n');
            // Not 0: a caller can tell "removed" from "said no".
            return 1;
        }
    }

    if (detected.length === 0) {
        console.log('  No supported agents detected.\n');
    }

    for (const agent of detected) {
        console.log(`  ${agent.name}:`);
        AGENT_UNINSTALLERS[agent.id]?.(dry);
    }

    // The LaunchAgent outlives every agent's rules, so removing it is part of
    // uninstall and not of any one agent's teardown.
    console.log('\n  Login-time service:');
    const serviceLine = await removeServiceStep(dry);
    if (serviceLine) report(serviceLine); else skip('not installed');

    // After the service: its bootout already stops a service-run daemon.
    console.log('\n  Listener:');
    const listenerLine = await stopListenerStep(dry, listenerDeps);
    if (listenerLine) report(listenerLine); else skip('not running');

    // ~/.hwip/config.json holds the API key — kept by default so a
    // re-install doesn't need the key re-entered. --purge removes it.
    console.log('\n  Config:');
    if (purge) {
        const removed = rmFile(CONFIG_FILE, dry);
        if (removed) ok(removed); else skip('no config file');
    } else {
        skip(`kept ${CONFIG_FILE} (pass --purge to remove)`);
    }

    console.log(closingLine(dry, attentionLines));
    return 0;
};
