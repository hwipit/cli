import { describe, expect, it } from 'vitest';
import { JsoncDoc, JsoncEditError, JsoncSyntaxError, parseJsonc } from './jsonc-doc.js';

describe('parseJsonc', () => {
  it('reads comments and trailing commas, as the agents do', () => {
    const text = '{\n  // mine\n  "theme": "dark", /* kept */\n  "list": [1, 2,],\n}\n';

    expect(parseJsonc(text)).toEqual({ theme: 'dark', list: [1, 2] });
  });

  it('reads a byte order mark and an empty file', () => {
    expect(parseJsonc('\uFEFF{ "a": 1 }')).toEqual({ a: 1 });
    expect(parseJsonc('  \n')).toEqual({});
  });

  it('is undefined for a syntax error, not a half-read value', () => {
    for (const text of ['{ "a": }', '{ "a": 1 "b": 2 }', '{ "a": 1', 'not json', '{ "a": 1 } trailing']) {
      expect(parseJsonc(text), text).toBeUndefined();
    }
  });
});

describe('JsoncDoc', () => {
  it('refuses a syntax error and a value that is not an object', () => {
    expect(() => new JsoncDoc('{ "a": }')).toThrow(JsoncSyntaxError);
    expect(() => new JsoncDoc('[1, 2]')).toThrow('does not hold a JSON object');
    expect(() => new JsoncDoc('null')).toThrow('does not hold a JSON object');
  });

  it('does not put the file contents in the message', () => {
    expect(() => new JsoncDoc('{ "apiKey": "ak_secret", }}')).not.toThrow(/ak_secret/);
    try {
      new JsoncDoc('{ "apiKey": "ak_secret", }}');
    } catch (err) {
      expect((err as Error).message).not.toContain('ak_secret');
    }
  });

  it('sets a key and leaves every comment, the order and the indentation as they were', () => {
    const doc = new JsoncDoc('{\n    // my theme\n    "theme": "dark", // inline\n    "size": 12\n}\n');

    doc.set(['hwip'], { on: true });

    expect(doc.text()).toBe(
      '{\n    // my theme\n    "theme": "dark", // inline\n    "size": 12,\n    "hwip": {\n        "on": true\n    }\n}\n',
    );
  });

  it('replaces a value in place, with its neighbours\' comments around it', () => {
    const doc = new JsoncDoc('{\n  "a": 1, // one\n  /* two */ "b": 2,\n  "c": 3\n}\n');

    doc.set(['b'], 20);

    expect(doc.text()).toBe('{\n  "a": 1, // one\n  /* two */ "b": 20,\n  "c": 3\n}\n');
  });

  it('creates what is missing on the way to a path', () => {
    const doc = new JsoncDoc('{}\n');

    doc.set(['mcpServers', 'hwip'], { command: 'hwip' });

    expect(doc.data).toEqual({ mcpServers: { hwip: { command: 'hwip' } } });
  });

  it('appends to an array and keeps the comments inside it', () => {
    const doc = new JsoncDoc('{\n  "hooks": {\n    "stop": [\n      // mine\n      { "command": "mine" }\n    ]\n  }\n}\n');

    doc.append(['hooks', 'stop'], { command: 'hwip' });

    const text = doc.text();
    expect(text).toContain('// mine');
    expect(doc.data).toEqual({ hooks: { stop: [{ command: 'mine' }, { command: 'hwip' }] } });
  });

  it('removes an array item and a property, keeping the comments that are not next to them', () => {
    const doc = new JsoncDoc(
      '{\n  // top\n  "theme": "dark",\n  "hooks": {\n    "stop": [\n      { "command": "a" },\n      { "command": "b" }\n    ]\n  },\n  "keep": 1 // inline\n}\n',
    );

    doc.remove(['hooks', 'stop', 0]);
    expect(doc.data).toEqual({ theme: 'dark', hooks: { stop: [{ command: 'b' }] }, keep: 1 });
    doc.remove(['hooks']);

    expect(doc.text()).toContain('// top');
    expect(doc.text()).toContain('// inline');
    expect(doc.data).toEqual({ theme: 'dark', keep: 1 });
  });

  describe('a new last entry', () => {
    it('goes after the comment on the last property\'s line, and does not re-indent its neighbours', () => {
      const doc = new JsoncDoc('{\n  "mcpServers": {\n    "github": { "command": "npx" }, // needs a token\n  },\n}\n');

      doc.set(['mcpServers', 'hwip'], { command: 'hwip' });

      expect(doc.text()).toBe(
        '{\n  "mcpServers": {\n    "github": { "command": "npx" }, // needs a token\n    "hwip": {\n      "command": "hwip"\n    },\n  },\n}\n',
      );
    });

    it('adds the comma the last property lacked, before its comment', () => {
      const doc = new JsoncDoc('{\n  "theme": "dark" // my theme\n}\n');

      doc.set(['hwip'], true);

      expect(doc.text()).toBe('{\n  "theme": "dark", // my theme\n  "hwip": true\n}\n');
    });

    it('keeps the file\'s habit of a trailing comma, or of none', () => {
      const withComma = new JsoncDoc('{\n  "a": 1,\n}\n');
      withComma.set(['b'], 2);
      expect(withComma.text()).toBe('{\n  "a": 1,\n  "b": 2,\n}\n');

      const without = new JsoncDoc('{\n  "a": 1\n}\n');
      without.set(['b'], 2);
      expect(without.text()).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
    });

    it('goes after the last array item the same way, and leaves the items as written', () => {
      const doc = new JsoncDoc('{\n  "stop": [\n    { "command": "./mine.sh" }, // mine\n  ],\n}\n');

      doc.append(['stop'], { command: 'hwip' });

      expect(doc.text()).toBe('{\n  "stop": [\n    { "command": "./mine.sh" }, // mine\n    {\n      "command": "hwip"\n    },\n  ],\n}\n');
    });

    it('writes it with the tabs and the line endings of the file', () => {
      const tabs = new JsoncDoc('{\n\t"a": 1\n}\n');
      tabs.set(['b'], { c: 2 });
      expect(tabs.text()).toBe('{\n\t"a": 1,\n\t"b": {\n\t\t"c": 2\n\t}\n}\n');

      const crlf = new JsoncDoc('{\r\n  "a": 1 // x\r\n}\r\n');
      crlf.set(['b'], 2);
      expect(crlf.text()).toBe('{\r\n  "a": 1, // x\r\n  "b": 2\r\n}\r\n');
    });

    it('falls back to the library for a file written on one line, still keeping its data', () => {
      const doc = new JsoncDoc('{ "a": 1 }\n');

      doc.set(['b'], 2);

      expect(doc.data).toEqual({ a: 1, b: 2 });
    });

    it('creates a missing parent holding the new entry', () => {
      const doc = new JsoncDoc('{\n  "a": 1, // one\n  "b": 2\n}\n');

      doc.set(['mcp', 'hwip'], { command: 'hwip' });

      expect(doc.data).toEqual({ a: 1, b: 2, mcp: { hwip: { command: 'hwip' } } });
      expect(doc.text()).toContain('"a": 1, // one');
    });
  });

  describe('an entry that shares its line with others', () => {
    const file = (arr: string): string => `{\n  // c\n  "version": 1,\n  "hooks": {"stop": ${arr}}\n}\n`;

    it.each([
      ['the last of two', '[{"command":"mine"}, {"command":"hwip"}]', 1, '[{"command":"mine"}]'],
      ['the first of two', '[{"command":"hwip"}, {"command":"mine"}]', 0, '[{"command":"mine"}]'],
      ['the middle of three', '[1, 2, 3]', 1, '[1, 3]'],
      ['the last, with a trailing comma', '[1, 2,]', 1, '[1,]'],
      ['the only one', '[{"command":"hwip"}]', 0, '[]'],
      ['the only one, with a trailing comma', '[1,]', 0, '[]'],
    ])('is taken out of a compact array, the rest of the file as written: %s', (_, arr, index, left) => {
      const doc = new JsoncDoc(file(arr));

      doc.remove(['hooks', 'stop', index]);

      expect(doc.text()).toBe(file(left));
    });

    it('is left (the edit throws) when a comment sits between it and the entry before it', () => {
      const doc = new JsoncDoc(file('[{"command":"mine"}, /* c */ {"command":"hwip"}]'));

      expect(() => doc.remove(['hooks', 'stop', 1])).toThrow(JsoncEditError);
      expect(doc.data).toEqual({ version: 1, hooks: { stop: [{ command: 'mine' }, { command: 'hwip' }] } });
    });
  });

  describe('a comment that is not next to the removed entry', () => {
    // Either the entry goes and the comment stays, or the edit is refused and nothing changes.
    const keeps = (text: string, path: (string | number)[], comment: string, left: unknown): 'removed' | 'refused' => {
      const doc = new JsoncDoc(text);
      let refused = false;
      try {
        doc.remove(path);
      } catch (err) {
        if (!(err instanceof JsoncEditError)) throw err;
        refused = true;
      }
      expect(doc.text(), `lost ${comment}`).toContain(comment);
      expect(doc.data).toEqual(refused ? parseJsonc(text) : left);
      return refused ? 'refused' : 'removed';
    };

    it('stays when it ends the line of the entry before', () => {
      expect(keeps('{"hooks":{"pre":[1], // K2\n "stop":[{"c":"hwip"}]}}\n', ['hooks', 'stop'], '// K2', { hooks: { pre: [1] } })).toBe('refused');
      expect(keeps('{"x": {"y":1, // K2\n "hwip": 2, "z": 3}}\n', ['x', 'hwip'], '// K2', { x: { y: 1, z: 3 } })).toBe('removed');
    });

    it('stays when it is about the entry after', () => {
      expect(keeps('{"stop": [{"c":"hwip"},\n  // about mine\n  {"c":"mine"}\n ]}\n', ['stop', 0], '// about mine', { stop: [{ c: 'mine' }] })).toBe('refused');
    });

    it('is not covered by an equal comment kept somewhere else', () => {
      expect(keeps('{"a": 1, // TODO\n "hwip": 2} // TODO\n', ['hwip'], '// TODO', { a: 1 })).toBe('refused');
    });

    it('stays above the entry whether or not the closing bracket shares its line', () => {
      expect(keeps('{\n  "a": 1,\n  // --- tools ---\n  "hwip": 2\n}\n', ['hwip'], '// --- tools ---', { a: 1 })).toBe('removed');
      expect(keeps('{\n  "a": 1,\n  // --- tools ---\n  "hwip": 2}\n', ['hwip'], '// --- tools ---', { a: 1 })).toBe('refused');
    });

    it('is told apart from a comment-like string and from CRLF line ends', () => {
      expect(keeps('{"a": "// c", // c\r\n "hwip": 1}\r\n', ['hwip'], '// c', { a: '// c' })).toBe('refused');
      expect(keeps('{"url": "http://x", // k\r\n "hwip": 1, "b": 2}\r\n', ['hwip'], '// k', { url: 'http://x', b: 2 })).toBe('removed');
    });

    it('is not one after the closing bracket: it stays when the last entry goes', () => {
      expect(keeps('{"a": 1, "hwip": 2} // after\n', ['hwip'], '// after', { a: 1 })).toBe('removed');
    });

    it('is no reason to refuse an entry that starts its line but shares the last one with the bracket', () => {
      const doc = new JsoncDoc('{"x":[1,\n2]}\n');

      doc.remove(['x', 1]);

      expect(doc.text()).toBe('{"x":[1]}\n');
    });

    it('may go with a value that is replaced: a comment inside it is its own', () => {
      const doc = new JsoncDoc('{\n  "k": { /* inner */ "a": 1 },\n  "z": 1 // keep\n}\n');

      doc.set(['k'], 2);

      expect(doc.data).toEqual({ k: 2, z: 1 });
      expect(doc.text()).toContain('// keep');
    });

    it('is not taken by a compact object entry going, and the rest stays as written', () => {
      const doc = new JsoncDoc('{"a":1,"b":{"c":2},"d":3} // K\n');

      doc.remove(['b']);

      expect(doc.text()).toBe('{"a":1,"d":3} // K\n');
    });

    it('is its own when it ends the entry\'s line: it goes with the entry, and a comment above it stays', () => {
      const doc = new JsoncDoc('{\n  "a": 1,\n  // about hwip\n  "hwip": 2, // hwip\n  "b": 3\n}\n');

      doc.remove(['hwip']);

      expect(doc.data).toEqual({ a: 1, b: 3 });
      expect(doc.text()).toBe('{\n  "a": 1,\n  // about hwip\n  "b": 3\n}\n');
    });
  });

  describe('a new entry the library would hand a comment of the user\'s', () => {
    // An uninstall takes the comment at the end of the entry's line along, so the user's comment must not land there.
    it.each([
      ['an empty object', '{"mcpServers": { // add servers below\n  }, "x": 1}\n', ['mcpServers', 'hwip'], 'set'],
      ['a compact last property', '{"a": 1 /* about a */}\n', ['hwip'], 'set'],
      ['a compact last list item', '{"hooks":{"Stop":[{"c":"mine"} /* mine: notify */]}}\n', ['hooks', 'Stop'], 'append'],
    ] as const)('is refused for %s, and the text stays', (_name, text, path, how) => {
      const doc = new JsoncDoc(text);

      expect(() => (how === 'set' ? doc.set([...path], { c: 1 }) : doc.append([...path], { c: 'hwip' }))).toThrow(JsoncEditError);

      expect(doc.text()).toBe(text);
    });

    it.each([
      ['two comments after the last item', '{\n "hooks": {\n "Stop": [\n {"c":"mine"} /* a */ // b\n ]\n }\n}\n', ['hooks', 'Stop'], 'append'],
      ['a comma between two comments', '{\n "hooks": {\n "Stop": [\n {"c":"mine"} /* a */, // b\n ]\n }\n}\n', ['hooks', 'Stop'], 'append'],
      ['two comments after the last property', '{\n "hooks": {\n "Pre": [] /* a */ // b\n }\n}\n', ['hooks', 'Stop'], 'set'],
      ['a comment alone in a list', '{\n "hooks": {\n "Stop": [ /* none */ ]\n }\n}\n', ['hooks', 'Stop'], 'append'],
      ['the first item on the bracket line', '{\n "hooks": {\n "Stop": [{"c":"mine"} // m\n ]\n }\n}\n', ['hooks', 'Stop'], 'append'],
      ['a block comment with the closing bracket after it', '{\n "hooks": {\n "Stop": [\n {"c":"mine"} /* x */ ]\n }\n}\n', ['hooks', 'Stop'], 'append'],
    ] as const)('is refused on the plain path too: %s', (_name, text, path, how) => {
      const doc = new JsoncDoc(text);

      expect(() => (how === 'set' ? doc.set([...path], []) : doc.append([...path], { c: 'hwip' }))).toThrow(JsoncEditError);

      expect(doc.text()).toBe(text);
    });

    it.each([
      ['no space before the comment', '{\n "Stop": [\n {"c":"mine"}// m\n ]\n}\n'],
      ['a block comment over two lines', '{\n "Stop": [\n {"c":"mine"} /* mine\n notify */\n ]\n}\n'],
    ])('keeps a comment whose first character is not a space: %s', (_name, text) => {
      const doc = new JsoncDoc(text);
      const comment = /\/[/*][^]*$/.exec(text.split('\n ]')[0]!)![0];

      doc.append(['Stop'], { c: 'hwip' });
      const added = doc.text();
      doc.remove(['Stop', 1]);

      expect(added).toContain(comment);
      expect(doc.data).toEqual({ Stop: [{ c: 'mine' }] });
      expect(doc.text()).toContain(comment);
    });

    it('is put in without that comment when the file has none', () => {
      const doc = new JsoncDoc('{"a": 1}\n');

      doc.set(['hwip'], 2);
      doc.remove(['hwip']);

      expect(doc.data).toEqual({ a: 1 });
    });
  });

  describe('an edit the library gets wrong', () => {
    // Removing the last item of an array in a file written on one line leaves invalid JSON.
    const oneLine = '{"version":1,"hooks":{"stop":[{"command":"mine"},{"command":"hwip"}],"other":[{"command":"x"}]}}';

    it('is applied correctly anyway on a file with no comments', () => {
      const doc = new JsoncDoc(oneLine);

      doc.remove(['hooks', 'stop', 1]);

      expect(doc.data).toEqual({ version: 1, hooks: { stop: [{ command: 'mine' }], other: [{ command: 'x' }] } });
      expect(parseJsonc(doc.text())).toEqual(doc.data);
    });

    it('throws and leaves the text alone when a rewrite would lose the comments', () => {
      const text = '{"hooks":{"stop":[{"command":"mine"}, /* mine */ {"command":"hwip"}],"other":[{"command":"x"}]}}';
      const doc = new JsoncDoc(text);

      expect(() => doc.remove(['hooks', 'stop', 1])).toThrow(JsoncEditError);

      expect(doc.text()).toBe(`${text}\n`);
    });

    it('does not take a comment inside a string for a comment', () => {
      const doc = new JsoncDoc('{"url":"http://x/*y*/","hooks":{"stop":[{"command":"mine"},{"command":"hwip"}],"other":[1]}}');

      doc.remove(['hooks', 'stop', 1]);

      expect(doc.data).toEqual({ url: 'http://x/*y*/', hooks: { stop: [{ command: 'mine' }], other: [1] } });
    });
  });

  it('keeps a byte order mark and ends in one line ending', () => {
    const doc = new JsoncDoc('\uFEFF{ "a": 1 }\n\n\n');

    doc.set(['b'], 2);

    expect(doc.text().startsWith('\uFEFF{')).toBe(true);
    expect(doc.text().endsWith('}\n')).toBe(true);
    expect(doc.text().endsWith('\n\n')).toBe(false);
  });

  it('writes the line ending and the indentation the file already has', () => {
    const crlf = new JsoncDoc('{\r\n  "a": 1\r\n}\r\n');
    crlf.set(['b'], { c: 2 });
    expect(crlf.text()).not.toMatch(/[^\r]\n/);

    const tabs = new JsoncDoc('{\n\t"a": 1\n}\n');
    tabs.set(['b'], { c: 2 });
    expect(tabs.text()).toContain('\t"b": {\n\t\t"c": 2\n\t}');
  });

  it('turns an empty file into a formatted object with two-space indentation', () => {
    const doc = new JsoncDoc('');

    doc.set(['a'], { b: 1 });

    expect(doc.text()).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });

  it('keeps a trailing comma the user wrote', () => {
    const doc = new JsoncDoc('{\n  "a": 1,\n}\n');

    doc.set(['b'], 2);

    expect(doc.data).toEqual({ a: 1, b: 2 });
    expect(parseJsonc(doc.text())).toEqual({ a: 1, b: 2 });
  });
});
