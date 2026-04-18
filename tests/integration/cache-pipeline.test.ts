// Pipeline test — composes the same pure helpers server.ts chains together,
// without bringing up Hono. Verifies the two things that matter end-to-end:
//   1. the body that goes to api.anthropic.com has `cache_control` on the
//      last system block and last tool, surviving sanitize-body's allowlist
//   2. the OpenAI-format response the proxy returns to the caller carries
//      the cache metrics under `usage.prompt_tokens_details`
//
// If both hold, the proxy is cache-ready from a black-box perspective —
// Anthropic will cache, and OpenAI-compat clients will see the cache hit.

import { describe, expect, it } from 'vitest'
import { injectCacheControl } from '../../src/utils/cache-control'
import { sanitizeBodyForAnthropic } from '../../src/utils/sanitize-body'
import { convertNonStreamingResponse } from '../../src/utils/anthropic-to-openai-converter'

describe('cache pipeline: client request → Anthropic body', () => {
  it('openclaw-like 22-tool request: survives sanitize with cache_control intact', () => {
    // Shape mirroring an openclaw payload: Claude Code marker already in
    // system (as if the proxy just injected it), 22 tools, and a top-level
    // body with OpenAI-only fields that sanitize-body is supposed to strip.
    const body: any = {
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      stream: false,
      // OpenAI-only fields that MUST be stripped by sanitize-body:
      frequency_penalty: 0,
      presence_penalty: 0,
      n: 1,
      logprobs: false,
      // Anthropic-compatible fields:
      system: [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        { type: 'text', text: 'A'.repeat(3000) },
      ],
      tools: Array.from({ length: 22 }, (_, i) => ({
        name: `tool_${String(i + 1).padStart(2, '0')}`,
        description: 'x'.repeat(200),
        input_schema: { type: 'object', properties: {} },
      })),
      messages: [{ role: 'user', content: 'pong' }],
    }

    injectCacheControl(body)
    const cleanBody = sanitizeBodyForAnthropic(body)

    // OpenAI-only fields gone
    expect(cleanBody.frequency_penalty).toBeUndefined()
    expect(cleanBody.presence_penalty).toBeUndefined()
    expect(cleanBody.n).toBeUndefined()
    expect(cleanBody.logprobs).toBeUndefined()

    // Anthropic fields preserved
    expect(cleanBody.model).toBe('claude-opus-4-6')
    expect(cleanBody.max_tokens).toBe(16000)

    // cache_control survives on last system block (not first) — that's the
    // single marker that caches tools + system together.
    const sys = cleanBody.system as any[]
    expect(sys[0].cache_control).toBeUndefined()
    expect(sys[sys.length - 1].cache_control).toEqual({ type: 'ephemeral' })

    // cache_control survives on last tool (not first/middle)
    const tools = cleanBody.tools as any[]
    expect(tools[0].cache_control).toBeUndefined()
    expect(tools[10].cache_control).toBeUndefined()
    expect(tools[21].cache_control).toEqual({ type: 'ephemeral' })

    // Serialization sanity — confirms what lands on the wire.
    const wire = JSON.parse(JSON.stringify(cleanBody))
    expect(wire.system[wire.system.length - 1].cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(wire.tools[21].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('request with client-placed cache_control: proxy does not overwrite', () => {
    // A sophisticated client (e.g. a future version of Claude Code) may
    // have placed its own 1h-TTL breakpoint. The proxy must treat that as
    // authoritative and not double-mark.
    const body: any = {
      system: [
        {
          type: 'text',
          text: 'shared preamble',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        { type: 'text', text: 'per-session bit' },
      ],
      tools: [{ name: 'calc', description: '', input_schema: {} }],
    }
    const result = injectCacheControl(body)
    // Client's 1h TTL is preserved as-is
    expect(body.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    // Proxy did not add a second breakpoint inside system
    expect(body.system[1].cache_control).toBeUndefined()
    // Tools had no client breakpoint → proxy adds one
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.skipReason).toBe('client_owns_system')
    expect(result.toolMarked).toBe(true)
  })

  it('request with string body.system: proxy wraps to array and marks it', () => {
    const body: any = {
      system: 'Legacy string system.',
      tools: [{ name: 'ping', description: '', input_schema: {} }],
    }
    injectCacheControl(body)
    const cleanBody = sanitizeBodyForAnthropic(body)
    // Wrapped to single-block array with cache_control
    expect(cleanBody.system).toEqual([
      {
        type: 'text',
        text: 'Legacy string system.',
        cache_control: { type: 'ephemeral' },
      },
    ])
  })
})

describe('cache pipeline: Anthropic response → OpenAI response', () => {
  it('first call (cache write): reports cache_creation under prompt_tokens_details', () => {
    const anthropicResp: any = {
      id: 'msg_abc123',
      type: 'message',
      model: 'claude-opus-4-6',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'pong!' }],
      usage: {
        input_tokens: 42, // uncached remainder (the user's "pong")
        output_tokens: 3,
        cache_creation_input_tokens: 5000, // wrote the cache (system + tools)
        cache_read_input_tokens: 0,
      },
    }
    const openAI = convertNonStreamingResponse(anthropicResp)
    // OpenAI's prompt_tokens is TOTAL (cached + uncached), not just uncached
    expect(openAI.usage.prompt_tokens).toBe(5042)
    expect(openAI.usage.completion_tokens).toBe(3)
    expect(openAI.usage.total_tokens).toBe(5045)
    expect(openAI.usage.prompt_tokens_details).toEqual({
      cached_tokens: 0,
      cache_creation_tokens: 5000,
    })
  })

  it('second call (cache hit): reports cached_tokens for OpenAI-compat clients', () => {
    const anthropicResp: any = {
      id: 'msg_def456',
      type: 'message',
      model: 'claude-opus-4-6',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'pong again!' }],
      usage: {
        input_tokens: 48,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5000, // read from cache at 0.1× price
      },
    }
    const openAI = convertNonStreamingResponse(anthropicResp)
    expect(openAI.usage.prompt_tokens).toBe(5048)
    expect(openAI.usage.prompt_tokens_details).toEqual({
      cached_tokens: 5000,
      cache_creation_tokens: 0,
    })
  })

  it('uncached response: omits prompt_tokens_details so shape stays OpenAI-clean', () => {
    const anthropicResp: any = {
      id: 'msg_ghi789',
      type: 'message',
      model: 'claude-haiku-4-5',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'cheap fast reply' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    }
    const openAI = convertNonStreamingResponse(anthropicResp)
    expect(openAI.usage.prompt_tokens).toBe(100)
    expect(openAI.usage.prompt_tokens_details).toBeUndefined()
  })
})
