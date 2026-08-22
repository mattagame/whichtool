import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WHICHTOOL_VERSION } from '../src/version.js'
import { REPO_ROOT } from './helpers.js'

test('src/version.ts and package.json do not drift', () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
  expect(WHICHTOOL_VERSION).toBe(packageJson.version)
})
