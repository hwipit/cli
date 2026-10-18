import { describe, expect, it } from 'vitest';
import { createByteBudget, FILE_VIEW_WINDOW_BYTES, FILE_VIEW_WINDOW_MS } from './file-view-budget.js';

describe('the file-view byte budget (D6)', () => {
    it('is 32 MiB in 10 minutes', () => {
        expect(FILE_VIEW_WINDOW_BYTES).toBe(32 * 1024 * 1024);
        expect(FILE_VIEW_WINDOW_MS).toBe(10 * 60_000);
    });

    it('is spent once a key has read its share, and only that key', () => {
        const budget = createByteBudget(100, 1000);
        budget.charge('a', 99, 0);
        expect(budget.spent('a', 1)).toBe(false);
        budget.charge('a', 1, 2);
        expect(budget.spent('a', 3)).toBe(true);
        expect(budget.spent('b', 3)).toBe(false);
    });

    it('opens again when the window that began at the first byte has run out', () => {
        const budget = createByteBudget(100, 1000);
        budget.charge('a', 100, 500);
        expect(budget.spent('a', 1499)).toBe(true);
        expect(budget.spent('a', 1500)).toBe(false);
        budget.charge('a', 10, 1500);
        expect(budget.spent('a', 1501)).toBe(false);
    });

    it('does not keep a window for a key that has read nothing recently', () => {
        const budget = createByteBudget(100, 1000);
        budget.charge('a', 100, 0);
        // Looking at any key after the window closed drops it; a charge of nothing opens none.
        budget.charge('b', 0, 5000);
        expect(budget.spent('a', 5000)).toBe(false);
        budget.charge('a', 50, 5000);
        expect(budget.spent('a', 5001)).toBe(false);
    });
});
