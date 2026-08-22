import { WhichtoolError } from '../core/errors.js'

export type FlagType = 'string' | 'number' | 'boolean'

export interface FlagSpec {
  type: FlagType
  alias?: string
  description: string
  placeholder?: string

  negatable?: boolean
}

export type FlagSpecs = Record<string, FlagSpec>

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | number | boolean>
}

function fail(message: string, hint?: string): never {
  throw new WhichtoolError('cli/bad-arguments', message, hint)
}

function coerce(name: string, spec: FlagSpec, raw: string): string | number | boolean {
  if (spec.type === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value)) fail(`\`--${name}\` expects a number, got \`${raw}\`.`)
    return value
  }
  if (spec.type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    fail(`\`--${name}\` expects true or false, got \`${raw}\`.`)
  }
  return raw
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const byAlias = new Map<string, string>()
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias !== undefined) byAlias.set(spec.alias, name)
  }

  const positionals: string[] = []
  const flags: Record<string, string | number | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string

    if (argument === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }

    if (!argument.startsWith('-') || argument === '-') {
      positionals.push(argument)
      continue
    }

    let name: string
    let inlineValue: string | undefined

    if (argument.startsWith('--')) {
      const body = argument.slice(2)
      const equals = body.indexOf('=')
      name = equals === -1 ? body : body.slice(0, equals)
      if (equals !== -1) inlineValue = body.slice(equals + 1)
    } else {
      const body = argument.slice(1)
      const resolved = byAlias.get(body)
      if (resolved === undefined) {
        fail(`Unknown flag \`-${body}\`.`, 'Run `whichtool --help` for the list.')
      }
      name = resolved
    }

    if (specs[name] === undefined && name.startsWith('no-')) {
      const positive = name.slice(3)
      const spec = specs[positive]
      if (spec !== undefined && spec.type === 'boolean' && spec.negatable !== false) {
        flags[positive] = false
        continue
      }
    }

    const spec = specs[name]
    if (spec === undefined) {
      fail(`Unknown flag \`--${name}\`.`, 'Run `whichtool --help` for the list.')
    }

    if (spec.type === 'boolean' && inlineValue === undefined) {
      flags[name] = true
      continue
    }

    let raw = inlineValue
    if (raw === undefined) {
      const next = argv[index + 1]
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        fail(`\`--${name}\` expects a value.`)
      }
      raw = next
      index += 1
    }
    flags[name] = coerce(name, spec, raw)
  }

  return { positionals, flags }
}

export function renderHelp(usage: string, specs: FlagSpecs): string {
  return [usage, 'Flags:', ...renderFlagHelp(specs), ''].join('\n')
}

export function renderFlagHelp(specs: FlagSpecs, indent = '  '): string[] {
  const entries = Object.entries(specs).map(([name, spec]) => {
    const alias = spec.alias === undefined ? '' : `-${spec.alias}, `
    const placeholder = spec.type === 'boolean' ? '' : ` <${spec.placeholder ?? spec.type}>`
    return { label: `${alias}--${name}${placeholder}`, description: spec.description }
  })
  const width = Math.max(...entries.map((entry) => entry.label.length), 0)
  return entries.map((entry) => `${indent}${entry.label.padEnd(width)}  ${entry.description}`)
}
