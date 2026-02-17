import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface OAuthCredentials {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

const AUTH_DIR = '.auth'
const AUTH_FILE = 'credentials.json'
const AUTH_KEY = 'anthropic'

function getAuthPath(): string {
  return join(process.cwd(), AUTH_DIR, AUTH_FILE)
}

async function ensureAuthDir(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true })
}

export async function get(): Promise<OAuthCredentials | null> {
  try {
    const path = getAuthPath()
    const data = await readFile(path, 'utf-8')
    const json = JSON.parse(data) as Record<string, OAuthCredentials>
    return json[AUTH_KEY] ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error('Error reading auth file:', error)
    return null
  }
}

export async function set(credentials: OAuthCredentials): Promise<boolean> {
  try {
    await ensureAuthDir()
    const path = getAuthPath()
    let data: Record<string, OAuthCredentials> = {}
    try {
      const content = await readFile(path, 'utf-8')
      data = JSON.parse(content) as Record<string, OAuthCredentials>
    } catch {
      /* file doesn't exist or is empty */
    }
    data[AUTH_KEY] = credentials
    await writeFile(path, JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('Error saving auth file:', error)
    throw error
  }
}

export async function remove(): Promise<boolean> {
  try {
    const path = getAuthPath()
    const data: Record<string, OAuthCredentials> = {}
    await writeFile(path, JSON.stringify(data), 'utf-8')
    return true
  } catch (error) {
    console.error('Error removing auth:', error)
    throw error
  }
}

export async function getAll(): Promise<Record<string, OAuthCredentials>> {
  const creds = await get()
  if (creds) return { [AUTH_KEY]: creds }
  return {}
}
