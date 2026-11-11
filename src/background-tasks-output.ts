/**
 * The end of a background command's output, for the phone
 * (`agent.task.output.request`, handled in listener.ts).
 *
 * The phone names a task by id and never a path. The file is the one the
 * transcript said the task writes, and is read only when its real path is a
 * `tasks/<id>.output` file for that same id — a transcript line that names
 * some other file, a symlink planted where the output should be, or a hard
 * link to some other file, reads nothing.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { BackgroundTask } from './background-tasks.js';

/** How much of the end of an output the phone sees: a few screens of a log. */
export const TASK_OUTPUT_TAIL_BYTES = 16 * 1024;

/** Whether `path` names this task's own output file: `…/tasks/<id>.output`. */
export const isTaskOutputPath = (path: string, taskId: string): boolean =>
    basename(path) === `${taskId}.output` && basename(dirname(path)) === 'tasks';

export type TaskOutputTail =
    | { readonly text: string; readonly size: number; readonly truncated: boolean }
    | { readonly error: 'not_found' | 'path_refused' | 'read_failed' };

/** Where a cut from the end lands inside a UTF-8 character: skip its continuation bytes. */
const wholeCharacterStart = (bytes: Buffer): number => {
    let start = 0;
    while (start < bytes.length && start < 4 && (bytes[start]! & 0xc0) === 0x80) start++;
    return start;
};

/** Where a read ends inside a UTF-8 character a running command has not finished writing: drop that character. */
const wholeCharacterEnd = (bytes: Buffer): number => {
    for (let back = 1; back <= Math.min(4, bytes.length); back++) {
        const byte = bytes[bytes.length - back]!;
        if ((byte & 0xc0) === 0x80) continue;
        const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return width > back ? bytes.length - back : bytes.length;
    }
    return bytes.length;
};

export const readTaskOutputTail = async (task: BackgroundTask, limit = TASK_OUTPUT_TAIL_BYTES): Promise<TaskOutputTail> => {
    let real: string;
    try {
        real = await realpath(task.outputPath);
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { error: 'not_found' } : { error: 'read_failed' };
    }
    if (!isTaskOutputPath(real, task.id)) return { error: 'path_refused' };
    let checked;
    let handle;
    try {
        checked = await lstat(real);
        handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT' ? { error: 'not_found' } : code === 'ELOOP' ? { error: 'path_refused' } : { error: 'read_failed' };
    }
    try {
        const stat = await handle.stat();
        // The file opened must be the one checked (a directory on the way swapped for a symlink opens another), a plain
        // file, and have no other name: a hard link to a secret has the output's real path too.
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== checked.dev || stat.ino !== checked.ino) return { error: 'path_refused' };
        const size = stat.size;
        const length = Math.min(size, limit);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, size - length);
        const read = bytes.subarray(0, bytesRead);
        const truncated = size > length;
        const whole = read.subarray(0, wholeCharacterEnd(read));
        const text = (truncated ? whole.subarray(wholeCharacterStart(whole)) : whole).toString('utf8');
        return { text, size, truncated };
    } catch {
        return { error: 'read_failed' };
    } finally {
        await handle.close().catch(() => undefined);
    }
};

/**
 * The sealed answer's body, with `text` cut from the top until the JSON fits
 * `maxBytes`. JSON writes each ESC byte of a coloured log as `\\u001b`, six
 * bytes, so 16 KB of output can come to far more than a frame holds.
 */
export const fitTaskOutputBody = (
    head: { readonly requestId: string; readonly at: string; readonly taskId: string },
    tail: { readonly text: string; readonly size: number; readonly truncated: boolean },
    maxBytes: number,
): string => {
    let { text, truncated } = tail;
    let body = JSON.stringify({ v: 1, ...head, text, size: tail.size, truncated });
    let bytes = Buffer.byteLength(body);
    while (bytes > maxBytes && text.length > 0) {
        // Cut about the share that is over, at the next line break; one runaway line loses its first half.
        const from = Math.floor(text.length * (1 - maxBytes / bytes));
        const cut = text.indexOf('\n', from);
        let start = cut === -1 ? Math.max(from, Math.ceil(text.length / 2)) : cut + 1;
        if (/[\uDC00-\uDFFF]/.test(text.charAt(start))) start += 1;
        text = text.slice(start);
        truncated = true;
        body = JSON.stringify({ v: 1, ...head, text, size: tail.size, truncated });
        bytes = Buffer.byteLength(body);
    }
    return body;
};
