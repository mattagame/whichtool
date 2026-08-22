import { describe, expect, test } from 'bun:test'
import { loadConfig, validateConfig } from '../src/cli/config-loader.js'
import { createFakeRuntime } from './helpers.js'

describe('runtime config validation', () => {
  test('accepts a complete valid config', () => {
    expect(
      validateConfig({
        target: { transport: 'stdio', command: 'server', args: ['--stdio'], env: { A: 'b' } },
        tasks: 'surface.tasks.yaml',
        provider: { name: 'openai', model: 'gpt-5.6' },
        trials: {
          repeat: 5,
          permute: true,
          temperature: 0,
          concurrency: 4,
          seed: 1,
          reasoningEffort: 'medium',
        },
        thresholds: { minAccuracy: 0.9, maxErrorRate: 0.1, minScored: 1 },
        report: { formats: ['json', 'junit'], out: 'run' },
      }),
    ).toBeTruthy()
  })

  test('rejects wrong types, unknown keys, and out-of-range values', () => {
    expect(() => validateConfig({ trials: { repeat: 'many' } })).toThrow('trials.repeat')
    expect(() => validateConfig({ trials: { concurrency: 0 } })).toThrow('trials.concurrency')
    expect(() => validateConfig({ trials: { temperature: 3 } })).toThrow('trials.temperature')
    expect(() => validateConfig({ trials: { reasoningEffort: '' } })).toThrow(
      'trials.reasoningEffort',
    )
    expect(() => validateConfig({ thresholds: { minAccuracy: 1.1 } })).toThrow(
      'thresholds.minAccuracy',
    )
    expect(() => validateConfig({ threshold: { minAccuracy: 0.9 } })).toThrow(
      'not a recognised option',
    )
  })

  test('uses the same validator for JSON and JavaScript/TypeScript modules', async () => {
    const jsonRuntime = createFakeRuntime({ files: { 'bad.json': '{"trials":{"repeat":0}}' } })
    await expect(loadConfig(jsonRuntime, 'bad.json')).rejects.toThrow('trials.repeat')

    for (const extension of ['js', 'ts']) {
      const runtime = createFakeRuntime({
        files: { [`bad.${extension}`]: '// module placeholder' },
      })
      runtime.importModule = async () => ({ default: { trials: { concurrency: Number.NaN } } })
      await expect(loadConfig(runtime, `bad.${extension}`)).rejects.toThrow('trials.concurrency')
    }
  })
})
