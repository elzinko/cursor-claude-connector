import { Hono } from 'hono'
import { logger } from '../middleware/request-logger'
import { rateLimiter } from '../middleware/rate-limiter'
import { requireApiKey } from './../middleware/require-api-key'

export const statsRouter = new Hono()

statsRouter.use('*', requireApiKey)

// GET /stats - Get usage statistics
statsRouter.get('/', (c) => {
  const project = c.req.query('project')
  const stats = logger.getStats(project)

  return c.json({
    stats,
    projects: stats.projects.map((proj) => ({
      name: proj,
      ...logger.getStats(proj),
      rateLimit: rateLimiter.getStats(proj),
    })),
  })
})

// GET /stats/logs - Get recent logs
statsRouter.get('/logs', (c) => {
  const project = c.req.query('project')
  const limit = parseInt(c.req.query('limit') || '50')
  
  const logs = logger.getLogs(project).slice(-limit)
  
  return c.json({ logs, total: logs.length })
})
