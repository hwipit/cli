import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asksForUsage, COMMAND_FLAGS, FLAG_KINDS, GLOBAL_FLAGS, parseArgs, parseCliArgv, unknownFlags } from './args.js';

describe('parseCliArgv', () => {
    // Read as the CLI's own, a `--base-url` in a message would send the API key elsewhere.
    it('reads flags before send only and keeps everything after it verbatim', () => {
        const argv = ['node', 'hwip', '--key', 'ak_1', 'send', 'hwip-api', 'run', '--base-url', 'http://evil', '--version'];

        const { args, sendArgv } = parseCliArgv(argv);

        expect(args).toMatchObject({ _command: 'send', key: 'ak_1' });
        expect(args['base-url']).toBeUndefined();
        expect(args.version).toBeUndefined();
        expect(sendArgv).toEqual(['hwip-api', 'run', '--base-url', 'http://evil', '--version']);
    });

    it('leaves other commands alone, even with a send word among their values', () => {
        const argv = ['node', 'hwip', 'notify', '--title', 'send', '--body', 'x'];

        expect(parseCliArgv(argv)).toEqual({
            args: { _command: 'notify', _arg1: '', _arg2: '', title: 'send', body: 'x' },
            sendArgv: [],
        });
    });
});

describe('parseCliArgv for hwip agent send', () => {
    const parse = (...words: string[]) => parseCliArgv(['node', 'hwip', ...words]);

    // Same rule as `send`: a `--base-url` in a message would send the API key elsewhere.
    it('reads flags before agent send only and keeps everything after it verbatim', () => {
        const { args, sendArgv } = parse('--key', 'ak_1', 'agent', 'send', 'hwip-api', 'run', '--base-url', 'http://evil', '--version');

        expect(args).toMatchObject({ _command: 'agent', _arg1: 'send', key: 'ak_1' });
        expect(args['base-url']).toBeUndefined();
        expect(args.version).toBeUndefined();
        expect(sendArgv).toEqual(['hwip-api', 'run', '--base-url', 'http://evil', '--version']);
    });

    it('reads a help flag where the target goes as a help request', () => {
        expect(parse('agent', 'send', '--help').args.help).toBe(true);
        expect(parse('agent', 'send', '-h').args.help).toBe(true);
    });

    it('keeps the word send inside the message from ending the flags early', () => {
        const { sendArgv } = parse('agent', 'send', 'hwip-api', 'please', 'send', 'it');

        expect(sendArgv).toEqual(['hwip-api', 'please', 'send', 'it']);
    });

    it('finds agent send even when a flag value before it is spelled agent', () => {
        expect(parse('--key', 'agent', 'agent', 'send', 't', 'm').sendArgv).toEqual(['t', 'm']);
        expect(parse('--title', 'agent', 'agent', 'send', 't', 'm').sendArgv).toEqual(['t', 'm']);
    });

    it('leaves agent without send alone', () => {
        expect(parse('agent', '--title', 'x')).toEqual({ args: { _command: 'agent', _arg1: '', _arg2: '', title: 'x' }, sendArgv: [] });
        expect(parse('agent', 'other', 'send', 'x').sendArgv).toEqual([]);
    });

    // A flag may stand between `agent` and `send`; the `send` is the word the parser reads as the one after `agent`.
    it('takes the send right after agent when a flag stands between, never a pair inside the message', () => {
        const { args, sendArgv } = parse('agent', '--key=ak_1', 'send', 'alice', 'tell', 'him', 'to', 'run', 'agent', 'send', 'bob', 'deploy');

        expect(args).toMatchObject({ _command: 'agent', _arg1: 'send', key: 'ak_1' });
        expect(sendArgv).toEqual(['alice', 'tell', 'him', 'to', 'run', 'agent', 'send', 'bob', 'deploy']);
    });

    it('never reads a flag word of the message as the CLI\'s own after such a flag (the API key stays on its host)', () => {
        const { args, sendArgv } = parse('agent', '--json=1', 'send', 'alice', 'see', '--base-url', 'http://evil', 'then', 'agent', 'send', 'bob', 'x');

        expect(args['base-url']).toBeUndefined();
        expect(sendArgv).toEqual(['alice', 'see', '--base-url', 'http://evil', 'then', 'agent', 'send', 'bob', 'x']);
    });

    it('reads a spaced flag between agent and send by its value, so a value spelled send is not the send', () => {
        const { args, sendArgv } = parse('agent', '--title', 'send', 'send', 'alice', 'hi');

        expect(args.title).toBe('send');
        expect(sendArgv).toEqual(['alice', 'hi']);
    });

    it('reads a help flag between agent and send as a help request, the message untouched', () => {
        const { args, sendArgv } = parse('agent', '--help', 'send', 'alice', 'hi');

        expect(args.help).toBe(true);
        expect(sendArgv).toEqual(['alice', 'hi']);
    });

    it('takes a send after -- as typed', () => {
        expect(parse('agent', '--', 'send', 'alice', '--base-url', 'x').sendArgv).toEqual(['alice', '--base-url', 'x']);
        expect(parse('agent', '--', 'send', 'alice').args['base-url']).toBeUndefined();
    });
});

describe('parseCliArgv for hwip send, with a flag value spelled send', () => {
    const parse = (...words: string[]) => parseCliArgv(['node', 'hwip', ...words]);

    it('starts the message after the send the parser reads, not after a flag value spelled send', () => {
        const { args, sendArgv } = parse('--title', 'send', 'send', 'alice', 'hi');

        expect(args).toMatchObject({ _command: 'send', title: 'send' });
        expect(sendArgv).toEqual(['alice', 'hi']);
    });

    it('takes the send after -- as typed, and reads no flag in the message', () => {
        const { args, sendArgv } = parse('--', 'send', 'alice', '--base-url', 'http://e');

        expect(args['base-url']).toBeUndefined();
        expect(sendArgv).toEqual(['alice', '--base-url', 'http://e']);
    });

    it('does not treat a flag value spelled send as the command', () => {
        expect(parse('--title', 'send', 'alice', 'hi').sendArgv).toEqual([]);
    });
});

// C99: the value of a flag can be text nobody typed — a command to approve, the
// model's last message. Told apart from a flag only by how it looks, such a value
// that starts with `--base-url=…` used to be read as the CLI's own flag, and the
// API key went to that host.
describe('a value that looks like a flag', () => {
    const parse = (...words: string[]) => parseArgs(['node', 'hwip', ...words]);

    it('is the value of a flag that takes one (the argv of the approve hook, word for word)', () => {
        const evil = '--base-url=http://127.0.0.1:9/evil; rm -rf build';
        const args = parse('ask', '--title', 'Approve in p?', '--body', evil, '--actions', 'approve:Approve,deny:Deny', '--timeout', '5');

        expect(args.body).toBe(evil);
        expect(args['base-url']).toBeUndefined();
        expect(args.actions).toBe('approve:Approve,deny:Deny');
        expect(args.timeout).toBe('5');
    });

    it('is the value for every flag that takes one, and never sets the base URL', () => {
        for (const flag of Object.keys(FLAG_KINDS).filter((f) => FLAG_KINDS[f] === 'value')) {
            const args = parse('notify', `--${flag}`, '--base-url=http://evil');

            expect(args[flag], flag).toBe('--base-url=http://evil');
            // (`--base-url` itself takes it as its own value, which is the flag doing what it says.)
            if (flag !== 'base-url') expect(args['base-url'], flag).toBeUndefined();
        }
    });

    it('is also the value for the notify argv of the stop hook, with the = form of the hooks unchanged', () => {
        const evil = '--key=ak_stolen';

        expect(parse('notify', '--title', 'Claude: p', '--body', evil, '--type', 'hook').body).toBe(evil);
        // The form the plugin's hooks use now: one word, so no CLI version can read it as a flag.
        expect(parse('notify', '--title=Claude: p', `--body=${evil}`, '--type=hook')).toMatchObject({ body: evil, title: 'Claude: p', type: 'hook' });
        expect(parse('notify', `--body=${evil}`).key).toBeUndefined();
    });

    it('does not take a word for a flag that takes none, and keeps -h, --help and -- as what they are', () => {
        expect(parse('notify', '--auto', '--base-url=http://e')['base-url']).toBe('http://e');
        expect(parse('notify', '--title', '--help').help).toBe(true);
        expect(parse('notify', '--title', '-h').help).toBe(true);
        expect(parse('notify', '--title', '--', 'x')).toMatchObject({ title: true, _arg1: 'x' });
    });

    it('reads the third positional word, the session of hwip agent read', () => {
        expect(parse('agent', 'read', 'hwip-api', '--turns', '5', '--json')).toMatchObject({
            _command: 'agent', _arg1: 'read', _arg2: 'hwip-api', turns: '5', json: true,
        });
        expect(parse('agent', 'list', '--json')).toMatchObject({ _arg1: 'list', _arg2: '', json: true });
    });

    it('leaves a flag at the end of argv without a value as a bare flag', () => {
        expect(parse('notify', '--title')).toMatchObject({ title: true });
    });

    it('takes a value for exactly the flags the usage text gives a value (--title <text>, --timeout <sec>, …)', () => {
        const withValue = Object.keys(FLAG_KINDS).filter((f) => FLAG_KINDS[f] === 'value').sort();

        expect(withValue).toEqual([
            'actions', 'allow-host', 'api-key', 'at', 'base-url', 'body', 'channel', 'days', 'device', 'every', 'hook', 'key', 'label', 'limit', 'marker',
            'max-runtime', 'nonreadonly', 'only', 'priority', 'prompt', 'pushmode-default', 'session', 'timeout', 'title', 'tools', 'turns', 'type', 'url',
            'web-url', 'ws-url', 'wt',
        ]);
    });

    it('is decided for every flag the CLI knows: a new flag has to say whether it takes a value', () => {
        const known = new Set([...GLOBAL_FLAGS, ...Object.values(COMMAND_FLAGS).flat()]);

        expect([...known].filter((flag) => !(flag in FLAG_KINDS))).toEqual([]);
    });
});

describe('flag values', () => {
    const parse = (...words: string[]) => parseCliArgv(['node', 'hwip', ...words]).args;

    // `--title=Foo` used to land as a flag named `title=Foo`, and the title was lost.
    it('reads --name=value as the flag and its value', () => {
        expect(parse('notify', '--title=Foo', '--body=a=b')).toMatchObject({ title: 'Foo', body: 'a=b' });
        expect(parse('notify', '--title=')).toMatchObject({ title: '' });
    });

    // `--title "--- done"` used to read the title as a flag named `- done`.
    it('takes a dash run as a value, not a flag', () => {
        expect(parse('notify', '--title', '--- done', '--json')).toMatchObject({ title: '--- done', json: true });
    });

    it('reads every word after -- as a positional, flags and -h included', () => {
        const args = parse('notify', '--json', '--', '--title', '-h');

        expect(args).toMatchObject({ _command: 'notify', _arg1: '--title', json: true });
        expect(args.title).toBeUndefined();
        expect(args.help).toBeUndefined();
    });

    it('never lets a flag swallow -- as its value', () => {
        expect(parse('forget', '--json', '--', '--weird-name')).toMatchObject({ json: true, _arg1: '--weird-name' });
    });
});

describe('help flags', () => {
    // `-h` used to land as a positional, so `hwip notify -h` sent a push.
    it('reads -h as the help flag, not as a word', () => {
        const { args } = parseCliArgv(['node', 'hwip', 'notify', '-h']);

        expect(args).toMatchObject({ _command: 'notify', _arg1: '', help: true });
    });

    it('never lets --help swallow the next word as its value', () => {
        const { args } = parseCliArgv(['node', 'hwip', 'notify', '--help', 'foo']);

        expect(args).toMatchObject({ _command: 'notify', _arg1: 'foo', help: true });
    });

    // A flag that takes no value used to swallow the -h after it, so
    // `uninstall --dry-run -h` turned dry-run off and really uninstalled.
    it.each([
        ['uninstall', '--dry-run', '-h'],
        ['notify', '--json', '-h'],
    ].map((words) => [words.join(' '), words] as const))('reads -h after a flag in %s as help', (_, words) => {
        const { args } = parseCliArgv(['node', 'hwip', ...words]);

        expect(args.help).toBe(true);
        expect(args[words[1].slice(2)]).toBe(true);
    });

    it('reads a help flag where the send target goes as help', () => {
        expect(parseCliArgv(['node', 'hwip', 'send', '--help']).args.help).toBe(true);
        expect(parseCliArgv(['node', 'hwip', 'send', '-h', 'hi']).args.help).toBe(true);
    });

    it('leaves -h and --help inside a send message alone', () => {
        const { args, sendArgv } = parseCliArgv(['node', 'hwip', 'send', 'hwip-api', 'run', '-h', '--help']);

        expect(args.help).toBeUndefined();
        expect(sendArgv).toEqual(['hwip-api', 'run', '-h', '--help']);
    });
});

describe('asksForUsage', () => {
    const decide = (words: string[], isAgentCommand = false): boolean => {
        const argv = ['node', 'hwip', ...words];
        return asksForUsage(argv, parseCliArgv(argv).args, isAgentCommand);
    };

    it.each([
        ['no command', [], false, true],
        ['help', ['help'], false, true],
        ['a command with --help', ['uninstall', '--help'], false, true],
        ['a command without a help flag', ['notify', '--title', 'x'], false, false],
        // The agent gets its own flags: `hwip cc --help` is claude's help.
        ['an agent command with its own --help', ['cc', '--help'], true, false],
        // It used to start the session: the help flag before `cc` was dropped.
        ['--help before an agent command', ['--help', 'cc'], true, true],
        ['-h before an agent command', ['-h', 'cc', '--resume'], true, true],
        ['an agent command alone', ['cc'], true, false],
    ] as const)('%s', (_, words, isAgentCommand, expected) => {
        expect(decide([...words], isAgentCommand)).toBe(expected);
    });
});

// C40: a typo flag used to vanish, and the push went out with the default title.
describe('unknownFlags', () => {
    const flagsOf = (...words: string[]) => unknownFlags(parseArgs(['node', 'hwip', ...words]));

    it('names a flag the command does not read', () => {
        expect(flagsOf('notify', '--titel', 'Done', '--json')).toEqual(['titel']);
        expect(flagsOf('list', '--all')).toEqual(['all']);
    });

    it('passes the command\'s own flags and the global ones', () => {
        expect(flagsOf('notify', '--title', 'x', '--auto', '--tools', '3', '--key', 'k', '--base-url=u')).toEqual([]);
        expect(flagsOf('setup', '--only', 'claude', '--no-service')).toEqual([]);
        expect(flagsOf('ask', '--api-key', 'k', '--accepts-exit')).toEqual([]);
    });

    it('leaves commands it has no table for alone', () => {
        expect(flagsOf('cc', '--resume')).toEqual([]);
        expect(flagsOf('sh', '--label', 'x')).toEqual([]);
        expect(flagsOf('nope', '--x')).toEqual([]);
        expect(flagsOf('constructor', '--x')).toEqual([]);
    });

    it('never reads a send message as flags', () => {
        const { args } = parseCliArgv(['node', 'hwip', 'send', 'box:main', 'try', '--titel', 'now']);
        expect(unknownFlags(args)).toEqual([]);
    });

    // The hooks hwip install writes run on every turn; a warning there would
    // land in every agent's hook output. They call only notify and ask.
    it('knows every flag the installed hooks pass', async () => {
        const gate = await import('./gate.js');
        const templates = readFileSync(join(__dirname, 'templates.ts'), 'utf-8')
            .replaceAll('${TOOL_COUNT_FLAG}', gate.TOOL_COUNT_FLAG)
            .replaceAll('${NONREADONLY_COUNT_FLAG}', gate.NONREADONLY_COUNT_FLAG)
            .replaceAll('${PUSHMODE_DEFAULT_FLAG}', gate.PUSHMODE_DEFAULT_FLAG);
        // The pi extension also calls the herdr binary, whose flags are not ours.
        const herdrFlags = ['--source', '--agent', '--seq', '--state'];
        const flags = [...new Set(templates.match(/--[a-z][a-z-]+/g))].filter((flag) => !herdrFlags.includes(flag));
        expect(flags.length).toBeGreaterThan(5);
        // `--turns` is pi's `hwip agent read` flag, so a flag any of the three commands reads is known.
        const unknownToBoth = flags.filter((flag) => flagsOf('notify', flag).length && flagsOf('ask', flag).length && flagsOf('agent', flag).length);
        expect(unknownToBoth).toEqual([]);
    });
});
