import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './helpers.js'

function walk(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...walk(path))
    } else if (path.endsWith('.ts')) {
      found.push(path)
    }
  }
  return found
}

/**
 * Remove comments before scanning: prose in `src/core/` legitimately names Bun and Node
 * (an error message has to tell the user which runtimes are supported), and matching that
 * would make the check unusable. Handles the common cases, not every pathological string.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
}

/**
 * SPEC §5 makes `src/core/` portable TypeScript: only `fetch` and standard APIs, no Bun
 * and no Node builtins, so the package runs under `npx` on Node where most of the MCP
 * ecosystem lives. That rule is easy to break by reflex, so it is checked rather than
 * remembered.
 */
describe('src/core stays portable', () => {
  const coreFiles = walk(join(REPO_ROOT, 'src', 'core'))

  test('there is something to check', () => {
    expect(coreFiles.length).toBeGreaterThan(10)
  })

  for (const file of coreFiles) {
    const name = relative(REPO_ROOT, file).replace(/\\/g, '/')
    test(`${name} uses no runtime-specific API`, () => {
      const source = stripComments(readFileSync(file, 'utf8'))
      const offenders: string[] = []
      // A property access, not the word: an error message may legitimately end a sentence
      // with "… or Bun." while naming the runtimes whichtool supports.
      if (/\bBun\s*\.\s*[A-Za-z_$]/.test(source)) offenders.push('Bun.*')
      if (/from\s+["']bun[:"']/.test(source)) offenders.push('import from "bun"')
      if (/from\s+["']node:/.test(source)) offenders.push('import from node: builtin')
      if (/\brequire\s*\(/.test(source)) offenders.push('require()')
      if (/\bprocess\s*\.\s*(env|cwd|exit|stdout|stderr)\b/.test(source))
        offenders.push('process.*')
      expect(offenders).toEqual([])
    })
  }
})

/**
 * Source files are UTF-8, and stay that way.
 *
 * A script that reads a file as single-byte text and writes it back as UTF-8 turns every em
 * dash and curly quote into garbage. It still compiles, so nothing complains, and the damage
 * compounds each time the file is rewritten.
 *
 * Which garbage depends on the code page the reader assumed. Windows-1252 produces a run
 * starting `<U+00E2><U+20AC>`; ISO-8859-1 produces C1 control characters, which no source
 * file has any other reason to contain. Both are checked, because both have happened.
 */
test('source files are intact UTF-8, not re-encoded single-byte text', () => {
  // Built from code points so this file cannot itself be what trips the check.
  const CP1252_LEAD = String.fromCharCode(0x00e2, 0x20ac)
  const C1_CONTROLS = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0x9f)}]`)
  const mangled = walk(join(REPO_ROOT, 'src'))
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      return source.includes(CP1252_LEAD) || C1_CONTROLS.test(source)
    })
    .map((file) => relative(REPO_ROOT, file).replace(/\\/g, '/'))
  expect(mangled).toEqual([])
})
