// The page the browser lands on after `hwip login`, served from the loopback
// callback server (login.ts). The user arrives from the web console's connect
// screen, so it speaks the console's language — warm paper background, one
// card, the logo lockup, Pretendard when installed — with the colours copied
// from hwip `design/tokens.json` (color.grouped · card · raised · ink · muted ·
// danger · separator, light and dark). The server has no network, so this is
// one self-contained document: inline styles, inline SVG, no script, no font
// or image fetch (the console loads Pretendard from a CDN; here the same
// stack falls back to the system face). It is on screen for a few seconds
// before the user returns to the terminal, so its job is to confirm state and
// point back.

/** design/tokens.json colours this page uses, as of hwip 011525e. `logo` is the lockup wordmark ink (kit `lockup-horizontal[-on-dark].svg`). */
export const PAGE_PALETTE = {
  light: {
    grouped: '#F3EEE6', card: '#FFFDF9', raised: '#F1ECE3', ink: '#1E1D1B', muted: '#6B665E',
    danger: '#B3261E', separator: '#E6DFD3', logo: '#1E1D1B',
  },
  dark: {
    grouped: '#100F0D', card: '#221F1C', raised: '#2C2925', ink: '#F2F1EE', muted: '#A9A39A',
    danger: '#F2A8A0', separator: '#36322D', logo: '#E9E4DA',
  },
} as const;

type PageVariant = 'ok' | 'error';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ));

const schemeVars = (p: typeof PAGE_PALETTE[keyof typeof PAGE_PALETTE]): string =>
  `--grouped:${p.grouped};--card:${p.card};--raised:${p.raised};--ink:${p.ink};--muted:${p.muted};` +
  `--danger:${p.danger};--separator:${p.separator};--logo:${p.logo}`;

const PAGE_STYLE = `*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light dark;${schemeVars(PAGE_PALETTE.light)};--shadow:0 3px 14px rgb(30 29 27/.05);--edge:transparent;
--font:Pretendard Variable,Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo",sans-serif}
@media (prefers-color-scheme:dark){:root{${schemeVars(PAGE_PALETTE.dark)};--shadow:none;--edge:var(--separator)}}
body{margin:0;background:var(--grouped);color:var(--ink);font:400 15px/1.5 var(--font)}
.center{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px 16px}
.lockup{width:120px;height:auto;color:var(--logo)}
.card{width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px;padding:24px;background:var(--card);
border:1px solid var(--edge);border-radius:24px;box-shadow:var(--shadow)}
.status{width:40px;height:40px;border-radius:999px;background:var(--raised);color:var(--ink);display:grid;place-items:center}
.status.error{color:var(--danger)}
.status svg{width:40px;height:40px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:20px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
p{margin:0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.chip{align-self:flex-start;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--ink);
background:var(--raised);border-radius:12px;padding:6px 10px}`;

// Drawn in a 48×48 box inside the 40px disc: a check, or an exclamation
// (the `h.01` path renders as a dot through the round line cap).
const GLYPH: Record<PageVariant, string> = {
  ok: '<path d="M14 25l7 7 13-14"/>',
  error: '<path d="M24 14v13"/><path d="M24 34h.01"/>',
};

// The kit's horizontal lockup (`design/logo/kit/svg/lockup-horizontal.svg`)
// with the ink as `currentColor`, so one drawing serves light and dark; the
// persimmon dot is the kit's in both.
const LOCKUP =
  '<svg class="lockup" viewBox="0 0 506 256" aria-hidden="true"><g transform="translate(0 8) scale(0.94)">' +
  '<g transform="translate(5.1 42.4) scale(0.917)"><g transform="translate(0 -12)">' +
  '<path fill="currentColor" fill-rule="evenodd" d="M14 122 C22 104 56 94 96 92 C130 90 152 90 166 86 C170 80 178 80 184 86 C196 82 206 72 212 60 C210 44 214 26 222 12 C230 26 232 42 228 56 C238 46 248 40 254 38 C250 54 238 68 222 78 C204 100 184 120 156 134 C126 148 84 158 50 152 C32 148 16 138 14 122 Z M30 136 C50 146 74 152 100 154 C74 150 50 144 30 134 Z M38 146 C56 152 74 156 94 158 C74 154 56 150 38 144 Z"/>' +
  '<path fill="currentColor" transform="matrix(0.6587 -0.1926 -0.1926 0.8913 58.93 33.26)" d="M82 144 C112 150 150 170 180 192 C194 202 204 212 214 222 C202 216 188 210 172 202 C140 188 110 172 94 160 C88 156 84 150 82 144 Z"/>' +
  '<circle fill="#D9623B" cx="100" cy="56" r="17"/></g></g></g>' +
  '<g transform="translate(262 60) scale(0.62)">' +
  '<path d="M0 190 V30 M0 190 V136 A36 36 0 0 1 72 136 V190 M102 96 L128 190 L154 104 L180 190 L206 96 M232 96 V190 M262 96 V238 M262 143 A47 47 0 1 1 356 143 A47 47 0 1 1 262 143" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle cx="232" cy="56" r="9.8" fill="currentColor"/></g></svg>';

export const renderPage = (
  variant: PageVariant,
  title: string,
  message: string,
  hint?: string,
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Hwip · ${esc(title)}</title><style>${PAGE_STYLE}</style></head>` +
  `<body><div class="center">${LOCKUP}<main class="card">` +
  `<span class="status ${variant}" aria-hidden="true"><svg viewBox="0 0 48 48">${GLYPH[variant]}</svg></span>` +
  `<h1>${esc(title)}</h1><p>${esc(message)}</p>` +
  (hint ? `<code class="chip">${esc(hint)}</code>` : '') +
  `</main></div></body></html>`;

export const okPage = (): string =>
  renderPage('ok', "You're connected", 'Close this tab and head back to your terminal.', 'hwip is ready');

// Turn an internal callback failure reason into end-user guidance: name what
// happened and how to recover, in the interface's voice — never an apology.
export const errorPage = (reason: string): string => {
  const copy: Record<string, [string, string]> = {
    'state mismatch': [
      "Sign-in didn't match",
      "This link didn't match the request that started it. Return to your terminal and run login again.",
    ],
    'missing key': [
      'No key came back',
      'The sign-in finished without a key. Return to your terminal and run login again.',
    ],
    'not found': [
      'Nothing to see here',
      'This page only handles the Hwip login callback.',
    ],
  };
  const [title, message] = copy[reason] ?? ['Something went wrong', reason];
  return renderPage('error', title, message);
};
