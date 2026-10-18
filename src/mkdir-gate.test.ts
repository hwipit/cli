/**
 * C123: a folder hwip makes goes through `mkdirHandedBack` / `mkdirExclusiveHandedBack` /
 * `ensurePrivateDir` (private-files.ts), so that root running through `sudo` hands it to the
 * person who ran `sudo` instead of leaving a root-owned folder in their home. A direct
 * `mkdir` / `mkdirSync` anywhere else walks round that, so this fails when one appears.
 * Reads the source, like keyed-fetch-guard.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const GATE_FILE = 'private-files.ts';
const MAKES_A_FOLDER = new Set(['mkdir', 'mkdirSync']);

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'fixtures' || entry.name === 'node_modules' ? [] : sourceFiles(path);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

/** `mkdirSync(`, `fs.mkdirSync(`, `promises.mkdir(`, and a name they were imported under (`import { mkdirSync as m }`). */
const directMkdirs = (file: string): string[] => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const aliases = new Set<string>();
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportSpecifier(node) && MAKES_A_FOLDER.has((node.propertyName ?? node.name).text)) aliases.add(node.name.text);
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
            if (MAKES_A_FOLDER.has(name) || aliases.has(name)) {
                found.push(`${file.slice(SRC.length + 1)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
};

describe('folders hwip makes', () => {
    it('never calls mkdir or mkdirSync outside the gate', () => {
        const direct = sourceFiles(SRC).filter((file) => !file.endsWith(`/${GATE_FILE}`)).flatMap(directMkdirs);

        expect(direct, 'use mkdirHandedBack (or ensurePrivateDir) from private-files.ts').toEqual([]);
    });

    it('does call it inside the gate (so the test is reading something)', () => {
        expect(directMkdirs(join(SRC, GATE_FILE)).length).toBeGreaterThan(0);
    });
});
