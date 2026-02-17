import { Context } from 'hono'

// Handle CORS preflight requests for all routes
export const corsPreflightHandler = (c: Context) => {
  // Allow all origins (you can restrict this to specific origins if needed)
  c.header('Access-Control-Allow-Origin', '*')

  // Allow all HTTP methods
  c.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
  )

  // Allow all headers
  c.header('Access-Control-Allow-Headers', '*')

  // Allow credentials
  c.header('Access-Control-Allow-Credentials', 'true')

  // Max age for preflight cache (24 hours)
  c.header('Access-Control-Max-Age', '86400')

  // Return 204 No Content for OPTIONS requests
  return c.body(null, 204)
}

// Middleware to add CORS headers to all responses
export const corsMiddleware = async (c: Context, next: () => Promise<void>) => {
  await next()

  // Add CORS headers to all responses
  c.header('Access-Control-Allow-Origin', '*')
  c.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
  )
  c.header('Access-Control-Allow-Headers', '*')
  c.header('Access-Control-Allow-Credentials', 'true')
}
