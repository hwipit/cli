import { afterEach, describe, expect, it, vi } from 'vitest';

describe('listener log', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('prefixes the line with a clock stamp', async () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { log } = await import('./listener-log.js');
        log('hello');
        expect(out).toHaveBeenCalledTimes(1);
        expect(out.mock.calls[0]![0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello$/);
    });

    it('says nothing once silenced', async () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { log, silenceListenerLog } = await import('./listener-log.js');
        silenceListenerLog();
        log('hello');
        expect(out).not.toHaveBeenCalled();
    });
});
