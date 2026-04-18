import { describe, expect, it } from 'vitest'
import { buildOpenAIUsage } from '../../src/utils/anthropic-to-openai-converter'

describe('buildOpenAIUsage', () => {
  it('maps Anthropic uncached input to OpenAI prompt_tokens without a details block', () => {
    const usage = buildOpenAIUsage({ input_tokens: 500, output_tokens: 42 })
    expect(usage).toEqual({
      prompt_tokens: 500,
      completion_tokens: 42,
      total_tokens: 542,
    })
    // No cache activity → no details block, no shape surprise for clients.
    expect(usage.prompt_tokens_details).toBeUndefined()
  })

  it('rolls cache_creation into prompt_tokens and surfaces it in the details block', () => {
    const usage = buildOpenAIUsage({
      input_tokens: 100, // uncached remainder
      output_tokens: 10,
      cache_creation_input_tokens: 1200, // first call — wrote the cache
      cache_read_input_tokens: 0,
    })
    // OpenAI's prompt_tokens is TOTAL input (billed both at full and cache-creation rates)
    expect(usage.prompt_tokens).toBe(1300)
    expect(usage.total_tokens).toBe(1310)
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 0,
      cache_creation_tokens: 1200,
    })
  })

  it('rolls cache_read into prompt_tokens and flags cached_tokens for OpenAI-compat clients', () => {
    const usage = buildOpenAIUsage({
      input_tokens: 50,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200, // second call — served from cache at 0.1× price
    })
    expect(usage.prompt_tokens).toBe(1250)
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 1200,
      cache_creation_tokens: 0,
    })
  })

  it('handles a mixed request (some new bytes written, some old bytes read)', () => {
    const usage = buildOpenAIUsage({
      input_tokens: 200,
      output_tokens: 20,
      cache_creation_input_tokens: 800,
      cache_read_input_tokens: 1600,
    })
    expect(usage.prompt_tokens).toBe(2600)
    expect(usage.total_tokens).toBe(2620)
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 1600,
      cache_creation_tokens: 800,
    })
  })

  it('treats missing cache fields as zero (older Anthropic responses)', () => {
    const usage = buildOpenAIUsage({ input_tokens: 100, output_tokens: 10 })
    expect(usage.prompt_tokens).toBe(100)
    expect(usage.prompt_tokens_details).toBeUndefined()
  })
})
