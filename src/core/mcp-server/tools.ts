import type { JsonObject, RawTool } from '../types.js'
import { ABSOLUTE_MAX_TOOLS, ABSOLUTE_MAX_TRIALS } from '../eval/options.js'

const TARGET_PROPERTY: JsonObject = {
  type: 'string',
  description:
    'Optional target override. By default whichtool uses the target selected in its startup config and rejects this field. The server operator must explicitly enable dynamic targets before a path, URL, or stdio command supplied by an agent is accepted.',
}

const TRANSPORT_PROPERTY: JsonObject = {
  type: 'string',
  enum: ['snapshot', 'http', 'stdio'],
  description:
    'Transport for a target override. Rejected with target overrides unless the server operator enabled dynamic targets.',
}

export const MCP_MAX_REPEAT = 20
export const MCP_MAX_TRIALS = ABSOLUTE_MAX_TRIALS
export const MCP_MAX_TOOLS = ABSOLUTE_MAX_TOOLS
export const MCP_MAX_CONCURRENCY = 16

/** Shared machine-readable result envelope returned by every whichtool MCP tool. */
export const MCP_TOOL_OUTPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', const: 'whichtool.mcp-result/1' },
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    data: {},
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string' },
        detail: {},
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'ok', 'summary'],
  oneOf: [
    { required: ['data'], not: { required: ['error'] } },
    {
      properties: { ok: { const: false } },
      required: ['error'],
      not: { required: ['data'] },
    },
  ],
  additionalProperties: false,
}

export const MCP_SERVER_TOOLS: readonly RawTool[] = [
  {
    name: 'inspect_surface',
    title: 'Inspect a tool surface',
    description:
      'Diagnose the vocabulary and schema footprint published by the operator-selected endpoint. Returns token allocation, annotation contradictions, duplicate or near-duplicate wording, and malformed header metadata. Static analysis only: it never asks an LLM or invokes a listed capability. Opening the endpoint may use target authentication or start its configured process.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_PROPERTY,
        transport: TRANSPORT_PROPERTY,
        maxContextTokens: {
          type: 'integer',
          minimum: 0,
          description: 'Report a failure when the whole tool list costs more tokens than this.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: MCP_TOOL_OUTPUT_SCHEMA,
    annotations: {
      // Inspecting a configured live target can launch a subprocess or contact a server.
      // That is non-destructive, but it is not read-only in the MCP trust sense.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  {
    name: 'run_evaluation',
    title: 'Measure which tool a model picks',
    description:
      'Show a language model what an MCP server offers, ask it a prepared set of questions repeatedly with the ordering shuffled, and record what it reaches for each time. Yields a confusion matrix, per-entry hit rates with confidence intervals, and which pairs get mistaken for each other. Spends money or GPU time and takes minutes. Operator-owned real-run limits default to 50 trials and 6 tools; dryRun reports them. Never invokes anything on the server under measurement.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_PROPERTY,
        transport: TRANSPORT_PROPERTY,
        tasks: {
          type: 'string',
          description:
            'Optional workspace-relative task file. When omitted, uses tasks from the startup config; paths outside the workspace are rejected.',
        },
        provider: {
          type: 'string',
          description:
            'Optional model service override, for example ollama or openai. Rejected unless the server operator separately enabled provider overrides at startup.',
        },
        model: {
          type: 'string',
          description:
            'Optional model override. Rejected unless the server operator separately enabled provider overrides at startup.',
        },
        repeat: {
          type: 'integer',
          minimum: 1,
          maximum: MCP_MAX_REPEAT,
          description: `How many times to repeat each task (hard limit ${MCP_MAX_REPEAT}). More repeats measure within-task stability; they do not add new task intents.`,
        },
        concurrency: {
          type: 'integer',
          minimum: 1,
          maximum: MCP_MAX_CONCURRENCY,
          description: `Maximum simultaneous provider calls (hard limit ${MCP_MAX_CONCURRENCY}).`,
        },
        dryRun: {
          type: 'boolean',
          description:
            'Count trials and show a prompt-token lower bound without sending anything to the model. Output and reasoning tokens are not included.',
        },
        minAccuracy: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Report a failure when fewer than this fraction of trials chose the intended tool.',
        },
        maxOverTrigger: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Report a failure when more than this fraction of the deliberately unanswerable tasks got a tool call anyway.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: MCP_TOOL_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  {
    name: 'validate_task_file',
    title: 'Check a question file',
    description:
      'Check whether a prepared routing benchmark is fit to score. Finds duplicate ids, invalid expected names, coverage gaps, and too few negative prompts. If a catalogue is configured, it opens it solely to resolve expected names; it never asks an LLM or invokes a listed capability.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'string',
          description:
            'Optional workspace-relative task file. When omitted, uses tasks from the startup config; paths outside the workspace are rejected.',
        },
        target: {
          type: 'string',
          description:
            'Optional. Supply the MCP server too and the checks that compare the tasks against the real tool names are performed as well.',
        },
        transport: TRANSPORT_PROPERTY,
      },
      additionalProperties: false,
    },
    outputSchema: MCP_TOOL_OUTPUT_SCHEMA,
    annotations: {
      // With a configured target this validation may also start/contact that target.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  {
    name: 'diff_saved_results',
    title: 'Compare two stored findings',
    description:
      'Given two stored findings, report what shifted: overall and per-entry hit rates, newly mistaken pairs, and movement in the token budget. Declines to subtract findings produced under unlike settings and uses an exact paired sign test over matched trials before calling a shift distinguishable. Opens two files, contacts nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          description: 'Path to the earlier stored finding, the one to compare against.',
        },
        head: {
          type: 'string',
          description: 'Path to the later stored finding, the one under review.',
        },
        maxAccuracyDrop: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Report a failure when the later result is worse than the earlier one by more than this fraction, beyond chance.',
        },
      },
      required: ['base', 'head'],
      additionalProperties: false,
    },
    outputSchema: MCP_TOOL_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
]

/** The surface in the shape a captured `tools/list` has, for dogfooding it with `inspect`. */
export function mcpServerToolsSnapshot(): JsonObject {
  return { tools: MCP_SERVER_TOOLS as unknown as JsonObject[] } as unknown as JsonObject
}
