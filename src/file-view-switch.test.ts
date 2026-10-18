import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askContextOffBy, setAskContext } from './ask-context-switch.js';
import { projectHash, stateDir } from './gate.js';
import {
    FILE_VIEW_LOG_LINES,
    fileViewOffBy,
    recentFileViewReads,
    runFileView,
    setFileView,
    type FileViewCommandDeps,
} from './file-view-switch.js';

let home: string;
let savedState: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwip-fv-switch-'));
    savedState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = home;
});
afterEach(() => {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
    rmSync(home, { recursive: true, force: true });
});

const A = '/work/project-a';
const B = '/work/project-b';
const NO_ENV: NodeJS.ProcessEnv = {};

describe('the file-view switch (V13)', () => {
    it('is on until someone turns it off (D10)', () => {
        expect(fileViewOffBy(A, NO_ENV)).toBeNull();
    });

    it('turns off one project and leaves the others alone, in a state file named for it', () => {
        setFileView(A, false, 'project');

        expect(existsSync(join(stateDir(), `file-view-off-${projectHash(A)}`))).toBe(true);
        expect(fileViewOffBy(A, NO_ENV)).toBe('project');
        expect(fileViewOffBy(B, NO_ENV)).toBeNull();
    });

    it('turns off every project with the global switch, and turning one project on does not undo it', () => {
        setFileView(A, false, 'global');

        expect(existsSync(join(stateDir(), 'file-view-off-default'))).toBe(true);
        expect(fileViewOffBy(B, NO_ENV)).toBe('global');
        setFileView(A, true, 'project');
        expect(fileViewOffBy(A, NO_ENV)).toBe('global');
        setFileView(A, true, 'global');
        expect(fileViewOffBy(A, NO_ENV)).toBeNull();
    });

    it('does not share its state with the ask-context switch', () => {
        setFileView(A, false, 'project');
        expect(askContextOffBy(A, NO_ENV)).toBeNull();

        setFileView(A, true, 'project');
        setAskContext(A, false, 'global');
        expect(fileViewOffBy(A, NO_ENV)).toBeNull();
    });

    it.each(['0', 'false', 'OFF', ' no '])('HWIP_FILE_VIEW=%j switches it off for the run', (value) => {
        expect(fileViewOffBy(A, { HWIP_FILE_VIEW: value })).toBe('env');
    });

    it.each(['1', 'on', '', 'yes'])('HWIP_FILE_VIEW=%j leaves it on', (value) => {
        expect(fileViewOffBy(A, { HWIP_FILE_VIEW: value })).toBeNull();
    });

    it('does not read HWIP_ASK_CONTEXT', () => {
        expect(fileViewOffBy(A, { HWIP_ASK_CONTEXT: '0' })).toBeNull();
    });

    it('counts a switch it cannot read as off, so a broken state directory does not turn it back on', () => {
        // The state directory is a file: looking inside it fails with ENOTDIR, which is not "no such file".
        writeFileSync(join(home, 'hwip'), 'not a directory');

        expect(fileViewOffBy(A, NO_ENV)).toBe('unreadable');
    });
});

const read = (n: number, path = 'a.ts') =>
    `[10:00:${String(n % 60).padStart(2, '0')}] file-view: at=2026-10-09T10:00:00.000Z device="dev_phone" session="hwip-api" op=blob path="${path}" bytes=${n} masked=0 result=ok`;
const fields = (n: number, path = 'a.ts') => read(n, path).replace(/^\[[^\]]*\] file-view: /, '');

describe('the file-view reads on record', () => {
    it('are the file-view lines of the log, without the stamp, oldest first', () => {
        const log = ['[10:00:00] listener started', read(1), '[10:00:02] ✗ diff: something', read(2, 'b.ts'), 'not a log line'].join('\n');

        expect(recentFileViewReads(log, '')).toEqual([fields(1), fields(2, 'b.ts')]);
    });

    it('are only the most recent ones, and reach into the rotated log only when the current one has too few', () => {
        const many = Array.from({ length: FILE_VIEW_LOG_LINES + 5 }, (_, i) => read(i)).join('\n');
        const reads = recentFileViewReads(many, read(999));
        expect(reads).toHaveLength(FILE_VIEW_LOG_LINES);
        expect(reads[reads.length - 1]).toBe(fields(FILE_VIEW_LOG_LINES + 4));
        expect(reads).not.toContain(fields(999));

        expect(recentFileViewReads(read(2), read(1))).toEqual([fields(1), fields(2)]);
    });

    it('do not take a line that only mentions file-view, or only starts like a read, for one', () => {
        expect(recentFileViewReads('[10:00:00] hwip file-view off was run\nfile-view: no stamp', '')).toEqual([]);
        expect(recentFileViewReads('[10:00:00] file-view: whatever a relay-chosen name made of this line', '')).toEqual([]);
        expect(recentFileViewReads('[10:00:00] file-view: at=x device="d" session="s" op=blob path="p" bytes=1 masked=0 result=ok EXTRA', '')).toEqual([]);
    });

    it('show nothing a terminal would act on, whatever the line holds', () => {
        const hostile = read(1, 'a\u001b[2J\u009b\u202e\u200b\ufeff\u{e0041}b');

        const [shown] = recentFileViewReads(hostile, '');

        expect(shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]|\u{e0041}/u);
        expect(shown).toContain('a\\u001b[2J\\u009b\\u202e\\u200b\\ufeff\\u{e0041}b');
    });
});

describe('hwip file-view', () => {
    const run = (sub: string | undefined, global = false, over: Partial<FileViewCommandDeps> = {}) => {
        const out: string[] = [];
        const err: string[] = [];
        const status = runFileView(sub, global, {
            cwd: () => `${A}/src`,
            repoRoot: () => A,
            env: NO_ENV,
            readLogs: () => ({ current: '', older: '' }),
            out: (line) => void out.push(line),
            err: (line) => void err.push(line),
            ...over,
        });
        return { status, out, err };
    };

    it('says it is on, with no subcommand or with status', () => {
        expect(run(undefined)).toEqual({ status: 0, out: ['file view: on'], err: [] });
        expect(run('status').out).toEqual(['file view: on']);
    });

    it('turns off for the project the directory is in, and says so; on undoes it', () => {
        expect(run('off')).toEqual({ status: 0, out: ['file view: off (turned off for this project)'], err: [] });
        expect(fileViewOffBy(A, NO_ENV)).toBe('project');
        expect(fileViewOffBy(B, NO_ENV)).toBeNull();
        expect(run('on').out).toEqual(['file view: on']);
        expect(fileViewOffBy(A, NO_ENV)).toBeNull();
    });

    it('turns off every project with --global, and says the global switch still holds after the project one is on', () => {
        expect(run('off', true).out).toEqual(['file view: off (turned off for every project)']);
        expect(run('on').out).toEqual(['file view: off (turned off for every project)']);
        expect(run('on', true).out).toEqual(['file view: on']);
    });

    it('says why when the environment turns it off', () => {
        expect(run('status', false, { env: { HWIP_FILE_VIEW: '0' } }).out).toEqual(['file view: off (HWIP_FILE_VIEW is set to off here; a running listener reads its own environment)']);
    });

    it('prints the recent reads with log, or that there are none and that a foreground listener would not have written any', () => {
        const none = run('log');
        expect(none.status).toBe(0);
        expect(none.out[0]).toBe('file view: no reads on record');
        expect(none.out[1]).toContain('foreground');
        const shown = run('log', false, { readLogs: () => ({ current: [read(1), read(2)].join('\n'), older: '' }) });
        expect(shown).toEqual({ status: 0, out: [fields(1), fields(2)], err: [] });
    });

    it('exits 1 and says so when the listener log is there but cannot be read, rather than "no reads"', () => {
        const result = run('log', false, { readLogs: () => { throw new Error('EACCES: permission denied, open listener.log'); } });

        expect(result.status).toBe(1);
        expect(result.out).toEqual([]);
        expect(result.err[0]).toContain('could not read the listener log: EACCES');
    });

    it('refuses --global with status or log, and a subcommand it does not know', () => {
        for (const [sub, global] of [['status', true], ['log', true], ['frobnicate', false]] as const) {
            const result = run(sub, global);
            expect(result.status).toBe(2);
            expect(result.out).toEqual([]);
            expect(result.err[0]).toContain('hwip file-view:');
        }
    });

    it('does not touch the switch when asked for a subcommand it refuses', () => {
        run('frobnicate');
        expect(existsSync(join(stateDir(), `file-view-off-${projectHash(A)}`))).toBe(false);
    });

    it('reports a switch it cannot write, and exits 1', () => {
        writeFileSync(join(home, 'hwip'), 'not a directory');

        const result = run('off');

        expect(result.status).toBe(1);
        expect(result.err[0]).toContain('could not change the switch');
    });
});
