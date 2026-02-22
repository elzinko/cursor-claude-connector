import { logger } from '../middleware/request-logger'
import { rateLimiter } from '../middleware/rate-limiter'

export function generateStatusline(project: string = 'default'): string {
  const stats = logger.getStats(project)
  const rateStats = rateLimiter.getStats(project)

  const bar = generateProgressBar(rateStats.count, rateStats.limit)
  const resetMin = Math.floor(rateStats.resetIn / 60)

  return (
    `📊 ${project} | ` +
    `${stats.totalTokens.toLocaleString()} tokens | ` +
    `${rateStats.count}/${rateStats.limit} req/h ${bar} | ` +
    `Reset: ${resetMin}m`
  )
}

function generateProgressBar(current: number, max: number, length: number = 10): string {
  const filled = Math.round((current / max) * length)
  const empty = length - filled
  return '▓'.repeat(filled) + '░'.repeat(empty)
}

export function printStatusline(project?: string) {
  const line = generateStatusline(project)
  // Move to bottom of terminal, clear line, print statusline
  process.stdout.write(`\x1b[999B\x1b[2K\r${line}\x1b[A`)
}
