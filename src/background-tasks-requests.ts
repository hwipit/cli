/**
 * What the phone is told about a Claude session's background commands when it
 * asks (`agent.tasks.request`). The handler that admits the request and seals
 * the answer is `handleBackgroundTasksRequest` in listener.ts, beside the
 * other sealed requests; this is what it answers with.
 */
import { lsofWritersAsync, type AsyncWriterProbe, type BackgroundTask } from './background-tasks.js';

/** One row as the phone sees it. The output path stays on this machine: the phone names a task by id. */
export interface TaskRow {
    readonly id: string;
    readonly description: string | null;
    readonly startedAt: string | null;
}

/**
 * The tasks whose output some process still writes, asked once for all of
 * them. A probe that cannot answer keeps every task: not knowing is not dead.
 * The sweep's own check runs at most every 15 s; this one runs on every
 * request, so a phone opening the list never sees a task that died since.
 * Asynchronous: it runs on the main thread, which serves the socket.
 */
export const liveTaskRows = async (tasks: readonly BackgroundTask[], probe: AsyncWriterProbe = lsofWritersAsync): Promise<TaskRow[]> => {
    if (tasks.length === 0) return [];
    const open = await probe(tasks.map((t) => t.outputPath));
    return tasks
        .filter((t) => !open || open.has(t.outputPath))
        .map(({ id, description, startedAt }) => ({ id, description, startedAt }));
};
