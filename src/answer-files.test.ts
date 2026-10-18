import { describe, expect, it, vi } from 'vitest';
import { saveAnswerFiles, type DownloadSealed } from './answer-files.js';

const OPENER = { deviceId: 'dev_laptop', senderPublicKey: 'PHONE' };
const wire = (iv: string, slots: Record<string, string> = { dev_laptop: 'w' }) =>
    ({ fileKey: `files/${iv}`, fileName: 'file', fileType: 'application/octet-stream', fileSize: 16, iv, deviceKeyMap: slots });
const meta = (iv: string, name: string) => ({ iv, name, type: 'text/plain', size: 1 });

describe('saveAnswerFiles — answer files', () => {
    it('hands the listener the wire files in the seal\'s order, with the seal\'s metas', async () => {
        const download = vi.fn<DownloadSealed>(async () => ({ paths: ['/a/evt_1/a.txt', '/a/evt_1/b.txt'], missing: [] }));

        const saved = await saveAnswerFiles('evt_1', [wire('B'), wire('A')], [meta('A', 'a.txt'), meta('B', 'b.txt')], OPENER, download);

        expect(saved).toEqual({ paths: ['/a/evt_1/a.txt', '/a/evt_1/b.txt'], missing: [] });
        expect(download).toHaveBeenCalledWith('evt_1', [wire('A'), wire('B')], { ...OPENER, files: [meta('A', 'a.txt'), meta('B', 'b.txt')] });
    });

    it('reports a named file with no wire file or no slot here, and fetches no file the seal does not name', async () => {
        const download = vi.fn<DownloadSealed>(async () => ({ paths: ['/a/evt_1/a.txt'], missing: [] }));

        const saved = await saveAnswerFiles('evt_1', [wire('A'), wire('B', { dev_other: 'w' }), wire('X')], [meta('A', 'a.txt'), meta('B', 'b.txt'), meta('C', 'c.txt')], OPENER, download);

        expect(saved).toEqual({ paths: ['/a/evt_1/a.txt'], missing: ['b.txt: not delivered', 'c.txt: not delivered'] });
        expect(download.mock.calls[0]![1]).toEqual([wire('A')]);
    });

    it('keeps what the download saved and adds what it could not', async () => {
        const download = vi.fn<DownloadSealed>(async () => ({ paths: ['/a/evt_1/a.txt'], missing: ['b.txt: download 403'] }));

        const saved = await saveAnswerFiles('evt_1', [wire('A'), wire('B')], [meta('A', 'a.txt'), meta('B', 'b.txt'), meta('C', 'c.txt')], OPENER, download);

        expect(saved).toEqual({ paths: ['/a/evt_1/a.txt'], missing: ['c.txt: not delivered', 'b.txt: download 403'] });
    });

    it('reports every delivered file with the reason when the download throws as a whole, and does not throw', async () => {
        const download = vi.fn<DownloadSealed>(async () => { throw new Error('download 403'); });

        const saved = await saveAnswerFiles('evt_1', [wire('A'), wire('B')], [meta('A', 'a.txt'), meta('B', 'b.txt')], OPENER, download);

        expect(saved).toEqual({ paths: [], missing: ['a.txt: download 403', 'b.txt: download 403'] });
    });

    it('calls no download when nothing was delivered', async () => {
        const download = vi.fn<DownloadSealed>();

        expect(await saveAnswerFiles('evt_1', 'not a list', [meta('A', 'a.txt')], OPENER, download)).toEqual({ paths: [], missing: ['a.txt: not delivered'] });
        expect(download).not.toHaveBeenCalled();
    });
});
