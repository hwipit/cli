import { describe, expect, it } from 'vitest';
import { maskSecrets } from './secret-mask.js';

/** A one-hunk patch whose changed lines are `body`. */
const patch = (...body: string[]): string =>
    ['diff --git a/f.ts b/f.ts', 'index 111..222 100644', '--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,2 @@', ...body].join('\n') + '\n';

const maskedLine = (line: string): { out: string; masked: number } => {
    const r = maskSecrets(patch(line));
    return { out: r.text.split('\n')[5], masked: r.masked };
};

describe('maskSecrets — what is hidden', () => {
    const cases: Array<[string, string, string]> = [
        ['AWS access key id', '+const k = "AKIAIOSFODNN7EXAMPLE";', '+const k = "***";'],
        ['GitHub token', '+gh = ghp_abcdefghijklmnopqrstuvwxyz0123456789', '+gh = ***'],
        ['GitHub fine-grained token', ' x github_pat_11ABCDEFG0abcdefghijklmnop_qrstuv', ' x ***'],
        ['sk- API key', '-key sk-ant-api03-abcdefghijklmnopqrstuv', '-key ***'],
        ['Slack token', '+t = xoxb-1234567890-abcdefghij', '+t = ***'],
        ['JWT', '+auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36', '+auth ***'],
        ['bearer token', '+  Authorization: `Bearer abcdefghijklmnop1234`', '+  Authorization: `***`'],
        ['hwip api key', '+HWIP=ak_abcd1234efgh', '+HWIP=ak_***'],
        ['secret-named assignment', '+  password: "correct-horse-battery"', '+  password: "***"'],
        ['env-style assignment', '+API_KEY=0123456789abcdef', '+API_KEY=***'],
        ['json key', '+  "client_secret": "abcdefghijkl",', '+  "client_secret": "***",'],
        ['credential in a longer name', '+const dbCredentialValue = "supersecretvalue"', '+const dbCredentialValue = "***"'],
    ];
    for (const [name, input, expected] of cases) {
        it(`hides a ${name}`, () => {
            expect(maskedLine(input)).toEqual({ out: expected, masked: 1 });
        });
    }

    it('counts every spot on a line', () => {
        const r = maskedLine('+a=AKIAIOSFODNN7EXAMPLE b=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
        expect(r.masked).toBe(2);
    });

    it('hides the body of a PEM private key block across lines and counts the block once', () => {
        const r = maskSecrets(patch(
            '+-----BEGIN RSA PRIVATE KEY-----',
            '+MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx',
            ' yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
            '+-----END RSA PRIVATE KEY-----',
            '+after = 1',
        ));
        const lines = r.text.split('\n');
        expect(lines.slice(5, 10)).toEqual([
            '+-----BEGIN RSA PRIVATE KEY-----',
            '+***',
            ' ***',
            '+-----END RSA PRIVATE KEY-----',
            '+after = 1',
        ]);
        expect(r.masked).toBe(1);
        expect(r.text).not.toContain('MIIEow');
    });

    it('hides a key whose begin and end share a line', () => {
        const r = maskedLine('+const k = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----";');
        expect(r.out).toBe('+const k = "-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----";');
        expect(r.masked).toBe(1);
    });
});

describe('maskSecrets — what is left alone', () => {
    const untouched = [
        '+const tokenCount = 3;',
        '+  password: string;',
        '+  token: "short"',
        '+// the secret sauce is refreshed hourly',
        '+const secret = process.env.APP_SECRET_VALUE;',
        '+TOKEN=$HWIP_TOKEN_FROM_VAULT',
        '+const apiKeyLabel = "key";',
        '+const tokenizer = createTokenizer(config);',
        '+accessToken = response.data.token;',
        '+tokenType = TokenType.Bearer;',
        '+sk-short',
        ' context line with nothing in it',
        '-removed line',
    ];
    for (const line of untouched) {
        it(`leaves ${JSON.stringify(line)}`, () => {
            expect(maskedLine(line)).toEqual({ out: line, masked: 0 });
        });
    }
});

describe('maskSecrets — the patch keeps its shape', () => {
    const noisy = patch(
        '+password: "hunter2hunter2"',
        ' unchanged',
        '-token = "abcdefghijkl"',
        '\\ No newline at end of file',
    );

    it('keeps the line count and each line\'s diff marker', () => {
        const before = noisy.split('\n');
        const after = maskSecrets(noisy).text.split('\n');
        expect(after).toHaveLength(before.length);
        after.forEach((line, i) => expect(line.slice(0, 1)).toBe(before[i].slice(0, 1)));
    });

    it('does not touch headers, even ones that look like secrets', () => {
        const headers = [
            'diff --git a/password: abcdefghijkl b/password: abcdefghijkl',
            'index 1234567..89abcde 100644',
            '--- a/token = abcdefghijkl',
            '+++ b/token = abcdefghijkl',
        ];
        const text = headers.join('\n') + '\n+x = 1\n';
        expect(maskSecrets(text)).toEqual({ text, masked: 0 });
    });

    it('masks the context line git copies into a hunk header, and nothing else in it', () => {
        const first = maskSecrets('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -4,4 +4,4 @@ API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n+x = 1\n');
        expect(first.text).toContain('@@ -4,4 +4,4 @@ API_KEY=***\n');
        expect(first.text).not.toContain('sk-abcdef');
        expect(first.masked).toBeGreaterThan(0);
        const later = maskSecrets(patch('+a', '@@ -9,1 +9,1 @@ const password = "abcdefghijkl"', '+b'));
        expect(later.text).toContain('@@ -9,1 +9,1 @@ const password = "***"');
        expect(later.masked).toBe(1);
        // A header with no context, or a long one, keeps its range and shape.
        expect(maskSecrets(patch('@@ -1,2 +1,2 @@', '+x')).text).toContain('@@ -1,2 +1,2 @@\n');
        const long = maskSecrets(patch('@@ -1 +1 @@ ' + 'a'.repeat(10_000), '+x'));
        expect(long.text.split('\n').find((l) => l.startsWith('@@ -1 +1'))).toBe('@@ -1 +1 @@ ***');
    });

    it('treats a "+++ " content line inside a hunk as content', () => {
        const r = maskSecrets(patch('++++ password = "abcdefghijkl"'));
        expect(r.text).toContain('++++ password = "***"');
    });

    it('is idempotent', () => {
        const once = maskSecrets(noisy);
        expect(maskSecrets(once.text)).toEqual({ text: once.text, masked: 0 });
    });

    it('resets key-block state at the next file', () => {
        const text = patch('+-----BEGIN PRIVATE KEY-----', '+AAAA') +
            patch('+const visible = "plain text here"');
        expect(maskSecrets(text).text).toContain('const visible = "plain text here"');
    });

    it('returns an empty patch unchanged', () => {
        expect(maskSecrets('')).toEqual({ text: '', masked: 0 });
    });
});

describe('maskSecrets — key blocks', () => {
    it('keeps the line count when a block never closes inside the patch', () => {
        const text = patch('+-----BEGIN PRIVATE KEY-----', '+AAAABBBBCCCCDDDD', '+later = 2');
        const r = maskSecrets(text);
        expect(r.text.split('\n')).toHaveLength(text.split('\n').length);
        expect(r.text.endsWith('\n')).toBe(true);
        expect(r.text).toContain('+later = 2');
    });

    it('is not opened by a marker that sits inside code', () => {
        const r = maskSecrets(
            patch(
                '+if (s.startsWith("-----BEGIN PRIVATE KEY-----")) {',
                '+    return parse(s);',
                '+}',
                '@@ -40,2 +41,2 @@',
                ' const kept = 1;',
            ),
        );
        expect(r.masked).toBe(0);
        expect(r.text).toContain('+    return parse(s);');
        expect(r.text).toContain(' const kept = 1;');
    });

    it('stops hiding at the next hunk and at the first line that is not key material', () => {
        const r = maskSecrets(
            patch('+-----BEGIN PRIVATE KEY-----', '+MIIEvQIBADANBgkqhkiG', '+  const visible = 1;', '@@ -9,1 +9,1 @@', '+AAAABBBBCCCCDDDD'),
        );
        expect(r.text).toContain('+  const visible = 1;');
        expect(r.text).toContain('+AAAABBBBCCCCDDDD');
        expect(r.text).not.toContain('MIIEvQ');
    });

    it('hides armor headers inside the block', () => {
        const r = maskSecrets(patch('+-----BEGIN RSA PRIVATE KEY-----', '+Proc-Type: 4,ENCRYPTED', '+DEK-Info: AES-128-CBC,ABCDEF', '+', '+-----END RSA PRIVATE KEY-----'));
        expect(r.text).not.toContain('DEK-Info');
    });

    it('keeps hiding past the blank line an encrypted key puts between its headers and its body', () => {
        for (const marker of ['+', ' ']) {
            const r = maskSecrets(
                patch(
                    '+-----BEGIN RSA PRIVATE KEY-----',
                    '+Proc-Type: 4,ENCRYPTED',
                    '+DEK-Info: AES-128-CBC,0123456789ABCDEF',
                    marker,
                    '+MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
                    '+VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
                    '+-----END RSA PRIVATE KEY-----',
                    '+const after = 1;',
                ),
            );
            expect(r.text).not.toContain('MIIEow');
            expect(r.text).not.toContain('VTLw7o');
            expect(r.text).not.toContain('0123456789ABCDEF');
            expect(r.text).toContain('+const after = 1;');
            expect(r.masked).toBe(1);
        }
    });

    it('still stops at the first line that is not key material after a blank line', () => {
        const r = maskSecrets(patch('+-----BEGIN RSA PRIVATE KEY-----', '+Proc-Type: 4,ENCRYPTED', '+', '+  const visible = 1;'));
        expect(r.text).toContain('+  const visible = 1;');
    });
});

describe('maskSecrets — key blocks that open mid-line', () => {
    const body = ['+MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '+KcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', '+-----END PRIVATE KEY-----"'];
    const shapes: Array<[string, string, string[]]> = [
        ['an assignment with an opening quote', '+private_key = "-----BEGIN RSA PRIVATE KEY-----', body],
        ['an .env line', '+PRIVATE_KEY=-----BEGIN PRIVATE KEY-----', body],
        ['a commented-out key', '+# -----BEGIN PRIVATE KEY-----', ['+# MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '+# KcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', '+# -----END PRIVATE KEY-----']],
        ['a JSON string with escaped newlines', '+  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', body],
    ];
    for (const [name, first, rest] of shapes) {
        it(`hides the body under ${name}`, () => {
            const r = maskSecrets(patch(first, ...rest));
            expect(r.masked).toBe(1);
            expect(r.text).not.toContain('MIIEvQ');
            expect(r.text).not.toContain('KcwggSj');
            expect(r.text.split('\n')).toHaveLength(patch(first, ...rest).split('\n').length);
        });
    }

    it('hides a key body spread over concatenated string literals', () => {
        const first = '+const k = "-----BEGIN PRIVATE KEY-----\\n" +';
        const rest = ['+  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n" +', '+  "KcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\\n" +', '+  "-----END PRIVATE KEY-----";'];
        const r = maskSecrets(patch(first, ...rest));
        expect(r.text).not.toContain('MIIEvQ');
        expect(r.text).not.toContain('KcwggSj');
        expect(r.text).toContain('"-----BEGIN PRIVATE KEY-----\\n" +');
    });

    it('hides a key body listed as array elements', () => {
        const r = maskSecrets(patch('+  "-----BEGIN PRIVATE KEY-----",', '+  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",', '+  "-----END PRIVATE KEY-----",'));
        expect(r.text).not.toContain('MIIEvQ');
    });

    it('hides a key body written as one very long base64 line', () => {
        const r = maskSecrets(patch('+-----BEGIN PRIVATE KEY-----', '+' + 'A'.repeat(300), '+-----END PRIVATE KEY-----'));
        expect(r.text).not.toContain('AAAAAAAAAA');
    });
});

describe('maskSecrets — more than one thing on a line', () => {
    const ghp = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

    it('hides every key block on a line and still reads the rest of it', () => {
        const line =
            `+a = "-----BEGIN PRIVATE KEY-----AAAA1111-----END PRIVATE KEY-----"; b = "-----BEGIN PRIVATE KEY-----BBBB2222-----END PRIVATE KEY-----"; t = ${ghp}`;
        const r = maskSecrets(patch(line));
        expect(r.text).not.toContain('AAAA1111');
        expect(r.text).not.toContain('BBBB2222');
        expect(r.text).not.toContain(ghp);
        expect(r.masked).toBe(3);
    });

    it('reads a line that ends one key block and starts the next', () => {
        const r = maskSecrets(
            patch('+-----BEGIN PRIVATE KEY-----', '+AAAA1111AAAA1111', `+-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----`, '+BBBB2222BBBB2222', '+-----END PRIVATE KEY-----'),
        );
        expect(r.text).not.toContain('AAAA1111');
        expect(r.text).not.toContain('BBBB2222');
        expect(r.text.split('\n')).toHaveLength(patch('+', '+', '+', '+', '+').split('\n').length);
    });

    it('reads what follows the end of a block on the same line', () => {
        const r = maskSecrets(patch('+-----BEGIN PRIVATE KEY-----', '+AAAA1111AAAA1111', `+-----END PRIVATE KEY----- ${ghp}`));
        expect(r.text).not.toContain(ghp);
        expect(r.text).not.toContain('AAAA1111');
    });

    it('hides a block that opens after an end marker on the same line', () => {
        const r = maskSecrets(patch('+-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----', '+MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
        expect(r.text).not.toContain('MIIEvQ');
    });

    it('opens a block at a line-ending marker that follows one inside code', () => {
        const r = maskSecrets(patch('+x("-----BEGIN PRIVATE KEY-----"); y = "-----BEGIN PRIVATE KEY-----', '+MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
        expect(r.text).not.toContain('MIIEvQ');
        expect(r.masked).toBe(1);
    });

    it('keeps a marker inside code from hiding the token beside it', () => {
        const r = maskSecrets(patch(`+if (s.startsWith("-----BEGIN PRIVATE KEY-----")) { t = "${ghp}" }`));
        expect(r.text).not.toContain(ghp);
        expect(r.text).toContain('-----BEGIN PRIVATE KEY-----');
    });
});

describe('maskSecrets — values that are not code', () => {
    for (const line of ['+token=ya29.a0AfH6SMBxxxxxxxxxxxxxxxx', '+password: hunter2.0abcdef']) {
        it(`hides ${JSON.stringify(line)}`, () => {
            expect(maskedLine(line).masked).toBe(1);
        });
    }
});

describe('maskSecrets — hostile lines', () => {
    // Patterns retried from every start of a long run are quadratic; a repo can
    // hold such a line and the scan runs on the listener's event loop.
    const probes: Array<[string, string]> = [
        ['repeated keyword', 'token'.repeat(40_000)],
        ['jwt prefix run', '-eyJ'.repeat(50_000)],
        ['prefix run without separator', 'ghp_'.repeat(50_000)],
        ['url scheme run', 'a://'.repeat(50_000)],
        ['spaces after keyword', 'password' + ' '.repeat(200_000)],
        ['key marker run', '-----BEGIN PRIVATE KEY-----'.repeat(10_000)],
    ];
    for (const [name, line] of probes) {
        it(`scans a 200 KB line of ${name} in well under a second`, () => {
            const started = Date.now();
            const r = maskSecrets(patch('+' + line));
            expect(Date.now() - started).toBeLessThan(1000);
            expect(r.text.split('\n')).toHaveLength(patch('+x').split('\n').length);
        });
    }

    // Inside a key block the body-line check runs on every line, long or not.
    for (const [name, line] of [['whitespace then punctuation', ' '.repeat(200_000) + '!'], ['whitespace only, 8000 characters', ' '.repeat(8000) + '!'], ['base64 then punctuation', 'A'.repeat(8000) + '!']] as const) {
        it(`scans a line of ${name} after a key marker quickly`, () => {
            const started = Date.now();
            const r = maskSecrets(patch('+-----BEGIN PRIVATE KEY-----', '+' + line, '+tail'));
            expect(Date.now() - started).toBeLessThan(1000);
            expect(r.text.split('\n')).toHaveLength(patch('+x', '+x', '+x').split('\n').length);
        });
    }

    // Just under the cap the patterns do run: their own bounds keep them cheap.
    for (const [name, unit] of [['keyword', 'token'], ['jwt prefix', '-eyJ'], ['url scheme', 'a://'], ['equals', 'password=']] as const) {
        it(`scans an 8000-character line of repeated ${name} quickly`, () => {
            const line = unit.repeat(Math.floor(8000 / unit.length));
            const started = Date.now();
            maskSecrets(patch('+' + line));
            expect(Date.now() - started).toBeLessThan(500);
        });
    }

    it('reads 8 MiB of lines thick with key markers in one pass', () => {
        // Each BEGIN used to look for its END again from itself: quadratic in the markers of a
        // line. The test pins the shape of the work, not a wall-clock cap (an absolute one trips
        // whenever another build or test suite runs on the same box): 4x the input costs about
        // 4x the time when the scan is linear and about 16x when it is quadratic. Each size is
        // timed three times and the fastest run taken, to drop scheduler noise from the ratio.
        const marker = '-----BEGIN PRIVATE KEY-----';
        const batch = (k: number) =>
            patch(...Array.from({ length: 1000 }, () => '+' + marker.repeat(Math.floor(8000 / marker.length) * k)));
        const fastest = (k: number) => {
            let best = Infinity;
            for (let i = 0; i < 3; i++) {
                const started = Date.now();
                maskSecrets(batch(k));
                best = Math.min(best, Date.now() - started);
            }
            return best;
        };
        const small = fastest(1);
        const big = fastest(4);
        // The constant keeps the bound honest if the small run lands near zero.
        expect(big).toBeLessThan(small * 8 + 200);
    });

    it('masks a line too long to scan whole, and says so', () => {
        const r = maskedLine('+' + 'x'.repeat(20_000));
        expect(r).toEqual({ out: '+***', masked: 1 });
    });
});

describe('maskSecrets — lookalikes that are not secrets', () => {
    const untouched = [
        '+npm_config_registry=https://registry.npmjs.org',
        '+npm_package_name=@scope/my-service',
        '+note: the glpat- prefix alone is not a token',
        '+glpat-short',
        '+// Basic usage: call the client with a profile',
        '+## Basic authentication is described in the next section',
        '+password = ""',
        '+password = "";',
        '+const password = getPassword();',
        '+see the "password" field of the config for details',
    ];
    for (const line of untouched) {
        it(`leaves ${JSON.stringify(line)}`, () => {
            expect(maskedLine(line)).toEqual({ out: line, masked: 0 });
        });
    }
});

describe('maskSecrets — more token formats', () => {
    const cases: Array<[string, string, string]> = [
        ['npm token', '+token npm_abcdefghijklmnopqrstuvwxyz0123456789', '+token ***'],
        ['GitLab personal access token', '+deploy key glpat-abcdefghijklmnopqrst', '+deploy key ***'],
        ['HTTP Basic credentials', '+Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4', '+Authorization: ***'],
        ['quoted value with a space', '+password = "hunter2 abc"', '+password = "***"'],
        ["quoted value, single quotes", "+secret: 'abcdefgh ijklmnop'", "+secret: '***'"],
    ];
    for (const [name, input, expected] of cases) {
        it(`hides a ${name}`, () => {
            expect(maskedLine(input)).toEqual({ out: expected, masked: 1 });
        });
    }

    it('counts an npm and a GitLab token on one line as two spots', () => {
        const r = maskedLine('+a=npm_abcdefghijklmnopqrstuvwxyz0123456789 b=glpat-abcdefghijklmnopqrst');
        expect(r.out).toBe('+a=*** b=***');
        expect(r.masked).toBe(2);
    });
});
