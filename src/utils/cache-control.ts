// Injects Anthropic `cache_control: {type: "ephemeral"}` breakpoints on the
// prefix blocks that are typically stable between two consecutive calls
// (tools + system prompt), so repeat requests hit the prompt cache at ~10%
// of the input price instead of the full rate. The function is pure — it
// mutates the body in place and returns metadata about what was done, so
// `server.ts` can surface the info in logs and debug headers without having
// to re-parse the body.
//
// Design notes (see shared/prompt-caching.md in the claude-api skill for the
// authoritative guidance):
//
// 1. Render order on Anthropic's side is `tools` → `system` → `messages`.
//    A single `cache_control` on the last system block caches both tools
//    and system together, and a single `cache_control` on the last tool
//    caches only tools. For openclaw's shape (stable system + stable tools)
//    one system-block breakpoint would suffice, but placing one on each
//    also saves the tools half when only the system text changes. Max 4
//    breakpoints per request total; we only ever add ≤2, leaving headroom
//    for clients that already placed their own markers.
//
// 2. Respect existing caller-placed breakpoints. If the client already put
//    `cache_control` on any block inside `system`, `tools`, or the message
//    history, we don't add our own to the same top-level slot — the client
//    knows their workload better than we do.
//
// 3. Minimum cacheable prefix is model-dependent (4096 tokens on Opus 4.6+,
//    2048 on Sonnet 4.6, 1024 on Sonnet 4.5). Below the threshold Anthropic
//    silently refuses to cache — `usage.cache_creation_input_tokens` stays
//    at 0, no error. We always place the marker; Anthropic does the right
//    thing at token-count time. Smaller-than-threshold requests simply cost
//    the same as before.
//
// 4. Top-level string `body.system` is accepted by Anthropic but loses the
//    per-block structure needed to attach `cache_control`. We coerce it to
//    a single `[{type:"text", text:...}]` block before placing the marker.
//
// 5. `DISABLE_CACHE_CONTROL=1` escape hatch for the rare case where a
//    client wants to bypass the injection without editing code (e.g. during
//    a silent-invalidator debug session).

export type CacheControl = {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

type SystemBlock = { type?: string; text?: unknown; cache_control?: CacheControl } & Record<string, unknown>
type ToolDef = { cache_control?: CacheControl } & Record<string, unknown>
type MessageBlock = { cache_control?: CacheControl } & Record<string, unknown>
type Message = { role?: string; content?: string | MessageBlock[] } & Record<string, unknown>

export type CacheControlResult = {
  // Whether the injector did anything at all.
  injected: boolean
  // Where it placed markers (useful for logs / debug headers).
  systemBlockMarked: boolean
  toolMarked: boolean
  // How many breakpoints were present before we ran. `0` means the caller
  // sent no markers and we had full budget.
  clientBreakpoints: number
  // How many we added.
  addedBreakpoints: number
  // A machine-readable reason when we decided to skip.
  skipReason?: 'disabled' | 'budget_exhausted' | 'client_owns_system' | 'client_owns_tools' | 'nothing_to_mark'
}

export type InjectCacheControlOpts = {
  disabled?: boolean
  // 1-hour TTL costs 2× on writes (vs 1.25× for 5-min default) and only
  // pays off with ≥3 reads per write. Keep it behind an explicit opt-in.
  ttl1h?: boolean
}

// Max 4 `cache_control` breakpoints per request, enforced by the Anthropic
// API. Adding a 5th returns 400 with `invalid_request_error`.
const MAX_BREAKPOINTS = 4

export function injectCacheControl(
  body: Record<string, unknown>,
  opts: InjectCacheControlOpts = {},
): CacheControlResult {
  const result: CacheControlResult = {
    injected: false,
    systemBlockMarked: false,
    toolMarked: false,
    clientBreakpoints: 0,
    addedBreakpoints: 0,
  }

  if (opts.disabled) {
    result.skipReason = 'disabled'
    return result
  }

  const cacheValue: CacheControl = opts.ttl1h
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' }

  // Step 1 — normalize `body.system` shape.
  // Anthropic accepts both `string` and `Array<block>`, but `cache_control`
  // only lives on blocks. Coerce non-empty strings to a single text block
  // so we have somewhere to attach the marker. Empty strings and missing
  // systems stay untouched.
  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [{ type: 'text', text: body.system }]
  }

  const systemBlocks = Array.isArray(body.system)
    ? (body.system as SystemBlock[])
    : undefined
  const tools = Array.isArray(body.tools) ? (body.tools as ToolDef[]) : undefined
  const messages = Array.isArray(body.messages)
    ? (body.messages as Message[])
    : undefined

  // Step 2 — count existing client-placed breakpoints across the request.
  const clientSystemBreakpoints = countBreakpoints(systemBlocks)
  const clientToolBreakpoints = countBreakpoints(tools)
  const clientMessageBreakpoints = countMessageBreakpoints(messages)
  result.clientBreakpoints =
    clientSystemBreakpoints +
    clientToolBreakpoints +
    clientMessageBreakpoints

  let budget = MAX_BREAKPOINTS - result.clientBreakpoints
  if (budget <= 0) {
    result.skipReason = 'budget_exhausted'
    return result
  }

  // Step 3 — place a marker on the last system block, if there is one and
  // the client hasn't already placed its own breakpoints inside system.
  let wantedSomething = false
  if (systemBlocks && systemBlocks.length > 0) {
    wantedSomething = true
    if (clientSystemBreakpoints > 0) {
      // Respect: the caller has opinions about system caching; don't layer
      // a second breakpoint on top.
      if (!result.skipReason) result.skipReason = 'client_owns_system'
    } else if (budget > 0) {
      const last = systemBlocks[systemBlocks.length - 1]
      if (last && typeof last === 'object') {
        last.cache_control = cacheValue
        result.systemBlockMarked = true
        result.addedBreakpoints += 1
        budget -= 1
      }
    }
  }

  // Step 4 — place a marker on the last tool. We do this even when we also
  // marked the last system block: the dual-breakpoint form gives a partial
  // cache hit on tools when `system` changes (e.g. between two different
  // personas sharing the same tool set).
  if (tools && tools.length > 0) {
    wantedSomething = true
    if (clientToolBreakpoints > 0) {
      if (!result.skipReason) result.skipReason = 'client_owns_tools'
    } else if (budget > 0) {
      const last = tools[tools.length - 1]
      if (last && typeof last === 'object') {
        last.cache_control = cacheValue
        result.toolMarked = true
        result.addedBreakpoints += 1
        budget -= 1
      }
    }
  }

  if (!wantedSomething) {
    result.skipReason = 'nothing_to_mark'
  }
  result.injected = result.addedBreakpoints > 0

  return result
}

function countBreakpoints(
  blocks: Array<{ cache_control?: CacheControl }> | undefined,
): number {
  if (!blocks) return 0
  let n = 0
  for (const b of blocks) {
    if (b && typeof b === 'object' && b.cache_control) n += 1
  }
  return n
}

function countMessageBreakpoints(messages: Message[] | undefined): number {
  if (!messages) return 0
  let n = 0
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && block.cache_control) n += 1
      }
    }
  }
  return n
}
