import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './helpers.js'

function repositoryFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

function workflowJob(source: string, name: string): string {
  const normalized = source.replace(/\r\n/g, '\n')
  const marker = `  ${name}:\n`
  const start = normalized.indexOf(marker)
  if (start < 0) throw new Error(`missing workflow job: ${name}`)
  const remainder = normalized.slice(start + marker.length)
  const nextJob = remainder.search(/^ {2}[a-z][a-z0-9_-]*:\n/m)
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob)
}

function actionDefinitionFiles(): string[] {
  const files = ['action.yml']
  const visit = (directory: string): void => {
    const absolute = join(REPO_ROOT, directory)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = join(absolute, entry.name)
      if (entry.isDirectory()) {
        visit(relative(REPO_ROOT, path))
      } else if (/\.ya?ml$/.test(entry.name)) {
        files.push(relative(REPO_ROOT, path).replace(/\\/g, '/'))
      }
    }
  }
  visit('.github/workflows')
  visit('.github/actions')
  visit('examples/github-action')
  return files
}

describe('release hardening', () => {
  test('compiled executables cannot autoload local dotenv or bunfig files', () => {
    const build = repositoryFile('scripts/build-binaries.ts')
    expect(build).toContain("'--no-compile-autoload-dotenv'")
    expect(build).toContain("'--no-compile-autoload-bunfig'")
  })

  test('a release is main-only and npm publishing uses short-lived OIDC credentials', () => {
    const workflow = repositoryFile('.github/workflows/release.yml')
    const npm = workflowJob(workflow, 'npm')
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
    expect(workflow).toContain('id-token: write')
    expect(npm).toContain('registry-url: https://registry.npmjs.org')
    expect(npm).toContain('package-manager-cache: false')
    expect(npm).toContain('npm publish --ignore-scripts --access public')
    expect(npm).toContain('published_git_head')
    expect(npm).toContain('expected_git_head="$(git rev-parse HEAD)"')
    expect(npm).toContain('"$expected_git_head"')
    expect(npm).toContain('[[ "$published_git_head" == *"E404"* ]]')
    expect(npm).toContain('exit "$view_status"')
    expect(workflow).not.toContain('NPM_TOKEN')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  test('publishing cannot bypass the quality gate or protected environments', () => {
    const workflow = repositoryFile('.github/workflows/release.yml')
    const quality = workflowJob(workflow, 'quality')
    const npm = workflowJob(workflow, 'npm')
    const container = workflowJob(workflow, 'container')
    const release = workflowJob(workflow, 'release')

    expect(quality).toContain('needs: verify')
    for (const command of [
      'bun run typecheck',
      'bun run lint',
      'bun run format:check',
      'bun test',
      'bun run build',
      'npm pack --dry-run',
    ]) {
      expect(quality).toContain(command)
    }
    expect(npm).toContain('needs: quality')
    expect(npm).toContain('environment: npm')
    expect(npm).toContain('id-token: write')
    expect(container).toContain('needs: npm')
    expect(container).toContain('provenance: mode=max')
    expect(container).toContain('sbom: true')
    expect(release).toContain('needs: container')
    expect(release).toContain('environment: release')
    expect(release).toContain('contents: write')
  })

  test('every third-party GitHub Action is pinned to a full commit SHA', () => {
    for (const path of actionDefinitionFiles()) {
      const source = repositoryFile(path)
      const references = [...source.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map(
        (match) => match[1] ?? '',
      )
      expect(references.length).toBeGreaterThan(0)
      for (const reference of references) {
        if (reference.startsWith('./')) continue
        const pinned = reference.startsWith('docker://')
          ? /@sha256:[a-f0-9]{64}$/.test(reference)
          : /@[a-f0-9]{40}$/.test(reference)
        expect({ path, reference, pinned }).toMatchObject({ pinned: true })
      }
    }
  })

  test('binary publication stays disabled until embedded-runtime notices are complete', () => {
    const workflow = repositoryFile('.github/workflows/release.yml')
    expect(workflow).not.toContain('bun run build:binaries')
    expect(workflow).not.toContain('softprops/action-gh-release')
    expect(workflow).not.toContain('binaries/whichtool-')
  })

  test('the composite action persists trial material only after an explicit opt-in', () => {
    const action = repositoryFile('action.yml')
    expect(action).toMatch(/cache:\s+description:[\s\S]*?default: 'false'/)
    expect(action).toContain("inputs.provider != '' && inputs.cache == 'true'")
    expect(action).toContain('key: whichtool-v1-${{ github.ref }}-')
    expect(action).toContain('args+=(--no-cache)')
    expect(action).not.toContain('restore-keys:')
  })

  test('Docker excludes local credentials and gives the runtime user a writable workdir', () => {
    const ignored = repositoryFile('.dockerignore').split(/\r?\n/)
    const dockerfile = repositoryFile('Dockerfile')
    expect(ignored).toContain('.env')
    expect(ignored).toContain('.env.*')
    expect(ignored).toContain('.npmrc')
    const baseImages = dockerfile.match(/^FROM .+$/gm) ?? []
    expect(baseImages).toHaveLength(2)
    for (const baseImage of baseImages) {
      expect(baseImage).toMatch(/^FROM \S+:\S+@sha256:[a-f0-9]{64}(?: AS [a-z][a-z0-9_-]*)?$/)
    }
    expect(dockerfile).toMatch(/WORKDIR \/work\r?\nRUN chown node:node \/work\r?\nUSER node/)
  })

  test('CI builds and smoke-tests the container image', () => {
    const workflow = repositoryFile('.github/workflows/ci.yml')
    const container = workflowJob(workflow, 'container')
    expect(container).toContain('docker build --tag whichtool:test .')
    expect(container).toContain('docker run --rm whichtool:test --version')
    expect(container).toContain('docker run --rm whichtool:test --help')
  })
})
