import { describe, it, expect } from 'vitest';

import { applyTodoEntry, type TodoList } from './todo-fold.js';

// The user entry Claude Code writes for a tool's result, with its top-level `toolUseResult`.
const result = (toolUseResult: unknown) => ({ type: 'user', toolUseResult });
const created = (id: string, subject: string) => result({ task: { id, subject } });
const moved = (taskId: string, from: string, to: string) =>
    result({ success: true, taskId, updatedFields: ['status'], statusChange: { from, to } });

const fold = (entries: Record<string, unknown>[], start?: TodoList) =>
    entries.reduce<TodoList | undefined>((list, entry) => applyTodoEntry(list, entry), start);

describe('applyTodoEntry', () => {
    it('folds creates and status moves into one list', () => {
        const list = fold([
            created('1', 'Read the spec'),
            created('2', 'Write the test'),
            created('3', 'Ship'),
            moved('1', 'pending', 'in_progress'),
            moved('1', 'in_progress', 'completed'),
            moved('2', 'pending', 'in_progress'),
        ]);

        expect(list?.items).toEqual([
            { id: '1', text: 'Read the spec', status: 'completed' },
            { id: '2', text: 'Write the test', status: 'in_progress' },
            { id: '3', text: 'Ship', status: 'pending' },
        ]);
    });

    it('returns the same list when the entry is not a task result', () => {
        const list = fold([created('1', 'a')]);
        const entries = [
            { type: 'assistant', message: { content: [] } },
            { type: 'user', message: { content: 'hi' } },
            result({ success: true, content: 'subagent output' }),
            result({ filePath: '/tmp/x', oldString: 'a' }),
        ];
        for (const entry of entries) expect(applyTodoEntry(list, entry)).toBe(list);
    });

    it('ignores a move for a task it never saw made', () => {
        const list = fold([created('5', 'later')]);
        expect(applyTodoEntry(list, moved('2', 'pending', 'completed'))).toBe(list);
        expect(applyTodoEntry(undefined, moved('2', 'pending', 'completed'))).toBeUndefined();
    });

    it('starts a new list when a task arrives after every task was done', () => {
        const list = fold([
            created('1', 'old'),
            moved('1', 'pending', 'completed'),
            created('2', 'next round'),
        ]);
        expect(list?.items).toEqual([{ id: '2', text: 'next round', status: 'pending' }]);
    });

    it('adds to a list that still has work left', () => {
        const list = fold([created('1', 'a'), moved('1', 'pending', 'completed'), created('2', 'b'), created('3', 'c')]);
        // 1 was done alone, so 2 started a new list; 3 joins it.
        expect(list?.items.map((item) => item.id)).toEqual(['2', '3']);
    });

    it('takes a task off the list on a status outside the three', () => {
        const list = fold([created('1', 'a'), created('2', 'b'), moved('1', 'pending', 'deleted')]);
        expect(list?.items.map((item) => item.id)).toEqual(['2']);
    });

    it('returns the same list when a move leaves the task where it was', () => {
        const list = fold([created('1', 'a'), moved('1', 'pending', 'in_progress')]);
        expect(applyTodoEntry(list, moved('1', 'in_progress', 'in_progress'))).toBe(list);
    });

    it('does not add the same task twice', () => {
        const list = fold([created('1', 'a')]);
        expect(applyTodoEntry(list, created('1', 'a'))).toBe(list);
    });

    it('skips a created task with no id or no subject', () => {
        expect(applyTodoEntry(undefined, result({ task: { id: '1' } }))).toBeUndefined();
        expect(applyTodoEntry(undefined, result({ task: { subject: 'x' } }))).toBeUndefined();
        expect(applyTodoEntry(undefined, result({ task: { id: ' ', subject: 'x' } }))).toBeUndefined();
    });

    it('keeps finished tasks a TaskList answer leaves out', () => {
        const list = fold([
            created('1', 'a'),
            created('2', 'b'),
            moved('1', 'pending', 'completed'),
            result({ tasks: [{ id: '2', subject: 'b', status: 'in_progress', blockedBy: [] }, { id: '3', subject: 'c', status: 'pending' }] }),
        ]);
        expect(list?.items).toEqual([
            { id: '1', text: 'a', status: 'completed' },
            { id: '2', text: 'b', status: 'in_progress' },
            { id: '3', text: 'c', status: 'pending' },
        ]);
    });

    it('builds a list from a TaskList answer alone', () => {
        const list = applyTodoEntry(undefined, result({ tasks: [{ id: '1', subject: 'a', status: 'pending' }] }));
        expect(list?.items).toEqual([{ id: '1', text: 'a', status: 'pending' }]);
    });

    it('returns the same list when a TaskList answer changes nothing', () => {
        const list = fold([created('1', 'a')]);
        expect(applyTodoEntry(list, result({ tasks: [{ id: '1', subject: 'a', status: 'pending' }] }))).toBe(list);
    });

    it('ignores a TaskList answer with a task it cannot read, rather than half of it', () => {
        const list = fold([created('1', 'a')]);
        const answer = result({ tasks: [{ id: '2', subject: 'b', status: 'pending' }, { id: '3', status: 'pending' }] });
        expect(applyTodoEntry(list, answer)).toBe(list);
    });

    it('ignores an empty TaskList answer', () => {
        const list = fold([created('1', 'a')]);
        expect(applyTodoEntry(list, result({ tasks: [] }))).toBe(list);
    });
    it('reads a task that says its status as a read, so it cannot restart a finished list', () => {
        const list = fold([created('1', 'a'), moved('1', 'pending', 'completed')]);
        const read = applyTodoEntry(list, result({ task: { id: '1', subject: 'a', status: 'completed' } }));
        expect(read).toBe(list);
    });
});
