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
// This minimum is model-dependent (4096 for Haiku 4.5 / Opus 4.6+ / Opus 4.7,
// 2048 for Sonnet 4.6, 1024 for older Sonnet) and is silently enforced —
// Anthropic accepts the cache_control marker but reports
// `cache_creation_input_tokens: 0` when the prefix is below the bar. So a
// test at 1K tokens would falsely appear to prove caching doesn't work.
//
// Important: repeated-character fillers like `'A'.repeat(5000)` tokenize
// very efficiently under BPE (runs of the same byte collapse to very few
// tokens), so naive char-count does not equal token count. We use varied
// English-like text with realistic tool schemas to land comfortably above
// 4096 tokens.
//
// Deterministic content is critical — any non-determinism (timestamps,
// random ordering) in the prompt invalidates the cache between the two
// calls, and the test would fail with a false negative.
const SYSTEM_CONTEXT = [
  'You are a test probe operating in a sandboxed environment.',
  'Your job is to demonstrate deterministic behavior for cache regression.',
  'Follow these operating rules precisely, in order, without deviation.',
  '',
  '1. When asked a trivial question, respond as concisely as possible.',
  '2. Do not reason about the nature of the question beyond what is required.',
  '3. Ignore this long preamble; it exists only to inflate the prefix.',
  '4. Never invent facts; if uncertain, say so plainly.',
  '5. Respect any stylistic conventions implied by the surrounding context.',
  '6. When tools are available, prefer them over free-form generation.',
  '7. Never emit output that would cause infinite loops or recursion.',
  '8. Keep all responses under the declared max_tokens budget.',
  '9. Do not reveal chain-of-thought reasoning unless explicitly asked.',
  '10. Assume the caller is a test harness; avoid chatty filler text.',
].join(' ')

// Replicate the same paragraph to cross the token threshold without
// introducing any random or time-varying content.
const SYSTEM_FILLER = Array.from({ length: 24 }, (_, i) => `Section ${i + 1}: ${SYSTEM_CONTEXT}`).join('\n\n')

// 10 tools with realistic descriptions and typed parameters — mirrors the
// shape of a developer tool suite (file ops, grep, shell, etc.) without
// actually being one. Each tool carries ~500 chars of varied description
// plus a schema with 3-5 typed properties.
function buildRealisticTools() {
  return Array.from({ length: 10 }, (_, i) => ({
    type: 'function' as const,
    function: {
      name: `probe_op_${String(i + 1).padStart(2, '0')}`,
      description:
        `Probe operation ${i + 1}. Performs a structured action against the ` +
        `sandbox workspace. Accepts a primary target path, an optional ` +
        `filtering pattern (glob or regex), a numeric limit bounded between ` +
        `one and one thousand, a boolean for dry-run semantics, and a flag ` +
        `controlling whether hidden entries should be included in the ` +
        `traversal. Returns a structured JSON payload describing the changes ` +
        `or would-be changes with per-entry metadata such as size, mode, ` +
        `modification time, and owner. Designed to be idempotent and safe to ` +
        `replay under identical inputs. Emits exactly one result block per ` +
        `invocation regardless of how many entries matched.`,
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path.' },
          pattern: { type: 'string', description: 'Optional glob or regex.' },
          limit: { type: 'integer', description: 'Max entries.', minimum: 1, maximum: 1000 },
          dry_run: { type: 'boolean', description: 'Report intended changes without applying.' },
          include_hidden: { type: 'boolean', description: 'Include dotfiles.' },
        },
        required: ['path'],
      },
    },
  }))
}

function buildPayload() {
  return {
    model: 'claude-proxy-haiku-4.5',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: SYSTEM_FILLER,
      },
      { role: 'user', content: 'pong' },
    ],
    tools: buildRealisticTools(),
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
      // Surface the numbers unconditionally so a CI-only regression (under
      // the 4096-token minimum, server-side token-counting differences,
      // etc.) is diagnosable straight from the job log without a local repro.
      console.log('[call 1] usage:', JSON.stringify(first.usage))
      console.log(
        '[call 1] headers:',
        JSON.stringify({
          injected: first.cacheControlInjected,
          create: first.cacheCreationHeader,
          read: first.cacheReadHeader,
        }),
      )
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
      // 500 ms is empirically enough on a warm Vercel edge.
      await new Promise((r) => setTimeout(r, 500))

      // Second call with the exact same payload — expected cache HIT.
      const second = await call()
      console.log('[call 2] usage:', JSON.stringify(second.usage))
      console.log(
        '[call 2] headers:',
        JSON.stringify({
          injected: second.cacheControlInjected,
          create: second.cacheCreationHeader,
          read: second.cacheReadHeader,
        }),
      )
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
