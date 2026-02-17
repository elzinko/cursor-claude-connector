// Shared type definitions

export interface AnthropicRequestBody {
  system?: Array<{ type: string; text: string }>
  messages?: Array<any>
  metadata?: {
    user_id?: string
  }
  stream?: boolean
  model: string
  [key: string]: unknown
}

export interface AnthropicResponse {
  id?: string
  model?: string
  stop_reason?: string | null
  content?: Array<{
    type: 'text' | 'tool_use'
    text?: string
    id?: string
    name?: string
    input?: unknown
  }>
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  [key: string]: unknown
}

export interface ErrorResponse {
  error: string
  message?: string
  details?: string
}

export interface SuccessResponse {
  success: boolean
  message: string
}

export interface ModelInfo {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface ModelsListResponse {
  object: 'list'
  data: ModelInfo[]
}
