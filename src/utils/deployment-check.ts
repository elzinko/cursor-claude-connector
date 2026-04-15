import { Redis } from '@upstash/redis'

export type Platform = 'vercel' | 'local'
export type StorageMode = 'file' | 'redis'

export interface DeploymentInfo {
  platform: Platform
  vercelEnv: string | null
  vercelUrl: string | null
  region: string | null
  nodeEnv: string
  nodeVersion: string
}

export interface EnvFlags {
  apiKey: boolean
  redisUrl: boolean
  redisToken: boolean
  corsOrigins: string | null
  storageMode: string | null
  rateLimitRequests: number
  rateLimitWindowMs: number
}

export interface RedisHealth {
  configured: boolean
  connected: boolean | null
  error: string | null
  latencyMs: number | null
}

export interface DeploymentWarning {
  severity: 'error' | 'warning'
  message: string
  remediation: string
}

export function getDeploymentInfo(): DeploymentInfo {
  const isVercel = process.env.VERCEL === '1'
  return {
    platform: isVercel ? 'vercel' : 'local',
    vercelEnv: process.env.VERCEL_ENV || null,
    vercelUrl: process.env.VERCEL_URL || null,
    region: process.env.VERCEL_REGION || null,
    nodeEnv: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
  }
}

export function getEnvFlags(): EnvFlags {
  return {
    apiKey: !!process.env.API_KEY?.trim(),
    redisUrl: !!process.env.UPSTASH_REDIS_REST_URL?.trim(),
    redisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
    corsOrigins: process.env.CORS_ORIGINS?.trim() || null,
    storageMode: process.env.STORAGE_MODE?.trim().toLowerCase() || null,
    rateLimitRequests: parseInt(process.env.RATE_LIMIT_REQUESTS || '100'),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000'),
  }
}

export function getEffectiveStorageMode(): StorageMode {
  const env = getEnvFlags()
  if (env.storageMode === 'file') return 'file'
  if (env.storageMode === 'redis') return 'redis'
  return env.redisUrl && env.redisToken ? 'redis' : 'file'
}

export async function checkRedisHealth(): Promise<RedisHealth> {
  const env = getEnvFlags()
  if (!env.redisUrl || !env.redisToken) {
    return { configured: false, connected: null, error: null, latencyMs: null }
  }
  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
    const start = Date.now()
    await redis.ping()
    return {
      configured: true,
      connected: true,
      error: null,
      latencyMs: Date.now() - start,
    }
  } catch (error) {
    return {
      configured: true,
      connected: false,
      error: (error as Error).message,
      latencyMs: null,
    }
  }
}

export function getDeploymentWarnings(): DeploymentWarning[] {
  const warnings: DeploymentWarning[] = []
  const info = getDeploymentInfo()
  const env = getEnvFlags()
  const mode = getEffectiveStorageMode()

  if (info.platform === 'vercel' && mode === 'file') {
    warnings.push({
      severity: 'error',
      message:
        'Running on Vercel but using file storage — /var/task is read-only, OAuth tokens cannot persist.',
      remediation:
        'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel → Settings → Environment Variables. Make sure the Preview scope is enabled if the PR preview is broken.',
    })
  }

  if (info.platform === 'vercel' && !env.apiKey) {
    warnings.push({
      severity: 'error',
      message: 'Running on Vercel without API_KEY — /v1/* endpoints return 500.',
      remediation:
        'Set API_KEY in Vercel → Settings → Environment Variables (any secret string).',
    })
  }

  if (env.storageMode === 'redis' && (!env.redisUrl || !env.redisToken)) {
    warnings.push({
      severity: 'error',
      message:
        'STORAGE_MODE=redis but UPSTASH_REDIS_REST_URL/TOKEN is missing.',
      remediation: 'Add both env vars or remove STORAGE_MODE to auto-detect.',
    })
  }

  if (info.platform === 'local' && info.nodeEnv === 'production' && !env.apiKey) {
    warnings.push({
      severity: 'error',
      message: 'NODE_ENV=production but API_KEY is not set.',
      remediation: 'Set API_KEY before running in production.',
    })
  }

  return warnings
}

export interface DeploymentHealth {
  info: DeploymentInfo
  env: EnvFlags
  storage: { mode: StorageMode; redis: RedisHealth }
  warnings: DeploymentWarning[]
}

export async function getDeploymentHealth(): Promise<DeploymentHealth> {
  const [info, env, redis] = [
    getDeploymentInfo(),
    getEnvFlags(),
    await checkRedisHealth(),
  ]
  return {
    info,
    env,
    storage: { mode: getEffectiveStorageMode(), redis },
    warnings: getDeploymentWarnings(),
  }
}
