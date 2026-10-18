/**
 * The agent's own to-do list, folded out of Claude Code's task tools.
 *
 * Claude Code does not write the list down whole: TaskCreate adds one task,
 * TaskUpdate moves one, TaskList reads them back. What the timeline wants is the
 * list as it stands, so this folds those steps into it.
 *
 * Only the *results* are read — the user entry's top-level `toolUseResult` —
 * because they carry everything at once: a created task's id comes back there and
 * nowhere in the call (measured 2026-10-09, one transcript: TaskCreate input is
 * `{subject, description, activeForm}`, its result `{task: {id, subject}}`;
 * TaskUpdate's result `{taskId, statusChange: {from, to}}`; TaskList's
 * `{tasks: [{id, subject, status}]}`). Folding results alone means a call and its
 * result landing in different reads never have to be matched up.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
    readonly id: string;
    readonly text: string;
    readonly status: TodoStatus;
}

export interface TodoList {
    readonly items: readonly TodoItem[];
}

const isTodoStatus = (value: unknown): value is TodoStatus =>
    value === 'pending' || value === 'in_progress' || value === 'completed';

// `record`, `nonBlank` and `listed` take `unknown` on purpose: they are the parse
// boundary, reading the vendor's JSON field by field.
const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined; // narrowed by the object/array check

const nonBlank = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const allDone = (list: TodoList): boolean =>
    list.items.length > 0 && list.items.every((item) => item.status === 'completed');

/** TaskCreate: one more task, pending. A finished list is replaced, not added to. */
const created = (list: TodoList | undefined, task: Record<string, unknown>): TodoList | undefined => {
    const id = nonBlank(task.id);
    const text = nonBlank(task.subject);
    if (!id || !text) return list;
    const item: TodoItem = { id, text, status: 'pending' };
    // Every task done and a new one arrives: that is the next list starting.
    if (!list || allDone(list)) return { items: [item] };
    if (list.items.some((existing) => existing.id === id)) return list;
    return { items: [...list.items, item] };
};

/** TaskUpdate: one task moved. `to` undefined = a status outside the three, which takes it off the list. */
const updated = (list: TodoList | undefined, taskId: string, to: TodoStatus | undefined): TodoList | undefined => {
    // A task this list never saw was made before the read began: nothing to move.
    const task = list?.items.find((item) => item.id === taskId);
    // Already there (or never seen): the same list, so no `todo` goes out again.
    if (!list || !task || task.status === to) return list;
    if (!to) return { items: list.items.filter((item) => item.id !== taskId) };
    return { items: list.items.map((item) => (item.id === taskId && item.status !== to ? { ...item, status: to } : item)) };
};

/**
 * TaskList: the tasks it named are refreshed and any it adds are taken, but a
 * task it leaves out stays. The one TaskList measured returned only pending and
 * in-progress tasks, so treating its answer as the whole list would drop every
 * finished one and turn 7/7 into 0/4.
 */
const listed = (list: TodoList | undefined, tasks: unknown[]): TodoList | undefined => {
    const named: TodoItem[] = [];
    for (const raw of tasks) {
        const task = record(raw);
        const id = nonBlank(task?.id);
        const text = nonBlank(task?.subject);
        if (!id || !text || !isTodoStatus(task?.status)) return list;
        named.push({ id, text, status: task.status });
    }
    if (!named.length) return list;
    const byId = new Map(named.map((item) => [item.id, item]));
    const kept = (list?.items ?? []).map((item) => byId.get(item.id) ?? item);
    const known = new Set(kept.map((item) => item.id));
    const items = [...kept, ...named.filter((item) => !known.has(item.id))];
    const same = list && items.length === list.items.length && items.every((item, i) => sameItem(item, list.items[i]));
    return same ? list : { items };
};

const sameItem = (a: TodoItem, b: TodoItem): boolean => a.id === b.id && a.text === b.text && a.status === b.status;

/**
 * The list after one transcript entry. Returns `list` itself — the same
 * reference — when the entry is not a task result, so a caller tells "changed"
 * from "not" by identity.
 */
export const applyTodoEntry = (list: TodoList | undefined, entry: Record<string, unknown>): TodoList | undefined => {
    if (entry.type !== 'user') return list;
    const result = record(entry.toolUseResult);
    if (!result) return list;
    const task = record(result.task);
    // A task that says its status (TaskGet's answer, unmeasured) is a read, not a create:
    // folded like a one-task TaskList, so it cannot restart a finished list.
    if (task && 'status' in task) return listed(list, [task]);
    if (task) return created(list, task);
    const taskId = nonBlank(result.taskId);
    const change = record(result.statusChange);
    if (taskId && change) return updated(list, taskId, isTodoStatus(change.to) ? change.to : undefined);
    if (Array.isArray(result.tasks)) return listed(list, result.tasks);
    return list;
};
