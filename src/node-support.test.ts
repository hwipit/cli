import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSupportedNode, SUPPORTED_NODE } from './node-support.js';

const root = join(__dirname, '..');
const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf-8')) as Record<string, any>;

// C80: `engines` said `>=18` while the prompt library the CLI depends on asked
// for 20.17 / 22.13 / 23.5, so npm warned nobody and Node 18 users broke later.

describe('isSupportedNode', () => {
    it.each([
        ['v20.16.9', false], ['v20.17.0', true], ['20.19.5', true],
        ['v21.7.3', false],
        ['v22.12.0', false], ['v22.13.0', true], ['v22.22.0', true],
        ['v23.4.0', false], ['v23.5.0', true],
        ['v24.0.0', true], ['v24.15.0', true], ['v25.4.0', true],
        ['v18.20.4', false], ['v19.9.0', false],
        ['', false], ['node', false], ['v24', false], ['v24.', false], ['24.15', false],
        // A prerelease sorts below its release, as in npm.
        ['v20.17.0-rc.1', false], ['v20.17.1-rc.1', true], ['v23.5.0-pre', false], ['v24.0.0-nightly2025', true],
    ])('%s → %s', (version, expected) => {
        expect(isSupportedNode(version)).toBe(expected);
    });
});

describe('package.json engines', () => {
    it('is the supported range', () => {
        expect(read('package.json').engines.node).toBe(SUPPORTED_NODE);
    });

    // The supported range is what the runtime dependencies allow, all of them at
    // once. Recomputed from the lockfile over a grid of versions, so a dependency
    // that raises its floor — or a floor here that is higher than any dependency
    // needs — fails here instead of leaving `engines` untrue.
    describe('against the lockfile', () => {
        /** `>=X`, `^X`, partial versions (`>=6.0`), and `||` unions: the shapes `engines` is written in. */
        const accepts = (range: string, [major, minor, patch]: [number, number, number]): boolean =>
            range.split('||').some((alternative) => {
                const m = /^\s*(>=|\^)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(alternative);
                if (!m) throw new Error(`engines range not understood: "${range}"`);
                const from = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)] as const;
                const atLeast = major !== from[0] ? major > from[0] : minor !== from[1] ? minor > from[1] : patch >= from[2];
                return m[1] === '>=' ? atLeast : atLeast && major === from[0];
            });

        type Lock = Record<string, { dev?: boolean; devOptional?: boolean; engines?: { node?: string } }>;
        const runtimeRanges = (lock: Lock, prefix = '') => Object.entries(lock)
            .filter(([name, pkg]) => name !== '' && !pkg.dev && !pkg.devOptional && pkg.engines?.node)
            .map(([name, pkg]) => [prefix + name, pkg.engines!.node!] as const);
        // `hwip mcp` runs the MCP server in this process, but `file:../mcp-server` is
        // a link: its own dependencies are not in this lockfile. CI checks the
        // repos out side by side, as does a dev machine; without it the scan is
        // just the CLI's own.
        const mcpLockPath = join(root, '..', 'mcp-server', 'package-lock.json');
        const ranges = [
            ...runtimeRanges(read('package-lock.json').packages as Lock),
            ...(existsSync(mcpLockPath) ? runtimeRanges(JSON.parse(readFileSync(mcpLockPath, 'utf-8')).packages as Lock, 'mcp-server/') : []),
        ];

        const grid: [number, number, number][] = [];
        for (let major = 16; major <= 26; major++) for (let minor = 0; minor <= 40; minor++) grid.push([major, minor, 0]);

        it('reads at least the dependencies it is known to depend on', () => {
            const names = ranges.map(([name]) => name);
            expect(names).toEqual(expect.arrayContaining(['node_modules/undici', 'node_modules/ws', 'node_modules/@inquirer/prompts']));
        });

        it('accepts exactly the versions every runtime dependency accepts', () => {
            const disagree = grid
                .filter((v) => isSupportedNode(v.join('.')) !== ranges.every(([, range]) => accepts(range, v)))
                .map((v) => v.join('.'));

            expect(disagree).toEqual([]);
        });

        // `engines` is the string, the service reads the function: the two must be one answer.
        it('has a function that says what the string says', () => {
            expect(grid.filter((v) => accepts(SUPPORTED_NODE, v) !== isSupportedNode(v.join('.'))).map((v) => v.join('.'))).toEqual([]);
        });
    });
});
