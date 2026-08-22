import { describe, expect, test } from 'bun:test'
import { buildInspectReport } from '../src/core/inspect.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import type { Transport } from '../src/core/transport/types.js'
import { main } from '../src/cli/run.js'
import { createFakeRuntime, fixturePath, readFixture } from './helpers.js'

/**
 * SPEC §3.1 is the design principle whichtool would be unsafe without: it never executes
 * a tool. These tests are what stops that from quietly regressing.
 */

interface RecordingTransport {
  transport: Transport
  accessed: string[]
  listToolsCalls: number
}

function recordingTransport(payload: unknown, ref: string): RecordingTransport {
  const inner = snapshotTransportFromData(payload, ref)
  const accessed: string[] = []
  let listToolsCalls = 0

  const proxied = new Proxy(inner, {
    get(target, property, receiver) {
      if (typeof property === 'string') accessed.push(property)
      if (property === 'listTools') {
        return async () => {
          listToolsCalls += 1
          return target.listTools()
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

  return {
    transport: proxied,
    accessed,
    get listToolsCalls() {
      return listToolsCalls
    },
  }
}

describe('the non-execution guarantee', () => {
  test('a full inspection touches listTools and nothing else', async () => {
    const recorder = recordingTransport(readFixture('clean.json'), 'clean.json')
    const surface = await loadSurface(recorder.transport)
    buildInspectReport(surface)

    const allowed = new Set(['kind', 'ref', 'listTools', 'close', 'then'])
    const unexpected = [...new Set(recorder.accessed)].filter((name) => !allowed.has(name))
    expect(unexpected).toEqual([])
    expect(recorder.listToolsCalls).toBe(1)
  })

  test('the Transport interface exposes no way to invoke a tool', () => {
    const transport = snapshotTransportFromData({ tools: [] }, 'inline')
    for (const forbidden of ['callTool', 'call', 'invoke', 'execute', 'run']) {
      expect((transport as unknown as Record<string, unknown>)[forbidden]).toBeUndefined()
    }
  })

  test('the CLI performs no network call while inspecting a snapshot', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      throw new Error('whichtool must not reach the network while inspecting a snapshot')
    }) as unknown as typeof fetch

    try {
      const runtime = createFakeRuntime()
      const code = await main(['inspect', fixturePath('no-annotations.json')], runtime)
      expect(code).toBe(0)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
