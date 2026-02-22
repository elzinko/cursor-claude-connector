import { Context } from 'hono'

interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map()
  private config: RateLimitConfig

  constructor(config: RateLimitConfig = { maxRequests: 100, windowMs: 3600000 }) {
    this.config = config
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now()
    const entry = this.limits.get(identifier)

    if (!entry || now >= entry.resetAt) {
      // New window
      this.limits.set(identifier, {
        count: 1,
        resetAt: now + this.config.windowMs,
      })
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetAt: now + this.config.windowMs,
      }
    }

    if (entry.count >= this.config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      }
    }

    entry.count++
    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.count,
      resetAt: entry.resetAt,
    }
  }

  getStats(identifier: string) {
    const entry = this.limits.get(identifier)
    if (!entry || Date.now() >= entry.resetAt) {
      return { count: 0, limit: this.config.maxRequests, resetIn: 0 }
    }
    return {
      count: entry.count,
      limit: this.config.maxRequests,
      resetIn: Math.ceil((entry.resetAt - Date.now()) / 1000),
    }
  }
}

export const rateLimiter = new RateLimiter({
  maxRequests: parseInt(process.env.RATE_LIMIT_REQUESTS || '100'),
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000'), // 1 hour
})
