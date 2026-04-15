import { Hono } from 'hono'
import { getTokenMetadata } from '../auth/oauth-manager'
import { logger } from '../middleware/request-logger'
import { rateLimiter } from '../middleware/rate-limiter'
import { requireApiKey, isApiKeyConfigured } from '../middleware/require-api-key'
import { getDeploymentHealth } from '../utils/deployment-check'

export const statusRouter = new Hono()

statusRouter.use('*', requireApiKey)

// GET /api/status/full — full diagnostics (no secrets)
statusRouter.get('/full', async (c) => {
  const project = c.req.query('project')
  const [metadata, deployment] = await Promise.all([
    getTokenMetadata(),
    getDeploymentHealth(),
  ])
  const stats = logger.getStats(project)

  return c.json({
    auth: {
      ...metadata,
      apiKeyConfigured: isApiKeyConfigured(),
    },
    deployment,
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
  })
})
