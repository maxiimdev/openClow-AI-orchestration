import type { TaskEvent } from './types'

/**
 * Deduplicate events by id, keeping the first occurrence.
 */
export function dedupeEvents(events: TaskEvent[]): TaskEvent[] {
  const seen = new Set<string>()
  const result: TaskEvent[] = []
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id)
      result.push(event)
    }
  }
  return result
}

/**
 * Sort events chronologically by createdAt timestamp, then by id as tiebreaker.
 */
export function sortEvents(events: TaskEvent[]): TaskEvent[] {
  return [...events].sort((a, b) => {
    const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    if (timeDiff !== 0) return timeDiff
    return a.id.localeCompare(b.id)
  })
}

/**
 * Merge new events into existing list: dedupe by id, sort chronologically.
 */
export function mergeEvents(existing: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  return sortEvents(dedupeEvents([...existing, ...incoming]))
}
