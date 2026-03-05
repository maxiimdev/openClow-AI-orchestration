import { describe, it, expect } from 'vitest'
import {
  filterReviewTasks,
  getReviewSummary,
  countFindingsBySeverity,
  getHighestSeverity,
  getReviewCardSummary,
  REVIEW_STATUSES,
} from '~/lib/reviews'
import type { Task, Finding } from '~/lib/types'

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-001',
    mode: 'review',
    status: 'review_pass',
    internalStatus: 'review_pass',
    branch: 'feature/test',
    repoPath: '/repo',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    message: 'Review passed',
    meta: {},
    userId: 1,
    ...overrides,
  }
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F1',
    severity: 'major',
    file: 'src/test.ts',
    issue: 'Test issue',
    risk: 'Test risk',
    required_fix: 'Fix it',
    acceptance_check: 'Check it',
    ...overrides,
  }
}

describe('REVIEW_STATUSES', () => {
  it('includes review_pass, review_fail, escalated', () => {
    expect(REVIEW_STATUSES).toEqual(['review_pass', 'review_fail', 'escalated'])
  })
})

describe('filterReviewTasks', () => {
  it('returns only review-status tasks', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'review_pass' }),
      makeTask({ id: 't2', status: 'running' }),
      makeTask({ id: 't3', status: 'review_fail' }),
      makeTask({ id: 't4', status: 'completed' }),
      makeTask({ id: 't5', status: 'escalated' }),
    ]
    const result = filterReviewTasks(tasks)
    expect(result.map(t => t.id)).toEqual(['t1', 't3', 't5'])
  })

  it('returns empty array when no review tasks', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'running' }),
      makeTask({ id: 't2', status: 'completed' }),
    ]
    expect(filterReviewTasks(tasks)).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(filterReviewTasks([])).toEqual([])
  })
})

describe('getReviewSummary', () => {
  it('counts review tasks by status', () => {
    const tasks = [
      makeTask({ status: 'review_pass' }),
      makeTask({ status: 'review_pass' }),
      makeTask({ status: 'review_fail' }),
      makeTask({ status: 'escalated' }),
      makeTask({ status: 'running' }),
    ]
    expect(getReviewSummary(tasks)).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      escalated: 1,
    })
  })

  it('returns all zeros for no review tasks', () => {
    expect(getReviewSummary([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      escalated: 0,
    })
  })
})

describe('countFindingsBySeverity', () => {
  it('counts findings by severity', () => {
    const findings = [
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'major' }),
      makeFinding({ severity: 'major' }),
      makeFinding({ severity: 'minor' }),
    ]
    expect(countFindingsBySeverity(findings)).toEqual({
      critical: 1,
      major: 2,
      minor: 1,
    })
  })

  it('returns all zeros for empty findings', () => {
    expect(countFindingsBySeverity([])).toEqual({
      critical: 0,
      major: 0,
      minor: 0,
    })
  })
})

describe('getHighestSeverity', () => {
  it('returns critical when present', () => {
    const findings = [
      makeFinding({ severity: 'minor' }),
      makeFinding({ severity: 'critical' }),
    ]
    expect(getHighestSeverity(findings)).toBe('critical')
  })

  it('returns major when no critical', () => {
    const findings = [
      makeFinding({ severity: 'minor' }),
      makeFinding({ severity: 'major' }),
    ]
    expect(getHighestSeverity(findings)).toBe('major')
  })

  it('returns minor when only minor', () => {
    expect(getHighestSeverity([makeFinding({ severity: 'minor' })])).toBe('minor')
  })

  it('returns null for empty findings', () => {
    expect(getHighestSeverity([])).toBeNull()
  })
})

describe('getReviewCardSummary', () => {
  it('returns pass message for review_pass', () => {
    const task = makeTask({ status: 'review_pass' })
    expect(getReviewCardSummary(task)).toBe('Review passed — no issues found')
  })

  it('returns findings count for review_fail with structured findings', () => {
    const task = makeTask({
      status: 'review_fail',
      structuredFindings: [makeFinding(), makeFinding({ id: 'F2' })],
    })
    expect(getReviewCardSummary(task)).toBe('2 findings require attention')
  })

  it('returns singular for single finding', () => {
    const task = makeTask({
      status: 'review_fail',
      structuredFindings: [makeFinding()],
    })
    expect(getReviewCardSummary(task)).toBe('1 finding requires attention')
  })

  it('returns escalated message with count', () => {
    const task = makeTask({
      status: 'escalated',
      structuredFindings: [makeFinding()],
    })
    expect(getReviewCardSummary(task)).toBe('Escalated — 1 finding unresolved')
  })

  it('falls back to reviewFindings text', () => {
    const task = makeTask({
      status: 'review_fail',
      reviewFindings: 'Missing tests',
    })
    expect(getReviewCardSummary(task)).toBe('Missing tests')
  })

  it('falls back to generic message', () => {
    const task = makeTask({ status: 'review_fail' })
    expect(getReviewCardSummary(task)).toBe('Review failed')
  })
})
