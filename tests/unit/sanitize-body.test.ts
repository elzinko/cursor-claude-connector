import { describe, expect, it } from 'vitest'
import { sanitizeBodyForAnthropic } from '../../src/utils/sanitize-body'

describe('sanitizeBodyForAnthropic', () => {
  it('keeps Anthropic-compatible fields as-is', () => {
    const clean = sanitizeBodyForAnthropic({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'sys' }],
      max_tokens: 100,
      tools: [],
      tool_choice: { type: 'auto' },
      stream: true,
      thinking: { type: 'adaptive' },
    })
    expect(clean).toEqual({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'sys' }],
      max_tokens: 100,
      tools: [],
      tool_choice: { type: 'auto' },
      stream: true,
      thinking: { type: 'adaptive' },
    })
  })

  it('strips OpenAI-only fields that Anthropic rejects', () => {
    const clean = sanitizeBodyForAnthropic({
      model: 'claude-opus-4-6',
      stream_options: { include_usage: true },
      store: true,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      seed: 42,
      n: 1,
      logprobs: true,
      top_logprobs: 3,
      reasoning_effort: 'medium',
    })
    expect(Object.keys(clean)).toEqual(['model'])
  })

  it('maps max_completion_tokens → max_tokens (OpenAI o1/o3 alias)', () => {
    const clean = sanitizeBodyForAnthropic({
      model: 'claude-opus-4-6',
      max_completion_tokens: 500,
    })
    expect(clean.max_tokens).toBe(500)
    expect(clean).not.toHaveProperty('max_completion_tokens')
  })

  it('keeps caller-provided max_tokens over max_completion_tokens when both present', () => {
    const clean = sanitizeBodyForAnthropic({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      max_completion_tokens: 500,
    })
    expect(clean.max_tokens).toBe(800)
  })
})
