# Contributing to @hwip/cli

Bug reports, fixes and docs improvements are welcome. For a larger change, open an
issue first so we can agree on the approach before you write it.

## Set up

You need Node.js `^20.17`, `^22.13` or `>=23.5`. CI runs the tests on 20.19, 22.13
and 24, so prefer one of those.

```bash
git clone https://github.com/hwipit/cli.git
cd cli && npm ci
```

`@hwip/mcp-server` comes from npm. To work on both at once, build a checkout of
[hwipit/mcp-server](https://github.com/hwipit/mcp-server) and `npm link` it here.

## Build and test

```bash
npm run build        # tsc: type-check and emit dist/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
```

Run `npm run build` and `npm test` before you open a pull request; CI runs both.

## Generated files

`src/hwip-core.generated.ts` and `src/fixtures/gate-vectors.json` are copied from
[hwipit/plugin](https://github.com/hwipit/plugin). Do not edit them by hand. To
regenerate, check out the plugin repository next to this one and run:

```bash
npm run sync:plugin                       # or: node scripts/sync-from-plugin.mjs --plugin <path>
node scripts/sync-from-plugin.mjs --check # fail if the files drifted from the plugin
```

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <description>`, for example `fix(listener): ...`. Releases are
  cut by semantic-release from these messages, so the type decides the version bump.
- Open pull requests against `main`.
- A DCO sign-off is not required. By contributing you agree that your work is
  licensed under the Apache License 2.0, as in [LICENSE](./LICENSE).

Report security problems privately, as described in [SECURITY.md](./SECURITY.md).
