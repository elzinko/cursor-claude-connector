import { Context } from 'hono'
import type { AnthropicResponse } from '../types'

export interface RequestLog {
  timestamp: string
  project: string
  apiKey: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  duration: number
  status: number
}

export class RequestLogger {
  private logs: RequestLog[] = []
  private maxLogs = 1000

  log(entry: RequestLog) {
    this.logs.push(entry)
    if (this.logs.length > this.maxLogs) {
      this.logs.shift()
    }
  }

  getLogs(project?: string): RequestLog[] {
    if (project) {
      return this.logs.filter((log) => log.project === project)
    }
    return this.logs
  }

  getStats(project?: string) {
    const logs = this.getLogs(project)
    const now = Date.now()
    const oneHour = 60 * 60 * 1000

    const lastHour = logs.filter(
      (log) => now - new Date(log.timestamp).getTime() < oneHour,
    )

    const totalTokens = logs.reduce((sum, log) => sum + log.totalTokens, 0)
    const totalCost = this.estimateCost(logs)

    return {
      totalRequests: logs.length,
      requestsLastHour: lastHour.length,
      totalTokens,
      totalCost,
      projects: [...new Set(logs.map((log) => log.project))],
    }
  }

  private estimateCost(logs: RequestLog[]): number {
    // Rough cost estimates (per 1M tokens)
    const costs: Record<string, { input: number; output: number }> = {
      'claude-3-5-sonnet': { input: 3, output: 15 },
      'claude-3-opus': { input: 15, output: 75 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    }

    return logs.reduce((total, log) => {
      const modelCost = costs[log.model] || costs['claude-3-5-sonnet']
      const inputCost = (log.inputTokens / 1_000_000) * modelCost.input
      const outputCost = (log.outputTokens / 1_000_000) * modelCost.output
      return total + inputCost + outputCost
    }, 0)
  }
}

export const logger = new RequestLogger()

export function extractProjectFromApiKey(apiKey: string): string {
  // Extract project name from API key format: project-name-key
  // e.g. "frontend-abc123" -> "frontend"
  const parts = apiKey.split('-')
  if (parts.length >= 2) {
    return parts.slice(0, -1).join('-')
  }
  return 'default'
}

export function logRequest(
  c: Context,
  apiKey: string,
  model: string,
  startTime: number,
  response: AnthropicResponse,
  status: number,
) {
  const duration = Date.now() - startTime
  const project = extractProjectFromApiKey(apiKey)

  const entry: RequestLog = {
    timestamp: new Date().toISOString(),
    project,
    apiKey: apiKey.slice(0, 8) + '***',
    model,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    totalTokens:
      (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    duration,
    status,
  }

  logger.log(entry)

  // Console log
  console.log(
    `[${entry.project}] ${model} | ` +
      `${entry.inputTokens}→${entry.outputTokens} tokens | ` +
      `${duration}ms | ${status}`,
  )
}
