/**
 * C128: the parser's message for a config.json that does not parse can quote the text around the
 * error ("Unexpected token 'a', …"apiKey": ak_live_ab"… is not valid JSON"), and that file holds
 * the API key. The reason is printed on stderr, in listener.log and by `verify`, so no part of the
 * file may be in it: where the error is (line and column) is all it says.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ak_live_abcdef123456';

const load = async () => {
    vi.resetModules();
    const config = await import('./config.js');
    mkdirSync(config.CONFIG_DIR, { recursive: true });
    rmSync(config.CONFIG_FILE, { force: true });
    return config;
};
afterEach(() => {
    vi.restoreAllMocks();
});

// Each one makes V8 name or quote a different part of the text in its message.
const BROKEN_WITH_A_KEY = [
    ['an unquoted value', `{"apiKey": ${KEY}}`],
    ['a missing comma', `{"apiKey": "${KEY}" "hookId": "h"}`],
    ['a trailing comma', `{"apiKey": "${KEY}",}`],
    ['single quotes', `{"apiKey": '${KEY}'}`],
    ['a cut-off file', `{"apiKey": "${KEY}`],
] as const;

describe.skipIf(process.platform === 'win32')('a config.json that does not parse', () => {
    it.each(BROKEN_WITH_A_KEY)('keeps the key out of every place the reason is printed (%s)', async (_name, text) => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
        const config = await load();
        writeFileSync(config.CONFIG_FILE, text);

        config.loadConfig();
        const ignored = config.configIgnoredBecause() ?? '';
        let saving = '';
        try {
            config.saveConfig({ apiKey: 'ak_new' });
        } catch (err) {
            saving = err instanceof Error ? err.message : String(err);
        }

        for (const said of [lines.join('\n'), ignored, saving]) {
            expect(said).toContain('is not valid JSON');
            expect(said).not.toContain(KEY);
            expect(said).not.toContain('ak_live');
            expect(said).not.toContain('apiKey');
        }
    });

    it('says where the error is, in lines and columns', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        writeFileSync(config.CONFIG_FILE, `{\n  "apiKey": "${KEY}"\n  "hookId": "h"\n}\n`);

        expect(config.configIgnoredBecause()).toMatch(/config\.json is not valid JSON at line 3 column 3\b/);
    });

    // V8 quotes a few characters of the file; digits after the word "position" in them are the file's, not the error's.
    it('does not take a place from the text V8 quotes', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        writeFileSync(config.CONFIG_FILE, `{"apiKey": position 98765}`);

        expect(config.configIgnoredBecause()).not.toMatch(/ at line \d+ column \d+/);
    });

    it('is the same for a file with a byte order mark: told apart from the rest', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        writeFileSync(config.CONFIG_FILE, `﻿{"apiKey": "${KEY}"}`);

        expect(config.configIgnoredBecause()).toMatch(/starts with a byte order mark/);
    });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a config.json that cannot be read', () => {
    it('names the error code and nothing else of the message', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const config = await load();
        writeFileSync(config.CONFIG_FILE, '{}');
        chmodSync(config.CONFIG_FILE, 0o000);
        try {
            const said = config.configIgnoredBecause() ?? '';
            expect(said).toMatch(/config\.json cannot be read \(EACCES\)/);
            expect(said).not.toMatch(/permission denied/);
        } finally {
            chmodSync(config.CONFIG_FILE, 0o600);
        }
    });
});
