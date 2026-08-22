import { WhichtoolError } from '../core/errors.js'
import { createAnthropicProvider } from '../core/providers/anthropic.js'
import { createMockProvider } from '../core/providers/mock.js'
import {
  createOllamaProvider,
  createOpenAiCompatibleProvider,
} from '../core/providers/openai-compatible.js'
import { createOpenAiResponsesProvider } from '../core/providers/openai-responses.js'
import type { Provider } from '../core/providers/types.js'
import type { ProviderConfig } from '../config.js'
import type { Runtime } from '../runtime/types.js'

interface Preset {
  baseUrl: string
  apiKeyEnv: string | null

  requiresKey: boolean
  api?: 'anthropic' | 'chat-completions' | 'responses'
  defaultModel?: string
}

const PRESETS: Record<string, Preset> = {
  // No `/v1` suffix: the Anthropic provider speaks `/v1/messages`, not `/chat/completions`.
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    requiresKey: true,
    api: 'anthropic',
  },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: null, requiresKey: false },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    requiresKey: true,
    api: 'responses',
  },
  'openai-chat': {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    requiresKey: true,
    api: 'chat-completions',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    requiresKey: true,
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    requiresKey: true,
  },
  vllm: { baseUrl: 'http://127.0.0.1:8000/v1', apiKeyEnv: null, requiresKey: false },
  'openai-compatible': {
    baseUrl: '',
    apiKeyEnv: 'WHICHTOOL_PROVIDER_API_KEY',
    requiresKey: false,
  },
}

export const PROVIDER_NAMES = ['mock', ...Object.keys(PRESETS)].sort()

export interface CreateProviderOptions {
  config: ProviderConfig | undefined

  name?: string | undefined

  model?: string | undefined
  baseUrl?: string | undefined
  /** Provider-side reasoning knob. Only the OpenAI-compatible path accepts one today. */
  reasoningEffort?: string | undefined
}

export function createProviderFromConfig(
  runtime: Runtime,
  options: CreateProviderOptions,
): Provider {
  const name = options.name ?? options.config?.name
  if (name === undefined) {
    throw new WhichtoolError(
      'provider/missing',
      'No provider configured.',
      `Pass --provider, or set \`provider.name\` in the config. Available: ${PROVIDER_NAMES.join(', ')}.`,
    )
  }

  if (name === 'mock') {
    // Reachable from the CLI on purpose: it makes `whichtool run` demonstrable, and
    // testable in CI, with no endpoint at all.
    return createMockProvider({
      model: options.model ?? options.config?.model ?? 'mock-1',
      script: () => ({ pick: null, text: 'the mock provider chooses nothing by default' }),
      // The script is a constant, so it may participate in the trial cache; without this
      // identity a function-valued script is treated as unrepresentable and never cached.
      cacheKey: 'cli-default-abstain/1',
    })
  }

  const preset = PRESETS[name]
  if (preset === undefined) {
    throw new WhichtoolError(
      'provider/unknown',
      `Unknown provider \`${name}\`.`,
      `Available: ${PROVIDER_NAMES.join(', ')}.`,
    )
  }

  const model = options.model ?? options.config?.model ?? preset.defaultModel
  if (model === undefined) {
    throw new WhichtoolError(
      'provider/no-model',
      `\`${name}\` needs a model.`,
      'Pass --model, or set `provider.model` in the config.',
    )
  }

  const baseUrl = options.baseUrl ?? options.config?.baseUrl ?? preset.baseUrl
  if (baseUrl === '') {
    throw new WhichtoolError(
      'provider/no-base-url',
      '`openai-compatible` needs a base URL.',
      'Set `provider.baseUrl` in the config, for example `http://127.0.0.1:8000/v1`.',
    )
  }

  const apiKey = preset.apiKeyEnv === null ? undefined : runtime.env(preset.apiKeyEnv)
  if (preset.requiresKey && (apiKey === undefined || apiKey === '')) {
    throw new WhichtoolError(
      'provider/no-api-key',
      `\`${name}\` needs an API key and \`${preset.apiKeyEnv}\` is not set.`,
      'whichtool reads keys only from the environment; it will not take one from a config file.',
    )
  }

  if (preset.api === 'anthropic') {
    return createAnthropicProvider({ baseUrl, model, apiKey })
  }

  if (preset.api === 'responses') {
    return createOpenAiResponsesProvider({
      id: name,
      baseUrl,
      model,
      apiKey,
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
    })
  }

  if (name === 'ollama') {
    return createOllamaProvider({ baseUrl, model })
  }

  return createOpenAiCompatibleProvider({
    id: name,
    baseUrl,
    model,
    apiKey,
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
  })
}
