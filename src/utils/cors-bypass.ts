import { Context } from 'hono'

// Get allowed CORS origins from env (comma-separated)
// Default: localhost + same-origin. Set CORS_ORIGINS=* for permissive
const getAllowedOrigin = (c: Context): string => {
  const requestOrigin = c.req.header('Origin')
  const allowed = process.env.CORS_ORIGINS?.trim()

  if (allowed === '*') return '*'
  if (allowed) {
    const origins = allowed.split(',').map((o) => o.trim())
    if (requestOrigin && origins.includes(requestOrigin)) return requestOrigin
    if (origins.length > 0) return origins[0]
  }
  // Allow same-origin (e.g. Vercel: page and API on same domain)
  try {
    const url = new URL(c.req.url)
    const serverOrigin = `${url.protocol}//${url.host}`
    if (requestOrigin === serverOrigin) return requestOrigin
  } catch {
    /* ignore */
  }
  // Default: localhost only
  const defaultOrigins = [
    'http://localhost:9095',
    'http://localhost:3000',
    'http://127.0.0.1:9095',
    'http://127.0.0.1:3000',
  ]
  if (requestOrigin && defaultOrigins.includes(requestOrigin)) return requestOrigin
  return defaultOrigins[0]
}

// Handle CORS preflight requests for all routes
export const corsPreflightHandler = (c: Context) => {
  const origin = getAllowedOrigin(c)
  c.header('Access-Control-Allow-Origin', origin)

  c.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
  )
  c.header('Access-Control-Allow-Headers', '*')
  c.header('Access-Control-Allow-Credentials', 'true')
  c.header('Access-Control-Max-Age', '86400')

  return c.body(null, 204)
}

// Middleware to add CORS headers to all responses
export const corsMiddleware = async (c: Context, next: () => Promise<void>) => {
  await next()

  const origin = getAllowedOrigin(c)
  c.header('Access-Control-Allow-Origin', origin)
  c.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
  )
  c.header('Access-Control-Allow-Headers', '*')
  c.header('Access-Control-Allow-Credentials', 'true')
}
