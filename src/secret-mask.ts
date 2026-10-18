/**
 * Best-effort masking of secret-looking strings in a patch, before it is sealed
 * for the phone. It keeps the patch's shape — the same lines, the same diff
 * marker on each, the same headers — so line numbers and hunks still line up;
 * only text after the marker changes.
 *
 * This is a list of well-known token formats and secret-named assignments, not
 * a promise: a secret in a form no rule knows goes through, and so does key
 * material whose BEGIN line is outside the patch (the rules see one line at a
 * time, plus whether a key block opened above). The count of masked spots is
 * part of the answer so the reader is told something was hidden, and is never
 * told nothing was.
 *
 * Every pattern is bounded: the patch comes from a repository the agent may
 * have cloned from anywhere, the masking runs on the listener's event loop, and
 * an unbounded `x*` retried from every start of a 200 KB line is quadratic.
 */

import { redactSecrets } from './redact.js';

export interface MaskedPatch {
    text: string;
    masked: number;
}

const MASK = '***';

/** Token formats with a recognisable prefix. Whole match is replaced. */
const TOKEN_FORMATS: RegExp[] = [
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,255}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
    /\bsk-[A-Za-z0-9_-]{20,255}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g,
    /\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,512}=*/g,
    // npm CLI tokens: npm_ plus exactly 36 word characters (env names such as
    // npm_config_registry hold an underscore inside, so the boundary keeps them out).
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    // GitLab personal access tokens.
    /\bglpat-[A-Za-z0-9_]{20,64}/g,
    // HTTP Basic credentials: the base64 blob needs a digit, sign or padding - a
    // plain English word after Basic (Basic authentication is...) stays.
    /\bBasic[ \t]+(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/=]{16,512}/g,
    /\beyJ[A-Za-z0-9_-]{5,256}\.[A-Za-z0-9_-]{5,1024}\.[A-Za-z0-9_-]{5,1024}/g,
];

/** A line longer than this is not read by a person on a phone and is not
 *  scanned: it is masked whole. Keeps the scan linear in the patch. */
const MAX_SCANNED_LINE = 8 * 1024;

/**
 * `name = value` / `name: value` / `"name": "value"` where the name says it is
 * a secret and the value is at least eight characters. Only the value is
 * replaced. A value that is a reference to somewhere the secret lives
 * (`process.env.X`, `$VAR`) is not the secret.
 */
const SECRET_ASSIGNMENT =
    /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]{0,64}["']?[ \t]{0,16}[=:][ \t]{0,16}["'`]?)([^\s"'`,;)}\]]{8,2048})/gi;
/** The same secret-named assignments, with the value quoted: a quoted value may hold
 *  spaces (password = "hunter2 abc"), so the unquoted rule no-whitespace value
 *  misses it. Same eight-character floor as the unquoted rule; run before it, so a
 *  value is counted once even when its first word alone would match there. */
const SECRET_QUOTED_VALUE =
    /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]{0,64}["']?[ \t]{0,16}[=:][ \t]{0,16}["'])([^"'`\n]{8,2048}?)(["'])/gi;

const ENV_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|System\.getenv|ENV\[|\$\{?[A-Za-z_])/;
/** An unquoted member chain or call (`response.data.token`, `createToken(cfg)`) is code, not a literal.
 *  A digit in the first segment (`ya29.a0…`, `hunter2.0x`) says it is a value. */
const CODE_EXPRESSION = /^[A-Za-z_]+(?:\.\w+|\()/;

/** What may follow a BEGIN marker that opens a block: nothing, a closing quote, or a string's escaped newline. */
const PEM_CLOSING_TAIL = /^(?:\\(?:r\\)?n)?["'`\\\s,+]*$/;
const PEM_OPENING_TAIL = /^(?:["'`\\\s,+]*|\\(?:r\\)?n.*)$/;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
/** What a key block's body lines look like: base64, or a header such as `Proc-Type: 4,ENCRYPTED`. */
const PEM_BODY_LINE =
    /^\s{0,64}(?:#|\/\/|\*|;)?\s{0,64}["'`]?(?:[A-Za-z0-9+/=]{1,8192}|[A-Za-z][A-Za-z0-9-]{0,40}: .{0,200})(?:\\(?:r\\)?n)?["'`]?[,+\s]*$/;

/** Mask one line of content (marker already taken off). */
const maskBody = (body: string): { body: string; masked: number } => {
    let masked = 0;
    let out = body;
    for (const format of TOKEN_FORMATS) {
        out = out.replace(format, () => {
            masked++;
            return MASK;
        });
    }
    out = out.replace(SECRET_QUOTED_VALUE, (_whole: string, head: string, _value: string, quote: string) => {
        masked++;
        return head + MASK + quote;
    });
    const cleaned = redactSecrets(out);
    if (cleaned !== out) {
        masked++;
        out = cleaned;
    }
    out = out.replace(SECRET_ASSIGNMENT, (whole, head: string, value: string) => {
        const quoted = /["'`]$/.test(head);
        if (ENV_REFERENCE.test(value) || (!quoted && CODE_EXPRESSION.test(value))) return whole;
        masked++;
        return head + MASK;
    });
    return { body: out, masked };
};

/** The `@@ -a,b +c,d @@` part of a hunk header; what follows it is a line of the file's own text. */
const HUNK_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const PEM_MARKER = /-----(BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

/** A hunk header with the file's context line (`@@ -4,4 +4,4 @@ API_KEY=sk-…`) masked like any other text. */
const maskHunkHeader = (line: string): { line: string; masked: number } => {
    const range = HUNK_RANGE.exec(line);
    if (!range) return { line, masked: 0 };
    const tail = line.slice(range[0].length);
    if (tail.length > MAX_SCANNED_LINE) return { line: range[0] + ' ' + MASK, masked: 1 };
    const result = maskBody(tail);
    return { line: range[0] + result.body, masked: result.masked };
};

/**
 * Mask one line's content (marker already taken off). `state.inPem` says a key
 * block opened on an earlier line and carries a block opened on this one out.
 * A line may hold several key blocks, the end of one and the start of the next,
 * or a key block beside a token: every piece is read.
 */
const maskContent = (body: string, state: { inPem: boolean }): { body: string; masked: number } => {
    let masked = 0;
    let out = '';
    const plain = (text: string) => {
        const result = maskBody(text);
        masked += result.masked;
        out += result.body;
    };

    let from = 0;
    if (state.inPem) {
        const end = PEM_END.exec(body);
        if (!end) {
            // Only lines that look like key material are hidden; anything else means
            // the block was not one (or has ended out of view) and is read normally.
            // A blank line stays inside: an encrypted key puts one between its headers and its body.
            if (body.trim() === '') return { body, masked: 0 };
            if (PEM_BODY_LINE.test(body)) return { body: MASK, masked: 0 };
            state.inPem = false;
        } else {
            // The block ends on this line: what is before the end marker is its last text.
            state.inPem = false;
            const before = body.slice(0, end.index);
            if (before === '' || PEM_BODY_LINE.test(before)) out += before === '' ? '' : MASK;
            else plain(before);
            from = end.index;
        }
    }

    // Every marker of the line, found once; `endAt[i]` is the first END among markers i.. — so a line
    // thick with markers is read in one pass, not once per BEGIN.
    const markers = [...body.matchAll(PEM_MARKER)];
    const endAt: number[] = new Array<number>(markers.length + 1).fill(-1);
    for (let i = markers.length - 1; i >= 0; i--) endAt[i] = markers[i][1] === 'END' ? i : endAt[i + 1];

    let k = 0;
    for (;;) {
        while (k < markers.length && (markers[k].index < from || markers[k][1] !== 'BEGIN')) k++;
        const begin = markers[k];
        if (!begin) {
            plain(body.slice(from));
            break;
        }
        const afterBegin = begin.index + begin[0].length;
        plain(body.slice(from, begin.index));
        out += begin[0];
        const endIndex = endAt[k + 1];
        if (endIndex >= 0) {
            // Begin and end on one line (a key inside a string literal): the middle goes.
            masked++;
            out += MASK;
            from = markers[endIndex].index;
            k = endIndex;
            continue;
        }
        // A marker that ends its line (after any quote) opens a block, counted once
        // however many lines it has; so does one followed by a string's escaped
        // newline, whose key text on the same line goes too. A marker inside code
        // (`startsWith("-----BEGIN …") {`) does not.
        const tail = body.slice(afterBegin);
        if (PEM_OPENING_TAIL.test(tail)) {
            masked++;
            state.inPem = true;
            out += PEM_CLOSING_TAIL.test(tail) ? tail : MASK;
            break;
        }
        // Not a block: read on, a later marker on the line may be one.
        from = afterBegin;
        k++;
    }
    return { body: out, masked };
};

/**
 * Mask secret-looking strings in prose or any other text that is not a patch: no marker is taken off a line, so
 * a token at the head of a line is read like any other. For text that leaves the machine to a reader other than
 * the user (what `hwip agent read` prints). Same rules, same limits as `maskSecrets`: best effort, not a promise.
 */
export const maskText = (text: string): MaskedPatch => {
    let masked = 0;
    const state = { inPem: false };
    const lines = text.split('\n').map((line) => {
        if (line.length > MAX_SCANNED_LINE) {
            masked++;
            return MASK;
        }
        const result = maskContent(line, state);
        masked += result.masked;
        return result.body;
    });
    return { text: lines.join('\n'), masked };
};

export const maskSecrets = (patch: string): MaskedPatch => {
    let masked = 0;
    let inHeader = false;
    const state = { inPem: false };
    const lines = patch.split('\n').map((line) => {
        // File headers run from `diff --git` to the first hunk: a line there that
        // starts with `+++ ` is a path, not an added line.
        if (line.startsWith('diff --git ')) {
            inHeader = true;
            state.inPem = false;
            return line;
        }
        if (inHeader && !line.startsWith('@@')) return line;
        if (line.startsWith('@@')) {
            inHeader = false;
            state.inPem = false;
            const header = maskHunkHeader(line);
            masked += header.masked;
            return header.line;
        }
        if (line === '' || line.startsWith('\\')) return line;

        const marker = line.slice(0, 1);
        const body = line.slice(1);
        if (body.length > MAX_SCANNED_LINE) {
            masked++;
            return marker + MASK;
        }
        const result = maskContent(body, state);
        masked += result.masked;
        return marker + result.body;
    });
    return { text: lines.join('\n'), masked };
};
