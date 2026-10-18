import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type FormattingOptions,
  type JSONPath,
  type Node,
  type ParseError,
} from 'jsonc-parser';

/**
 * An agent's settings file read as JSONC — comments and trailing commas allowed,
 * the way the agents themselves read them — and changed by small edits to its
 * text, so what the user wrote around hwip's entries (comments, their ordering,
 * their indentation) stays exactly as it was. `jsonc-parser` (Microsoft, the
 * parser VS Code uses for its own settings) does the parsing and the edits;
 * this file only fixes the conventions hwip needs on top of it.
 *
 * Plain JSON is a subset, so a file without comments is read and edited the
 * same way. A file with a syntax error is not read at all (`JsoncSyntaxError`):
 * editing around a broken part could write something worse.
 *
 * Every edit is checked: the text after it must read back as exactly the value
 * the edit was meant to produce. The library gets that wrong in places — removing
 * an item of an array whose last two items share a line joins them into one or
 * breaks the brackets — and a settings file that agents read must never be left
 * like that. A file with
 * no comments is then written whole from the intended value (nothing of the
 * user's is lost); one with comments is left unchanged and the edit throws
 * (`JsoncEditError`).
 */

export class JsoncSyntaxError extends Error {
  constructor() {
    super('not valid JSON (comments and trailing commas are fine, anything else is not)');
    this.name = 'JsoncSyntaxError';
  }
}

/** Valid JSONC, but the value is a list, a string, `null` — not a settings object. */
export class JsoncNotObjectError extends Error {
  constructor() {
    super('does not hold a JSON object');
    this.name = 'JsoncNotObjectError';
  }
}

// jsonc-parser's `SyntaxKind` is a const enum, which this build cannot import (isolatedModules).
const SYNTAX_LINE_COMMENT = 12;
const SYNTAX_BLOCK_COMMENT = 13;
const SYNTAX_EOF = 17;

/** An edit the library could not apply correctly to a file whose comments a rewrite would lose. */
export class JsoncEditError extends Error {
  constructor() {
    super('could not be edited without risking its comments');
    this.name = 'JsoncEditError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value of a JSONC text, or `undefined` when it has a syntax error. An empty text is `{}`. */
export const parseJsonc = (text: string): unknown => {
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(body, errors, { allowTrailingComma: true });
  return errors.length > 0 ? undefined : value;
};

/** The indentation and line ending the file already uses, so an inserted entry looks like its neighbours. */
const formattingOf = (body: string): FormattingOptions => {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(body)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? Math.min(indent.length, 8) : 2, eol };
};

/**
 * A copy of `data` with `change` applied to the container that holds `path`'s last
 * segment, missing containers on the way created as objects — the value an edit is
 * meant to leave behind, to check the text against.
 */
const valueAfter = (
  data: Record<string, unknown>,
  path: JSONPath,
  change: (container: object, key: string | number) => void,
): Record<string, unknown> => {
  const copy = structuredClone(data);
  let container: Record<string | number, unknown> = copy;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(container[segment]) && !Array.isArray(container[segment])) container[segment] = {};
    container = container[segment] as Record<string | number, unknown>;
  }
  change(container, path[path.length - 1]!);
  return copy;
};

export class JsoncDoc {
  private readonly bom: string;
  private body: string;
  private readonly formatting: FormattingOptions;
  /** What the file held when it was read (null: there was no file), for `replaceFile` to check before it writes. */
  readonly expected: string | null;

  /**
   * `text` is a settings file's content; throws `JsoncSyntaxError`, or `JsoncNotObjectError` when it is valid but not an object.
   * `existed` is false for a file that was not there (`text` is then empty).
   */
  constructor(text: string, existed = true) {
    this.expected = existed ? text : null;
    this.bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const stripped = text.slice(this.bom.length);
    const value = parseJsonc(stripped);
    if (value === undefined) throw new JsoncSyntaxError();
    if (!isPlainObject(value)) throw new JsoncNotObjectError();
    // An empty file is a new one: edits need a document to land in.
    this.body = stripped.trim() === '' ? '{}' : stripped;
    this.formatting = formattingOf(this.body);
  }

  /** The text without an entry that shares its line (a compact array or object), or null when a comment sits in the way. */
  private withoutInline(unit: Node, siblings: Node[]): string | null {
    const i = siblings.indexOf(unit);
    const end = unit.offset + unit.length;
    const between = (from: number, to: number): string => this.body.slice(from, to);
    const bare = (text: string): boolean => /^[\s,]*$/.test(text);
    const next = siblings[i + 1];
    if (next) {
      // Up to the next entry: the entry, its comma and the space after it.
      return bare(between(end, next.offset)) ? between(0, unit.offset) + between(next.offset, this.body.length) : null;
    }
    const before = siblings[i - 1];
    const close = (unit.parent?.offset ?? 0) + (unit.parent?.length ?? 0) - 1;
    // The only entry: everything from it to the closing bracket, its trailing comma included.
    if (!before) return bare(between(end, close)) ? between(0, unit.offset) + between(close, this.body.length) : null;
    // The last of several: from the end of the one before (its comma goes) to this one's end; a trailing comma stays.
    const beforeEnd = before.offset + before.length;
    return bare(between(beforeEnd, unit.offset)) && bare(between(end, close))
      ? between(0, beforeEnd) + between(end, this.body.length)
      : null;
  }

  /** Would removing the entry at `path` take a comment with it (one inside the entry, or at the end of its last line)? */
  removalTakesComment(path: JSONPath): boolean {
    const zone = this.removalZone(path);
    return !!zone && JsoncDoc.commentsIn(this.body).some((c) => c.offset >= zone[0] && c.offset < zone[1]);
  }

  /** Does the text hold a comment? (Not one inside a string: the scanner knows tokens.) */
  hasComments(): boolean {
    const scanner = createScanner(this.body, false);
    for (let kind = scanner.scan(); kind !== SYNTAX_EOF; kind = scanner.scan()) {
      if (kind === SYNTAX_LINE_COMMENT || kind === SYNTAX_BLOCK_COMMENT) return true;
    }
    return false;
  }

  /** Every comment in `text` with where it starts, in order. */
  private static commentsIn(text: string): { text: string; offset: number }[] {
    const scanner = createScanner(text, false);
    const found: { text: string; offset: number }[] = [];
    for (let kind = scanner.scan(); kind !== SYNTAX_EOF; kind = scanner.scan()) {
      if (kind === SYNTAX_LINE_COMMENT || kind === SYNTAX_BLOCK_COMMENT) found.push({ text: text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()), offset: scanner.getTokenOffset() });
    }
    return found;
  }

  /**
   * Did `next` lose a comment of the current text that was not inside `allowed`
   * (a range of the current text: what the edit may take with it)? The library
   * drops comments around a removed entry it has no right to; a copy of the same
   * text elsewhere does not stand in for a lost one.
   */
  private losesComment(next: string, allowed: [number, number] | null): boolean {
    const left = new Map<string, number>();
    for (const c of JsoncDoc.commentsIn(next)) left.set(c.text, (left.get(c.text) ?? 0) + 1);
    const inAllowed = (offset: number): boolean => !!allowed && offset >= allowed[0] && offset < allowed[1];
    // Comments outside the allowed range claim their survivors first.
    const before = JsoncDoc.commentsIn(this.body);
    for (const c of [...before.filter((x) => !inAllowed(x.offset)), ...before.filter((x) => inAllowed(x.offset))]) {
      const count = left.get(c.text) ?? 0;
      if (count > 0) left.set(c.text, count - 1);
      else if (!inAllowed(c.offset)) return true;
    }
    return false;
  }

  /** Take `next` as the new text if it reads back as `expected` and loses no comment but those in `allowed`; else see the class comment. */
  private commit(next: string, expected: unknown, allowed: [number, number] | null = null): void {
    if (isDeepStrictEqual(parseJsonc(next), expected) && !this.losesComment(next, allowed)) {
      this.body = next;
      return;
    }
    if (this.hasComments()) throw new JsoncEditError();
    this.body = JSON.stringify(expected, null, this.formatting.insertSpaces === false ? '\t' : ' '.repeat(this.formatting.tabSize ?? 2));
  }

  /** The current value, read again after every edit. */
  get data(): Record<string, unknown> {
    return parseJsonc(this.body) as Record<string, unknown>;
  }

  /** Set `path` to `value`, creating what is missing on the way. */
  set(path: JSONPath, value: unknown): void {
    const expected = valueAfter(this.data, path, (container, key) => {
      (container as Record<string | number, unknown>)[key] = value;
    });
    const tree = parseTree(this.body, [], { allowTrailingComma: true });
    const existing = tree ? findNodeAtLocation(tree, path) : undefined;
    if (tree && !existing) {
      // A new property goes after the last one — and after the comment on its line.
      const key = path[path.length - 1];
      const parent = findNodeAtLocation(tree, path.slice(0, -1));
      const text = parent?.type === 'object' && typeof key === 'string'
        ? this.insertLast(parent, `${JSON.stringify(key)}: ${this.render(value)}`)
        : null;
      if (text !== null) {
        this.refuseAdoptedComment(text, path);
        return this.commit(text, expected);
      }
    }
    // A value that is replaced may take the comments inside it along.
    const replaced: [number, number] | null = existing ? [existing.offset, existing.offset + existing.length] : null;
    const next = applyEdits(this.body, modify(this.body, path, value, { formattingOptions: this.formatting }));
    if (!existing) this.refuseAdoptedComment(next, path);
    this.commit(next, expected, replaced);
  }

  /** Remove the property or array item at `path`. A comment right next to it goes with it. */
  remove(path: JSONPath): void {
    const expected = valueAfter(this.data, path, (container, key) => {
      if (Array.isArray(container)) container.splice(key as number, 1);
      else delete (container as Record<string, unknown>)[key as string];
    });
    const lines = this.withoutLines(path);
    this.commit(
      lines ?? applyEdits(this.body, modify(this.body, path, undefined, { formattingOptions: this.formatting })),
      expected,
      this.removalZone(path),
    );
  }

  /**
   * What removing the entry at `path` may take with it: the entry itself and the
   * comment at the end of its last line — not one above it, nor one after the
   * closing bracket of its container, which are not this entry's.
   */
  private removalZone(path: JSONPath): [number, number] | null {
    const tree = parseTree(this.body, [], { allowTrailingComma: true });
    const node = tree ? findNodeAtLocation(tree, path) : undefined;
    const unit = node?.parent?.type === 'property' ? node.parent : node;
    const siblings = unit?.parent?.children;
    if (!unit || !siblings) return null;
    const lineEndAfter = (at: number): number => {
      const nl = this.body.indexOf('\n', at);
      return nl < 0 ? this.body.length : nl + 1;
    };
    const after = siblings[siblings.indexOf(unit) + 1];
    const end = unit.offset + unit.length;
    return [unit.offset, Math.min(lineEndAfter(end), after?.offset ?? unit.parent!.offset + unit.parent!.length - 1)];
  }

  /**
   * The text without the lines of the entry at `path`, when it stands on lines of
   * its own: its own comment and comma go with it, and so does the comma before it
   * when it was the last one. A comment on another line, or on the line of the
   * entry before, stays — the library would take the comment next to the entry
   * along. An entry that shares its line with others goes through `withoutInline`.
   */
  private withoutLines(path: JSONPath): string | null {
    const tree = parseTree(this.body, [], { allowTrailingComma: true });
    const node = tree ? findNodeAtLocation(tree, path) : undefined;
    const unit = node?.parent?.type === 'property' ? node.parent : node;
    const siblings = unit?.parent?.children;
    if (!unit || !siblings) return null;
    const lineStart = this.body.lastIndexOf('\n', unit.offset - 1) + 1;
    const end = unit.offset + unit.length;
    if (/\S/.test(this.body.slice(lineStart, unit.offset))) return this.withoutInline(unit, siblings);
    const rest = /^[ \t]*(,)?[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/)?[ \t]*(?:\r?\n|$)/.exec(this.body.slice(end));
    if (!rest) return this.withoutInline(unit, siblings);
    const without = this.body.slice(0, lineStart) + this.body.slice(end + rest[0].length);
    const before = siblings[siblings.indexOf(unit) - 1];
    if (rest[1] !== undefined || !before) return without;
    // The last entry, in a file that writes no trailing comma: the one before it loses its comma.
    const beforeEnd = before.offset + before.length;
    const comma = /^[ \t]*,/.exec(this.body.slice(beforeEnd));
    return comma ? without.slice(0, beforeEnd + comma[0].length - 1) + without.slice(beforeEnd + comma[0].length) : null;
  }

  /** Add `value` at the end of the array at `path`, after the comment on the last item's line. */
  append(path: JSONPath, value: unknown): void {
    const expected = valueAfter(this.data, path, (container, key) => {
      const list = (container as Record<string | number, unknown>)[key];
      if (!Array.isArray(list)) throw new Error('not a list');
      list.push(value);
    });
    const tree = parseTree(this.body, [], { allowTrailingComma: true });
    const array = tree ? findNodeAtLocation(tree, path) : undefined;
    const text = array?.type === 'array' ? this.insertLast(array, this.render(value)) : null;
    const added = [...path, array?.children?.length ?? 0];
    if (text !== null) {
      this.refuseAdoptedComment(text, added);
      return this.commit(text, expected);
    }
    const next = applyEdits(this.body, modify(this.body, [...path, -1], value, { formattingOptions: this.formatting, isArrayInsertion: true }));
    this.refuseAdoptedComment(next, added);
    this.commit(next, expected);
  }

  /**
   * The library's insert can leave a comment of the user's on the line of the new
   * entry, and an uninstall would take it away with the entry (it is the entry's
   * "own" comment by position). A new entry must have no comment in its removal
   * zone; otherwise fail now, naming the file, and leave the text alone.
   */
  private refuseAdoptedComment(next: string, path: JSONPath): void {
    if (!this.hasComments()) return;
    const after = new JsoncDoc(next);
    if (after.removalTakesComment(path)) throw new JsoncEditError();
  }

  /** `value` as JSON text in the file's own indentation unit. */
  private render(value: unknown): string {
    const unit = this.formatting.insertSpaces === false ? '\t' : ' '.repeat(this.formatting.tabSize ?? 2);
    return JSON.stringify(value, null, unit);
  }

  /**
   * The text with `childText` put after the last child of an object or array, on a
   * line of its own at the last child's indentation; null for an empty container
   * or one whose last child shares its line with something else (the caller falls
   * back). The library's insert would re-indent the siblings and move a comment at
   * the end of the last child's line onto the new child.
   */
  private insertLast(container: Node, childText: string): string | null {
    const children = container.children ?? [];
    const last = children[children.length - 1];
    if (!last) return null;
    const lineStart = this.body.lastIndexOf('\n', last.offset - 1) + 1;
    const before = this.body.slice(lineStart, last.offset);
    if (/\S/.test(before)) return null;
    const lastEnd = last.offset + last.length;
    const close = container.offset + container.length - 1;
    const tail = /^[ \t]*(,)?[ \t]*(\/\/[^\r\n]*|\/\*[^]*?\*\/)?/.exec(this.body.slice(lastEnd, close))!;
    const hasComma = tail[1] !== undefined;
    const at = lastEnd + tail[0].length;
    // A comment that the closing bracket follows on its line would be left between the two entries.
    if (tail[2] && !this.body.slice(at, close).includes('\n')) return null;
    const eol = this.formatting.eol ?? '\n';
    // `childText` came in indented from its own first line: move it under the last child.
    const text = childText.replace(/\r?\n/g, `${eol}${before}`);
    const withNew = this.body.slice(0, at) + `${eol}${before}${text}${hasComma ? ',' : ''}` + this.body.slice(at);
    return hasComma ? withNew : withNew.slice(0, lastEnd) + ',' + withNew.slice(lastEnd);
  }

  /** The file's new text: its byte order mark kept, one line ending at the end. */
  text(): string {
    return this.bom + this.body.trimEnd() + (this.formatting.eol ?? '\n');
  }
}
