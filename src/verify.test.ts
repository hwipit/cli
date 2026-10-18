import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { binaryResolves, claudeHasHwip, classifyMcpRegistration, registeredMcpArgv, UNREADABLE } from './verify.js';
import { MCP_LAUNCH_ARGV, MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';

// An MCP registration is written once, at install time, and never read back.
// When it rots — the command left PATH, or it still points at the npm launcher
// `hwip mcp` replaced — the only symptom is that the agent's hwip tools quietly
// vanish. `hwip verify` is the one place that can say so.

const onPath = (bin: string) => bin === 'hwip' || bin === 'npx';
const nothingOnPath = () => false;

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'sdk-verify-test-')); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

const writeJson = (rel: string, data: unknown): string => {
    const file = join(TMP, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
};

describe('registeredMcpArgv', () => {
    it('reads the command+args shape (Cursor, Windsurf, Gemini)', () => {
        const file = writeJson('mcp.json', { mcpServers: { hwip: MCP_SERVERS_ENTRY } });
        expect(registeredMcpArgv(file, 'mcpServers')).toEqual([...MCP_LAUNCH_ARGV]);
    });

    it('reads the array-command shape (opencode)', () => {
        const file = writeJson('opencode.json', { mcp: { hwip: OPENCODE_MCP_ENTRY } });
        expect(registeredMcpArgv(file, 'mcp')).toEqual([...MCP_LAUNCH_ARGV]);
    });

    it('reads a legacy npx registration verbatim rather than normalizing it away', () => {
        const file = writeJson('mcp.json', {
            mcpServers: { hwip: { command: 'npx', args: ['-y', '@hwip/mcp-server'] } },
        });
        expect(registeredMcpArgv(file, 'mcpServers')).toEqual(['npx', '-y', '@hwip/mcp-server']);
    });

    it('returns null for a missing file or no hwip entry', () => {
        expect(registeredMcpArgv(join(TMP, 'nope.json'), 'mcpServers')).toBeNull();
        expect(registeredMcpArgv(writeJson('other.json', { mcpServers: { other: {} } }), 'mcpServers')).toBeNull();
    });

    // It used to read as "no hwip entry", so verify reported the agent as
    // never registered when its file merely could not be parsed.
    // The installer reads these as `{}` / plain JSON, so verify must too.
    it.each([
        ['an empty file', ''],
        ['a BOM-led file', '\uFEFF{ "mcpServers": {} }'],
    ])('calls %s unregistered, not unreadable', (_, content) => {
        const file = join(TMP, 'quiet.json');
        writeFileSync(file, content);
        expect(registeredMcpArgv(file, 'mcpServers')).toBeNull();
    });

    it.each([
        ['unparseable JSON', '{ not json'],
        ['JSON that is not an object', 'null\n'],
    ])('calls %s unreadable, not unregistered', (_, content) => {
        const broken = join(TMP, 'broken.json');
        writeFileSync(broken, content);
        expect(registeredMcpArgv(broken, 'mcpServers')).toBe(UNREADABLE);
    });
});

describe('classifyMcpRegistration', () => {
    it('calls the canonical launch current', () => {
        expect(classifyMcpRegistration([...MCP_LAUNCH_ARGV], onPath)).toEqual({ state: 'current' });
    });

    // The whole point of `hwip mcp`: a registration left on npx keeps paying
    // for the launcher process, and reports success while doing it.
    it('calls a surviving npx registration stale, and says what it found', () => {
        const argv = ['npx', '-y', '@hwip/mcp-server'];
        expect(classifyMcpRegistration(argv, onPath)).toEqual({ state: 'stale', argv });
    });

    it('calls a registration whose binary left PATH unresolvable', () => {
        const argv = ['/opt/node/v20/bin/hwip-mcp'];
        expect(classifyMcpRegistration(argv, nothingOnPath)).toEqual({ state: 'unresolvable', argv });
    });

    // Unresolvable outranks stale — a stale entry still starts a server.
    it('reports an unreachable binary even when the argv is also stale', () => {
        const argv = ['npx', '-y', '@hwip/mcp-server'];
        expect(classifyMcpRegistration(argv, nothingOnPath)?.state).toBe('unresolvable');
    });

    it('reports nothing for a missing or empty registration', () => {
        expect(classifyMcpRegistration(null, onPath)).toBeNull();
        expect(classifyMcpRegistration([], onPath)).toBeNull();
    });
});

describe('binaryResolves', () => {
    it('finds a bare command on PATH', () => {
        expect(binaryResolves('node')).toBe(true);
        expect(binaryResolves('definitely-not-a-real-binary-xyz')).toBe(false);
    });

    // The reason this exists instead of the shared hasCommand: that one builds
    // `which ${cmd}` as a shell string, so an absolute path containing a space
    // — ordinary on macOS — splits into two words and a working binary reports
    // as missing. Registered commands come out of a config file, not a literal.
    it('resolves an absolute path that contains a space', () => {
        const dir = mkdtempSync(join(tmpdir(), 'sdk verify space-'));
        const bin = join(dir, 'hwip');
        writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
        expect(bin).toContain(' ');
        expect(binaryResolves(bin)).toBe(true);
        expect(binaryResolves(join(dir, 'absent'))).toBe(false);
        rmSync(dir, { recursive: true, force: true });
    });

    it('does not hand the command to a shell', () => {
        expect(binaryResolves('nope; echo injected')).toBe(false);
    });
});

describe('readCodexMcpArgv — the one TOML registry', () => {
    const writeToml = (rel: string, body: string): string => {
        const file = join(TMP, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
        return file;
    };

    it('reads the registration the installer writes', async () => {
        const { readCodexMcpArgv } = await import('./verify.js');
        const file = writeToml('config.toml', '[mcp_servers.hwip]\ncommand = "hwip"\nargs = ["mcp"]\n');
        expect(readCodexMcpArgv(file)).toEqual(['hwip', 'mcp']);
    });

    it('hands back a stale registration unnormalized, so it can be called stale', async () => {
        const { readCodexMcpArgv, classifyMcpRegistration } = await import('./verify.js');
        const file = writeToml('stale.toml', '[mcp_servers.hwip]\ncommand = "npx"\nargs = ["-y", "@hwip/mcp-server"]\n');
        const argv = readCodexMcpArgv(file);
        expect(argv).toEqual(['npx', '-y', '@hwip/mcp-server']);
        expect(classifyMcpRegistration(argv, () => true)).toEqual({ state: 'stale', argv });
    });

    it('is null for a config without hwip, and for a file that is not there', async () => {
        const { readCodexMcpArgv } = await import('./verify.js');
        expect(readCodexMcpArgv(writeToml('bare.toml', 'model = "gpt-5.6-luna"\n'))).toBeNull();
        expect(readCodexMcpArgv(join(TMP, 'absent.toml'))).toBeNull();
    });
});

describe('claudeHasHwip', () => {
    it('finds the hwip plugin in installed_plugins.json', () => {
        writeJson('.claude/plugins/installed_plugins.json', { plugins: { 'hwip@hwip': [{ installPath: '/p' }] } });
        expect(claudeHasHwip(TMP)).toBe(true);
    });

    it('finds the plugin in the older one-object-per-plugin layout', () => {
        writeJson('.claude/plugins/installed_plugins.json', { plugins: { 'hwip@hwip': { installPath: '/p' } } });
        expect(claudeHasHwip(TMP)).toBe(true);
    });

    it('finds a hwip MCP server registered in ~/.claude.json', () => {
        writeJson('.claude.json', { mcpServers: { hwip: MCP_SERVERS_ENTRY } });
        expect(claudeHasHwip(TMP)).toBe(true);
    });

    // Any "hwip" in ~/.claude.json used to pass — a project path like
    // a checkout named hwip is in there on every machine that works on hwip — and
    // so did any installed plugin at all.
    it('ignores hwip mentioned elsewhere, and other plugins', () => {
        writeJson('.claude.json', { projects: { '/Users/me/workspace/hwipit': {} }, mcpServers: { other: {} } });
        writeJson('.claude/plugins/installed_plugins.json', { plugins: { 'other@market': [{ installPath: '/p' }] } });
        expect(claudeHasHwip(TMP)).toBe(false);
    });
});
