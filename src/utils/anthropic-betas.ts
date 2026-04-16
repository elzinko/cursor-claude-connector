// Builds the value of the `anthropic-beta` request header. Each beta opts
// into a preview Anthropic capability; shipping a beta that a client didn't
// ask for can push otherwise-free requests onto the paid "Extra usage"
// quota on Pro/Max accounts, so only add betas when the feature is
// actually in use.
export function buildAnthropicBetas(opts: {
  thinking: boolean
  model: string
  enable1M: boolean
}): string[] {
  const betas = [
    'oauth-2025-04-20',
    'fine-grained-tool-streaming-2025-05-14',
  ]

  if (opts.thinking) {
    betas.push('interleaved-thinking-2025-05-14')
  }

  if (opts.enable1M && opts.model.toLowerCase().includes('sonnet')) {
    betas.push('context-1m-2025-08-07')
  }

  return betas
}
