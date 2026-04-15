import { Hono, Context } from 'hono'
import { createAdaptorServer } from '@hono/node-server'
import {
  logger,
  extractProjectFromApiKey,
  logRequest,
} from './middleware/request-logger'
import { rateLimiter } from './middleware/rate-limiter'
import { printStatusline } from './utils/statusline'
import { statsRouter } from './routes/stats'
import { statusRouter } from './routes/status'
import { isApiKeyConfigured, validateApiKey } from './middleware/require-api-key'
import {
  getDeploymentInfo,
  getDeploymentWarnings,
  getEffectiveStorageMode,
} from './utils/deployment-check'
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAccessToken, getTokenMetadata } from './auth/oauth-manager'
import {
  login as oauthLogin,
  logout as oauthLogout,
  generateAuthSession,
  handleOAuthCallback,
} from './auth/oauth-flow'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
} from './utils/anthropic-to-openai-converter'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
import type {
  AnthropicRequestBody,
  AnthropicResponse,
  ErrorResponse,
  SuccessResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')

function logConnectionInfo(context?: string) {
  const port = process.env.PORT || 9095
  const baseUrl = `http://localhost:${port}/v1`
  const apiKey = process.env.API_KEY
  const apiKeyDisplay = apiKey
    ? `${apiKey.slice(0, 4)}${'*'.repeat(Math.min(apiKey.length - 4, 8))}`
    : '(not set)'
  const prefix = context ? `✅ ${context}` : '📋 Cursor configuration'
  console.log(`\n${prefix} :`)
  console.log('   Base URL :', baseUrl)
  console.log('   API Key  :', apiKeyDisplay)
  console.log('')
  console.log('   Cursor setup (Settings → Models):')
  console.log('   1. ✅ Enable  "OpenAI API Key" and paste your API_KEY from .env')
  console.log(`   2. ✅ Set     "Override OpenAI Base URL" to ${baseUrl}`)
  console.log('   3. ❌ Disable "Anthropic API Key" (leave empty)')
  console.log('')
}
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// Stats API (protected by API_KEY)
app.route('/api/stats', statsRouter)

// Status API — full dashboard JSON (protected by API_KEY)
app.route('/api/status', statusRouter)

// New OAuth start endpoint for UI
app.post('/auth/oauth/start', async (c: Context) => {
  try {
    const { authUrl, sessionId } = await generateAuthSession()

    return c.json({
      success: true,
      authUrl,
      sessionId,
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to start OAuth flow',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// New OAuth callback endpoint for UI
app.post('/auth/oauth/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { code, sessionId } = body

    if (!code) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing OAuth code',
          message: 'OAuth code is required',
        },
        400,
      )
    }

    // Use sessionId (PKCE verifier) from client, or extract from code#verifier format
    const splits = code.split('#')
    const codeOnly = splits[0]
    const verifier = sessionId || splits[1] || ''

    await handleOAuthCallback(codeOnly, verifier)

    logConnectionInfo('Authentication successful')

    return c.json<SuccessResponse>({
      success: true,
      message: 'OAuth authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.post('/auth/login/start', async (c: Context) => {
  try {
    console.log('\n Starting OAuth authentication flow...')
    const result = await oauthLogin()
    if (result) {
      return c.json<SuccessResponse>({
        success: true,
        message: 'OAuth authentication successful',
      })
    } else {
      return c.json<SuccessResponse>(
        { success: false, message: 'OAuth authentication failed' },
        401,
      )
    }
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.post('/auth/logout', async (c: Context) => {
  try {
    await oauthLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/status', async (c: Context) => {
  const info = getDeploymentInfo()
  const warnings = getDeploymentWarnings()
  const deployment = {
    platform: info.platform,
    vercelEnv: info.vercelEnv,
    region: info.region,
    warnings,
  }

  try {
    const metadata = await getTokenMetadata()
    return c.json({
      ...metadata,
      apiKeyConfigured: isApiKeyConfigured(),
      deployment,
    })
  } catch (error) {
    return c.json({
      authenticated: false,
      expiresAt: null,
      expiresInSeconds: null,
      hasRefreshToken: false,
      storageMode: getEffectiveStorageMode(),
      apiKeyConfigured: isApiKeyConfigured(),
      deployment,
    })
  }
})

app.get('/v1/models', async (c: Context) => {
  try {
    // Fetch models from models.dev
    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const modelsData = (await response.json()) as any

    // Extract Anthropic models and format them like OpenAI's API would
    const anthropicProvider = modelsData.anthropic
    if (!anthropicProvider || !anthropicProvider.models) {
      return c.json<ModelsListResponse>({
        object: 'list',
        data: [],
      })
    }

    // Convert models to OpenAI's format
    const models: ModelInfo[] = Object.entries(anthropicProvider.models).map(
      ([modelId, modelData]: [string, any]) => {
        // Convert release date to Unix timestamp
        const releaseDate = modelData.release_date || '1970-01-01'
        const created = Math.floor(new Date(releaseDate).getTime() / 1000)

        return {
          id: modelId,
          object: 'model' as const,
          created: created,
          owned_by: 'anthropic',
        }
      },
    )

    // Sort models by created timestamp (newest first)
    models.sort((a, b) => b.created - a.created)

    // Add alias models so they appear in Cursor's model dropdown
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      models.unshift({
        id: alias,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'proxy-alias',
      })
    }

    const response_data: ModelsListResponse = {
      object: 'list',
      data: models,
    }

    return c.json(response_data)
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
})

// ── Model Aliases ─────────────────────────────────────────────────────
// Cursor intercepts well-known model names (deepseek-v3, gpt-4o, etc.)
// and routes them to its OWN backend instead of the custom Base URL.
// Solution: use completely invented model names that Cursor doesn't
// recognize — it will then forward them to the custom Base URL.
// In Cursor Settings > Models, add one of these as a custom model:
//   "claude-proxy-opus"  → maps to claude-opus-4-6
//   "claude-proxy"       → maps to claude-sonnet-4-6
const MODEL_ALIASES: Record<string, string> = {
  // ── Recommended: invented names Cursor cannot intercept ──────────
  // Add these in Cursor Settings > Models as custom model names
  'claude-proxy-opus':        'claude-opus-4-6',
  'claude-proxy-opus-4.6':    'claude-opus-4-6',
  'claude-proxy-opus-4.5':    'claude-opus-4-5-20251101',
  'claude-proxy-sonnet':      'claude-sonnet-4-6',
  'claude-proxy-sonnet-4.6':  'claude-sonnet-4-6',
  'claude-proxy-sonnet-4.5':  'claude-sonnet-4-5-20250929',
  'claude-proxy-haiku':       'claude-haiku-4-5-20251001',
  'claude-proxy-haiku-4.5':   'claude-haiku-4-5-20251001',
  'claude-proxy':             'claude-sonnet-4-6',
  // ── DeepSeek names (Cursor may intercept → deepseek.com) ────────
  'deepseek-v3':          'claude-opus-4-6',
  'deepseek-r1':          'claude-opus-4-6',
  'deepseek-v3-sonnet':   'claude-sonnet-4-6',
  'deepseek-coder':       'claude-opus-4-6',
  'deepseek-chat':        'claude-sonnet-4-6',
  'deepseek-reasoner':    'claude-sonnet-4-6',
  // ── OpenAI names (Cursor intercepts → Cursor own backend) ───────
  'gpt-4o':               'claude-opus-4-6',
  'gpt-4o-mini':          'claude-sonnet-4-6',
  'gpt-4-turbo':          'claude-opus-4-6',
  'gpt-4':                'claude-opus-4-6',
  'gpt-3.5-turbo':        'claude-sonnet-4-6',
  'o1':                   'claude-opus-4-6',
  'o1-mini':              'claude-sonnet-4-6',
}

// Map model names sent by Cursor/IDEs to actual Anthropic API model IDs.
// Cursor fabricates non-standard IDs (e.g. appending old snapshot dates).
// The official Anthropic API IDs for 4.6 models have NO date suffix.
// See: https://docs.anthropic.com/en/docs/about-claude/models
function mapModelName(model: string): string {
  // ── Check aliases first (deepseek-coder → claude-opus-4-6, etc.) ──
  const lowerModel = model.toLowerCase()
  if (MODEL_ALIASES[lowerModel]) {
    console.log(`[PROXY] Model alias: ${model} -> ${MODEL_ALIASES[lowerModel]}`)
    return MODEL_ALIASES[lowerModel]
  }

  // ── Handle Cursor's format like "claude-4.6-opus-high" → "claude-opus-4-6"
  const cursorPattern = /^claude-(\d+(?:\.\d+)?)-(\w+)(?:-\w+)?$/i
  const cursorMatch = model.match(cursorPattern)
  if (cursorMatch) {
    const version = cursorMatch[1].replace('.', '-')
    const family = cursorMatch[2].toLowerCase()
    const normalized = `claude-${family}-${version}`
    console.log(`[PROXY] Model normalized: ${model} -> ${normalized}`)
    return normalized
  }

  // ── Handle dots in version: "claude-opus-4.6" → "claude-opus-4-6"
  const dotFixed = model.replace(/claude-(\w+)-(\d+)\.(\d+)/i, 'claude-$1-$2-$3')
  if (dotFixed !== model) {
    console.log(`[PROXY] Model dot-fix: ${model} -> ${dotFixed}`)
    return dotFixed
  }

  const MODEL_MAP: Record<string, string> = {
    // ── Claude 4.6 (latest) ──────────────────────────────────────────
    'claude-sonnet-4-6-20250514': 'claude-sonnet-4-6',
    'claude-opus-4-6-20250514':   'claude-opus-4-6',

    // ── Claude 4.5 ──────────────────────────────────────────────────
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101':   'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20241022': 'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20241022':   'claude-opus-4-5-20251101',

    // ── Claude 4.0 ──────────────────────────────────────────────────
    'claude-sonnet-4-20250514':   'claude-sonnet-4-20250514',
    'claude-opus-4-20250514':     'claude-opus-4-20250514',

    // ── Legacy 3.x aliases → map to closest current model ───────────
    'claude-3-5-sonnet-latest':   'claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-latest':   'claude-sonnet-4-6',

    // ── "latest" aliases ────────────────────────────────────────────
    'claude-sonnet-latest':       'claude-sonnet-4-6',
    'claude-opus-latest':         'claude-opus-4-6',

    // ── Haiku ───────────────────────────────────────────────────────
    'claude-haiku-4-5-20251001':  'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022':  'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-latest':    'claude-haiku-4-5-20251001',
    'claude-3-haiku-20240307':    'claude-3-haiku-20240307',
  }

  if (MODEL_MAP[model]) {
    console.log(`[PROXY] Model mapped: ${model} -> ${MODEL_MAP[model]}`)
    return MODEL_MAP[model]
  }

  return model
}

// Anthropic Messages API only accepts these top-level fields.
// Any extra fields (from OpenAI format) cause a 400 error.
const ANTHROPIC_ALLOWED_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'metadata',
  'stop_sequences', 'stream', 'temperature', 'top_p', 'top_k',
  'tools', 'tool_choice', 'thinking',
])

function sanitizeBodyForAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (ANTHROPIC_ALLOWED_FIELDS.has(key)) {
      clean[key] = body[key]
    }
  }
  return clean
}

const messagesFn = async (c: Context) => {
  const startTime = Date.now()
  const body: AnthropicRequestBody = await c.req.json()
  const isStreaming = body.stream === true

  // Map model name to OAuth-compatible ID
  body.model = mapModelName(body.model)

  console.log(`[PROXY] ${c.req.path} model=${body.model} stream=${isStreaming}`)

  // API Key validation — shared with /api/stats and /api/status/full
  const keyResult = validateApiKey(c)
  if (!keyResult.ok) {
    if (keyResult.status === 401) console.log('[PROXY] Rejected: invalid API key')
    return c.json(keyResult.body, keyResult.status)
  }
  const apiKey = keyResult.key
  const project = extractProjectFromApiKey(apiKey)

  // Rate limiting check
  const rateCheck = rateLimiter.check(project)
  if (!rateCheck.allowed) {
    const resetIn = Math.ceil((rateCheck.resetAt - Date.now()) / 1000 / 60)
    const rateStats = rateLimiter.getStats(project)
    console.log(
      `[${project}] RATE LIMIT | ${rateStats.count}/${rateStats.limit} requests | Reset in ${resetIn}m`,
    )
    return c.json(
      {
        error: 'Rate limit exceeded',
        message: `Too many requests for project "${project}". Try again in ${resetIn} minutes.`,
        resetAt: new Date(rateCheck.resetAt).toISOString(),
      },
      429,
    )
  }

  // Log incoming request
  console.log(`[${project}] ${body.model || 'unknown'} | REQUEST START`)

  // Bypass cursor enable openai key check
  if (isCursorKeyCheck(body)) {
    console.log('[PROXY] Cursor key validation detected, sending bypass response')
    return c.json(createCursorBypassResponse())
  }

  // ── Convert OpenAI tool_choice format to Anthropic format ──────────
  if ((body as any).tool_choice !== undefined) {
    const tc = (body as any).tool_choice
    if (tc === 'auto') {
      (body as any).tool_choice = { type: 'auto' }
    } else if (tc === 'none') {
      delete (body as any).tool_choice
    } else if (tc === 'required') {
      (body as any).tool_choice = { type: 'any' }
    } else if (tc?.type === 'function' && tc?.function?.name) {
      (body as any).tool_choice = { type: 'tool', name: tc.function.name }
    }
  }

  // ── Convert OpenAI-format tools to Anthropic format ────────────────
  if ((body as any).tools) {
    (body as any).tools = (body as any).tools.map((tool: any) => {
      if (tool.type === 'function' && tool.function) {
        return {
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object', properties: {} },
        }
      }
      return tool
    })
  }

  // ── Convert OpenAI-format messages to Anthropic format ─────────────
  // (assistant with tool_calls → tool_use blocks, tool role → tool_result)
  if (body.messages) {
    const convertedMessages: any[] = []
    for (const rawMsg of body.messages) {
      // OpenAI 2025 introduced `role: "developer"` as a replacement for
      // `system` on newer models. Anthropic only accepts `system`, so
      // normalize here before any downstream handling.
      const msg = rawMsg.role === 'developer' ? { ...rawMsg, role: 'system' } : rawMsg
      if (msg.role === 'assistant' && msg.tool_calls) {
        const content: any[] = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || '',
            input: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function?.arguments || {}),
          })
        }
        convertedMessages.push({ role: 'assistant', content })
      } else if (msg.role === 'tool') {
        convertedMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content || '',
          }],
        })
      } else {
        convertedMessages.push(msg)
      }
    }
    body.messages = convertedMessages
  }

  try {
    let transformToOpenAIFormat = false

    if (
      !body.system?.[0]?.text?.includes(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      ) && body.messages
    ) {
      const systemMessages = body.messages.filter((msg: any) => msg.role === 'system')
      body.messages = body.messages?.filter((msg: any) => msg.role !== 'system')
      transformToOpenAIFormat = true // not claude-code, need to transform to openai format
      if (!body.system) {
        body.system = []
      }
      body.system.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      })

      for (const sysMsg of systemMessages) {
        body.system.push({
          type: 'text',
          text: sysMsg.content || ''
        })
      }

      // Anthropic API requires max_tokens. Set sensible defaults per model family.
      // Keep these small to leave headroom for input context
      // (Claude's context_window is the sum of input + output tokens).
      // Clients that need longer completions can always pass max_tokens explicitly.
      if (!body.max_tokens) {
        const model = body.model.toLowerCase()
        if (model.includes('haiku')) {
          body.max_tokens = 8_192
        } else {
          // Default for opus, sonnet, and any other/future model.
          body.max_tokens = 16_000
        }
      }

      // ── Extended thinking ────────────────────────────────────────────
      // Opus 4.6+ uses adaptive thinking, older models use budget_tokens.
      // Anthropic requires budget_tokens >= 1024, and the budget must leave
      // room for the actual response. Skip extended thinking when max_tokens
      // is too small to accommodate both, and split ~50/50 below the 16K cap
      // otherwise (avoids the old `maxTokens - 1000` formula starving responses
      // at the new 16K default).
      if (body.model.includes('opus-4-6')) {
        body.thinking = {
          type: 'adaptive',
        }
      } else {
        const maxTokens = (body.max_tokens as number) || 32000
        if (maxTokens >= 2048) {
          body.thinking = {
            type: 'enabled',
            budget_tokens: Math.max(1024, Math.min(16000, Math.floor(maxTokens / 2))),
          }
        }
      }
    }

    const oauthToken = await getAccessToken()

    if (!oauthToken) {
      console.log('[PROXY] No OAuth token found')
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message:
            'Please authenticate using OAuth first. Visit /auth/login for instructions.',
        },
        401,
      )
    }

    // When thinking is enabled, temperature/top_p/top_k are not supported
    if (body.thinking) {
      delete (body as any).temperature
      delete (body as any).top_p
      delete (body as any).top_k
    }

    // Forward X-Routing-Group if Cursor sent it — undocumented header that
    // significantly improves routing success rate through Cursor's backend
    const routingGroup = c.req.header('x-routing-group')

    // Build the anthropic-beta header dynamically.
    // Add 1M context window beta for Sonnet models only (Opus/Haiku don't support it).
    const anthropicBetas = [
      'oauth-2025-04-20',
      'fine-grained-tool-streaming-2025-05-14',
      'interleaved-thinking-2025-05-14',
    ]
    if (body.model.toLowerCase().includes('sonnet')) {
      anthropicBetas.push('context-1m-2025-08-07')
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta': anthropicBetas.join(','),
      'anthropic-version': '2023-06-01',
      'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
      ...(routingGroup ? { 'x-routing-group': routingGroup } : {}),
    }

    if (transformToOpenAIFormat) {
      if (!body.metadata) {
        body.metadata = {}
      }

      if (!body.system) {
        body.system = []
      }
    }

    // Remove OpenAI-only fields that Anthropic doesn't understand (causes 400)
    const cleanBody = sanitizeBodyForAnthropic(body as Record<string, unknown>)

    console.log(`[PROXY] -> Anthropic: model=${cleanBody.model} max_tokens=${cleanBody.max_tokens} transform=${transformToOpenAIFormat}`)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(cleanBody),
      signal: c.req.raw.signal,
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)

      // Log error response
      try {
        const errorData = JSON.parse(error)
        const errorResponse: AnthropicResponse = {
          type: 'error',
          error: errorData.error || { type: 'api_error', message: error },
        }
        logRequest(c, apiKey, body.model, startTime, errorResponse, response.status)
      } catch {
        // If error is not JSON, log anyway
        console.log(
          `[${project}] ${body.model} | ERROR | ${Date.now() - startTime}ms | ${response.status}`,
        )
      }

      if (response.status === 401) {
        return c.json<ErrorResponse>(
          {
            error: 'Authentication failed',
            message:
              'OAuth token may be expired. Please re-authenticate using /auth/login/start',
            details: error,
          },
          401,
        )
      }
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    if (isStreaming) {
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== 'content-encoding' &&
          key.toLowerCase() !== 'content-length' &&
          key.toLowerCase() !== 'transfer-encoding'
        ) {
          c.header(key, value)
        }
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      return stream(c, async (stream) => {
        const converterState = createConverterState()
        const enableLogging = false

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })

            if (transformToOpenAIFormat) {
              if (enableLogging) {
                console.log('🔄 [TRANSFORM MODE] Converting to OpenAI format')
              }

              const results = processChunk(converterState, chunk, enableLogging)

              for (const result of results) {
                if (result.type === 'ping') {
                  // Forward as SSE comment to keep connection alive during long thinking
                  await stream.write(': ping\n\n')
                } else if (result.type === 'chunk') {
                  const dataToSend = `data: ${JSON.stringify(result.data)}\n\n`
                  if (enableLogging) {
                    console.log('✅ [SENDING] OpenAI Chunk:', dataToSend)
                  }
                  await stream.write(dataToSend)
                } else if (result.type === 'done') {
                  await stream.write('data: [DONE]\n\n')
                }
              }
            } else {
              await stream.write(chunk)
            }
          }
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      // Log request (non-streaming only for now)
      logRequest(c, apiKey, body.model, startTime, responseData, response.status)

      if (transformToOpenAIFormat) {
        const openAIResponse = convertNonStreamingResponse(responseData)

        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value)
          }
        })

        return c.json(openAIResponse)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          c.header(key, value)
        }
      })

      return c.json(responseData)
    }

    // Log streaming requests (basic info, tokens not available until end)
    console.log(
      `[${project}] ${body.model} | STREAMING | ${Date.now() - startTime}ms | 200`,
    )
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

const port = Number(process.env.PORT || 9095)

// Start local HTTP server when run directly with Node (not when imported for Vercel)
if (require.main === module) {
  const server = createAdaptorServer({ fetch: app.fetch })
  server.listen(port, async () => {
    console.log(`Listening on http://localhost:${port}`)
    const token = await getAccessToken()
    if (token) logConnectionInfo('Already authenticated')

    // Print statusline every 5 seconds
    setInterval(() => {
      const stats = logger.getStats()
      if (stats.totalRequests > 0) {
        console.log('\n' + '─'.repeat(80))
        console.log(
          `📊 Stats: ${stats.totalRequests} requests | ` +
            `${stats.totalTokens.toLocaleString()} tokens | ` +
            `$${stats.totalCost.toFixed(4)} | ` +
            `${stats.requestsLastHour} req/h`,
        )
        if (stats.projects.length > 1) {
          console.log(`   Projects: ${stats.projects.join(', ')}`)
        }
        console.log('─'.repeat(80))
      }
    }, 5000)
  })

  const shutdown = () => {
    console.log('\nShutting down...')
    server.close(() => {
      console.log('Server closed')
      process.exit(0)
    })
    // Force exit after 3s if connections are hanging
    setTimeout(() => process.exit(0), 3000)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Export app for Vercel
export default app
