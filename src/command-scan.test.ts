import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYLOAD_LIMIT_BYTES, scanAgentCommands } from './command-scan.js';

// Fixture tree mirrors the real skill layouts measured 2026-09-12:
//   ~/.claude/skills/<name>/SKILL.md
//   ~/.claude/plugins/installed_plugins.json -> installPath/skills/*/SKILL.md
//   ~/.agents/skills/<name> -> symlink (some dangling)
// Nothing here touches the real home directory; `homeDir` is injected.
//
// The catalog carries commands only — a directory name under whatever prefix the
// agent registers it with (`skill:` for pi, the plugin name for Claude Code
// plugins). SKILL.md content is never parsed: these fixtures write a body to
// prove the scanner ignores it.

let home: string;

const skill = (dir: string, name: string, body = 'anything at all') => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), body);
};

const names = (entries: Array<{ name: string }> | undefined) => (entries ?? []).map((e) => e.name);

/** `~/.claude/settings.json` `enabledPlugins` — Claude Code loads a plugin only when its key is `true` there. */
const enablePlugins = (enabled: Record<string, boolean>) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
};

/** Registers `<key>` in `installed_plugins.json` with an install dir of its own, and returns that dir. */
const installPlugin = (key: string): string => {
    const plugins = join(home, '.claude', 'plugins');
    const install = join(plugins, 'cache', 'mkt', key.split('@')[0], '1.0.0');
    mkdirSync(install, { recursive: true });
    const file = join(plugins, 'installed_plugins.json');
    let parsed: { version: number; plugins: Record<string, unknown> } = { version: 2, plugins: {} };
    try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
        // first plugin of the fixture
    }
    parsed.plugins[key] = [{ scope: 'user', installPath: install }];
    writeFileSync(file, JSON.stringify(parsed));
    return install;
};

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cmdscan-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe('scanAgentCommands', () => {
    it('lists claude user skills by directory name', () => {
        skill(join(home, '.claude', 'skills'), 'tdd');
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['tdd']);
    });

    it('ignores SKILL.md content entirely — quotes and folded scalars cannot leak', () => {
        // The regex parser this replaced shipped the quotes and truncated the
        // folded scalar to a bare '>'. Both live layouts are written here.
        skill(join(home, '.claude', 'skills'), 'quoted', '---\nname: "wrong"\ndescription: "has \\"quotes\\""\n---\n');
        skill(join(home, '.claude', 'skills'), 'folded', '---\nname: wrong\ndescription: >\n  folded text\n---\n');
        const serialized = JSON.stringify(scanAgentCommands(home).catalog);
        expect(names(scanAgentCommands(home).catalog.claude).sort()).toEqual(['folded', 'quoted']);
        expect(serialized).not.toContain('wrong');
        expect(serialized).not.toContain('>');
        expect(serialized).not.toContain('description');
    });

    it('lists pi skills resolved through symlinks', () => {
        const real = join(home, 'real-skill');
        mkdirSync(real);
        writeFileSync(join(real, 'SKILL.md'), 'body');
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(real, join(home, '.agents', 'skills', 'pi-skill'));
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual(['skill:pi-skill']);
    });

    it('drops dangling symlinks', () => {
        // A real skill sits beside the ghost: asserting an empty pi list alone
        // would also pass with pi not scanned at all, which is the regression
        // that put this whole file here.
        const real = join(home, 'real-skill');
        mkdirSync(real);
        writeFileSync(join(real, 'SKILL.md'), 'body');
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(real, join(home, '.agents', 'skills', 'alive'));
        symlinkSync(join(home, 'nowhere'), join(home, '.agents', 'skills', 'ghost'));
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual(['skill:alive']);
    });

    it('finds a pi skill filed under a grouping folder', () => {
        // pi walks the tree (`loadSkillsFromDirInternal`, dist/core/skills.js),
        // so a skill two levels down is real to it and must be listed.
        skill(join(home, '.agents', 'skills', 'group'), 'nested');
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual(['skill:nested']);
    });

    it('does not descend into a skill dir, or below the depth cap', () => {
        // A skill's own fixtures are not more skills, and nothing arbitrarily
        // deep is a skill either.
        skill(join(home, '.agents', 'skills'), 'outer');
        skill(join(home, '.agents', 'skills', 'outer', 'examples'), 'inner');
        skill(join(home, '.agents', 'skills', 'a', 'b', 'c'), 'too-deep');
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual(['skill:outer']);
    });

    it('does not descend for claude — only registered skill dirs count', () => {
        // `~/.claude/skills/_shared` holds directories Claude Code does not
        // register; recursing there would invent commands that do not run.
        skill(join(home, '.claude', 'skills', '_shared'), 'helper');
        skill(join(home, '.claude', 'skills'), 'real');
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['real']);
    });

    it('throws rather than report an empty catalog when a dir cannot be read', () => {
        // An unreadable skills dir is not "no skills": reporting empty would
        // blank the phone's menu. The listener keeps its previous catalog when
        // this throws.
        const dir = join(home, '.claude', 'skills');
        skill(dir, 'present');
        chmodSync(dir, 0o000);
        try {
            expect(() => scanAgentCommands(home)).toThrow();
        } finally {
            chmodSync(dir, 0o700);
        }
    });

    it('scans both of pi global skill dirs, not its project dir', () => {
        // pi 0.85.1 `docs/skills.md § Locations`: global = `~/.pi/agent/skills`
        // + `~/.agents/skills`; `.pi/skills` is the PROJECT dir, and scanning it
        // as if it were global reported pi as having no skills on this machine.
        skill(join(home, '.pi', 'agent', 'skills'), 'from-pi-agent');
        skill(join(home, '.agents', 'skills'), 'from-agents');
        skill(join(home, '.pi', 'skills'), 'project-only');
        const found = names(scanAgentCommands(home).catalog.pi).sort();
        expect(found).toEqual(['skill:from-agents', 'skill:from-pi-agent']);
    });

    it('skips directories with no SKILL.md', () => {
        mkdirSync(join(home, '.claude', 'skills', 'naked'), { recursive: true });
        skill(join(home, '.claude', 'skills'), 'good');
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['good']);
    });

    it('keeps a user skill and a plugin skill of the same name apart', () => {
        // Two distinct directories, one shared name. They are two different
        // commands in Claude Code, and collapsing them would hide one of them.
        skill(join(home, '.claude', 'skills'), 'ship');
        const plugins = join(home, '.claude', 'plugins');
        const install = join(plugins, 'cache', 'official', 'shipper', 'abc');
        skill(join(install, 'skills'), 'ship');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
            join(plugins, 'installed_plugins.json'),
            JSON.stringify({ version: 2, plugins: { 'shipper@official': [{ scope: 'user', installPath: install }] } }),
        );
        enablePlugins({ 'shipper@official': true });
        // Different commands: `/ship` is the user skill, `/shipper:ship` the plugin's.
        expect(names(scanAgentCommands(home).catalog.claude).sort()).toEqual(['ship', 'shipper:ship']);
    });

    it('includes installed plugin skills but not marketplace cache', () => {
        const plugins = join(home, '.claude', 'plugins');
        const cache = join(plugins, 'cache', 'official', 'installed-plugin', 'abc');
        skill(join(cache, 'skills'), 'plugin-skill');
        // same tree layout, but NOT referenced by installed_plugins.json
        const orphan = join(plugins, 'cache', 'official', 'marketplace-cached', 'def');
        skill(join(orphan, 'skills'), 'orphan-skill');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
            join(plugins, 'installed_plugins.json'),
            JSON.stringify({ version: 2, plugins: { 'installed-plugin@official': [{ scope: 'user', installPath: cache }] } }),
        );
        enablePlugins({ 'installed-plugin@official': true });
        const found = names(scanAgentCommands(home).catalog.claude);
        expect(found).toContain('installed-plugin:plugin-skill');
        expect(found).not.toContain('installed-plugin:orphan-skill');
        expect(found.some((n) => n.endsWith('orphan-skill'))).toBe(false);
    });

    it('caps the serialized catalog at the byte limit, dropping from the tail', () => {
        // Sized to actually cross the limit, or the cap never engages and the assertion
        // passes with the drop loop deleted. Long names (the scanner caps none, a directory
        // name takes up to 255 bytes) cross it with ~400 directories instead of ~3600 short
        // ones: thousands of mkdir + write took seconds on a loaded machine.
        const pad = 'x'.repeat(200);
        const nameOf = (i: number) => `skill-${String(i).padStart(4, '0')}-${pad}`;
        const dir = join(home, '.claude', 'skills');
        const count = 400;
        for (let i = 0; i < count; i++) skill(dir, nameOf(i));
        expect(count * (nameOf(0).length + 10)).toBeGreaterThan(PAYLOAD_LIMIT_BYTES);
        const before = scanAgentCommands(home);
        expect(before.dropped).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(before.catalog), 'utf-8')).toBeLessThanOrEqual(PAYLOAD_LIMIT_BYTES);
        expect(names(before.catalog.claude)).toContain(nameOf(0));
        expect(names(before.catalog.claude)).not.toContain(nameOf(count - 1));
    });

    it('reports nothing dropped when the catalog fits', () => {
        skill(join(home, '.claude', 'skills'), 'small');
        expect(scanAgentCommands(home).dropped).toBe(0);
    });

    it('never puts a filesystem path in the payload', () => {
        skill(join(home, '.claude', 'skills'), 'clean');
        const serialized = JSON.stringify(scanAgentCommands(home).catalog);
        expect(serialized).not.toContain(home);
        expect(serialized).not.toContain('.claude');
        expect(serialized).not.toContain(tmpdir());
    });

    it('returns an empty catalog for a home with no agents', () => {
        const result = scanAgentCommands(home);
        expect(JSON.stringify(result.catalog)).toBe('{}');
        expect(result.dropped).toBe(0);
    });

    it('mixes agents independently — the same name in two agents stays in both', () => {
        skill(join(home, '.claude', 'skills'), 'shared');
        const piReal = join(home, 'pi-shared');
        mkdirSync(piReal);
        writeFileSync(join(piReal, 'SKILL.md'), 'body');
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(piReal, join(home, '.agents', 'skills', 'shared'));
        const { catalog } = scanAgentCommands(home);
        expect(names(catalog.claude)).toEqual(['shared']);
        expect(names(catalog.pi)).toEqual(['skill:shared']);
    });
});

// Each agent's catalog, measured against the agent's own report on 2026-10-20: `codex app-server`
// `skills/list`, `opencode serve` `/api/skill`, `claude -p` init `slash_commands`.
describe('agent catalog', () => {
    it('lists codex skills from ~/.agents/skills and its own dirs as $mentions', () => {
        skill(join(home, '.agents', 'skills'), 'tdd');
        skill(join(home, '.codex', 'skills'), 'mine');
        // Codex ships its system skills in a hidden folder and registers them all the same.
        skill(join(home, '.codex', 'skills', '.system'), 'imagegen');
        expect(names(scanAgentCommands(home).catalog.codex).sort()).toEqual(['$imagegen', '$mine', '$tdd']);
    });

    it('lists opencode skills from the claude, agents and opencode dirs as @mentions, once each', () => {
        skill(join(home, '.claude', 'skills'), 'plan');
        skill(join(home, '.agents', 'skills'), 'plan');
        skill(join(home, '.agents', 'skills'), 'tdd');
        skill(join(home, '.config', 'opencode', 'skills'), 'local');
        expect(names(scanAgentCommands(home).catalog.opencode).sort()).toEqual(['@local', '@plan', '@tdd']);
    });

    it('finds an opencode skill filed under grouping folders, which claude does not register', () => {
        // Claude Code's synced skills land in `~/.claude/skills/synced/<id>/<name>`; opencode walks into them.
        skill(join(home, '.claude', 'skills', 'synced', 'abc'), 'pdf');
        const { catalog } = scanAgentCommands(home);
        expect(names(catalog.opencode)).toEqual(['@pdf']);
        expect(catalog.claude).toBeUndefined();
    });

    it('leaves out the skills of a claude plugin that is installed but not enabled', () => {
        skill(join(installPlugin('on@mkt'), 'skills'), 'a');
        skill(join(installPlugin('off@mkt'), 'skills'), 'b');
        skill(join(installPlugin('unlisted@mkt'), 'skills'), 'c');
        enablePlugins({ 'on@mkt': true, 'off@mkt': false });
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['on:a']);
    });

    it('lists a claude plugin command file as a plugin command, once when a skill shares its name', () => {
        const install = installPlugin('cave@mkt');
        skill(join(install, 'skills'), 'cave');
        mkdirSync(join(install, 'commands'), { recursive: true });
        writeFileSync(join(install, 'commands', 'cave.md'), 'body');
        writeFileSync(join(install, 'commands', 'cave-init.md'), 'body');
        // A sibling of another format is not a Claude Code command.
        writeFileSync(join(install, 'commands', 'cave-init.toml'), 'body');
        enablePlugins({ 'cave@mkt': true });
        expect(names(scanAgentCommands(home).catalog.claude).sort()).toEqual(['cave:cave', 'cave:cave-init']);
    });
});

describe('import side effects', () => {
    // The listener imports this module, and the inventory worker loads the
    // listener in a second thread — a filesystem read at module scope would run
    // the scan twice. Make every fs call throw, then import: the module must
    // still load, which it can only do by touching nothing on the way in.
    it('does not read the filesystem at import time', async () => {
        vi.resetModules();
        const explode = () => {
            throw new Error('fs touched at import time');
        };
        vi.doMock('fs', () => ({
            readdirSync: explode,
            statSync: explode,
            readFileSync: explode,
            mkdirSync: explode,
            writeFileSync: explode,
        }));
        const mod = await import('./command-scan.js');
        expect(typeof mod.scanAgentCommands).toBe('function');
        vi.doUnmock('fs');
        vi.resetModules();
    });
});
