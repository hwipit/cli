import { execFileSync } from 'child_process';
import { accessSync, constants, existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';

// Agent detection shared by install / uninstall / verify. Kept in one place
// so the three commands can never disagree about which agents exist or how
// they're detected.

/**
 * Per-agent GLOBAL skill directories, keyed by the same `id` used in
 * `detectAgents`. Scan targets for `command-scan.ts` — keep next to the
 * detection table so the two can never disagree about which agents exist.
 *
 * Global only: project-level dirs depend on a session's cwd, and the catalog is
 * device-level (one scan per listener, shared by every session on the machine).
 *
 * pi's two entries come from its own docs (`docs/skills.md § Locations`,
 * pi 0.85.1): global is `~/.pi/agent/skills/` and `~/.agents/skills/`, while
 * `.pi/skills/` is the PROJECT dir — scanning `~/.pi/skills` found only three
 * dangling symlinks and reported pi as having no skills at all.
 *
 * codex reads `$CODEX_HOME/skills` and `~/.agents/skills` (codex-rs
 * `ext/skills/src/host_roots.rs`), and keeps its bundled skills in the hidden
 * `.codex/skills/.system`, which the scanner's dot-skip would otherwise pass
 * over. opencode reads the claude and agents dirs as well as its own
 * (opencode `docs/skills.mdx § Discovery`, 2.0.29). Measured against the agents'
 * own reports on 2026-10-20: codex 59 of `codex app-server` `skills/list` 59;
 * opencode 87 of `opencode serve` `/api/skill` 91 — the rest are two built-ins
 * and two skills it reads out of `~/.claude/skills/.trash/`, which the scanner's
 * dot-skip leaves out on purpose.
 */
export const AGENT_SKILL_DIRS: Record<string, string[]> = {
    claude: ['.claude/skills'],
    codex: ['.codex/skills', '.codex/skills/.system', '.agents/skills'],
    opencode: ['.claude/skills', '.agents/skills', '.config/opencode/skills'],
    pi: ['.pi/agent/skills', '.agents/skills'],
};

export interface Agent {
    name: string;
    id: string;
    detected: boolean;
}

const HOME = homedir();

/**
 * Absolute path of a command on PATH, or null when it isn't there.
 * `execFileSync`, not a shell: `process.execve` needs a real path (it does no
 * PATH lookup of its own), and building `which ${cmd}` as a shell string would
 * let a path containing a space split into two words.
 */
export const resolveCommand = (cmd: string): string | null => {
    try {
        return execFileSync('which', [cmd], { encoding: 'utf-8' }).trim() || null;
    } catch {
        // Minimal images (Arch base, Fedora/RHEL minimal) ship no `which`;
        // walking PATH ourselves answers the same question there.
        return findOnPath(cmd);
    }
};

/** The first executable `cmd` on PATH, found without spawning anything. */
export const findOnPath = (cmd: string): string | null => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        try {
            accessSync(join(dir, cmd), constants.X_OK);
            return join(dir, cmd);
        } catch { /* not in this directory */ }
    }
    return null;
};

export const hasCommand = (cmd: string): boolean => resolveCommand(cmd) !== null;

export const detectAgents = (): Agent[] => [
    { name: 'Claude Code', id: 'claude', detected: hasCommand('claude') },
    { name: 'Cursor', id: 'cursor', detected: existsSync(join(HOME, '.cursor')) },
    { name: 'Windsurf', id: 'windsurf', detected: existsSync(join(HOME, '.codeium')) },
    { name: 'Gemini CLI', id: 'gemini', detected: hasCommand('gemini') },
    { name: 'Codex CLI', id: 'codex', detected: hasCommand('codex') },
    { name: 'Copilot CLI', id: 'copilot', detected: existsSync(join(HOME, '.copilot')) },
    { name: 'Cline', id: 'cline', detected: existsSync(join(HOME, '.cline')) },
    { name: 'Aider', id: 'aider', detected: hasCommand('aider') },
    { name: 'Pi', id: 'pi', detected: existsSync(join(HOME, '.pi')) || hasCommand('pi') },
    { name: 'OpenCode', id: 'opencode', detected: existsSync(join(HOME, '.config', 'opencode')) || hasCommand('opencode') },
];
