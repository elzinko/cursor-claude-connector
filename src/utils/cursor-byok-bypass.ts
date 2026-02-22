import { AnthropicRequestBody } from "../types";

// Bypass cursor enable openai key check
export function createCursorBypassResponse() {
  return {
    choices: [
      {
        finish_reason: 'length',
        index: 0,
        logprobs: null,
        message: {
          annotations: [],
          content: 'Of course! Please provide me with the text or',
          refusal: null,
          role: 'assistant',
        },
      },
    ],
    created: 1751755415,
    id: 'chatcmpl-Bq5tXYkUOGxyRInJljhsBrlLP1066',
    model: 'gpt-4o-2024-08-06',
    object: 'chat.completion',
    service_tier: 'default',
    system_fingerprint: 'fp_a288987b44',
    usage: {
      completion_tokens: 10,
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        audio_tokens: 0,
        reasoning_tokens: 0,
        rejected_prediction_tokens: 0,
      },
      prompt_tokens: 28,
      prompt_tokens_details: {
        audio_tokens: 0,
        cached_tokens: 0,
      },
      total_tokens: 38,
    },
  }
}

// Check if the request is from Cursor trying to validate OpenAI key.
// Must be strict to avoid intercepting legitimate Claude requests.
export function isCursorKeyCheck(body: AnthropicRequestBody): boolean {
  const isGPTModel = body.model?.startsWith('gpt-')
  const isTestPrompt = body.messages?.some(
    (m: any) =>
      typeof m.content === 'string' &&
      (m.content === 'Test prompt using gpt-3.5-turbo' ||
       m.content === 'Say "hi" to confirm the connection is working.'),
  )
  // Only bypass if it's clearly a GPT model validation request
  return (isGPTModel && body.messages?.length === 1) || isTestPrompt || false
}
