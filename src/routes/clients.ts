import { Hono } from 'hono'
import { requireApiKey } from '../middleware/require-api-key'
import { tracker } from '../middleware/client-tracker'

export const clientsRouter = new Hono()

clientsRouter.use('*', requireApiKey)

// GET /api/clients — list known clients with aggregated stats
clientsRouter.get('/', async (c) => {
  const clients = await tracker.listClients()
  return c.json({
    retentionDays: tracker.retentionDays,
    backend: tracker.hasRedis ? 'redis' : 'memory',
    clients,
  })
})

// GET /api/clients/daily?days=30 — daily buckets for the usage chart
clientsRouter.get('/daily', async (c) => {
  const raw = parseInt(c.req.query('days') || String(tracker.retentionDays))
  const days = Math.max(1, Math.min(tracker.retentionDays, isNaN(raw) ? tracker.retentionDays : raw))
  const daily = await tracker.getDailyStats(days)
  return c.json({ days, daily })
})

// POST /api/clients/:fp/revoke — block this fingerprint immediately
clientsRouter.post('/:fp/revoke', async (c) => {
  const fp = c.req.param('fp')
  if (!fp || fp.length < 8) {
    return c.json({ error: 'Invalid fingerprint' }, 400)
  }
  try {
    await tracker.revoke(fp)
    return c.json({ success: true, fingerprint: fp, revoked: true })
  } catch (err) {
    return c.json(
      { error: 'Revoke failed', message: (err as Error).message },
      500,
    )
  }
})

// POST /api/clients/:fp/unrevoke — re-allow a previously revoked fingerprint
clientsRouter.post('/:fp/unrevoke', async (c) => {
  const fp = c.req.param('fp')
  if (!fp || fp.length < 8) {
    return c.json({ error: 'Invalid fingerprint' }, 400)
  }
  try {
    await tracker.unrevoke(fp)
    return c.json({ success: true, fingerprint: fp, revoked: false })
  } catch (err) {
    return c.json(
      { error: 'Unrevoke failed', message: (err as Error).message },
      500,
    )
  }
})
