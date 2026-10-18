import { flagOn } from './args.js';
import type { HwipConfig } from './config.js';

/**
 * The listener's opt-out features: on unless a flag or the config says no. Only an absent value or
 * `true` keeps one on in the config: `"turnHistory": "false"`, `0` or `null` is someone's attempt to
 * turn it off, and reading it as "not set" uploaded the conversations anyway. `loadConfig` reads a
 * config.json it cannot use as every option off (`unreadableConfigDefaults`), so what this
 * returns is the privacy-safe set then, with the flags unable to turn anything back on. A flag is
 * read by `flagOn`: `--no-turn-history=true` and `=1` are as much a no as the bare form, and a
 * value that is neither yes nor no throws `FlagValueError`.
 */
const configKeepsOn = (value: unknown): boolean => value === undefined || value === true;

export const optionalFeatures = (
    args: Record<string, string | boolean>,
    config: Pick<HwipConfig, 'turnHistory' | 'keepAwake'>,
): { turnHistory: boolean; keepAwake: boolean } => ({
    turnHistory: !flagOn(args, 'no-turn-history') && configKeepsOn(config.turnHistory),
    keepAwake: !flagOn(args, 'no-keep-awake') && configKeepsOn(config.keepAwake),
});
