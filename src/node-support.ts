/**
 * The Node versions this CLI runs on: the intersection of what its runtime
 * dependencies declare in `engines` (read from `package-lock.json`, non-dev
 * packages, 2026-10-02): `@inquirer/*` `>=23.5.0 || ^22.13.0 || ^20.17.0`,
 * `mute-stream` `^20.17.0 || >=22.9.0`, `undici` 6 `>=18.17`, the MCP server
 * `>=18.17.0`, the rest lower. `package.json` `engines.node` is this string,
 * and `node-support.test.ts` recomputes the intersection from the lockfile, so
 * a dependency that raises its floor fails a test instead of leaving `engines`
 * untrue again (C80: it said `>=18` for a while after its dependencies needed 20.17).
 */
export const SUPPORTED_NODE = '^20.17.0 || ^22.13.0 || >=23.5.0';

/** The lowest supported minor of each line whose floor is not its `.0`. */
const FLOOR_MINOR: Readonly<Record<number, number>> = { 20: 17, 22: 13, 23: 5 };

/**
 * Whether a version (`v24.15.0` or `24.15.0`) is in `SUPPORTED_NODE`. Anything
 * that is not `X.Y.Z` (with an optional `-prerelease`) is not. A prerelease sorts
 * below its release, as in npm: `20.17.0-rc.1` is under the floor, `20.17.1-rc.1`
 * is over it.
 */
export const isSupportedNode = (version: string): boolean => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const prerelease = m[4] !== undefined;
  if (major >= 24) return true;
  const floor = FLOOR_MINOR[major];
  if (floor === undefined) return false;
  if (minor !== floor) return minor > floor;
  return !prerelease || patch > 0;
};
