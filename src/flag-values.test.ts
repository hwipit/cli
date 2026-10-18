/**
 * C116-C118: a yes/no flag is read one way everywhere (`flagOn`), and the opt-outs of the listener
 * hold only for the values that mean on. `--dry-run=true` used to be "not given" and removed what
 * it was asked to preview; `--no-turn-history=1` left the upload on; `"turnHistory": "false"` too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { badFlagValue, FLAG_KINDS, flagOn, FlagValueError, parseArgs } from './args.js';
import { optionalFeatures } from './optional-features.js';

const parse = (...argv: string[]) => parseArgs(['node', 'hwip', ...argv]);

describe('flagOn: one reading of a yes/no flag', () => {
    it.each([
        ['not given', undefined, false],
        ['bare', true, true],
        ['=false', false, false],
        ['=true', 'true', true],
        ['=TRUE', 'TRUE', true],
        ['=1', '1', true],
        ['=yes', 'yes', true],
        ['=Yes with spaces', ' Yes ', true],
        ['=false (text)', 'false', false],
        ['=0', '0', false],
        ['=no', 'no', false],
        ['=NO', 'NO', false],
    ])('%s', (_name, value, expected) => {
        expect(flagOn(value === undefined ? {} : { x: value }, 'x')).toBe(expected);
    });

    it.each(['maybe', '2', '', 'on', 'off', 'y', 'truee', '-1'])('stops on %j, naming the flag and the value', (value) => {
        expect(() => flagOn({ 'dry-run': value }, 'dry-run')).toThrow(FlagValueError);
        expect(() => flagOn({ 'dry-run': value }, 'dry-run')).toThrow(`--dry-run takes true or false (or nothing, which is true), not "${value}"`);
    });

    it('reads a value that is neither as off when it must not stop (the usage gate, an error report)', () => {
        expect(flagOn({ help: 'maybe' }, 'help', true)).toBe(false);
        expect(flagOn({ help: 'yes' }, 'help', true)).toBe(true);
    });

    it('takes the word the boolean parser swallowed after the flag (`--dry-run yes`)', () => {
        expect(flagOn(parse('uninstall', '--dry-run', 'yes'), 'dry-run')).toBe(true);
        expect(flagOn(parse('uninstall', '--dry-run=true'), 'dry-run')).toBe(true);
        expect(flagOn(parse('uninstall', '--dry-run=0'), 'dry-run')).toBe(false);
        expect(() => flagOn(parse('uninstall', '--dry-run', 'cursor'), 'dry-run')).toThrow(FlagValueError);
    });
});

describe('badFlagValue: before a command does anything', () => {
    it('names the first yes/no flag of the command with a value that is neither', () => {
        expect(badFlagValue(parse('uninstall', '--dry-run=maybe'))).toBe('--dry-run takes true or false (or nothing, which is true), not "maybe"');
        expect(badFlagValue(parse('listener', '--no-turn-history=2'))).toContain('--no-turn-history');
        expect(badFlagValue(parse('list', '--json=perhaps'))).toContain('--json');
        expect(badFlagValue(parse('setup', '--relogin=x'))).toContain('--relogin');
    });

    // C132: a host list that is no list stops login and install before a picker or a browser opens.
    it('stops login and install on an --allow-host that is no list of host names, and only there', () => {
        expect(badFlagValue(parse('login', '--allow-host', 'https://api.mine.example'))).toContain('--allow-host');
        expect(badFlagValue(parse('install', '--allow-host=com'))).toContain('--allow-host');
        expect(badFlagValue(parse('login', '--allow-host'))).toContain('--allow-host');
        expect(badFlagValue(parse('login', '--allow-host', 'api.mine.example,b.example.org'))).toBeNull();
        expect(badFlagValue(parse('login'))).toBeNull();
        expect(badFlagValue(parse('uninstall', '--allow-host=com', '--dry-run'))).toBeNull();
    });

    it('lets every spelling of yes and no through', () => {
        expect(badFlagValue(parse('uninstall', '--dry-run=true', '--purge=0', '--yes=no'))).toBeNull();
        expect(badFlagValue(parse('uninstall', '--dry-run'))).toBeNull();
        expect(badFlagValue(parse('notify', '--auto=1', '--title', 'x'))).toBeNull();
    });

    it('does not check what is not a yes/no flag of the command, or a command that hands its words on', () => {
        // `trust --yes <device>` reads its own value: the device it names.
        expect(badFlagValue(parse('trust', '--yes', 'dev_phone'))).toBeNull();
        // `uninstall` reads no `--auto`: it is "unknown flag", not a bad value.
        expect(badFlagValue(parse('uninstall', '--auto=maybe'))).toBeNull();
        // An agent subcommand passes the words after it to the agent.
        expect(badFlagValue(parse('cc', '--yes=maybe', '--resume'))).toBeNull();
        expect(badFlagValue(parse('nonsense', '--json=maybe'))).toBeNull();
    });
});

describe('optionalFeatures: what the listener starts with', () => {
    it('keeps an option on only for an absent value or true', () => {
        expect(optionalFeatures({}, {})).toEqual({ turnHistory: true, keepAwake: true });
        expect(optionalFeatures({}, { turnHistory: true, keepAwake: true })).toEqual({ turnHistory: true, keepAwake: true });
    });

    // A value someone typed to turn it off, in a shape the code did not expect, is still a no.
    it.each([false, 'false', 'no', 0, null, 'off', [], {}, 1, 'true'])('reads %j in config.json as off', (value) => {
        const config = { turnHistory: value, keepAwake: value } as unknown as Parameters<typeof optionalFeatures>[1];
        expect(optionalFeatures({}, config)).toEqual({ turnHistory: false, keepAwake: false });
    });

    it.each(['--no-turn-history', '--no-turn-history=true', '--no-turn-history=1', '--no-turn-history=yes', '--no-turn-history=YES'])('%s turns turn history off', (flag) => {
        expect(optionalFeatures(parse('listener', flag), {})).toEqual({ turnHistory: false, keepAwake: true });
    });

    it('`--no-turn-history yes` (the word after the flag) is a no as well', () => {
        expect(optionalFeatures(parse('listener', '--no-turn-history', 'yes'), {}).turnHistory).toBe(false);
    });

    it.each(['--no-keep-awake=true', '--no-keep-awake=1'])('%s turns keep-awake off', (flag) => {
        expect(optionalFeatures(parse('listener', flag), {})).toEqual({ turnHistory: true, keepAwake: false });
    });

    it('`=false` / `=0` / `=no` leave the option on, and a flag cannot turn on what the config turned off', () => {
        expect(optionalFeatures(parse('listener', '--no-turn-history=false'), {})).toEqual({ turnHistory: true, keepAwake: true });
        expect(optionalFeatures(parse('listener', '--no-turn-history=0', '--no-keep-awake=no'), {})).toEqual({ turnHistory: true, keepAwake: true });
        expect(optionalFeatures(parse('listener', '--no-turn-history=false'), { turnHistory: false })).toEqual({ turnHistory: false, keepAwake: true });
    });

    it('stops on a flag value that is neither yes nor no', () => {
        expect(() => optionalFeatures(parse('listener', '--no-turn-history=maybe'), {})).toThrow(FlagValueError);
    });
});

// A consumer that reads `args['dry-run'] === true` again brings the bug back, so the source says no: every read of
// a yes/no flag out of `args` goes through `flagOn`. (`trust` reads `--yes` as a device name and has its own parse.)
describe('every consumer of a yes/no flag goes through flagOn', () => {
    const YES_NO = Object.keys(FLAG_KINDS).filter((key) => FLAG_KINDS[key] === 'boolean');
    const EXEMPT = new Set(['args.ts', 'trust-command.ts']);
    const sources = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXEMPT.has(f));

    it('lists the sources it checks, and the flags', () => {
        expect(sources).toContain('uninstall.ts');
        expect(sources).toContain('optional-features.ts');
        expect(YES_NO).toEqual(expect.arrayContaining(['dry-run', 'purge', 'yes', 'no-turn-history', 'no-keep-awake', 'stop', 'restart', 'json']));
    });

    it.each(sources)('%s reads none of them straight from args', (file) => {
        const text = readFileSync(join(__dirname, file), 'utf8');
        const raw = [...text.matchAll(/\bargs(?:\.([A-Za-z][\w]*)|\[['"]([\w-]+)['"]\])/g)]
            .map((m) => m[1] ?? m[2])
            .filter((name) => YES_NO.includes(name));
        expect(raw, `${file} reads ${raw.join(', ')} from args without flagOn`).toEqual([]);
    });
});
