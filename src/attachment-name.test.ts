import { describe, expect, it } from 'vitest';
import { fitAttachmentName, MAX_ATTACHMENT_NAME_BYTES } from './attachment-name.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('fitAttachmentName', () => {
    it('keeps an ordinary name as it is', () => {
        expect(fitAttachmentName('shot.png', 'file-0')).toBe('shot.png');
        expect(fitAttachmentName('사진.png', 'file-0')).toBe('사진.png');
    });

    it('strips directories, control characters, separators and leading dots', () => {
        expect(fitAttachmentName('../../etc/passwd', 'f')).toBe('passwd');
        expect(fitAttachmentName('.hidden', 'f')).toBe('hidden');
        expect(fitAttachmentName('a\x00b', 'f')).toBe('ab');
        expect(fitAttachmentName('...', 'f')).toBe('f');
        expect(fitAttachmentName('', 'f')).toBe('f');
    });

    it('fits a hundred Korean characters to the byte limit, with the extension', () => {
        const out = fitAttachmentName('가'.repeat(100) + '.png', 'f');
        expect(bytes(out)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
        expect(out).toBe('가'.repeat(65) + '.png');
    });

    it('never splits a code point', () => {
        const out = fitAttachmentName('😀'.repeat(80) + '.txt', 'f');
        expect(bytes(out)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
        expect(out).toBe('😀'.repeat(49) + '.txt');
    });

    it('cuts an extension too long to be one like the rest of the name', () => {
        const out = fitAttachmentName('a.' + 'x'.repeat(300), 'f');
        expect(bytes(out)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
    });
});
