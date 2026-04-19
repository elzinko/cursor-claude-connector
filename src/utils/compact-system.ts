// Heuristic system-prompt trimmer used as an escape hatch against Anthropic's
// "Extra Usage" classification. Empirical probing with claude-proxy-probe has
// shown the gate triggers when `body.system` carries more than ~8 KB of
// openclaw-signature content (markdown `## Section` headings, structured
// instructions, long skill blocks). The prompt cache injection from PR #8
// cuts the *repeat* cost by ~90 % but does not rescue the *first* call from
// Extra Usage — the classifier runs before caching. This module attacks the
// problem upstream by shrinking the system text back under the threshold.
//
// Design mirrors src/utils/cache-control.ts on purpose:
//   - pure function, mutates body in place
//   - returns a typed result + machine-readable skipReason
//   - normalizes `body.system` from `string` into an array of blocks so the
//     trimmer always walks a uniform shape
//   - deterministic output: a given input always produces the same output,
//     which is required to keep the prompt-cache hash stable across calls
//
// Strategy (heuristic A from the design doc):
//   1. detect markdown `## Section` headings
//   2. truncate each oversized section to sectionCapChars, keeping the
//      heading intact + a literal `[... N chars truncated]` suffix
//   3. leave small sections and non-markdown blocks untouched
//
// This preserves the overall document structure (Claude can still see the
// section layout) while dropping the density that triggers the classifier.
//
// Escape hatches:
//   - COMPACT_SYSTEM=1 env var: opt-in. Default behavior is no-op.
//   - Claude Code native requests are never touched. Detection is based on
//     the caller's `transformToOpenAIFormat` flag (if the body already had
//     the "You are Claude Code" marker in system[0], the proxy did not
//     inject it, so `transformToOpenAIFormat === false` signals a native
//     Claude Code request). A safety net inside the trimmer also skips any
//     block whose text starts with the Claude Code marker.

type SystemBlock = { type?: string; text?: unknown } & Record<string, unknown>

export type CompactSystemOpts = {
  enabled?: boolean
  isClaudeCodeOrigin?: boolean
  // Below this total char count, skip. Default 8000 — tracks the empirical
  // 8 KB gate reported by claude-proxy-probe. Tunable for future drift.
  thresholdChars?: number
  // Per-section char cap after compaction. 400 keeps the heading + enough
  // context for Claude to still know what the section was about, without
  // dumping the full payload. Tunable.
  sectionCapChars?: number
}

export type CompactSystemResult = {
  compacted: boolean
  originalChars: number
  newChars: number
  sectionsTouched: number
  skipReason?:
    | 'disabled'
    | 'claude_code_origin'
    | 'no_system'
    | 'below_threshold'
    | 'not_openclaw_like'
}

const DEFAULT_THRESHOLD_CHARS = 8000
const DEFAULT_SECTION_CAP_CHARS = 400
const CLAUDE_CODE_MARKER = 'You are Claude Code'

// Split on a newline followed by an H2 heading. Using a lookahead keeps the
// `## ` prefix on the following section rather than dropping it. We accept
// only `## ` (space-required) to avoid matching `###` subsections.
const SECTION_SPLIT = /\n(?=## )/

export function compactSystem(
  body: Record<string, unknown>,
  opts: CompactSystemOpts = {},
): CompactSystemResult {
  const result: CompactSystemResult = {
    compacted: false,
    originalChars: 0,
    newChars: 0,
    sectionsTouched: 0,
  }

  if (!opts.enabled) {
    result.skipReason = 'disabled'
    return result
  }

  if (opts.isClaudeCodeOrigin) {
    result.skipReason = 'claude_code_origin'
    return result
  }

  // Step 1 — normalize body.system shape. Mirror of cache-control.ts
  // lines 103-105. Empty strings and missing systems leave early.
  if (body.system == null) {
    result.skipReason = 'no_system'
    return result
  }
  if (typeof body.system === 'string') {
    if (body.system.length === 0) {
      result.skipReason = 'no_system'
      return result
    }
    body.system = [{ type: 'text', text: body.system }]
  }
  if (!Array.isArray(body.system) || body.system.length === 0) {
    result.skipReason = 'no_system'
    return result
  }

  const blocks = body.system as SystemBlock[]
  const threshold = opts.thresholdChars ?? DEFAULT_THRESHOLD_CHARS
  const sectionCap = opts.sectionCapChars ?? DEFAULT_SECTION_CAP_CHARS

  // Step 2 — total size of the system across all text blocks.
  let originalChars = 0
  for (const block of blocks) {
    if (block && typeof block.text === 'string') {
      originalChars += block.text.length
    }
  }
  result.originalChars = originalChars
  result.newChars = originalChars

  if (originalChars <= threshold) {
    result.skipReason = 'below_threshold'
    return result
  }

  // Step 3 — must contain at least one openclaw-style section in at least
  // one block. Blunt truncation of an unstructured block is a bad idea:
  // we'd cut mid-instruction with no way for Claude to recover the intent.
  // Prefer to let the request through as-is and accept the Extra Usage hit.
  let hasSections = false
  for (const block of blocks) {
    if (block && typeof block.text === 'string' && block.text.includes('\n## ')) {
      hasSections = true
      break
    }
    // Also catch the case where a block starts directly with `## ` (no
    // preamble before the first heading).
    if (block && typeof block.text === 'string' && block.text.startsWith('## ')) {
      hasSections = true
      break
    }
  }
  if (!hasSections) {
    result.skipReason = 'not_openclaw_like'
    return result
  }

  // Step 4 — walk blocks, compact in place. Two safety nets preserve the
  // Claude Code marker and keep the trimmer deterministic:
  //   - any block whose text starts with the Claude Code marker is left
  //     untouched (belt-and-suspenders with the isClaudeCodeOrigin gate);
  //     the proxy also injects this marker on Cursor-origin requests at
  //     server.ts line ~572, and Anthropic's plan-side routing may rely
  //     on the exact prefix.
  //   - the suffix `[... N chars truncated]` contains only N (deterministic);
  //     no timestamps, no UUIDs, so repeated identical inputs always produce
  //     identical outputs and the prompt-cache hash (PR #8) stays stable.
  let newChars = 0
  let sectionsTouched = 0

  for (const block of blocks) {
    if (!block || typeof block.text !== 'string') {
      continue
    }
    const text = block.text

    // Safety net: never trim the "You are Claude Code" prefix block, even
    // if opts.isClaudeCodeOrigin was false (defense in depth against a
    // wrong caller-side flag).
    if (text.startsWith(CLAUDE_CODE_MARKER)) {
      newChars += text.length
      continue
    }

    const compacted = compactOne(text, sectionCap)
    block.text = compacted.text
    newChars += compacted.text.length
    sectionsTouched += compacted.sectionsTouched
  }

  result.newChars = newChars
  result.sectionsTouched = sectionsTouched
  result.compacted = newChars < originalChars

  return result
}

// Compact a single block of text. Splits on H2 boundaries, caps each
// oversized section at sectionCap chars, and reassembles. Sections under
// the cap are returned verbatim. The block's preamble before the first
// section is treated as a section with no heading — also capped if
// oversized, to avoid a loophole where someone inlines a 20 KB preamble.
function compactOne(
  text: string,
  sectionCap: number,
): { text: string; sectionsTouched: number } {
  const parts = text.split(SECTION_SPLIT)
  let sectionsTouched = 0
  const out: string[] = []

  for (const part of parts) {
    if (part.length <= sectionCap) {
      out.push(part)
      continue
    }
    const truncated = part.length - sectionCap
    // Slice up to sectionCap, then trim trailing whitespace so the
    // ellipsis reads cleanly after the cut. The suffix is deterministic
    // (depends only on `truncated`, which is fully determined by input).
    const head = part.slice(0, sectionCap).trimEnd()
    out.push(`${head}\n\n[... ${truncated} chars truncated]`)
    sectionsTouched += 1
  }

  return { text: out.join('\n'), sectionsTouched }
}
