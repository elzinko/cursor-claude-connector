import { handle } from 'hono/vercel'
import app from '../src/server'

export const runtime = 'nodejs'

// Export handlers for all HTTP methods
export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
export const OPTIONS = handle(app)
