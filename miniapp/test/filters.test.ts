import { describe, it, expect } from 'vitest'
import { filterByStatus, filterBySearch, applyFilters } from '~/lib/filters'
import type { Task } from '~/lib/types'

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-001',
    mode: 'implement',
    status: 'running',
    internalStatus: 'started',
    branch: 'feature/test',
    repoPath: '/repo',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    message: 'Test task',
    meta: {},
    userId: 1,
    ...overrides,
  }
}

const tasks: Task[] = [
  makeTask({ id: 'task-001-auth', status: 'running', message: 'Add auth module', branch: 'feature/auth' }),
  makeTask({ id: 'task-002-db', status: 'needs_input', message: 'Database migration', branch: 'feature/db' }),
  makeTask({ id: 'task-003-api', status: 'review_pass', message: 'API review', branch: 'feature/api' }),
  makeTask({ id: 'task-004-ui', status: 'completed', message: 'UI fixes', branch: 'feature/ui' }),
  makeTask({ id: 'task-005-perf', status: 'failed', message: 'Performance tuning', branch: 'feature/perf' }),
  makeTask({ id: 'task-006-risk', status: 'at_risk', internalStatus: 'risk', message: 'Slow deploy', branch: 'feature/deploy' }),
]

describe('filterByStatus', () => {
  it('returns all tasks when status is empty', () => {
    expect(filterByStatus(tasks, '')).toEqual(tasks)
  })

  it('filters tasks by status', () => {
    const result = filterByStatus(tasks, 'running')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-001-auth')
  })

  it('filters at_risk tasks', () => {
    const result = filterByStatus(tasks, 'at_risk')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-006-risk')
  })

  it('returns empty when no match', () => {
    expect(filterByStatus(tasks, 'escalated')).toEqual([])
  })
})

describe('filterBySearch', () => {
  it('returns all tasks when query is empty', () => {
    expect(filterBySearch(tasks, '')).toEqual(tasks)
  })

  it('matches by task id', () => {
    const result = filterBySearch(tasks, '002')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-002-db')
  })

  it('matches by message (case-insensitive)', () => {
    const result = filterBySearch(tasks, 'AUTH')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-001-auth')
  })

  it('matches by branch', () => {
    const result = filterBySearch(tasks, 'feature/api')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-003-api')
  })

  it('returns empty when no match', () => {
    expect(filterBySearch(tasks, 'nonexistent')).toEqual([])
  })
})

describe('applyFilters', () => {
  it('applies both status and search filters', () => {
    const result = applyFilters(tasks, 'running', 'auth')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-001-auth')
  })

  it('returns empty when status matches but search does not', () => {
    expect(applyFilters(tasks, 'running', 'nonexistent')).toEqual([])
  })

  it('returns all when both filters are empty', () => {
    expect(applyFilters(tasks, '', '')).toEqual(tasks)
  })
})
