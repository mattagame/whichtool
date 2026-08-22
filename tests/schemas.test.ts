import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIFF_SCHEMA_VERSION } from '../src/core/diff.js'
import { INSPECT_SCHEMA_VERSION } from '../src/core/inspect.js'
import { MCP_TOOL_OUTPUT_SCHEMA } from '../src/core/mcp-server/tools.js'
import { RUN_SCHEMA_VERSION } from '../src/core/run.js'
import { TASK_SET_VERSION } from '../src/core/tasks/schema.js'
import { REPO_ROOT } from './helpers.js'

interface SchemaCase {
  file: string
  exportName: string
  wireProperty?: 'schemaVersion' | 'version'
  wireVersion?: string | number
}

const SCHEMAS: readonly SchemaCase[] = [
  { file: 'common.schema.json', exportName: './schemas/common' },
  { file: 'config.schema.json', exportName: './schemas/config' },
  {
    file: 'task-set.schema.json',
    exportName: './schemas/task-set',
    wireProperty: 'version',
    wireVersion: TASK_SET_VERSION,
  },
  {
    file: 'inspect-report.schema.json',
    exportName: './schemas/inspect-report',
    wireProperty: 'schemaVersion',
    wireVersion: INSPECT_SCHEMA_VERSION,
  },
  {
    file: 'run-report.schema.json',
    exportName: './schemas/run-report',
    wireProperty: 'schemaVersion',
    wireVersion: RUN_SCHEMA_VERSION,
  },
  {
    file: 'diff-report.schema.json',
    exportName: './schemas/diff-report',
    wireProperty: 'schemaVersion',
    wireVersion: DIFF_SCHEMA_VERSION,
  },
  {
    file: 'mcp-result.schema.json',
    exportName: './schemas/mcp-result',
    wireProperty: 'schemaVersion',
    wireVersion: 'whichtool.mcp-result/1',
  },
]

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as Record<string, unknown>
}

function schemaReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaReferences)
  if (value === null || typeof value !== 'object') return []

  const object = value as Record<string, unknown>
  const own = typeof object['$ref'] === 'string' ? [object['$ref']] : []
  return [...own, ...Object.values(object).flatMap(schemaReferences)]
}

function pointerTarget(document: unknown, fragment: string): unknown {
  return fragment
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, part) => {
      if (current === null || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[part]
    }, document)
}

describe('published JSON Schemas', () => {
  test('every schema is valid JSON with a canonical 2020-12 identity', () => {
    for (const schemaCase of SCHEMAS) {
      const schema = json(join('schemas', schemaCase.file))
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema['$id']).toBe(
        `https://raw.githubusercontent.com/mattagame/whichtool/main/schemas/${schemaCase.file}`,
      )

      if (schemaCase.wireProperty !== undefined) {
        const properties = schema['properties'] as Record<string, Record<string, unknown>>
        expect(properties[schemaCase.wireProperty]?.['const']).toBe(schemaCase.wireVersion)
      }
    }
  })

  test('npm pack includes the schema directory and exposes every documented subpath', () => {
    const packageJson = json('package.json')
    expect(packageJson['files']).toContain('schemas')

    const exports = packageJson['exports'] as Record<string, unknown>
    for (const schemaCase of SCHEMAS) {
      expect(exports[schemaCase.exportName]).toBe(`./schemas/${schemaCase.file}`)
    }
  })

  test('every local reference resolves inside the shipped schema directory', () => {
    for (const schemaCase of SCHEMAS) {
      const document = json(join('schemas', schemaCase.file))
      for (const reference of schemaReferences(document)) {
        const [filePart = '', fragment = ''] = reference.split('#', 2)
        const targetFile = filePart === '' ? schemaCase.file : filePart
        const target = json(join('schemas', targetFile))
        expect(pointerTarget(target, fragment)).toBeDefined()
      }
    }
  })

  test('the serialized proportion contract ties nullability to the denominator', () => {
    const common = json(join('schemas', 'common.schema.json'))
    const definitions = common['$defs'] as Record<string, Record<string, unknown>>
    const proportion = definitions['proportion'] as Record<string, unknown>
    const properties = proportion['properties'] as Record<string, Record<string, unknown>>
    const conditions = proportion['allOf'] as Array<Record<string, unknown>>
    const condition = conditions[0] as Record<string, Record<string, unknown>>
    const whenZero = condition['then']?.['properties'] as Record<string, Record<string, unknown>>
    const whenMeasured = condition['else']?.['properties'] as Record<
      string,
      Record<string, unknown>
    >
    const measuredInterval = whenMeasured['ci95'] as Record<string, unknown>

    expect(properties['value']?.['type']).toEqual(['number', 'null'])
    expect(condition['if']).toEqual({
      properties: { denominator: { const: 0 } },
      required: ['denominator'],
    })
    expect(whenZero['value']?.['type']).toBe('null')
    expect(whenZero['ci95']?.['type']).toBe('null')
    expect(whenMeasured['denominator']?.['minimum']).toBe(1)
    expect(whenMeasured['value']?.['type']).toBe('number')
    expect(measuredInterval['prefixItems']).toHaveLength(2)
    expect(measuredInterval['items']).toBe(false)
    expect(proportion['$comment']).toContain('numerator <= denominator')
  })

  test('run/2 preserves every proposed call and marks multi-call trials', () => {
    const run = json(join('schemas', 'run-report.schema.json'))
    const definitions = run['$defs'] as Record<string, Record<string, unknown>>
    const metricsRequired = definitions['runMetrics']?.['required'] as string[]
    const trial = definitions['scoredTrial'] as Record<string, unknown>
    const trialRequired = trial['required'] as string[]
    const trialProperties = trial['properties'] as Record<string, Record<string, unknown>>
    const relationships = trial['allOf'] as Array<Record<string, unknown>>
    const reproducibilityProperties = definitions['reproducibility']?.['properties'] as Record<
      string,
      Record<string, unknown>
    >
    const reportProperties = run['properties'] as Record<string, Record<string, unknown>>
    const metricTrialProperties = (
      definitions['runMetrics']?.['properties'] as Record<string, Record<string, unknown>>
    )['trials']?.['properties'] as Record<string, Record<string, unknown>>

    expect(metricsRequired).toContain('multiCallRate')
    expect(trialRequired).toContain('calls')
    expect(trialRequired).toContain('unexpectedAdditionalCalls')
    expect(trialProperties['verdict']?.['enum']).toContain('unexpected-additional-calls')
    expect(trialProperties['calls']?.['maxItems']).toBe(1000)
    expect(trialProperties['callCount']?.['maximum']).toBe(1000)
    expect(trialProperties['trialIndex']?.['maximum']).toBe(999)
    expect(reproducibilityProperties['temperature']?.['maximum']).toBe(2)
    expect(reproducibilityProperties['repeat']?.['maximum']).toBe(1000)
    expect(reproducibilityProperties['concurrency']?.['maximum']).toBe(64)
    expect(reportProperties['trials']?.['maxItems']).toBe(100000)
    expect(metricTrialProperties['planned']?.['maximum']).toBe(100000)
    expect(metricTrialProperties['scored']?.['maximum']).toBe(100000)
    expect(metricTrialProperties['errored']?.['maximum']).toBe(100000)
    expect(relationships).toContainEqual({
      if: { properties: { calls: { minItems: 2 } }, required: ['calls'] },
      then: { properties: { unexpectedAdditionalCalls: { const: true } } },
      else: { properties: { unexpectedAdditionalCalls: { const: false } } },
    })
    const errorRelationship = relationships.find(
      (relationship) =>
        JSON.stringify(relationship['if']) === JSON.stringify({ required: ['error'] }),
    )
    expect(errorRelationship).toMatchObject({
      then: {
        properties: {
          calls: { maxItems: 0 },
          text: { const: '' },
          callCount: { const: 0 },
          latencyMs: { const: 0 },
          verdict: { const: 'error' },
          askedForClarification: { const: false },
        },
      },
      else: { properties: { verdict: { not: { const: 'error' } } } },
    })
    expect(relationships).toContainEqual({
      if: {
        properties: { verdict: { const: 'unexpected-additional-calls' } },
        required: ['verdict'],
      },
      then: {
        properties: {
          expected: { type: 'string' },
          pick: { type: 'string' },
          calls: { minItems: 2 },
          unexpectedAdditionalCalls: { const: true },
        },
      },
    })
    expect(relationships).toContainEqual({
      if: {
        properties: {
          expected: { type: 'null' },
          calls: { minItems: 1 },
          verdict: { not: { const: 'error' } },
        },
        required: ['expected', 'calls', 'verdict'],
      },
      then: { properties: { verdict: { const: 'over-triggered' } } },
    })
    expect(trial['$comment']).toContain('callCount === calls.length')
    expect(trial['$comment']).toContain('calls[0]')
  })

  test('run thresholds are closed and tied to the metrics checked at runtime', () => {
    const run = json(join('schemas', 'run-report.schema.json'))
    const properties = run['properties'] as Record<string, Record<string, unknown>>
    const definitions = run['$defs'] as Record<string, Record<string, unknown>>
    const thresholds = properties['thresholds'] as Record<string, unknown>
    const runThreshold = definitions['runThreshold'] as Record<string, unknown>

    expect(thresholds['items']).toEqual({ $ref: '#/$defs/runThreshold' })
    expect(runThreshold['additionalProperties']).toBe(false)
    expect(runThreshold['oneOf']).toHaveLength(3)
    expect(runThreshold['$comment']).toContain('metrics or contextCost')
  })

  test('run headline ok includes execution, thresholds, and error diagnostics', () => {
    const run = json(join('schemas', 'run-report.schema.json'))
    const headline = (run['allOf'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>

    expect(headline['$comment']).toContain('no error-severity diagnostic')
    expect(headline['then']).toEqual({ properties: { ok: { const: true } } })
    expect(headline['else']).toEqual({ properties: { ok: { const: false } } })
    expect(JSON.stringify(headline['if'])).toContain('thresholdsOk')
    expect(JSON.stringify(headline['if'])).toContain('severity')
  })

  test('the MCP envelope requires exactly one data or error branch', () => {
    const published = json(join('schemas', 'mcp-result.schema.json'))
    const { $schema: _schema, $id: _id, title: _title, oneOf, ...publishedBase } = published
    const { oneOf: _advertisedBranches, ...advertisedBase } = MCP_TOOL_OUTPUT_SCHEMA

    expect(publishedBase).toEqual(advertisedBase)
    expect(JSON.stringify(_advertisedBranches)).toBe(JSON.stringify(oneOf))
    expect(oneOf).toEqual([
      { required: ['data'], not: { required: ['error'] } },
      {
        properties: { ok: { const: false } },
        required: ['error'],
        not: { required: ['data'] },
      },
    ])
    expect((oneOf as Array<Record<string, unknown>>)[0]?.['properties']).toBeUndefined()
  })
})
