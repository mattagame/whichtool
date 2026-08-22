import { describe, expect, test } from 'bun:test'
import { buildInspectReport } from '../src/core/inspect.js'
import { MCP_SERVER_TOOLS, mcpServerToolsSnapshot } from '../src/core/mcp-server/tools.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'

/**
 * whichtool inspecting its own MCP surface.
 *
 * A tool that measures whether tool surfaces are readable has no business shipping an
 * unreadable one. This is the only test in the suite whose subject is the project itself,
 * and it is the one that would catch the most embarrassing regression: two whichtool tools
 * drifting towards each other until an agent cannot tell them apart.
 */
const surface = await loadSurface(
  snapshotTransportFromData(mcpServerToolsSnapshot(), 'whichtool-mcp-server'),
)
const report = buildInspectReport(surface)

describe("whichtool's own tool surface", () => {
  test('passes its own inspection with no errors and no warnings', () => {
    const loud = report.diagnostics.filter((d) => d.severity !== 'info')
    expect(loud.map((d) => `${d.code}: ${d.message}`)).toEqual([])
  })

  test('no two of its tools are lexically confusable', () => {
    const high = report.overlap.pairs.filter((pair) => pair.score >= 0.4)
    expect(
      high.map((pair) => `${pair.tools[0]} <-> ${pair.tools[1]} @ ${pair.score.toFixed(2)}`),
    ).toEqual([])
  })

  test('every tool declares all four annotations', () => {
    expect(report.annotations.coverage.annotated).toBe(MCP_SERVER_TOOLS.length)
    for (const hint of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const) {
      expect(report.annotations.coverage.byHint[hint]).toBe(MCP_SERVER_TOOLS.length)
    }
  })

  test('run_evaluation is honest about not being read-only', () => {
    // It spends money or GPU time and writes the trial cache. Claiming otherwise would be
    // precisely the kind of annotation this project exists to catch.
    const run = surface.tools.find((tool) => tool.name === 'run_evaluation')
    expect(run?.annotations?.['readOnlyHint']).toBe(false)
    expect(run?.annotations?.['openWorldHint']).toBe(true)
  })

  test('only the file-only comparison tool declares itself read-only', () => {
    for (const name of ['inspect_surface', 'validate_task_file']) {
      const tool = surface.tools.find((item) => item.name === name)
      expect(tool?.annotations?.['readOnlyHint']).toBe(false)
    }
    const diff = surface.tools.find((item) => item.name === 'diff_saved_results')
    expect(diff?.annotations?.['readOnlyHint']).toBe(true)
  })

  test('stays inside a modest token budget', () => {
    // An agent pays for this surface on every request it makes. Cheap to keep, expensive
    // to notice too late.
    expect(surface.tokens.total).toBeLessThan(1700)
  })

  test('no description names another tool, which would invite a wrong pick', () => {
    for (const tool of surface.tools) {
      const others = surface.tools
        .filter((item) => item.name !== tool.name)
        .map((item) => item.name)
      for (const other of others) {
        // Cross-references are fine in prose; what is not fine is a bare tool name that a
        // model could latch onto as the answer.
        const bare = new RegExp(`(^|[^\`\\w])${other}([^\`\\w]|$)`)
        expect({ tool: tool.name, mentions: bare.test(tool.description) ? other : null }).toEqual({
          tool: tool.name,
          mentions: null,
        })
      }
    }
  })
})
