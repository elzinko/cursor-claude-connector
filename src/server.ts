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
import { clientsRouter } from './routes/clients'
import { isApiKeyConfigured, validateApiKey } from './middleware/require-api-key'
import {
  tracker,
  fingerprint as computeFingerprint,
  getClientIp,
  getCountry,
} from './middleware/client-tracker'
import {
  getDeploymentInfo,
  getDeploymentWarnings,
  getEffectiveStorageMode,
} from './utils/deployment-check'
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getAccessToken,
  getTokenMetadata,
  redactUpstashError,
} from './auth/oauth-manager'
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
import { convertMessages } from './utils/convert-messages'
import { buildAnthropicBetas } from './utils/anthropic-betas'
import { sanitizeBodyForAnthropic } from './utils/sanitize-body'
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

// Clients API — per-fingerprint list, daily usage, revoke/unrevoke (protected)
app.route('/api/clients', clientsRouter)

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
    // Never propagate (error as Error).message here: it may contain the
    // Upstash "command was: [...]" payload (access + refresh tokens) or the
    // raw Anthropic response body. Log sanitized server-side, return fixed
    // message to the client. See oauth-manager.redactUpstashError.
    console.error(
      'OAuth callback failed:',
      redactUpstashError(error as Error),
    )
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message:
          'Unable to persist OAuth credentials. Check server logs and Redis configuration.',
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
    // Same leak risk as /auth/oauth/callback — oauthLogin -> startAuthFlow ->
    // exchangeCodeForTokens -> authManager.set. Sanitize.
    console.error(
      'OAuth login failed:',
      redactUpstashError(error as Error),
    )
    return c.json<SuccessResponse>(
      { success: false, message: 'OAuth login failed. See server logs.' },
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
    // oauthLogout -> authManager.remove can also throw a redis-shaped error.
    console.error(
      'OAuth logout failed:',
      redactUpstashError(error as Error),
    )
    return c.json<SuccessResponse>(
      { success: false, message: 'OAuth logout failed. See server logs.' },
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

  // Client fingerprint (api_key + IP) + revocation check
  const clientIp = getClientIp(c)
  const clientUa = c.req.header('user-agent') || ''
  const clientCountry = getCountry(c)
  const clientFp = computeFingerprint(apiKey, clientIp)
  if (await tracker.isRevoked(clientFp)) {
    console.log(`[PROXY] Rejected: client ${clientFp} is revoked (ip=${clientIp})`)
    // Record the blocked attempt for the dashboard.
    await tracker.trackRequest({
      fingerprint: clientFp,
      apiKey,
      ip: clientIp,
      ua: clientUa,
      country: clientCountry,
      tokensIn: 0,
      tokensOut: 0,
      blocked: true,
    })
    return c.json(
      {
        error: 'Client revoked',
        message:
          'This client has been revoked from the proxy dashboard. Contact the proxy administrator.',
      },
      403,
    )
  }

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

  if (body.messages) {
    body.messages = convertMessages(body.messages as any) as any
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
        // system content can be a string OR an array of blocks (OpenAI
        // responses-style, e.g. [{type:"text", text:"..."}]).
        // Anthropic's system[].text must be a string — flatten array blocks
        // into separate entries instead of nesting the array under `text`.
        const c = sysMsg.content
        if (typeof c === 'string') {
          if (c) body.system.push({ type: 'text', text: c })
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block && typeof block.text === 'string' && block.text) {
              body.system.push({ type: 'text', text: block.text })
            }
          }
        }
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

    // The 1M context window beta for Sonnet triggers Anthropic's
    // "Extra usage is required for long context requests" rate limit on
    // accounts that haven't enabled long-context billing — even for tiny
    // requests. Gate it behind an opt-in env var so the proxy stays usable
    // by default; users who've enabled long-context on their Anthropic
    // plan can set ENABLE_1M_CONTEXT=true to get back the 1M window.
    const anthropicBetas = buildAnthropicBetas({
      thinking: Boolean(body.thinking),
      model: body.model,
      enable1M: process.env.ENABLE_1M_CONTEXT === 'true',
    })

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

    // TEMPORARY DEBUG — diagnose 'out of extra usage' on 14+ tools. Remove after diagnosis.
    try {
      const dbgMessages = Array.isArray((cleanBody as any).messages)
        ? (cleanBody as any).messages.map((m: any) => ({
            role: m?.role,
            content:
              typeof m?.content === 'string'
                ? m.content.substring(0, 50) + (m.content.length > 50 ? '...' : '')
                : Array.isArray(m?.content)
                  ? `[${m.content.length} blocks]`
                  : m?.content,
          }))
        : undefined
      const dbgSystem = Array.isArray((cleanBody as any).system)
        ? `[${(cleanBody as any).system.length} blocks, first=${JSON.stringify(
            (cleanBody as any).system[0],
          )?.substring(0, 120)}...]`
        : typeof (cleanBody as any).system === 'string'
          ? `[string, first=${((cleanBody as any).system as string).substring(0, 120)}...]`
          : (cleanBody as any).system
      console.log(
        '[DEBUG-BODY]',
        JSON.stringify({
          model: (cleanBody as any).model,
          thinking: (cleanBody as any).thinking,
          has_thinking: 'thinking' in (cleanBody as any),
          system: dbgSystem,
          max_tokens: (cleanBody as any).max_tokens,
          tools_count: Array.isArray((cleanBody as any).tools)
            ? (cleanBody as any).tools.length
            : undefined,
          tool_choice: (cleanBody as any).tool_choice,
          stream: (cleanBody as any).stream,
          temperature: (cleanBody as any).temperature,
          top_p: (cleanBody as any).top_p,
          top_k: (cleanBody as any).top_k,
          messages_count: Array.isArray((cleanBody as any).messages)
            ? (cleanBody as any).messages.length
            : undefined,
          messages_roles: Array.isArray((cleanBody as any).messages)
            ? (cleanBody as any).messages.map((m: any) => m?.role)
            : undefined,
          messages_preview: dbgMessages,
          top_level_keys: Object.keys(cleanBody as any),
        }),
      )
      console.log(
        '[DEBUG-HEADERS]',
        JSON.stringify({
          'anthropic-beta': headers['anthropic-beta'],
          'anthropic-version': headers['anthropic-version'],
          'user-agent': headers['user-agent'],
          'x-routing-group': headers['x-routing-group'],
          accept: headers.accept,
        }),
      )
    } catch (dbgErr) {
      console.error('[DEBUG-BODY] log failed:', (dbgErr as Error).message)
    }

    // TEMPORARY DEBUG — echo the sanitized [DEBUG-BODY]/[DEBUG-HEADERS] values
    // back to the caller as response headers, so a curl from CI/EC2 can see
    // them without having to read Vercel runtime logs. Triple-gated:
    //   1. opt-in per request via `x-debug-trace: 1` header
    //   2. refused outside preview/development (VERCEL_ENV !== 'production')
    //   3. content is already sanitized (no OAuth tokens, no API_KEY, messages
    //      truncated to 50 chars, system to 120 chars, tools count only).
    // Remove with the rest of the debug commits once the 14+ tools diagnosis
    // lands.
    const debugTraceRequested = c.req.header('x-debug-trace') === '1'
    const debugTraceAllowed =
      debugTraceRequested && process.env.VERCEL_ENV !== 'production'
    if (debugTraceAllowed) {
      try {
        const dbgSystemEcho = Array.isArray((cleanBody as any).system)
          ? `[${(cleanBody as any).system.length} blocks, first=${JSON.stringify(
              (cleanBody as any).system[0],
            )?.substring(0, 120)}]`
          : typeof (cleanBody as any).system === 'string'
            ? `[string len=${((cleanBody as any).system as string).length}]`
            : undefined
        const dbgBodyEcho = {
          model: (cleanBody as any).model,
          has_thinking: 'thinking' in (cleanBody as any),
          thinking: (cleanBody as any).thinking ?? null,
          system: dbgSystemEcho,
          max_tokens: (cleanBody as any).max_tokens,
          tools_count: Array.isArray((cleanBody as any).tools)
            ? (cleanBody as any).tools.length
            : 0,
          tool_choice: (cleanBody as any).tool_choice ?? null,
          stream: Boolean((cleanBody as any).stream),
          temperature: (cleanBody as any).temperature ?? null,
          top_p: (cleanBody as any).top_p ?? null,
          top_k: (cleanBody as any).top_k ?? null,
          messages_count: Array.isArray((cleanBody as any).messages)
            ? (cleanBody as any).messages.length
            : 0,
          messages_roles: Array.isArray((cleanBody as any).messages)
            ? (cleanBody as any).messages.map((m: any) => m?.role)
            : [],
          top_level_keys: Object.keys(cleanBody as any),
        }
        const dbgHeadersEcho = {
          'anthropic-beta': headers['anthropic-beta'],
          'anthropic-version': headers['anthropic-version'],
          'user-agent': headers['user-agent'],
          'x-routing-group': headers['x-routing-group'] ?? null,
          accept: headers.accept,
        }
        // Hono header values must be single-line ASCII-safe. JSON.stringify
        // produces that. Cap at 4KB to stay well under Vercel's 32KB limit.
        const bodyJson = JSON.stringify(dbgBodyEcho).slice(0, 4096)
        const headersJson = JSON.stringify(dbgHeadersEcho).slice(0, 2048)
        c.header('x-debug-body', bodyJson)
        c.header('x-debug-headers', headersJson)
      } catch (dbgErr) {
        c.header(
          'x-debug-error',
          (dbgErr as Error).message.slice(0, 200),
        )
      }
    }

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

      // Persist client-level stats even on upstream error (tokens unknown).
      await tracker.trackRequest({
        fingerprint: clientFp,
        apiKey,
        ip: clientIp,
        ua: clientUa,
        country: clientCountry,
        tokensIn: 0,
        tokensOut: 0,
        blocked: false,
      })

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
      // Streaming: we don't have token usage until the stream closes, so persist
      // a request-count-only entry here. Token counts for streaming are a TODO
      // (requires parsing message_start / message_delta SSE events).
      await tracker.trackRequest({
        fingerprint: clientFp,
        apiKey,
        ip: clientIp,
        ua: clientUa,
        country: clientCountry,
        tokensIn: 0,
        tokensOut: 0,
        blocked: false,
      })

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

      // Per-client stats (non-streaming has usage tokens available)
      await tracker.trackRequest({
        fingerprint: clientFp,
        apiKey,
        ip: clientIp,
        ua: clientUa,
        country: clientCountry,
        tokensIn: responseData.usage?.input_tokens || 0,
        tokensOut: responseData.usage?.output_tokens || 0,
        blocked: false,
      })

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
