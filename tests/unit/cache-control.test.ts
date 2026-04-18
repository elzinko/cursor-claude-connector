import { describe, expect, it } from 'vitest'
import { injectCacheControl } from '../../src/utils/cache-control'

describe('injectCacheControl — system blocks', () => {
  it('marks the last system block when none is already marked', () => {
    const body: any = {
      system: [
        { type: 'text', text: 'block A' },
        { type: 'text', text: 'block B' },
      ],
    }
    const result = injectCacheControl(body)
    expect(body.system[0].cache_control).toBeUndefined()
    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.systemBlockMarked).toBe(true)
    expect(result.addedBreakpoints).toBe(1)
  })

  it('coerces a string body.system into a single-block array and marks it', () => {
    const body: any = { system: 'You are a helpful assistant.' }
    injectCacheControl(body)
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system).toHaveLength(1)
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('leaves an empty-string body.system untouched (no block to mark)', () => {
    const body: any = { system: '' }
    const result = injectCacheControl(body)
    expect(body.system).toBe('')
    expect(result.injected).toBe(false)
  })

  it('does not overwrite a client-placed cache_control on system', () => {
    const body: any = {
      system: [
        { type: 'text', text: 'block A', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'block B' },
      ],
    }
    const result = injectCacheControl(body)
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.system[1].cache_control).toBeUndefined()
    expect(result.systemBlockMarked).toBe(false)
    expect(result.skipReason).toBe('client_owns_system')
    expect(result.clientBreakpoints).toBeGreaterThanOrEqual(1)
  })
})

describe('injectCacheControl — tools', () => {
  it('marks only the last tool when none is already marked', () => {
    const body: any = {
      tools: [
        { name: 't1', description: 'a', input_schema: {} },
        { name: 't2', description: 'b', input_schema: {} },
        { name: 't3', description: 'c', input_schema: {} },
      ],
    }
    const result = injectCacheControl(body)
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toBeUndefined()
    expect(body.tools[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.toolMarked).toBe(true)
  })

  it('does not mark tools when the client already placed a breakpoint on any tool', () => {
    const body: any = {
      tools: [
        { name: 't1', description: 'a', cache_control: { type: 'ephemeral' } },
        { name: 't2', description: 'b' },
        { name: 't3', description: 'c' },
      ],
    }
    const result = injectCacheControl(body)
    expect(body.tools[2].cache_control).toBeUndefined()
    expect(result.toolMarked).toBe(false)
    expect(result.skipReason).toBe('client_owns_tools')
  })

  it('does nothing on an empty tools array', () => {
    const body: any = { tools: [] }
    const result = injectCacheControl(body)
    expect(body.tools).toEqual([])
    expect(result.toolMarked).toBe(false)
  })
})

describe('injectCacheControl — combined placement', () => {
  it('marks both last system block and last tool (the default dual-breakpoint pattern)', () => {
    const body: any = {
      system: [
        { type: 'text', text: 'sys1' },
        { type: 'text', text: 'sys2' },
      ],
      tools: [
        { name: 't1' },
        { name: 't2' },
      ],
    }
    const result = injectCacheControl(body)
    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.systemBlockMarked).toBe(true)
    expect(result.toolMarked).toBe(true)
    expect(result.addedBreakpoints).toBe(2)
  })

  it('falls back to tools-only when system is missing', () => {
    const body: any = {
      tools: [{ name: 't1' }],
    }
    const result = injectCacheControl(body)
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.toolMarked).toBe(true)
    expect(result.systemBlockMarked).toBe(false)
  })

  it('falls back to system-only when tools is missing', () => {
    const body: any = {
      system: [{ type: 'text', text: 'sys1' }],
    }
    const result = injectCacheControl(body)
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.systemBlockMarked).toBe(true)
    expect(result.toolMarked).toBe(false)
  })

  it('no-op when request has neither system nor tools', () => {
    const body: any = {
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = injectCacheControl(body)
    expect(result.injected).toBe(false)
    expect(result.skipReason).toBe('nothing_to_mark')
    expect((body.messages[0] as any).cache_control).toBeUndefined()
  })
})

describe('injectCacheControl — breakpoint budget', () => {
  it('refuses to add anything when client already consumed all 4 breakpoints', () => {
    const body: any = {
      system: [
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's2', cache_control: { type: 'ephemeral' } },
      ],
      tools: [
        { name: 't1', cache_control: { type: 'ephemeral' } },
        { name: 't2', cache_control: { type: 'ephemeral' } },
      ],
    }
    const result = injectCacheControl(body)
    expect(result.injected).toBe(false)
    expect(result.addedBreakpoints).toBe(0)
    expect(result.skipReason).toBe('budget_exhausted')
    expect(result.clientBreakpoints).toBe(4)
  })

  it('counts message-level breakpoints toward the 4-budget', () => {
    const body: any = {
      system: [{ type: 'text', text: 's1' }],
      tools: [{ name: 't1' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    }
    // Client consumed 3 breakpoints in messages. We can still add 1.
    const result = injectCacheControl(body)
    expect(result.clientBreakpoints).toBe(3)
    expect(result.addedBreakpoints).toBe(1)
    // System wins the remaining slot (caches tools + system together).
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools[0].cache_control).toBeUndefined()
  })
})

describe('injectCacheControl — options', () => {
  it('is a no-op when opts.disabled is true', () => {
    const body: any = {
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't1' }],
    }
    const result = injectCacheControl(body, { disabled: true })
    expect(body.system[0].cache_control).toBeUndefined()
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(result.injected).toBe(false)
    expect(result.skipReason).toBe('disabled')
  })

  it('uses 1h TTL when opts.ttl1h is true', () => {
    const body: any = {
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't1' }],
    }
    injectCacheControl(body, { ttl1h: true })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})
