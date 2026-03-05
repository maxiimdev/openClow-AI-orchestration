import { describe, it, expect, beforeEach, vi } from 'vitest'
import { trackTaskId, getKnownTaskIds, removeTaskId, hasKnownTasks, resetCache } from '../server/lib/task-cache'

describe('task-cache', () => {
  beforeEach(() => {
    resetCache()
    // Clear env so seed logic is clean
    delete process.env.ORCH_SEED_TASK_IDS
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
})
