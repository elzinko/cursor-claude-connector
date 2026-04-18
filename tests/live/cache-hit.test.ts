// Live two-call regression — the only test that proves the cache actually
// works end-to-end. Fires two identical requests a few seconds apart and
// asserts the second one comes back with `cache_read_input_tokens > 0`.
// Reads the value out of `usage.prompt_tokens_details.cached_tokens` in
// the OpenAI-compat response, which is the same path openclaw and other
// OpenAI-compat clients use — so if this test passes, they'll see cache
// hits too.
//
// Excluded from `npm test` (vitest.config.ts only includes tests/live
// when LIVE_TESTS=1). Run explicitly:
//
//   PROXY_URL=https://<preview>.vercel.app \
//   PROBE_API_KEY=<same as Vercel API_KEY env var> \
//   PROBE_BYPASS_TOKEN=<Vercel Deployment Protection Bypass> \
//   LIVE_TESTS=1 \
//   npm run test:live
//
// Uses Haiku to keep quota cost minimal (two ~5K-token input calls ≈ a
// few cents). Live tests burn real OAuth quota every run — use sparingly.

import { describe, expect, it } from 'vitest'

const PROXY_URL = process.env.PROXY_URL
const API_KEY = process.env.PROBE_API_KEY
const BYPASS = process.env.PROBE_BYPASS_TOKEN

const shouldRun = Boolean(PROXY_URL && API_KEY)

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  }
  if (BYPASS) h['x-vercel-protection-bypass'] = BYPASS
  return h
}

// A payload large enough to clear Haiku's 4096-token cache-minimum prefix.
// The skill doc is explicit: smaller prefixes silently won't cache, so a
// probe at 1K tokens would return zero and lie about whether the feature
// works. 5K ASCII chars ≈ ~1250 tokens on their own; combined with 5
// verbose tools (~500 chars of description each) we land well above 4K.
//
// Deterministic content is critical — any non-determinism (timestamps,
// random ordering) in the prompt invalidates the cache between the two
// calls, and the test would fail with a false negative.
function buildPayload() {
  const filler = 'A'.repeat(5000)
  return {
    model: 'claude-proxy-haiku-4.5',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: `You are a test probe. Ignore this filler: ${filler}`,
      },
      { role: 'user', content: 'pong' },
    ],
    tools: Array.from({ length: 5 }, (_, i) => ({
      type: 'function',
      function: {
        name: `probe_tool_${i}`,
        description: 'Y'.repeat(500),
        parameters: { type: 'object', properties: {} },
      },
    })),
  }
}

type UsageShape = {
  prompt_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_tokens?: number
  }
}

async function call(): Promise<{
  status: number
  usage: UsageShape | undefined
  cacheCreationHeader: string | null
  cacheReadHeader: string | null
  cacheControlInjected: string | null
}> {
  const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(buildPayload()),
  })
  const body = (await r.json()) as { usage?: UsageShape } | null
  return {
    status: r.status,
    usage: body?.usage,
    cacheCreationHeader: r.headers.get('x-anthropic-cache-creation'),
    cacheReadHeader: r.headers.get('x-anthropic-cache-read'),
    cacheControlInjected: r.headers.get('x-cache-control-injected'),
  }
}

describe.skipIf(!shouldRun)('live cache-hit regression (two-call pattern)', () => {
  it(
    'call 1 writes the cache, call 2 reads from it',
    async () => {
      // First call — expected to write the cache. Anthropic reports the
      // bytes written under cache_creation_input_tokens at ~1.25× rate.
      const first = await call()
      expect(first.status).toBe(200)
      expect(first.cacheControlInjected).toBe('2') // system + tools breakpoints
      const firstCached =
        first.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const firstCreate =
        first.usage?.prompt_tokens_details?.cache_creation_tokens ?? 0
      expect(firstCreate).toBeGreaterThan(0)
      expect(firstCached).toBe(0) // nothing in cache to read yet

      // Small delay so the cache entry is committed before call 2 fires.
      // Prompt cache is readable once the first response begins streaming;
      // 200 ms is empirically enough on a warm Vercel edge.
      await new Promise((r) => setTimeout(r, 500))

      // Second call with the exact same payload — expected cache HIT.
      const second = await call()
      expect(second.status).toBe(200)
      const secondCached =
        second.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const secondCreate =
        second.usage?.prompt_tokens_details?.cache_creation_tokens ?? 0
      expect(secondCached).toBeGreaterThan(0)
      expect(secondCached).toBeGreaterThanOrEqual(firstCreate * 0.9)
      expect(secondCreate).toBe(0)

      // Response header mirror for human-readable inspection
      expect(Number(second.cacheReadHeader)).toBe(secondCached)
      expect(Number(second.cacheCreationHeader)).toBe(0)
    },
    30_000,
  )
})
