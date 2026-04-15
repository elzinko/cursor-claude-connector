import type { Context, MiddlewareHandler } from 'hono'

function getAllowedKeys(): string[] {
  return process.env.API_KEY?.split(',').map((k) => k.trim()).filter(Boolean) || []
}

function extractBearer(c: Context): string | undefined {
  const header = c.req.header('authorization')
  if (!header) return undefined
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return undefined
  return value
}

export function isApiKeyConfigured(): boolean {
  return getAllowedKeys().length > 0
}

export function validateApiKey(c: Context): { ok: true; key: string } | { ok: false; status: 401 | 500; body: Record<string, unknown> } {
  const allowedKeys = getAllowedKeys()
  const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'

  if (isProduction && allowedKeys.length === 0) {
    console.error('⚠️  SECURITY: API_KEY is required in production but not set')
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Configuration error',
        message: 'API_KEY must be configured in production environment',
      },
    }
  }

  if (allowedKeys.length === 0) {
    return { ok: true, key: 'default' }
  }

  const providedKey = extractBearer(c)
  if (!providedKey || !allowedKeys.includes(providedKey)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Authentication required',
        message: 'Please provide a valid API key',
      },
    }
  }

  return { ok: true, key: providedKey }
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const result = validateApiKey(c)
  if (!result.ok) {
    return c.json(result.body, result.status)
  }
  c.set('apiKey', result.key)
  await next()
}
