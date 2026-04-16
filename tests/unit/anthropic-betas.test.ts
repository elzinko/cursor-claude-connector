import { describe, expect, it } from 'vitest'
import { buildAnthropicBetas } from '../../src/utils/anthropic-betas'

describe('buildAnthropicBetas', () => {
  it('always includes the OAuth and tool-streaming betas', () => {
    const betas = buildAnthropicBetas({
      thinking: false, model: 'claude-opus-4-6', enable1M: false,
    })
    expect(betas).toContain('oauth-2025-04-20')
    expect(betas).toContain('fine-grained-tool-streaming-2025-05-14')
  })

  it('regression Bug C: omits interleaved-thinking beta when thinking is disabled', () => {
    const betas = buildAnthropicBetas({
      thinking: false, model: 'claude-opus-4-6', enable1M: false,
    })
    expect(betas).not.toContain('interleaved-thinking-2025-05-14')
  })

  it('adds interleaved-thinking beta when thinking is enabled', () => {
    const betas = buildAnthropicBetas({
      thinking: true, model: 'claude-opus-4-6', enable1M: false,
    })
    expect(betas).toContain('interleaved-thinking-2025-05-14')
  })

  it('adds context-1m beta only for Sonnet when enable1M is true', () => {
    const sonnet = buildAnthropicBetas({
      thinking: false, model: 'claude-sonnet-4-6', enable1M: true,
    })
    const opus = buildAnthropicBetas({
      thinking: false, model: 'claude-opus-4-6', enable1M: true,
    })
    expect(sonnet).toContain('context-1m-2025-08-07')
    expect(opus).not.toContain('context-1m-2025-08-07')
  })

  it('omits context-1m beta when enable1M is false, even for Sonnet', () => {
    const betas = buildAnthropicBetas({
      thinking: false, model: 'claude-sonnet-4-6', enable1M: false,
    })
    expect(betas).not.toContain('context-1m-2025-08-07')
  })
})
