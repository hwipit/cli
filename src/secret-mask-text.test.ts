import { describe, expect, it } from 'vitest';
import { maskText } from './secret-mask.js';

// `maskSecrets` reads a patch: it takes the first character of each line for a diff marker and leaves the lines
// after `diff --git`. `maskText` is for prose, where a token can stand at the head of a line.
const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SK = `sk-${'abcDEF123456'.repeat(3)}`;

describe('maskText', () => {
    it('hides a token at the head of a line, which a diff marker would have eaten', () => {
        const r = maskText(`${GH}\n${SK} is the other one`);

        expect(r.text).toBe('***\n*** is the other one');
        expect(r.masked).toBe(2);
    });

    it('hides a token in the middle of a sentence and keeps the rest', () => {
        const r = maskText(`use ${GH} to push, then stop`);

        expect(r).toEqual({ text: 'use *** to push, then stop', masked: 1 });
    });

    it('hides a secret-named assignment value on any line of a multi-line text', () => {
        const r = maskText('first line\npassword=hunter2hunter2\nlast line');

        expect(r.text).toBe('first line\npassword=***\nlast line');
        expect(r.masked).toBe(1);
    });

    it('hides a private key block across lines, as the diff view does', () => {
        const r = maskText('here:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\ndone');

        expect(r.text).not.toContain('MIIEvQ');
        expect(r.text.startsWith('here:')).toBe(true);
        expect(r.text.endsWith('done')).toBe(true);
        expect(r.masked).toBeGreaterThan(0);
    });

    it('leaves text with nothing secret-looking as it is, and counts nothing', () => {
        const text = 'run `npm test`\n\nthen read process.env.API_TOKEN and token = process.env.X';

        expect(maskText(text)).toEqual({ text, masked: 0 });
    });

    it('masks a line too long to scan whole, like the diff view', () => {
        const r = maskText(`short\n${'x'.repeat(9000)}`);

        expect(r).toEqual({ text: 'short\n***', masked: 1 });
    });

    it('does not tell the length of the line it hid', () => {
        expect(maskText(`a ${GH} b`).text).toBe(maskText(`a ${GH}${'Z'.repeat(50)} b`).text);
    });
});
