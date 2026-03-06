/**
 * Lightweight structured logger for the miniapp server.
 *
 * Mirrors the worker.js JSON logging pattern:
 *   { ts, level, component, msg, ...meta }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  const env = process.env.MINIAPP_LOG_LEVEL?.toLowerCase()
  if (env && env in LEVEL_PRIORITY) return env as LogLevel
  return 'info'
}

export function log(level: LogLevel, msg: string, meta: Record<string, unknown> = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[getMinLevel()]) return

  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'miniapp-server',
    msg,
    ...meta,
  }

  if (level === 'error') {
    console.error(JSON.stringify(entry))
  } else {
    console.log(JSON.stringify(entry))
  }
}
