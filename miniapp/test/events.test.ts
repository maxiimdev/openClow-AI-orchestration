import { describe, it, expect } from 'vitest'
import { dedupeEvents, sortEvents, mergeEvents } from '../app/lib/events'
import type { TaskEvent } from '../app/lib/types'

function evt(id: string, createdAt: string, taskId = 'task-1'): TaskEvent {
  return { id, taskId, status: 'progress', phase: 'claude', message: `Event ${id}`, meta: {}, createdAt }
}

describe('dedupeEvents', () => {
  it('removes duplicate events by id', () => {
    const events = [
      evt('evt-1', '2025-01-01T00:00:00Z'),
      evt('evt-2', '2025-01-01T00:01:00Z'),
      evt('evt-1', '2025-01-01T00:00:00Z'),
      evt('evt-3', '2025-01-01T00:02:00Z'),
      evt('evt-2', '2025-01-01T00:01:00Z'),
    ]
    const result = dedupeEvents(events)
    expect(result).toHaveLength(3)
    expect(result.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('returns empty array for empty input', () => {
    expect(dedupeEvents([])).toEqual([])
  })

  it('preserves single events', () => {
    const events = [evt('evt-1', '2025-01-01T00:00:00Z')]
    expect(dedupeEvents(events)).toHaveLength(1)
  })
})

describe('sortEvents', () => {
  it('sorts events chronologically by createdAt', () => {
    const events = [
      evt('evt-3', '2025-01-01T00:02:00Z'),
      evt('evt-1', '2025-01-01T00:00:00Z'),
      evt('evt-2', '2025-01-01T00:01:00Z'),
    ]
    const result = sortEvents(events)
    expect(result.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('uses id as tiebreaker for same timestamp', () => {
    const events = [
      evt('evt-b', '2025-01-01T00:00:00Z'),
      evt('evt-a', '2025-01-01T00:00:00Z'),
      evt('evt-c', '2025-01-01T00:00:00Z'),
    ]
    const result = sortEvents(events)
    expect(result.map((e) => e.id)).toEqual(['evt-a', 'evt-b', 'evt-c'])
  })

  it('does not mutate original array', () => {
    const events = [
      evt('evt-2', '2025-01-01T00:01:00Z'),
      evt('evt-1', '2025-01-01T00:00:00Z'),
    ]
    sortEvents(events)
    expect(events[0].id).toBe('evt-2')
  })

  it('handles empty array', () => {
    expect(sortEvents([])).toEqual([])
  })
})

describe('mergeEvents', () => {
  it('merges and dedupes events from two arrays', () => {
    const existing = [
      evt('evt-1', '2025-01-01T00:00:00Z'),
      evt('evt-2', '2025-01-01T00:01:00Z'),
    ]
    const incoming = [
      evt('evt-2', '2025-01-01T00:01:00Z'),
      evt('evt-3', '2025-01-01T00:02:00Z'),
    ]
    const result = mergeEvents(existing, incoming)
    expect(result).toHaveLength(3)
    expect(result.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('preserves chronological order', () => {
    const existing = [evt('evt-3', '2025-01-01T00:02:00Z')]
    const incoming = [evt('evt-1', '2025-01-01T00:00:00Z')]
    const result = mergeEvents(existing, incoming)
    expect(result.map((e) => e.id)).toEqual(['evt-1', 'evt-3'])
  })

  it('handles empty existing array', () => {
    const incoming = [evt('evt-1', '2025-01-01T00:00:00Z')]
    const result = mergeEvents([], incoming)
    expect(result).toHaveLength(1)
  })

  it('handles empty incoming array', () => {
    const existing = [evt('evt-1', '2025-01-01T00:00:00Z')]
    const result = mergeEvents(existing, [])
    expect(result).toHaveLength(1)
  })
})
