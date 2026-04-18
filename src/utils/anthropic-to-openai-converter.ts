import type { AnthropicResponse } from '../types'

// Anthropic types
interface AnthropicMessage {
  id: string
  model: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  stop_reason?: string
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking'
  id?: string
  name?: string
  text?: string
  thinking?: string
  input?: unknown
}

interface AnthropicStreamEvent {
  type: string
  message?: AnthropicMessage
  content_block?: AnthropicContentBlock
  delta?: {
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  index?: number
  model?: string
  stop_reason?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

interface AnthropicFullResponse {
  id: string
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// OpenAI types
interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAIUsage
}

// OpenAI's usage shape, extended to carry Anthropic's cache metrics.
// `prompt_tokens_details.cached_tokens` is the OpenAI-native field for
// "tokens served from a cache hit" — openai/types exposes it for their own
// cache, and OpenAI-compat clients (openclaw, Cursor) read it. Mapping
// Anthropic's `cache_read_input_tokens` into it keeps clients vendor-neutral.
//
// `cache_creation_tokens` is a non-standard passthrough of
// `cache_creation_input_tokens`: useful for diagnostics but won't be read
// by generic OpenAI clients. We still emit it — it's cheap, it lives under
// `prompt_tokens_details` which OpenAI tolerates for extras, and it's the
// only way a caller can tell a first-write from an uncached miss.
interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens: number
    cache_creation_tokens?: number
  }
}

interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage: OpenAIUsage
}

// Internal types
interface ToolCallTracker {
  id: string
  name: string
  arguments: string
}

interface MetricsData {
  model: string
  stop_reason: string | null
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  messageId: string | null
  openAIId: string | null
  inThinking: boolean
  hadThinking: boolean
  answerStarted: boolean
}

interface ProcessResult {
  type: 'chunk' | 'done' | 'ping'
  data?: OpenAIStreamChunk
}

// Converter state that needs to be maintained during streaming
export interface ConverterState {
  toolCallsTracker: Map<number, ToolCallTracker>
  metricsData: MetricsData
}

// Create initial converter state
export function createConverterState(): ConverterState {
  return {
    toolCallsTracker: new Map(),
    metricsData: {
      model: '',
      stop_reason: null,
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      messageId: null,
      openAIId: null,
      inThinking: false,
      hadThinking: false,
      answerStarted: false,
    },
  }
}

// Convert non-streaming response to OpenAI format (stateless)
export function convertNonStreamingResponse(
  anthropicResponse: AnthropicResponse | AnthropicFullResponse,
): OpenAIResponse {
  const openAIResponse: OpenAIResponse = {
    id:
      'chatcmpl-' +
      (anthropicResponse.id || Date.now()).toString().replace('msg_', ''),
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model || 'claude-unknown',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [],
        },
        finish_reason:
          anthropicResponse.stop_reason === 'end_turn'
            ? 'stop'
            : anthropicResponse.stop_reason === 'tool_use'
            ? 'tool_calls'
            : anthropicResponse.stop_reason || null,
      },
    ],
    usage: buildOpenAIUsage({
      input_tokens: anthropicResponse.usage?.input_tokens || 0,
      output_tokens: anthropicResponse.usage?.output_tokens || 0,
      cache_creation_input_tokens:
        anthropicResponse.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens:
        anthropicResponse.usage?.cache_read_input_tokens || 0,
    }),
  }

  // Process content blocks
  let textContent = ''
  for (const block of anthropicResponse.content || []) {
    if (block.type === 'thinking' && block.thinking) {
      // Render thinking as styled italic markdown
      const lines = block.thinking
        .split(/\n+/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0)
        .map((t: string) => `*${t}*`)
        .join('\n\n')
      textContent += `\n\n${lines}\n\n---\n\n`
      continue
    } else if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'tool_use' && block.id && block.name) {
      openAIResponse.choices[0].message.tool_calls.push({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      })
    }
  }

  // Set content only if there's text
  if (textContent) {
    openAIResponse.choices[0].message.content = textContent
  }

  return openAIResponse
}

// Process a chunk and update the state
export function processChunk(
  state: ConverterState,
  chunk: string,
  enableLogging: boolean = false,
): ProcessResult[] {
  const results: ProcessResult[] = []
  const lines = chunk.split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (trimmedLine === '') continue

    // Skip event lines in OpenAI format
    if (trimmedLine.startsWith('event:')) {
      continue
    }

    if (trimmedLine.startsWith('data: ') && trimmedLine.includes('{')) {
      try {
        const data: AnthropicStreamEvent = JSON.parse(
          trimmedLine.replace(/^data: /, ''),
        )

        // Forward ping events as keepalive signals
        if (data.type === 'ping') {
          results.push({ type: 'ping' })
          continue
        }

        // Handle content_block_stop — close thinking if this was a thinking block
        if (data.type === 'content_block_stop') {
          if (state.metricsData.inThinking) {
            state.metricsData.inThinking = false
            const closeChunk: OpenAIStreamChunk = {
              id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: state.metricsData.model || 'claude-unknown',
              choices: [{
                index: 0,
                delta: { content: '\n\n---\n\n' },
                finish_reason: null,
              }],
            }
            results.push({ type: 'chunk', data: closeChunk })
          }
          continue
        }

        // Skip text and thinking content_block_start (we only care about tool_use blocks)
        if (
          data.type === 'content_block_start' &&
          (data.content_block?.type === 'text' || data.content_block?.type === 'thinking')
        ) {
          continue
        }

        // Update metrics
        updateMetrics(state.metricsData, data)

        // Transform to OpenAI format
        const openAIChunk = transformToOpenAI(state, data, enableLogging)

        if (openAIChunk) {
          results.push({
            type: 'chunk',
            data: openAIChunk,
          })
        }

        // Fallback: close thinking if still open when message stops
        if (data.type === 'message_stop' && state.metricsData.inThinking) {
          state.metricsData.inThinking = false
          const thinkingChunk: OpenAIStreamChunk = {
            id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: state.metricsData.model || 'claude-unknown',
            choices: [{
              index: 0,
              delta: { content: '\n\n---\n\n' },
              finish_reason: null,
            }],
          }
          results.push({ type: 'chunk', data: thinkingChunk })
        }

        // Send usage chunk and [DONE] when message stops
        if (data.type === 'message_stop') {
          // Send usage information chunk before [DONE]
          const usageChunk = createUsageChunk(state)
          if (usageChunk) {
            results.push({
              type: 'chunk',
              data: usageChunk,
            })
          }

          results.push({
            type: 'done',
          })
        }
      } catch (parseError) {
        if (enableLogging) {
          console.error('Parse error:', parseError)
        }
      }
    }
  }

  return results
}

// Update metrics data
function updateMetrics(
  metricsData: MetricsData,
  data: AnthropicStreamEvent,
): void {
  if (data.type === 'message_start' && data.message) {
    metricsData.messageId = data.message.id
    if (data.message.model) {
      metricsData.model = data.message.model
    }
  }

  if (data.model) {
    metricsData.model = data.model
  }

  if (data.stop_reason) {
    metricsData.stop_reason = data.stop_reason
  }

  if (data.type === 'message_delta' && data?.delta?.stop_reason) {
    metricsData.stop_reason = data.delta.stop_reason
  }

  if (data.usage) {
    metricsData.input_tokens += data.usage.input_tokens || 0
    metricsData.output_tokens += data.usage.output_tokens || 0
    metricsData.cache_creation_input_tokens +=
      data.usage.cache_creation_input_tokens || 0
    metricsData.cache_read_input_tokens +=
      data.usage.cache_read_input_tokens || 0
  }

  if (data?.message?.usage) {
    if (data?.message?.model) {
      metricsData.model = data.message.model
    }
    metricsData.input_tokens += data.message.usage.input_tokens || 0
    metricsData.output_tokens += data.message.usage.output_tokens || 0
    metricsData.cache_creation_input_tokens +=
      data.message.usage.cache_creation_input_tokens || 0
    metricsData.cache_read_input_tokens +=
      data.message.usage.cache_read_input_tokens || 0
  }

  if (data?.message?.stop_reason) {
    metricsData.stop_reason = data.message.stop_reason
  }
}

// Map Anthropic's token accounting to OpenAI's shape.
//
// Semantic gotcha: Anthropic reports `input_tokens` as the UNCACHED
// remainder only — cached bytes are reported separately. OpenAI's
// `prompt_tokens` is the TOTAL input (cached + uncached). So
// `prompt_tokens = input_tokens + cache_creation + cache_read`.
// A client that reads only `prompt_tokens` sees the full cost; a client
// that reads `prompt_tokens_details.cached_tokens` can tell how much was
// billed at the ~0.1× cached rate.
export function buildOpenAIUsage(anthropicUsage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): OpenAIUsage {
  const input = anthropicUsage.input_tokens || 0
  const cacheCreate = anthropicUsage.cache_creation_input_tokens || 0
  const cacheRead = anthropicUsage.cache_read_input_tokens || 0
  const output = anthropicUsage.output_tokens || 0
  const totalPrompt = input + cacheCreate + cacheRead

  const usage: OpenAIUsage = {
    prompt_tokens: totalPrompt,
    completion_tokens: output,
    total_tokens: totalPrompt + output,
  }
  // Only attach the `prompt_tokens_details` block when there's actually
  // cache activity. Clients that ignore the field don't get unexpected
  // shape changes on uncached requests.
  if (cacheCreate > 0 || cacheRead > 0) {
    usage.prompt_tokens_details = {
      cached_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
    }
  }
  return usage
}

// Create usage chunk for OpenAI format
function createUsageChunk(state: ConverterState): OpenAIStreamChunk | null {
  // Only send usage if we have token data
  if (
    state.metricsData.input_tokens === 0 &&
    state.metricsData.output_tokens === 0 &&
    state.metricsData.cache_creation_input_tokens === 0 &&
    state.metricsData.cache_read_input_tokens === 0
  ) {
    return null
  }

  return {
    id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: state.metricsData.model || 'claude-unknown',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
      },
    ],
    usage: buildOpenAIUsage({
      input_tokens: state.metricsData.input_tokens,
      output_tokens: state.metricsData.output_tokens,
      cache_creation_input_tokens:
        state.metricsData.cache_creation_input_tokens,
      cache_read_input_tokens: state.metricsData.cache_read_input_tokens,
    }),
  }
}

// Transform Anthropic event to OpenAI format
function transformToOpenAI(
  state: ConverterState,
  data: AnthropicStreamEvent,
  enableLogging: boolean = false,
): OpenAIStreamChunk | null {
  let openAIChunk = null

  if (data.type === 'message_start' && data.message) {
    // Generate OpenAI-style ID
    const openAIId = 'chatcmpl-' + data.message.id.replace('msg_', '')
    state.metricsData.openAIId = openAIId

    openAIChunk = {
      id: openAIId,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: data.message.model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        },
      ],
    }
  } else if (
    data.type === 'content_block_start' &&
    data.content_block?.type === 'tool_use'
  ) {
    // Start of tool call - store the tool info for tracking
    if (enableLogging) {
      console.log('🔧 [ANTHROPIC] Tool Start:', {
        type: data.type,
        index: data.index,
        id: data.content_block.id,
        name: data.content_block.name,
      })
    }

    state.toolCallsTracker.set(data.index ?? 0, {
      id: data.content_block.id ?? '',
      name: data.content_block.name ?? '',
      arguments: '',
    })

    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: data.index ?? 0,
                id: data.content_block.id,
                type: 'function' as const,
                function: {
                  name: data.content_block.name,
                  arguments: '',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }

    if (enableLogging) {
      console.log(
        '📤 [OPENAI] Tool Start Chunk:',
        JSON.stringify(openAIChunk, null, 2),
      )
    }
  } else if (data.type === 'content_block_delta' && data.delta?.partial_json) {
    // Tool call arguments - OpenAI expects incremental string chunks
    if (enableLogging) {
      console.log('🔨 [ANTHROPIC] Tool Arguments Delta:', {
        index: data.index,
        partial_json: data.delta.partial_json,
      })
    }

    const toolCall = state.toolCallsTracker.get(data.index ?? 0)
    if (toolCall) {
      // Anthropic sends partial_json which might be a fragment or accumulated
      let newPart = ''

      // Check if this is a continuation of previous arguments
      if (
        toolCall.arguments &&
        data.delta.partial_json.startsWith(toolCall.arguments)
      ) {
        // It's accumulated - calculate the delta
        newPart = data.delta.partial_json.substring(toolCall.arguments.length)
        toolCall.arguments = data.delta.partial_json
      } else {
        // It's a fragment - append it
        newPart = data.delta.partial_json
        toolCall.arguments += data.delta.partial_json
      }

      if (enableLogging) {
        console.log('📊 [DELTA] Calculation:', {
          index: data.index,
          partial_json: data.delta.partial_json,
          accumulated: toolCall.arguments,
          newPart: newPart,
        })
      }

      openAIChunk = {
        id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: state.metricsData.model || 'claude-unknown',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: data.index ?? 0,
                  function: {
                    arguments: newPart,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }

      if (enableLogging) {
        console.log(
          '📤 [OPENAI] Tool Arguments Chunk:',
          JSON.stringify(openAIChunk, null, 2),
        )
      }
    }
  } else if (data.type === 'content_block_delta' && data.delta?.thinking) {
    // Stream thinking as italic text
    let content = ''
    if (!state.metricsData.inThinking) {
      state.metricsData.inThinking = true
      state.metricsData.hadThinking = true
      state.metricsData.answerStarted = false
      content = '\n\n'
    }
    // Render thinking text in italic
    content += data.delta.thinking.replace(/\n/g, '\n')
    if (content) {
      openAIChunk = {
        id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: state.metricsData.model || 'claude-unknown',
        choices: [{
          index: 0,
          delta: { content },
          finish_reason: null,
        }],
      }
    }
  } else if (data.type === 'content_block_delta' && data.delta?.text) {
    // Add prefix on the first text chunk after thinking was shown
    let prefix = ''
    if (state.metricsData.hadThinking && !state.metricsData.answerStarted) {
      state.metricsData.answerStarted = true
      prefix = ''
    }
    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: { content: prefix + data.delta.text },
          finish_reason: null,
        },
      ],
    }
  } else if (data.type === 'message_delta' && data.delta?.stop_reason) {
    openAIChunk = {
      id: state.metricsData.openAIId || 'chatcmpl-' + Date.now(),
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: state.metricsData.model || 'claude-unknown',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            data.delta.stop_reason === 'end_turn'
              ? 'stop'
              : data.delta.stop_reason === 'tool_use'
              ? 'tool_calls'
              : data.delta.stop_reason,
        },
      ],
    }
  }

  return openAIChunk as OpenAIStreamChunk | null
}
