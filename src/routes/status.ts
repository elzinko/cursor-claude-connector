import { Hono } from 'hono'
import { getTokenMetadata } from '../auth/oauth-manager'
import { logger } from '../middleware/request-logger'
import { rateLimiter } from '../middleware/rate-limiter'
import { requireApiKey, isApiKeyConfigured } from '../middleware/require-api-key'

export const statusRouter = new Hono()

statusRouter.use('*', requireApiKey)

// GET /api/status/full — token metadata + stats (no secrets)
statusRouter.get('/full', async (c) => {
  const metadata = await getTokenMetadata()
  const project = c.req.query('project')
  const stats = logger.getStats(project)

  return c.json({
    auth: {
      ...metadata,
      apiKeyConfigured: isApiKeyConfigured(),
    },
    stats: {
      totalRequests: stats.totalRequests,
      requestsLastHour: stats.requestsLastHour,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      projects: stats.projects.map((proj) => ({
        name: proj,
        ...logger.getStats(proj),
        rateLimit: rateLimiter.getStats(proj),
      })),
    },
    env: {
      vercel: process.env.VERCEL === '1',
      nodeEnv: process.env.NODE_ENV || 'development',
    },
  })
})
