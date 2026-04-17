// IP provenance enrichment for the clients dashboard.
//
// Turns a raw IP into something a human can read at a glance — e.g.
//   37.65.35.26    → "SFR (FR, residential)"
//   13.38.80.221   → "AWS eu-west-3"
//   52.176.18.34   → "Azure"
//
// Design:
//   - Resolver interface so we can swap providers (ipinfo today, MaxMind
//     local later) without touching callers.
//   - Results cached in Upstash HASH-independent key `stats:ipinfo:<ip>`
//     with a 30-day TTL so we don't spam the upstream on every proxy call.
//   - Reverse DNS is best-effort (short timeout) because it's the only
//     reliable way to spot "ec2-*.<region>.compute.amazonaws.com" style
//     hosts and derive a usable region label for cloud providers.
//   - Fully fail-safe: if any step fails we return an all-null record.
//     The caller (client-tracker) treats provenance as decorative only.
//
// Privacy note: IPs are already visible to Vercel/Cloudflare/Anthropic
// along the proxy path, so sending them to ipinfo for enrichment doesn't
// meaningfully widen exposure, and the cache makes it effectively one
// call per unique IP per month.

import { Redis } from '@upstash/redis'
import dns from 'node:dns/promises'

// ── Types ─────────────────────────────────────────────────────────────
export type NetType =
  | 'residential'
  | 'hosting'
  | 'mobile'
  | 'business'
  | 'unknown'

export interface ProvenanceData {
  asn: number | null
  asnOrg: string | null
  netType: NetType
  ptr: string | null
  hostLabel: string | null
}

export const EMPTY_PROVENANCE: ProvenanceData = {
  asn: null,
  asnOrg: null,
  netType: 'unknown',
  ptr: null,
  hostLabel: null,
}

// ── Redis wiring (shared env with oauth/tracker) ──────────────────────
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
const redis =
  redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null

const CACHE_TTL_OK = 30 * 86_400 // 30 days for successful lookups
const CACHE_TTL_NEG = 300 // 5 min for empty/failed lookups — retry soon

const LOOKUP_TIMEOUT_MS = parseInt(process.env.IP_LOOKUP_TIMEOUT_MS || '500')
const PTR_TIMEOUT_MS = parseInt(process.env.IP_PTR_TIMEOUT_MS || '250')

const kIpInfo = (ip: string) => `stats:ipinfo:${ip}`

// ── Private IP / bogon detection ─────────────────────────────────────
// We skip lookup for RFC1918, loopback, link-local, and IPv6 ULA/link-local.
// ipinfo returns garbage for these and the network round-trip is wasted.
export function isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true
  if (ip === '127.0.0.1' || ip === '::1') return true
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (ip.startsWith('169.254.')) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true // fc00::/7
  if (/^fe80:/i.test(ip)) return true
  return false
}

// ── PTR parser ────────────────────────────────────────────────────────
// Given a reverse DNS name, try to extract a short "cloud provider +
// region" label. Keep this pure — it's the most-tested piece.
export function parsePtr(ptr: string | null | undefined): string | null {
  if (!ptr) return null
  const host = String(ptr).toLowerCase().replace(/\.$/, '')
  if (!host) return null

  // AWS EC2 standard: ec2-<dashed-ip>.<region>.compute.amazonaws.com
  let m = host.match(/\.([a-z0-9-]+)\.compute\.amazonaws\.com$/)
  if (m) return `AWS ${m[1]}`
  // AWS us-east-1 legacy: *.compute-1.amazonaws.com
  if (/\.compute-1\.amazonaws\.com$/.test(host)) return 'AWS us-east-1'
  // CloudFront / other amazon subdomains
  if (/\.amazonaws\.com$/.test(host)) return 'AWS'

  // Azure: *.<region>.cloudapp.azure.com
  m = host.match(/\.([a-z0-9-]+)\.cloudapp\.azure\.com$/)
  if (m) return `Azure ${m[1]}`
  if (/\.cloudapp\.azure\.com$/.test(host)) return 'Azure'
  if (/\.azure\.com$/.test(host)) return 'Azure'

  // GCP
  if (/\.googleusercontent\.com$/.test(host)) return 'GCP'
  if (/\.1e100\.net$/.test(host)) return 'Google'

  // Others worth calling out
  if (/\.cloudflare\.com$/.test(host) || /\.cloudflare\.net$/.test(host))
    return 'Cloudflare'
  if (/\.fastly\.net$/.test(host)) return 'Fastly'
  if (/\.digitalocean\.com$/.test(host)) return 'DigitalOcean'
  if (/\.linode\.com$/.test(host)) return 'Linode'
  if (/\.ovh\.net$/.test(host) || /\.ovh\.ca$/.test(host)) return 'OVH'
  if (/\.hetzner\.com$/.test(host) || /\.your-server\.de$/.test(host))
    return 'Hetzner'

  return null
}

// ── ASN org classifier ────────────────────────────────────────────────
const HOSTING_PATTERNS: RegExp[] = [
  /\bamazon\b/i,
  /\baws\b/i,
  /\bgoogle\b/i,
  /\bmicrosoft\b/i,
  /\bazure\b/i,
  /\bdigitalocean\b/i,
  /\bovh\b/i,
  /\bhetzner\b/i,
  /\blinode\b/i,
  /\bvultr\b/i,
  /\bscaleway\b/i,
  /\boracle\s+cloud\b/i,
  /\bfastly\b/i,
  /\bcloudflare\b/i,
  /\bvercel\b/i,
  /\bheroku\b/i,
  /\bnetlify\b/i,
  /\bfly\.io\b/i,
  /\brackspace\b/i,
  /\bhostinger\b/i,
  /\bcontabo\b/i,
]

const MOBILE_PATTERNS: RegExp[] = [
  /\bt-?mobile\b/i,
  /\bverizon wireless\b/i,
  /\bvodafone\b/i,
  /\borange mobile\b/i,
  /\bsfr mobile\b/i,
  /\bfree mobile\b/i,
  /\bbouygues\b/i,
  /\bo2\b/i,
  /\bgsm\b/i,
  /\bwireless\b/i,
]

const BUSINESS_PATTERNS: RegExp[] = [
  /\benterprise\b/i,
  /\bcorporate\b/i,
  /\bdatacenter\b/i,
]

export function classifyNetType(
  asnOrg: string | null | undefined,
  ipinfoType: string | null | undefined,
  ptrLabel: string | null | undefined,
): NetType {
  // PTR match wins — if we recognized a cloud host from reverse DNS, it's
  // definitely hosting regardless of what the ASN says.
  if (ptrLabel) return 'hosting'

  // ipinfo's `type` is authoritative when present:
  // values observed: isp | business | hosting | education | government
  const t = ipinfoType ? ipinfoType.toLowerCase() : null
  if (t === 'hosting') return 'hosting'
  if (t === 'business' || t === 'education' || t === 'government')
    return 'business'
  if (t === 'isp') {
    if (asnOrg && MOBILE_PATTERNS.some((r) => r.test(asnOrg))) return 'mobile'
    return 'residential'
  }

  // Fallback: regex on ASN org
  if (!asnOrg) return 'unknown'
  if (HOSTING_PATTERNS.some((r) => r.test(asnOrg))) return 'hosting'
  if (MOBILE_PATTERNS.some((r) => r.test(asnOrg))) return 'mobile'
  if (BUSINESS_PATTERNS.some((r) => r.test(asnOrg))) return 'business'
  return 'residential'
}

// ── Host label formatter ──────────────────────────────────────────────
// Produces the string rendered in the dashboard's "Host / ASN" column.
// Priority:
//   1. PTR-derived cloud label ("AWS eu-west-3", "Azure", ...)
//   2. Short ASN org + contextual tag for residential/mobile/business
//   3. Bare "AS<n>" as last resort
export function shortenOrg(org: string): string {
  if (!org) return ''
  // Drop leading "AS<number> " prefix (ipinfo returns it that way).
  let s = org.replace(/^AS\d+\s+/i, '').trim()
  // Drop trailing corporate suffixes that add noise.
  s = s
    .replace(
      /,?\s*(Inc\.?|LLC|Ltd\.?|Limited|GmbH|S\.?A\.?S\.?|S\.?A\.?|Corp\.?|Corporation|Co\.?|Company|B\.?V\.?|PLC)\.?\s*$/i,
      '',
    )
    .trim()
  // "Something - SFR" → prefer the shorter, more recognizable part.
  if (s.includes(' - ')) {
    const parts = s.split(' - ').map((p) => p.trim())
    const shortest = parts.reduce((a, b) => (a.length <= b.length ? a : b))
    if (shortest.length >= 2 && shortest.length <= 10) return shortest
    return parts[0]
  }
  return s.length > 32 ? s.slice(0, 32).trim() : s
}

export function formatHostLabel(d: {
  asn: number | null
  asnOrg: string | null
  ptrLabel: string | null
  netType: NetType
  country: string | null
}): string | null {
  if (d.ptrLabel) return d.ptrLabel
  const org = d.asnOrg ? shortenOrg(d.asnOrg) : null
  if (org) {
    if (
      d.netType === 'residential' ||
      d.netType === 'mobile' ||
      d.netType === 'business'
    ) {
      return d.country
        ? `${org} (${d.country}, ${d.netType})`
        : `${org} (${d.netType})`
    }
    return org
  }
  if (d.asn) {
    return `AS${d.asn}`
  }
  return null
}

// ── Resolver interface ────────────────────────────────────────────────
// Pluggable so a MaxMind-local resolver can be added later without
// changing the caller.
export interface IpResolver {
  name: string
  resolve(
    ip: string,
    signal: AbortSignal,
  ): Promise<{
    asn: number | null
    asnOrg: string | null
    ipinfoType: string | null
  }>
}

// ── ipinfo.io resolver ────────────────────────────────────────────────
function parseIpinfoOrg(org: unknown): { asn: number | null; asnOrg: string | null } {
  if (typeof org !== 'string' || !org) return { asn: null, asnOrg: null }
  // ipinfo returns e.g. "AS16509 Amazon.com, Inc."
  const m = org.match(/^AS(\d+)\s+(.*)$/)
  if (m) return { asn: parseInt(m[1], 10), asnOrg: m[2].trim() || null }
  return { asn: null, asnOrg: org.trim() }
}

export const ipinfoResolver: IpResolver = {
  name: 'ipinfo',
  async resolve(ip, signal) {
    const token = process.env.IPINFO_TOKEN?.trim()
    const url = token
      ? `https://ipinfo.io/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`
      : `https://ipinfo.io/${encodeURIComponent(ip)}/json`
    const res = await fetch(url, {
      signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { asn: null, asnOrg: null, ipinfoType: null }
    }
    const data = (await res.json()) as {
      org?: unknown
      asn?: { asn?: string; name?: string }
      type?: unknown
    }
    // Paid ipinfo plans expose a nested `asn` object; free tier puts it in `org`.
    let asn: number | null = null
    let asnOrg: string | null = null
    if (data.asn && typeof data.asn.asn === 'string') {
      asn = parseInt(data.asn.asn.replace(/^AS/i, ''), 10) || null
      asnOrg = data.asn.name || null
    } else {
      const parsed = parseIpinfoOrg(data.org)
      asn = parsed.asn
      asnOrg = parsed.asnOrg
    }
    const ipinfoType = typeof data.type === 'string' ? data.type : null
    return { asn, asnOrg, ipinfoType }
  },
}

// Active resolver — single slot today, ready for pluggable selection later.
function getActiveResolver(): IpResolver | null {
  const provider = (process.env.IP_PROVENANCE_PROVIDER || 'ipinfo')
    .trim()
    .toLowerCase()
  if (provider === 'none' || provider === 'off') return null
  // ipinfo is the only resolver wired today. Unknown providers fall through
  // to ipinfo rather than disabling the feature silently.
  return ipinfoResolver
}

// ── Reverse DNS ───────────────────────────────────────────────────────
async function reverseDns(ip: string): Promise<string | null> {
  try {
    const result = await withTimeout(
      dns.reverse(ip).catch(() => [] as string[]),
      PTR_TIMEOUT_MS,
      [] as string[],
    )
    return Array.isArray(result) && result[0] ? String(result[0]) : null
  } catch {
    return null
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(fallback)
    }, ms)
    p.then(
      (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

// ── Cache ─────────────────────────────────────────────────────────────
function decodeCached(raw: unknown): ProvenanceData | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ProvenanceData
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') return raw as ProvenanceData
  return null
}

// ── Public entrypoint ────────────────────────────────────────────────
// Safe to call on every proxy request. Returns fast on cache hit,
// bounded by LOOKUP_TIMEOUT_MS on cache miss, never throws.
export async function lookupProvenance(
  ip: string,
  country: string | null,
): Promise<ProvenanceData> {
  if (isPrivateIp(ip)) return EMPTY_PROVENANCE

  // Cache hit → return as-is.
  if (redis) {
    try {
      const cached = decodeCached(await redis.get(kIpInfo(ip)))
      if (cached) return cached
    } catch {
      // Fall through to fresh lookup — cache read failure shouldn't block.
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  const resolver = getActiveResolver()
  try {
    const [info, ptr] = await Promise.all([
      resolver
        ? resolver
            .resolve(ip, controller.signal)
            .catch(() => ({ asn: null, asnOrg: null, ipinfoType: null }))
        : Promise.resolve({ asn: null, asnOrg: null, ipinfoType: null }),
      reverseDns(ip),
    ])
    const ptrLabel = parsePtr(ptr)
    const netType = classifyNetType(info.asnOrg, info.ipinfoType, ptrLabel)
    const result: ProvenanceData = {
      asn: info.asn,
      asnOrg: info.asnOrg,
      netType,
      ptr,
      hostLabel: formatHostLabel({
        asn: info.asn,
        asnOrg: info.asnOrg,
        ptrLabel,
        netType,
        country,
      }),
    }

    if (redis) {
      // Shorter TTL for empty results so a transient outage doesn't stick
      // for 30 days.
      const isEmpty =
        result.asn == null &&
        result.asnOrg == null &&
        result.ptr == null &&
        result.hostLabel == null
      const ttl = isEmpty ? CACHE_TTL_NEG : CACHE_TTL_OK
      try {
        await redis.set(kIpInfo(ip), JSON.stringify(result), { ex: ttl })
      } catch {
        // non-fatal — enrichment is decorative
      }
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}
