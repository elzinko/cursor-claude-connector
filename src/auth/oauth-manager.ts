import { Redis } from '@upstash/redis'
import * as fileStorage from './file-storage'

interface OAuthCredentials {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

interface AuthData {
  [provider: string]: OAuthCredentials
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

// Storage mode: 'file' (local) or 'redis' (vercel). Auto-detect if not set.
// Vercel: add Upstash Redis via Vercel Marketplace → Storage → Redis
const storageMode = process.env.STORAGE_MODE?.toLowerCase()
const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL?.trim() ||
  process.env.KV_REST_API_URL?.trim()
const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
  process.env.KV_REST_API_TOKEN?.trim()

const useFileStorage =
  storageMode === 'file' ||
  (storageMode !== 'redis' && (!redisUrl || !redisToken))
if (useFileStorage) {
  console.log('📁 Using local file storage (.auth/credentials.json)')
} else {
  console.log('🔗 Using Redis storage (Vercel/Upstash)')
}

const redis = useFileStorage
  ? null
  : new Redis({ url: redisUrl!, token: redisToken! })

const AUTH_KEY = 'auth:anthropic'

async function get(): Promise<OAuthCredentials | null> {
  if (useFileStorage) return fileStorage.get()
  try {
    const data = await redis!.get<OAuthCredentials>(AUTH_KEY)
    return data
  } catch (error) {
    console.error('Error getting auth from Redis:', error)
    return null
  }
}

async function set(credentials: OAuthCredentials): Promise<boolean> {
  if (useFileStorage) return fileStorage.set(credentials)
  try {
    await redis!.set(AUTH_KEY, credentials)
    return true
  } catch (error) {
    console.error('Error saving auth to Redis:', error)
    throw error
  }
}

async function remove(): Promise<boolean> {
  if (useFileStorage) return fileStorage.remove()
  try {
    await redis!.del(AUTH_KEY)
    return true
  } catch (error) {
    console.error('Error removing auth from Redis:', error)
    throw error
  }
}

async function getAll(): Promise<AuthData> {
  if (useFileStorage) return fileStorage.getAll()
  try {
    const credentials = await redis!.get<OAuthCredentials>(AUTH_KEY)
    if (credentials) return { anthropic: credentials }
    return {}
  } catch (error) {
    console.error('Error getting all auth from Redis:', error)
    return {}
  }
}

async function refreshToken(
  credentials: OAuthCredentials,
): Promise<string | null> {
  try {
    const CLIENT_ID =
      process.env.ANTHROPIC_OAUTH_CLIENT_ID ||
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

    const response = await fetch(
      'https://console.anthropic.com/v1/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30_000), // 30s timeout for token refresh
      },
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to refresh token: ${error}`)
    }

    const data = (await response.json()) as TokenResponse

    const newCredentials: OAuthCredentials = {
      type: 'oauth',
      refresh: data.refresh_token,
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000,
    }

    await set(newCredentials)

    return data.access_token
  } catch (error) {
    console.error('Error refreshing token:', error)
    return null
  }
}

async function getAccessToken(): Promise<string | null> {
  const credentials = await get()
  if (!credentials || credentials.type !== 'oauth') {
    return null
  }

  // Check if token is expired
  if (credentials.expires && credentials.expires > Date.now()) {
    console.log('Token is valid')
    return credentials.access
  }

  // Token is expired, need to refresh
  if (credentials.refresh) {
    console.log('Token is expired, need to refresh')
    return await refreshToken(credentials)
  }

  return null
}

export { get, set, remove, getAll, getAccessToken }
