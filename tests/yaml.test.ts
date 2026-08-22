import { describe, expect, test } from 'bun:test'
import { parseYamlSubset } from '../src/core/tasks/yaml.js'

describe('the YAML subset', () => {
  test('reads a block mapping with scalars', () => {
    expect(parseYamlSubset('version: 1\nname: hello\nflag: true\nnothing: null')).toEqual({
      version: 1,
      name: 'hello',
      flag: true,
      nothing: null,
    })
  })

  test('treats an absent value, `null` and `~` alike', () => {
    expect(parseYamlSubset('a:\nb: null\nc: ~')).toEqual({ a: null, b: null, c: null })
  })

  test('reads a sequence of mappings, which is the task-set shape', () => {
    const parsed = parseYamlSubset(
      [
        'tasks:',
        '  - id: one',
        '    prompt: first',
        '    expected: list_users',
        '  - id: two',
        '    prompt: second',
        '    expected: null',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      tasks: [
        { id: 'one', prompt: 'first', expected: 'list_users' },
        { id: 'two', prompt: 'second', expected: null },
      ],
    })
  })

  test('reads flow sequences', () => {
    expect(parseYamlSubset('tags: [users, read]\nempty: []')).toEqual({
      tags: ['users', 'read'],
      empty: [],
    })
  })

  test('keeps a colon inside a quoted scalar', () => {
    expect(parseYamlSubset(`prompt: "the ratio is 3:1"`)).toEqual({ prompt: 'the ratio is 3:1' })
  })

  test('keeps a `#` inside a quoted scalar but strips a real comment', () => {
    expect(parseYamlSubset(`a: "issue #42"   # a comment\nb: plain # gone`)).toEqual({
      a: 'issue #42',
      b: 'plain',
    })
  })

  test('reads single quotes with the doubled-quote escape', () => {
    expect(parseYamlSubset("a: 'it''s here'")).toEqual({ a: "it's here" })
  })

  test('reads escapes in double quotes', () => {
    expect(parseYamlSubset('a: "line\\nbreak\\tand \\"quotes\\""')).toEqual({
      a: 'line\nbreak\tand "quotes"',
    })
  })

  test('reads a literal block scalar', () => {
    const parsed = parseYamlSubset(['prompt: |', '  first line', '  second line'].join('\n'))
    expect(parsed).toEqual({ prompt: 'first line\nsecond line\n' })
  })

  test('reads a folded block scalar and the `-` chomping indicator', () => {
    expect(parseYamlSubset(['prompt: >-', '  folded', '  together'].join('\n'))).toEqual({
      prompt: 'folded together',
    })
  })

  test('reads nested mappings', () => {
    expect(parseYamlSubset('outer:\n  inner:\n    leaf: 3')).toEqual({
      outer: { inner: { leaf: 3 } },
    })
  })

  test('ignores a leading document marker and blank lines', () => {
    expect(parseYamlSubset('---\n\n# heading\na: 1\n\n')).toEqual({ a: 1 })
  })

  test('distinguishes the string `null` from the null value', () => {
    expect(parseYamlSubset('a: null\nb: "null"')).toEqual({ a: null, b: 'null' })
  })

  test('reads numbers, including negative and exponent forms', () => {
    expect(parseYamlSubset('a: 1\nb: -2.5\nc: 1e3\nd: 007x')).toEqual({
      a: 1,
      b: -2.5,
      c: 1000,
      d: '007x',
    })
  })
})

describe('what the subset refuses', () => {
  const refusals: Array<{ name: string; text: string; expect: RegExp }> = [
    { name: 'anchors', text: 'a: &anchor value', expect: /anchor, alias or tag/ },
    { name: 'aliases', text: 'a: *ref', expect: /anchor, alias or tag/ },
    { name: 'tags', text: 'a: !!str 5', expect: /anchor, alias or tag/ },
    { name: 'flow mappings', text: 'a: { b: 1 }', expect: /Flow mappings/ },
    { name: 'merge keys', text: '<<: base\na: 1', expect: /Merge keys/ },
    { name: 'multiple documents', text: 'a: 1\n---\nb: 2', expect: /Multiple YAML documents/ },
    { name: 'tab indentation', text: 'a:\n\tb: 1', expect: /tab characters/ },
    { name: 'duplicate keys', text: 'a: 1\na: 2', expect: /Duplicate key/ },
    { name: 'unterminated quotes', text: 'a: "open', expect: /Unterminated double-quoted/ },
    { name: 'a bare line', text: 'a: 1\nnot a mapping entry', expect: /Expected `key: value`/ },
  ]

  for (const item of refusals) {
    test(`refuses ${item.name} with a line number`, () => {
      expect(() => parseYamlSubset(item.text)).toThrow(item.expect)
      try {
        parseYamlSubset(item.text)
      } catch (cause) {
        expect((cause as Error).message).toMatch(/^Line \d+:/)
      }
    })
  }

  test('points at the documented subset rather than leaving the user guessing', () => {
    try {
      parseYamlSubset('a: &x 1')
    } catch (cause) {
      expect((cause as Error & { hint?: string }).hint).toContain('documented subset')
    }
  })
})

describe('a block scalar is content, not structure', () => {
  // The tokenizer strips comments and drops blank lines. Inside `|` and `>` both are
  // real text, and silently deleting them rewrites the prompt a run is measuring —
  // exactly the silent misreading the subset exists to prevent.
  test('keeps a `#` inside a literal block instead of treating it as a comment', () => {
    expect(
      parseYamlSubset(['prompt: |', '  Delete issue #42 from the tracker'].join('\n')),
    ).toEqual({ prompt: 'Delete issue #42 from the tracker\n' })
  })

  test('keeps a blank line inside a literal block', () => {
    expect(parseYamlSubset(['prompt: |', '  first', '', '  second'].join('\n'))).toEqual({
      prompt: 'first\n\nsecond\n',
    })
  })

  test('keeps a comment-only line inside a literal block', () => {
    expect(parseYamlSubset(['prompt: |', '  first', '  # not a comment here'].join('\n'))).toEqual({
      prompt: 'first\n# not a comment here\n',
    })
  })

  test('keeps relative indentation inside a literal block', () => {
    expect(parseYamlSubset(['prompt: |', '  outer', '    inner'].join('\n'))).toEqual({
      prompt: 'outer\n  inner\n',
    })
  })

  test('folds a break to a space but a blank line to a newline', () => {
    expect(parseYamlSubset(['prompt: >', '  one', '  two', '', '  three'].join('\n'))).toEqual({
      prompt: 'one two\nthree\n',
    })
  })

  test('keeps a `#` inside a folded block', () => {
    expect(parseYamlSubset(['prompt: >-', '  issue #42', '  resolved'].join('\n'))).toEqual({
      prompt: 'issue #42 resolved',
    })
  })

  test('refuses a more-indented line in a folded block rather than folding it away', () => {
    expect(() => parseYamlSubset(['prompt: >', '  outer', '    inner'].join('\n'))).toThrow(
      /more-indented/,
    )
  })

  test('a comment after the block does not become part of it', () => {
    expect(parseYamlSubset(['prompt: |', '  body', '# trailing', 'other: 1'].join('\n'))).toEqual({
      prompt: 'body\n',
      other: 1,
    })
  })
})
