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
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAccessToken } from './auth/oauth-manager'
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

// Stats API
app.route('/api/stats', statsRouter)

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
  try {
    const token = await getAccessToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
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

// Map model names sent by Cursor/IDEs to actual Anthropic API model IDs.
// Cursor fabricates non-standard IDs (e.g. appending old snapshot dates).
// The official Anthropic API IDs for 4.6 models have NO date suffix.
// See: https://docs.anthropic.com/en/docs/about-claude/models
function mapModelName(model: string): string {
  const MODEL_MAP: Record<string, string> = {
    // ── Claude 4.6 (latest) ──────────────────────────────────────────
    // Cursor appends the old 4.0 snapshot date "20250514" which is wrong.
    // Official 4.6 IDs are just "claude-sonnet-4-6" / "claude-opus-4-6".
    'claude-sonnet-4-6-20250514': 'claude-sonnet-4-6',
    'claude-opus-4-6-20250514':   'claude-opus-4-6',

    // ── Claude 4.5 ──────────────────────────────────────────────────
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929',  // passthrough (valid)
    'claude-opus-4-5-20251101':   'claude-opus-4-5-20251101',    // passthrough (valid)
    'claude-sonnet-4-5-20241022': 'claude-sonnet-4-5-20250929',  // Cursor may send wrong date
    'claude-opus-4-5-20241022':   'claude-opus-4-5-20251101',    // Cursor may send wrong date

    // ── Claude 4.0 ──────────────────────────────────────────────────
    'claude-sonnet-4-20250514':   'claude-sonnet-4-20250514',    // passthrough (valid)
    'claude-opus-4-20250514':     'claude-opus-4-20250514',      // passthrough (valid)

    // ── Legacy 3.x aliases → map to closest current model ───────────
    'claude-3-5-sonnet-latest':   'claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-latest':   'claude-sonnet-4-6',

    // ── "latest" aliases ────────────────────────────────────────────
    'claude-sonnet-latest':       'claude-sonnet-4-6',
    'claude-opus-latest':         'claude-opus-4-6',

    // ── Haiku ───────────────────────────────────────────────────────
    'claude-haiku-4-5-20251001':  'claude-haiku-4-5-20251001',   // passthrough (valid)
    'claude-3-5-haiku-20241022':  'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-latest':    'claude-haiku-4-5-20251001',
    'claude-3-haiku-20240307':    'claude-3-haiku-20240307',     // passthrough (valid)
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
  'tools', 'tool_choice',
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

  // API Key validation - supports multiple keys (comma-separated in API_KEY)
  // In production (Vercel), API_KEY is required for security
  const providedKey = c.req.header('authorization')?.split(' ')?.[1]
  const allowedKeys = process.env.API_KEY?.split(',').map((k) => k.trim()) || []
  const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'

  // Require API_KEY in production/Vercel for security
  if (isProduction && allowedKeys.length === 0) {
    console.error('⚠️  SECURITY WARNING: API_KEY is required in production but not set!')
    return c.json(
      {
        error: 'Configuration error',
        message: 'API_KEY must be configured in production environment',
      },
      500,
    )
  }

  if (allowedKeys.length > 0) {
    if (!providedKey || !allowedKeys.includes(providedKey)) {
      console.log('[PROXY] Rejected: invalid API key')
      return c.json(
        {
          error: 'Authentication required',
          message: 'Please provide a valid API key',
        },
        401,
      )
    }
  }

  const apiKey = providedKey || 'default'
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
      if (!body.max_tokens) {
        const model = body.model.toLowerCase()
        if (model.includes('opus')) {
          body.max_tokens = 32_000
        } else if (model.includes('haiku')) {
          body.max_tokens = 8_192
        } else {
          // Default for sonnet and any other/future model
          body.max_tokens = 64_000
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

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta':
        'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
      'anthropic-version': '2023-06-01',
      'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
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
                if (result.type === 'chunk') {
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
