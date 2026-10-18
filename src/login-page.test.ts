import { describe, expect, it } from 'vitest';
import { PAGE_PALETTE, errorPage, okPage, renderPage } from './login-page.js';

// The browser lands here from the web console's connect screen, so the page
// speaks the console's language (hwip design/tokens.json): warm paper
// background, a card, Pretendard, the persimmon mark. It is served by a
// loopback server with no network, so it must be one self-contained document.

const luminance = (hex: string): number => {
    const channel = (offset: number): number => {
        const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
};

describe('login callback page', () => {
    it('confirms the connection and points back to the terminal', () => {
        const html = okPage();
        expect(html).toContain('<title>Hwip · You\'re connected</title>');
        expect(html).toContain('<h1>You\'re connected</h1>');
        expect(html).toContain('Close this tab and head back to your terminal.');
        expect(html).toContain('hwip is ready');
    });

    it.each([
        ['state mismatch', "Sign-in didn't match", "This link didn't match the request that started it. Return to your terminal and run login again."],
        ['missing key', 'No key came back', 'The sign-in finished without a key. Return to your terminal and run login again.'],
        ['not found', 'Nothing to see here', 'This page only handles the Hwip login callback.'],
    ])('keeps the %s wording', (reason, title, message) => {
        const html = errorPage(reason);
        expect(html).toContain(`<h1>${title}</h1>`);
        expect(html).toContain(`<p>${message}</p>`);
        expect(html).toContain('class="status error"');
    });

    it('escapes an unknown reason instead of echoing markup', () => {
        const html = errorPage('<img src=x onerror=alert(1)>');
        expect(html).toContain('Something went wrong');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
    });

    it('is one self-contained document: nothing to fetch, nothing to run', () => {
        for (const html of [okPage(), errorPage('state mismatch')]) {
            expect(html).toMatch(/^<!doctype html><html lang="en">/);
            expect(html).not.toMatch(/https?:|\/\/[\w-]+\./i);
            expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|http-equiv|<base|@import|url\(|image-set\(|src=|href=|srcdoc|data=/i);
        }
    });

    it('follows the system light / dark setting', () => {
        const html = okPage();
        expect(html).toContain('color-scheme:light dark');
        expect(html).toContain('@media (prefers-color-scheme:dark)');
    });

    // Written out here on purpose: the table must keep matching hwip
    // design/tokens.json (011525e), and this is the second copy that notices an edit.
    it('uses the console colours from design/tokens.json', () => {
        expect(PAGE_PALETTE.light).toEqual({
            grouped: '#F3EEE6', card: '#FFFDF9', raised: '#F1ECE3', ink: '#1E1D1B', muted: '#6B665E',
            danger: '#B3261E', separator: '#E6DFD3', logo: '#1E1D1B',
        });
        expect(PAGE_PALETTE.dark).toEqual({
            grouped: '#100F0D', card: '#221F1C', raised: '#2C2925', ink: '#F2F1EE', muted: '#A9A39A',
            danger: '#F2A8A0', separator: '#36322D', logo: '#E9E4DA',
        });
    });

    it('puts the light colours in :root and the dark ones only under the dark media query', () => {
        const css = okPage().match(/<style>([\s\S]*)<\/style>/)![1]!;
        const [light, dark] = css.split('@media (prefers-color-scheme:dark)') as [string, string];
        for (const colour of Object.values(PAGE_PALETTE.light)) expect(light.toLowerCase()).toContain(colour.toLowerCase());
        for (const colour of Object.values(PAGE_PALETTE.dark)) {
            expect(dark.toLowerCase()).toContain(colour.toLowerCase());
            if (!Object.values(PAGE_PALETTE.light).includes(colour as never)) expect(light.toLowerCase()).not.toContain(colour.toLowerCase());
        }
    });

    it.each(['light', 'dark'] as const)('keeps every text colour readable on its surface (%s)', (scheme) => {
        const p = PAGE_PALETTE[scheme];
        // The rules design/tokens.json "contrast" holds the console to.
        for (const surface of [p.card, p.raised, p.grouped]) {
            expect(contrast(p.ink, surface)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(p.muted, surface)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(p.danger, p.card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.danger, p.raised)).toBeGreaterThanOrEqual(4.5);
        // The lockup: wordmark ink, and the kit's persimmon dot (#D9623B) in both schemes.
        expect(contrast(p.logo, p.grouped)).toBeGreaterThanOrEqual(4.5);
        expect(contrast('#D9623B', p.grouped)).toBeGreaterThanOrEqual(3);
    });

    it('marks the two states by shape, not by colour alone', () => {
        const ok = renderPage('ok', 'T', 'M');
        const error = renderPage('error', 'T', 'M');
        expect(ok).toContain('class="status ok"');
        expect(error).toContain('class="status error"');
        expect(ok).toContain('M14 25l7 7 13-14');
        expect(error).toContain('M24 14v13');
        expect(ok).not.toContain('M24 14v13');
    });

    it('labels its landmarks and hides the decorative drawings', () => {
        const html = okPage();
        expect(html).toContain('<main class="card">');
        expect((html.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(html).toContain('<title>');
    });
});
