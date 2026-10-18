/**
 * The path rules (design V7 ①) against the vector file the iOS app reads too: one
 * table, so the phone never builds a request this side would refuse for its spelling.
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { isViewablePath } from './file-view.js';

const VECTORS = JSON.parse(readFileSync(new URL('./file-view-paths.vectors.json', import.meta.url), 'utf8')) as Array<{
    path: string;
    ok: boolean;
    why: string;
}>;

describe('isViewablePath', () => {
    it('reads the vector file', () => {
        expect(VECTORS.length).toBe(13);
        expect(VECTORS.some((v) => v.ok)).toBe(true);
        expect(VECTORS.some((v) => !v.ok)).toBe(true);
    });

    it.each(VECTORS.map((v) => [v.why, v] as const))('%s', (_why, vector) => {
        expect(isViewablePath(vector.path)).toBe(vector.ok);
    });

    it('allows exactly 1,024 bytes and counts bytes, not characters', () => {
        expect(isViewablePath('a'.repeat(1024))).toBe(true);
        // 342 × 3 bytes = 1,026
        expect(isViewablePath('한'.repeat(341))).toBe(true);
        expect(isViewablePath('한'.repeat(342))).toBe(false);
    });

    it('refuses DEL and a newline', () => {
        expect(isViewablePath('a\u007fb')).toBe(false);
        expect(isViewablePath('a\nb')).toBe(false);
    });

    it('refuses a .git segment only as a whole segment', () => {
        expect(isViewablePath('.github/workflows/ci.yml')).toBe(true);
        expect(isViewablePath('a/.gitignore')).toBe(true);
        expect(isViewablePath('a/.Git')).toBe(false);
        expect(isViewablePath('.git')).toBe(false);
    });
});
