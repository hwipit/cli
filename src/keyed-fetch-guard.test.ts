/**
 * C106: the guard behind `keyed-fetch-redirect.test.ts`. That file shows each known
 * caller refusing a redirect; this one makes a NEW network call decide.
 *
 * Every call to `fetch`, to a function named like it (`fetchFn`, `fetchImpl`, `apiFetch`, also
 * `?.(`, `.call(` and `.apply(`) is read from the TypeScript syntax tree and has to either pass
 * `redirect: 'error'` (undici sends `X-API-Key` across origins, so a key-carrying call must not
 * follow a redirect) or be named in KEYLESS below with the reason it carries no key. Counting per
 * file was not enough: a second call in a file that already had one `redirect: 'error'` passed
 * unnoticed. `apiFetch` itself is one such call, and so covers everything that goes through it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const SRC = __dirname;

/** Calls that carry no API key: file, the start of their arguments, and why. Each names exactly one call. */
const KEYLESS: Record<string, string> = {
    'agent-rules-fetch.ts: url, { headers: etag ? { \'If-None-Match\': etag } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }': 'the public agent-rules manifest',
    'check-update.ts: `https://registry.npmjs.org/${pkg}/latest`, { headers: { Accept: \'application/json\' }, signal: AbortSignal.timeout(timeoutMs) }': 'the public npm registry',
    'hwip-hook.ts: url, { method: \'PUT\', headers: { \'Content-Type\': uploadContentType(contentType) }, body, signal: AbortSignal.timeout(this.timeoutMs) }': 'a presigned upload URL, self-authenticating',
    'lan-sender.ts: `${base}${LAN_PATHS.ping}`, { headers: toLanAuthHeaders(fields, mac), signal: pingDeadline.signal }': 'a peer on the LAN, signed with the LAN key',
    'lan-sender.ts: `${base}${LAN_PATHS.upload}`, init': 'a peer on the LAN, signed with the LAN key',
};

/** Named like a fetch, but only a helper that goes on to call one of the calls this test reads. */
const NOT_A_REQUEST = new Set(['fetchAttachmentBytes', 'fetchLatest']);

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'fixtures' || entry.name === 'node_modules' ? [] : sourceFiles(path);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

interface Call { file: string; name: string; args: string; refuses: boolean }

const printer = ts.createPrinter({ removeComments: true });

/** `f`, `deps.f`, `f?.`, `f.call` and `f.apply` all name the callee `f`. */
const calleeName = (expression: ts.Expression): string | null => {
    let callee = expression;
    while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
    if (ts.isPropertyAccessExpression(callee) && ['call', 'apply'].includes(callee.name.text)) return calleeName(callee.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return null;
};

/** The last word on `redirect` in an options object is `'error'`: a later spread could put it back. */
const refusesRedirect = (args: readonly ts.Expression[]): boolean =>
    args.some((arg) => {
        if (!ts.isObjectLiteralExpression(arg)) return false;
        let refuses = false;
        for (const property of arg.properties) {
            if (ts.isSpreadAssignment(property)) refuses = false;
            else if (ts.isPropertyAssignment(property) && property.name.getText() === 'redirect') {
                refuses = ts.isStringLiteralLike(property.initializer) && property.initializer.text === 'error';
            }
        }
        return refuses;
    });

const scan = (path: string): { calls: Call[]; aliases: string[] } => {
    const file = relative(SRC, path);
    const source = ts.createSourceFile(file, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);
    const calls: Call[] = [];
    const aliases: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name && /fetch/i.test(name) && !NOT_A_REQUEST.has(name)) {
                const args = node.arguments.map((arg) => printer.printNode(ts.EmitHint.Unspecified, arg, source).replace(/\s+/g, ' ').replace(/, }/g, ' }')).join(', ');
                calls.push({ file, name, args, refuses: refusesRedirect(node.arguments) });
            }
        }
        // `const send = fetch; send(url)` would hide a call under a name this test does not read.
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === 'fetch'
            && !/fetch/i.test(node.name.getText())) aliases.push(`${file}: ${node.getText()}`);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { calls, aliases };
};

const scanned = sourceFiles(SRC).map(scan);
const calls = scanned.flatMap((s) => s.calls);
const id = (call: Call): string => `${call.file}: ${call.args}`;
const keyless = (call: Call): boolean => id(call) in KEYLESS;

describe('every network call decides about redirects', () => {
    it('finds the calls it is meant to guard', () => {
        const refusing = calls.filter((call) => call.refuses).map((call) => call.file);

        for (const file of ['api.ts', 'ask.ts', 'hwip-hook.ts']) expect(refusing).toContain(file);
        expect(calls.length).toBeGreaterThanOrEqual(15);
    });

    it('passes redirect: \'error\', or is a call named as keyless', () => {
        const undecided = calls.filter((call) => !call.refuses && call.name !== 'apiFetch' && !keyless(call)).map(id);

        expect(undecided, 'a new network call: pass redirect: \'error\' if it carries the API key, else add it to KEYLESS with the reason').toEqual([]);
    });

    it('names each keyless call exactly once, so the list can neither go stale nor exempt a second call', () => {
        const found = calls.filter(keyless).map(id);

        for (const entry of Object.keys(KEYLESS)) expect(found.filter((one) => one === entry), entry).toHaveLength(1);
    });

    it('lets no keyless call touch the key', () => {
        expect(calls.filter((call) => keyless(call) && /api.?key/i.test(call.args)).map(id)).toEqual([]);
    });

    it('lets no call that names the key go without redirect: \'error\'', () => {
        expect(calls.filter((call) => /X-API-Key/i.test(call.args) && !call.refuses).map(id)).toEqual([]);
    });

    it('lets fetch go under no other name', () => {
        expect(scanned.flatMap((s) => s.aliases)).toEqual([]);
    });
});
