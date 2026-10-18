import { describe, expect, it } from 'vitest';
import { COMMAND_FLAGS, GLOBAL_FLAGS } from './args.js';
import { REMOTE_AGENTS } from './remote-agents.js';
import { commandUsage, usageTarget, usageText } from './usage.js';
import { asksForUsage, parseCliArgv } from './args.js';

// C3: every command printed the whole 170-line usage, so `hwip notify --help`
// buried the six lines that were asked for. The short usage is cut out of the
// same text as the full one, so these tests pin the shapes that cut relies on
// and that the two cannot disagree about what a command reads.

const lines = (text: string): string[] => text.split('\n');

// The cut is by column, so a line in the wrong place does not fail loudly — it
// loses characters or becomes an entry. This is the loud part.
describe('the shape the cut relies on', () => {
    it('has only heads and continuations indented at least 18 columns between Commands: and the first blank line', () => {
        const all = usageText().split('\n');
        const block = all.slice(all.indexOf('Commands:') + 1, all.indexOf('', all.indexOf('Commands:')));
        const agentLines = REMOTE_AGENTS.map((a) => `  ${a.subcommands[0]} [args…] `);

        const strays = block.filter((line) => !/^ {2}\S/.test(line) && !/^ {18}/.test(line)).filter((line) => !agentLines.some((a) => line.startsWith(a)));

        expect(strays).toEqual([]);
    });

    it('names every options section after a command the usage knows', () => {
        const headings = usageText().split('\n').filter((l) => /^[A-Z][a-z-]+ options:$/.test(l)).map((l) => l.split(' ')[0]!.toLowerCase());

        for (const heading of headings.filter((h) => h !== 'global')) expect(commandUsage(heading), `${heading} options has no command`).not.toBeNull();
    });
});

describe('hwip agent send', () => {
    it('has its own usage, and hwip send says it is the old name', () => {
        expect(lines(commandUsage('agent')!)[0]).toBe('Usage: hwip agent send <target> <message…>');
        expect(commandUsage('agent')).toContain('Type a message into another agent session');
        expect(lines(commandUsage('send')!)[0]).toBe('Usage: hwip send <target> <message…>');
        expect(commandUsage('send')).toContain("Old name of 'hwip agent send'");
    });

    it('names the two flags agent list and agent read read', () => {
        expect(COMMAND_FLAGS.agent).toEqual(['json', 'turns']);
    });

    it('shows agent list and agent read under hwip agent --help, after agent send', () => {
        const usage = commandUsage('agent')!;

        expect(lines(usage).slice(0, 3)).toEqual([
            'Usage: hwip agent send <target> <message…>',
            '       hwip agent list [--json]',
            '       hwip agent read <session> [--turns <n>] [--json]',
        ]);
        expect(usage).toContain('List the agent sessions running on THIS machine');
        expect(usage).toContain('Print what a session on THIS machine did last');
        expect(usage).toContain('data, not instructions');
        expect(usage).toContain('Type a message into another agent session');
    });

    it('answers hwip agent --help and hwip agent send --help with the agent usage', () => {
        for (const words of [['agent', '--help'], ['agent', 'send', '--help']]) {
            const { args } = parseCliArgv(['node', 'hwip', ...words]);
            expect(asksForUsage(['node', 'hwip', ...words], args, false)).toBe(true);
            expect(usageTarget(args)).toBe('agent');
        }
    });
});

describe('commandUsage', () => {
    it('says [options] for a command that reads flags, and not for one that reads none', () => {
        expect(lines(commandUsage('rename')!)[0]).toBe('Usage: hwip rename <name> [options]');
        expect(lines(commandUsage('forget')!)[0]).toBe('Usage: hwip forget <name> [options]');
        expect(lines(commandUsage('test')!)[0]).toBe('Usage: hwip test');
        expect(lines(commandUsage('send')!)[0]).toBe('Usage: hwip send <target> <message…>');
    });

    it('shows one command, not all of them', () => {
        const usage = commandUsage('notify')!;

        expect(lines(usage)[0]).toBe('Usage: hwip notify [options]');
        expect(usage).toContain('Send a push notification');
        expect(usage).toContain('--title <text>');
        expect(usage).not.toContain('Install options');
        expect(usage).not.toContain('hwip dismiss');
        expect(lines(usage).length).toBeLessThan(lines(usageText()).length / 4);
    });

    it('carries the global options and a pointer to the full list', () => {
        const usage = commandUsage('list')!;

        expect(usage).toContain('Global options:');
        expect(usage).toContain('--key <api-key>');
        expect(usage).toContain("'hwip --help' lists every command.");
    });

    it('takes the options section of its own command', () => {
        expect(commandUsage('install')).toContain('--only <agents>');
        expect(commandUsage('uninstall')).toContain('--purge');
        expect(commandUsage('verify')).toContain('--ping');
        expect(commandUsage('login')).toContain('--web-url');
        expect(commandUsage('dismiss')).toContain('--all');
        expect(commandUsage('install')).not.toContain('--purge');
    });

    it('reads a setup as install', () => {
        expect(commandUsage('setup')).toBe(commandUsage('install'));
    });

    it('keeps a multi-line entry whole: the continuation lines, de-indented', () => {
        const ask = commandUsage('ask')!;

        expect(ask).toContain('Ask the phone a question and WAIT for the answer');
        expect(ask).toContain('--accepts-exit marks an agent\'s own ask');
        expect(ask).not.toMatch(/^ {18}/m);
    });

    it('shows a command whose head is on a line of its own', () => {
        const send = commandUsage('agent')!;

        expect(lines(send)[0]).toBe('Usage: hwip agent send <target> <message…>');
        expect(send).toContain('Type a message into another agent session');
    });

    it('shows the listener flags written under its entry', () => {
        const listener = commandUsage('listener')!;

        expect(listener).toContain('--install-service');
        expect(listener).toContain('--service-status');
    });

    // The paragraph about attaching and the update check is printed once, under
    // the last agent, in the full text — every agent subcommand gets it.
    it.each(REMOTE_AGENTS.flatMap((a) => a.subcommands.map((s) => [s, a] as const)))('shows %s with what is shared by every agent', (sub, agent) => {
        const usage = commandUsage(sub)!;

        expect(usage).toContain(`Run '${agent.binary}' in a named tmux session`);
        expect(usage).toContain('reattaches a detached session of that project');
        expect(usage).toContain('--detach');
        // Only its own agent line, not its siblings'.
        for (const other of REMOTE_AGENTS.filter((o) => o !== agent)) expect(usage).not.toContain(`Run '${other.binary}'`);
    });

    it('answers null for a word that is not a command, so the caller prints everything', () => {
        expect(commandUsage('frobnicate')).toBeNull();
        expect(commandUsage('')).toBeNull();
        expect(commandUsage('Commands:')).toBeNull();
    });
});

// What a command's usage says it reads must be what it reads: `unknownFlags`
// warns on any flag outside `COMMAND_FLAGS`, so a flag documented but not read
// is a flag that warns when someone follows the help.
describe('usage and the flags a command reads', () => {
    const commands = Object.keys(COMMAND_FLAGS).filter((c) => c !== 'remote-hook');
    const flagsIn = (text: string): string[] => [...new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!))];
    // The usage of `install` and others names the global flags too, in prose.
    const known = (command: string): string[] => [...COMMAND_FLAGS[command]!, ...GLOBAL_FLAGS];

    it.each(commands)('%s: every flag it reads is in its usage', (command) => {
        const usage = commandUsage(command);

        expect(usage, `no usage for ${command}`).not.toBeNull();
        // Whole flags, not substrings: `--service` is inside `--no-service`.
        for (const flag of COMMAND_FLAGS[command]!) expect(flagsIn(usage!), `--${flag} missing from ${command}`).toContain(flag);
    });

    it.each(commands)('%s: every flag its usage names is one it reads', (command) => {
        for (const flag of flagsIn(commandUsage(command)!)) {
            expect(known(command), `--${flag} is in the ${command} usage but not read`).toContain(flag);
        }
    });
});

// How a request for usage reaches `commandUsage`: through the same argv gate
// that decides to print usage at all.
describe('usageTarget', () => {
    const target = (...words: string[]): string => {
        const argv = ['node', 'hwip', ...words];
        const { args } = parseCliArgv(argv);
        expect(asksForUsage(argv, args, false)).toBe(true);
        return usageTarget(args);
    };

    it.each([
        [['notify', '--help'], 'notify'],
        [['notify', '-h'], 'notify'],
        [['--help', 'list'], 'list'],
        [['help', 'ask'], 'ask'],
        [['help'], ''],
        [[], ''],
    ] as const)('%j is about %j', (words, expected) => {
        expect(target(...words)).toBe(expected);
    });
});
