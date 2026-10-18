import { buildSync, type Metafile } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `notify` runs on every agent turn and `remote-hook` on every prompt. Neither
// touches the listener daemon, so neither may load it: what cli.ts reaches
// without an `await import()` is what every command pays for at startup.
//
// Read from a bundle's metafile rather than by running the CLI: an ESM build
// with code splitting keeps each `await import()` as its own chunk, so the
// chunks the entry imports statically are exactly the startup load.

/** Modules only the listener daemon needs — never on the hot paths. */
const DAEMON_ONLY = [/^src\/listener\.ts$/, /^src\/turn-watch\.ts$/, /^src\/lan-[^/]+\.ts$/];
const DAEMON_PACKAGES = ['ws'];
/** Only needed when a proxy variable is set; loaded by `useProxyFromEnv`, never at startup. */
const PROXY_PACKAGES = ['undici', 'https-proxy-agent'];

let dir: string;
let meta: Metafile;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hwip-lazy-'));
    meta = buildSync({
        entryPoints: [resolve(__dirname, 'cli.ts')],
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        outdir: dir,
        metafile: true,
        write: false,
        logLevel: 'silent',
    }).metafile;
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Source files and packages loaded before any dynamic import runs. */
const startupLoad = (): { files: string[]; packages: string[] } => {
    const root = resolve(__dirname, '..');
    const outputs = meta.outputs;
    const entry = Object.keys(outputs).find((o) => outputs[o].entryPoint?.endsWith('src/cli.ts'));
    if (!entry) throw new Error('no entry chunk in the metafile');
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (out: string): void => {
        if (seen.has(out)) return;
        seen.add(out);
        for (const imp of outputs[out].imports) {
            // Everything but `import()` runs at load: an import statement,
            // a require() call, a require.resolve.
            if (imp.kind === 'dynamic-import') continue;
            if (imp.external) packages.add(imp.path);
            else walk(imp.path);
        }
    };
    walk(entry);
    const files = [...seen].flatMap((out) => Object.keys(outputs[out].inputs))
        .map((input) => relative(root, resolve(process.cwd(), input)));
    return { files, packages: [...packages] };
};

describe('cli startup load', () => {
    it('leaves the listener daemon out of what every command loads', () => {
        const { files, packages } = startupLoad();

        expect(files.filter((f) => DAEMON_ONLY.some((re) => re.test(f)))).toEqual([]);
        expect(packages.filter((p) => DAEMON_PACKAGES.includes(p))).toEqual([]);
    });

    it('leaves the proxy libraries out of what every command loads', () => {
        expect(startupLoad().packages.filter((p) => PROXY_PACKAGES.includes(p))).toEqual([]);
    });

    it('keeps notify and remote-hook on the startup load, so they need no dynamic import', () => {
        const { files } = startupLoad();

        expect(files).toEqual(expect.arrayContaining(['src/hwip-hook.ts', 'src/remote-hook.ts']));
    });

    it('still reaches the listener through a dynamic import', () => {
        const all = Object.values(meta.outputs).flatMap((o) => Object.keys(o.inputs));

        expect(all.some((input) => input.endsWith('src/listener.ts'))).toBe(true);
    });
});
