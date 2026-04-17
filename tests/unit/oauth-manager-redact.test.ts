import { describe, expect, it } from 'vitest'
import { redactUpstashError } from '../../src/auth/oauth-manager'

// Regression: the Upstash JS SDK embeds the failing command — payload
// included — in the thrown error's `.message`. When the proxy re-threw that
// message into the `/auth/oauth/callback` response body, access + refresh
// OAuth tokens leaked into the browser (and into our Vercel logs).
//
// redactUpstashError is what separates "this is safe to log / return" from
// "this prints tokens in plaintext". If it regresses, we leak again.

describe('redactUpstashError', () => {
  it('drops the "command was:" tail that the Upstash SDK appends', () => {
    const err = new Error(
      'WRONGPASS invalid or missing auth token. See https://docs.upstash.com/... , command was: [["set","auth:anthropic","{\\"type\\":\\"oauth\\",\\"refresh\\":\\"sk-ant-ort01-REAL_TOKEN\\",\\"access\\":\\"sk-ant-oat01-OTHER_REAL_TOKEN\\"}"]]',
    )
    const out = redactUpstashError(err)
    expect(out).not.toContain('sk-ant-ort01-REAL_TOKEN')
    expect(out).not.toContain('sk-ant-oat01-OTHER_REAL_TOKEN')
    expect(out).not.toContain('command was:')
    expect(out).toContain('WRONGPASS')
  })

  it('redacts stray access/refresh fields even without the "command was:" marker', () => {
    const err = new Error(
      'Something else: payload={"type":"oauth","refresh":"sk-ant-ort01-LEAK","access":"sk-ant-oat01-LEAK2"}',
    )
    const out = redactUpstashError(err)
    expect(out).not.toContain('sk-ant-ort01-LEAK')
    expect(out).not.toContain('sk-ant-oat01-LEAK2')
    expect(out).toContain('"refresh":"[redacted]"')
    expect(out).toContain('"access":"[redacted]"')
  })

  it('redacts bare sk-ant-* tokens that appear outside JSON', () => {
    const err = new Error(
      'Context: token sk-ant-ort01-h8ldMgeTJfJRqggVVNs6J8UF was used',
    )
    const out = redactUpstashError(err)
    expect(out).not.toContain('sk-ant-ort01-h8ldMgeTJfJRqggVVNs6J8UF')
    expect(out).toContain('sk-ant-[redacted]')
  })

  it('caps output length so a huge message cannot fill the log', () => {
    const err = new Error('X'.repeat(10_000))
    const out = redactUpstashError(err)
    // name + ": " + up to 200 chars of cleaned body
    expect(out.length).toBeLessThanOrEqual(10 + 2 + 200)
  })

  it('keeps the error name so we can still diagnose from logs', () => {
    const err = new Error('nope')
    err.name = 'UpstashError'
    const out = redactUpstashError(err)
    expect(out.startsWith('UpstashError:')).toBe(true)
  })

  it('tolerates a non-Error with missing fields', () => {
    const fake = { name: '', message: '' } as Error
    const out = redactUpstashError(fake)
    // Should default to "Error: " with an empty body rather than crashing.
    expect(out).toMatch(/^Error:\s*$/)
  })
})
