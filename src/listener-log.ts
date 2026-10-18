/** The listener's timestamped log line, and the switch that silences it for a CLI command. */

const stamp = (): string => new Date().toISOString().slice(11, 19);
/**
 * The daemon's log is stdout, which its supervisor redirects to a file. A CLI
 * command that borrows these helpers has no such redirect — `hwip forget` calls
 * `sessionExists`, and socket discovery logs from there — so the chatter would
 * land in that command's own output, and inside a `--json` line it would break
 * the parse.
 */
let logSilenced = false;
export const silenceListenerLog = (): void => {
    logSilenced = true;
};
export const log = (msg: string): void => {
    if (logSilenced) return;
    console.log(`[${stamp()}] ${msg}`);
};
