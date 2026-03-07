import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { trackTaskId, getKnownTaskIds, removeTaskId, hasKnownTasks, getCacheSize, resetCache } from '../server/lib/task-cache'

describe('task-cache', () => {
  beforeEach(() => {
    resetCache()
    delete process.env.ORCH_SEED_TASK_IDS
    delete process.env.TASK_CACHE_TTL_MS
    delete process.env.TASK_CACHE_MAX_SIZE
  })

  afterEach(() => {
    delete process.env.TASK_CACHE_TTL_MS
    delete process.env.TASK_CACHE_MAX_SIZE
  })

  it('starts empty', () => {
    expect(hasKnownTasks()).toBe(false)
    expect(getKnownTaskIds()).toEqual([])
  })

  it('tracks and retrieves task IDs', () => {
    trackTaskId('task-1')
    trackTaskId('task-2')
    expect(hasKnownTasks()).toBe(true)
    expect(getKnownTaskIds()).toContain('task-1')
    expect(getKnownTaskIds()).toContain('task-2')
  })

  it('deduplicates IDs', () => {
    trackTaskId('task-1')
    trackTaskId('task-1')
    expect(getKnownTaskIds()).toHaveLength(1)
  })

  it('removes task IDs', () => {
    trackTaskId('task-1')
    trackTaskId('task-2')
    removeTaskId('task-1')
    expect(getKnownTaskIds()).toEqual(['task-2'])
  })

  it('seeds from ORCH_SEED_TASK_IDS env var', () => {
    process.env.ORCH_SEED_TASK_IDS = 'seed-1, seed-2, seed-3'
    expect(getKnownTaskIds()).toEqual(['seed-1', 'seed-2', 'seed-3'])
  })

  it('handles empty seed env var', () => {
    process.env.ORCH_SEED_TASK_IDS = ''
    expect(hasKnownTasks()).toBe(false)
  })

  it('merges seeds with tracked IDs', () => {
    process.env.ORCH_SEED_TASK_IDS = 'seed-1'
    trackTaskId('tracked-1')
    const ids = getKnownTaskIds()
    expect(ids).toContain('seed-1')
    expect(ids).toContain('tracked-1')
  })

  // ── TTL tests ──

  describe('TTL eviction', () => {
    it('evicts entries older than TTL on getKnownTaskIds', () => {
      process.env.TASK_CACHE_TTL_MS = '100'
      trackTaskId('old-task')

      // Fast-forward time
      vi.useFakeTimers()
      vi.advanceTimersByTime(150)

      expect(getKnownTaskIds()).toEqual([])
      expect(hasKnownTasks()).toBe(false)

      vi.useRealTimers()
    })

    it('keeps entries within TTL', () => {
      process.env.TASK_CACHE_TTL_MS = '10000'
      trackTaskId('fresh-task')
      expect(getKnownTaskIds()).toContain('fresh-task')
    })

    it('re-tracking refreshes TTL', () => {
      process.env.TASK_CACHE_TTL_MS = '200'
      vi.useFakeTimers()

      trackTaskId('task-a')
      vi.advanceTimersByTime(150) // 150ms elapsed
      trackTaskId('task-a') // refresh TTL
      vi.advanceTimersByTime(100) // 250ms total, but only 100ms since refresh

      expect(getKnownTaskIds()).toContain('task-a')

      vi.advanceTimersByTime(150) // now 250ms since refresh — expired
      expect(getKnownTaskIds()).not.toContain('task-a')

      vi.useRealTimers()
    })
  })

  // ── Max size eviction tests ──

  describe('max size eviction', () => {
    it('evicts oldest entries when exceeding max size', () => {
      process.env.TASK_CACHE_MAX_SIZE = '3'
      trackTaskId('a')
      trackTaskId('b')
      trackTaskId('c')
      trackTaskId('d') // should evict 'a'

      const ids = getKnownTaskIds()
      expect(ids).not.toContain('a')
      expect(ids).toContain('b')
      expect(ids).toContain('c')
      expect(ids).toContain('d')
      expect(getCacheSize()).toBe(3)
    })

    it('re-tracking moves entry to end (not evicted first)', () => {
      process.env.TASK_CACHE_MAX_SIZE = '3'
      trackTaskId('a')
      trackTaskId('b')
      trackTaskId('c')
      trackTaskId('a') // refresh — moves to end of Map
      trackTaskId('d') // should evict 'b' (oldest)

      const ids = getKnownTaskIds()
      expect(ids).not.toContain('b')
      expect(ids).toContain('a')
      expect(ids).toContain('c')
      expect(ids).toContain('d')
    })
  })

  // ── getCacheSize ──

  it('getCacheSize returns current count', () => {
    expect(getCacheSize()).toBe(0)
    trackTaskId('x')
    trackTaskId('y')
    expect(getCacheSize()).toBe(2)
    removeTaskId('x')
    expect(getCacheSize()).toBe(1)
  })
})
