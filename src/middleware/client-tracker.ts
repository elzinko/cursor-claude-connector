import { createHash } from 'node:crypto'
import { Redis } from '@upstash/redis'
import type { Context } from 'hono'

// ── Redis wiring (same env vars as oauth-manager) ────────────────────
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
const hasRedis = !!(redisUrl && redisToken)
const redis = hasRedis ? new Redis({ url: redisUrl!, token: redisToken! }) : null

// ── Retention ─────────────────────────────────────────────────────────
export const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.STATS_RETENTION_DAYS || '30'),
)
const RETENTION_SECONDS = RETENTION_DAYS * 86_400

// ── Redis keys ────────────────────────────────────────────────────────
const K_CLIENTS = 'stats:clients' // HASH: fingerprint -> JSON(ClientRecord)
const K_REVOKED = 'stats:revoked' // SET: revoked fingerprints
const kDaily = (date: string) => `stats:daily:${date}` // HASH with TTL

// ── Types ─────────────────────────────────────────────────────────────
export interface ClientRecord {
  fingerprint: string
  apiKeySuffix: string
  ip: string
  ua: string
  uaParsed: string
  country: string | null
  firstSeen: string
  lastSeen: string
  requests: number
  tokensIn: number
  tokensOut: number
  blocked: number
  revoked?: boolean
}

export interface DailyCounters {
  requests: number
  tokensIn: number
  tokensOut: number
  blocked: number
}

export interface DailyBucket {
  date: string
  perFingerprint: Record<string, DailyCounters>
}

// ── In-memory fallback (local dev without Redis) ──────────────────────
const memClients = new Map<string, ClientRecord>()
const memDaily = new Map<string, Map<string, DailyCounters>>()
const memRevoked = new Set<string>()

// ── Helpers ───────────────────────────────────────────────────────────
export function maskApiKey(key: string): string {
  if (!key) return '***'
  if (key.length <= 6) return '***'
  return `***${key.slice(-4)}`
}

export function parseUserAgent(ua: string): string {
  if (!ua) return 'unknown'
  const lower = ua.toLowerCase()
  if (lower.includes('cursor')) return 'cursor'
  if (lower.includes('openclaw')) return 'openclaw'
  if (lower.includes('claude-code') || lower.includes('claudecode')) return 'claude-code'
  if (lower.startsWith('curl/')) return 'curl'
  if (lower.includes('anthropic')) return 'anthropic-sdk'
  if (lower.includes('python')) return 'python'
  if (lower.includes('node')) return 'node'
  if (lower.startsWith('mozilla/')) return 'browser'
  return 'unknown'
}

export function getClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const real = c.req.header('x-real-ip')
  if (real) return real.trim()
  const vercelFwd = c.req.header('x-vercel-forwarded-for')
  if (vercelFwd) return vercelFwd.split(',')[0].trim()
  return 'unknown'
}

export function getCountry(c: Context): string | null {
  return (
    c.req.header('x-vercel-ip-country') ||
    c.req.header('cf-ipcountry') ||
    null
  )
}

export function fingerprint(apiKey: string, ip: string): string {
  return createHash('sha256')
    .update(`${apiKey}|${ip}`)
    .digest('hex')
    .slice(0, 16)
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

// Upstash returns hash fields either as pre-parsed objects or raw strings
// depending on how they were stored. Normalize both.
function decode<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
  return raw as T
}

// ── Public API ────────────────────────────────────────────────────────
async function isRevoked(fp: string): Promise<boolean> {
  if (!redis) return memRevoked.has(fp)
  try {
    const res = await redis.sismember(K_REVOKED, fp)
    return res === 1
  } catch (err) {
    console.error('[client-tracker] isRevoked failed:', err)
    return false
  }
}

async function revoke(fp: string): Promise<void> {
  if (!redis) {
    memRevoked.add(fp)
    const rec = memClients.get(fp)
    if (rec) rec.revoked = true
    return
  }
  try {
    await redis.sadd(K_REVOKED, fp)
    const existing = decode<ClientRecord>(await redis.hget(K_CLIENTS, fp))
    if (existing) {
      existing.revoked = true
      await redis.hset(K_CLIENTS, { [fp]: JSON.stringify(existing) })
    }
  } catch (err) {
    console.error('[client-tracker] revoke failed:', err)
    throw err
  }
}

async function unrevoke(fp: string): Promise<void> {
  if (!redis) {
    memRevoked.delete(fp)
    const rec = memClients.get(fp)
    if (rec) rec.revoked = false
    return
  }
  try {
    await redis.srem(K_REVOKED, fp)
    const existing = decode<ClientRecord>(await redis.hget(K_CLIENTS, fp))
    if (existing) {
      existing.revoked = false
      await redis.hset(K_CLIENTS, { [fp]: JSON.stringify(existing) })
    }
  } catch (err) {
    console.error('[client-tracker] unrevoke failed:', err)
    throw err
  }
}

export interface TrackInput {
  fingerprint: string
  apiKey: string
  ip: string
  ua: string
  country: string | null
  tokensIn: number
  tokensOut: number
  blocked: boolean
}

async function trackRequest(input: TrackInput): Promise<void> {
  const now = new Date().toISOString()
  const day = todayKey()
  const reqDelta = input.blocked ? 0 : 1
  const blockDelta = input.blocked ? 1 : 0
  const tokInDelta = input.blocked ? 0 : input.tokensIn
  const tokOutDelta = input.blocked ? 0 : input.tokensOut

  if (!redis) {
    // In-memory path
    const existing = memClients.get(input.fingerprint)
    if (existing) {
      existing.lastSeen = now
      existing.ua = input.ua
      existing.uaParsed = parseUserAgent(input.ua)
      existing.country = input.country
      existing.requests += reqDelta
      existing.tokensIn += tokInDelta
      existing.tokensOut += tokOutDelta
      existing.blocked += blockDelta
    } else {
      memClients.set(input.fingerprint, {
        fingerprint: input.fingerprint,
        apiKeySuffix: maskApiKey(input.apiKey),
        ip: input.ip,
        ua: input.ua,
        uaParsed: parseUserAgent(input.ua),
        country: input.country,
        firstSeen: now,
        lastSeen: now,
        requests: reqDelta,
        tokensIn: tokInDelta,
        tokensOut: tokOutDelta,
        blocked: blockDelta,
        revoked: memRevoked.has(input.fingerprint),
      })
    }
    let dayMap = memDaily.get(day)
    if (!dayMap) {
      dayMap = new Map()
      memDaily.set(day, dayMap)
    }
    const dc = dayMap.get(input.fingerprint) || {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      blocked: 0,
    }
    dc.requests += reqDelta
    dc.tokensIn += tokInDelta
    dc.tokensOut += tokOutDelta
    dc.blocked += blockDelta
    dayMap.set(input.fingerprint, dc)
    return
  }

  // Redis path — read/modify/write. Acceptable for personal-proxy volume.
  try {
    const existing = decode<ClientRecord>(
      await redis.hget(K_CLIENTS, input.fingerprint),
    )
    const rec: ClientRecord = existing
      ? {
          ...existing,
          lastSeen: now,
          ua: input.ua,
          uaParsed: parseUserAgent(input.ua),
          country: input.country,
          requests: (existing.requests || 0) + reqDelta,
          tokensIn: (existing.tokensIn || 0) + tokInDelta,
          tokensOut: (existing.tokensOut || 0) + tokOutDelta,
          blocked: (existing.blocked || 0) + blockDelta,
        }
      : {
          fingerprint: input.fingerprint,
          apiKeySuffix: maskApiKey(input.apiKey),
          ip: input.ip,
          ua: input.ua,
          uaParsed: parseUserAgent(input.ua),
          country: input.country,
          firstSeen: now,
          lastSeen: now,
          requests: reqDelta,
          tokensIn: tokInDelta,
          tokensOut: tokOutDelta,
          blocked: blockDelta,
        }
    await redis.hset(K_CLIENTS, {
      [input.fingerprint]: JSON.stringify(rec),
    })

    const dayKey = kDaily(day)
    const existDay = decode<DailyCounters>(
      await redis.hget(dayKey, input.fingerprint),
    )
    const dc: DailyCounters = existDay
      ? {
          requests: (existDay.requests || 0) + reqDelta,
          tokensIn: (existDay.tokensIn || 0) + tokInDelta,
          tokensOut: (existDay.tokensOut || 0) + tokOutDelta,
          blocked: (existDay.blocked || 0) + blockDelta,
        }
      : {
          requests: reqDelta,
          tokensIn: tokInDelta,
          tokensOut: tokOutDelta,
          blocked: blockDelta,
        }
    await redis.hset(dayKey, {
      [input.fingerprint]: JSON.stringify(dc),
    })
    await redis.expire(dayKey, RETENTION_SECONDS)
  } catch (err) {
    console.error('[client-tracker] trackRequest failed:', err)
  }
}

async function listClients(): Promise<ClientRecord[]> {
  if (!redis) {
    const list = Array.from(memClients.values()).map((c) => ({
      ...c,
      revoked: memRevoked.has(c.fingerprint),
    }))
    list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''))
    return list
  }
  try {
    const map = (await redis.hgetall(K_CLIENTS)) as Record<string, unknown> | null
    if (!map) return []
    const revoked = await redis.smembers(K_REVOKED)
    const revokedSet = new Set<string>(revoked || [])
    const result: ClientRecord[] = []
    for (const [fp, raw] of Object.entries(map)) {
      const rec = decode<ClientRecord>(raw)
      if (!rec) continue
      result.push({ ...rec, fingerprint: fp, revoked: revokedSet.has(fp) })
    }
    result.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''))
    return result
  } catch (err) {
    console.error('[client-tracker] listClients failed:', err)
    return []
  }
}

async function getDailyStats(days: number = RETENTION_DAYS): Promise<DailyBucket[]> {
  const capped = Math.max(1, Math.min(days, RETENTION_DAYS))
  const result: DailyBucket[] = []
  const now = new Date()
  for (let i = capped - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const date = d.toISOString().slice(0, 10)
    const perFingerprint: Record<string, DailyCounters> = {}

    if (!redis) {
      const mem = memDaily.get(date)
      if (mem) {
        for (const [fp, dc] of mem) perFingerprint[fp] = { ...dc }
      }
    } else {
      try {
        const map = (await redis.hgetall(kDaily(date))) as
          | Record<string, unknown>
          | null
        if (map) {
          for (const [fp, raw] of Object.entries(map)) {
            const dc = decode<DailyCounters>(raw)
            if (dc) perFingerprint[fp] = dc
          }
        }
      } catch (err) {
        console.error(`[client-tracker] getDailyStats ${date} failed:`, err)
      }
    }
    result.push({ date, perFingerprint })
  }
  return result
}

export const tracker = {
  isRevoked,
  revoke,
  unrevoke,
  trackRequest,
  listClients,
  getDailyStats,
  retentionDays: RETENTION_DAYS,
  hasRedis,
}
