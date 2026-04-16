// Anthropic Messages API only accepts these top-level fields.
// Any extra fields (from OpenAI format) cause a 400 error.
const ANTHROPIC_ALLOWED_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'metadata',
  'stop_sequences', 'stream', 'temperature', 'top_p', 'top_k',
  'tools', 'tool_choice', 'thinking',
])

// Strips OpenAI-only fields and forwards Anthropic-compatible ones.
// Also bridges a handful of OpenAI aliases that Anthropic doesn't know
// (e.g. `max_completion_tokens`, the o1/o3-era rename of `max_tokens`)
// so the client's intent isn't silently dropped by the allowlist filter.
export function sanitizeBodyForAnthropic(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {}

  for (const key of Object.keys(body)) {
    if (ANTHROPIC_ALLOWED_FIELDS.has(key)) {
      clean[key] = body[key]
    }
  }

  if (clean.max_tokens == null && typeof body.max_completion_tokens === 'number') {
    clean.max_tokens = body.max_completion_tokens
  }

  return clean
}
