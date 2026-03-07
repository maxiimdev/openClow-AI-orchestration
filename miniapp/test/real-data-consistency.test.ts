/**
 * Real-data consistency tests — Phase 4 foundation.
 *
 * Verifies that mock data shape matches orch-mapper output shape,
 * status mapping tables stay in sync, and edge cases like epoch
 * fallbacks are handled gracefully.
 */
import { describe, it, expect } from 'vitest'
import { mapOrchTask } from '../server/lib/orch-mapper'
import type { OrchTask } from '../server/lib/orch-client'
import { mockTasks } from '../server/lib/mock-data'
import {
  mapWorkerStatus,
  getStatusLabel,
  getStatusColor,
  formatRelativeTime,
} from '../app/lib/mappers'
import type { UserStatus, WorkerStatus, Task } from '../app/lib/types'

// ── Status mapping parity ──

describe('status mapping parity (server orch-mapper vs client mappers)', () => {
  const workerStatuses: WorkerStatus[] = [
    'claimed', 'started', 'progress', 'keepalive', 'context_reset',
    'review_loop_fail', 'risk', 'completed', 'failed', 'timeout',
    'rejected', 'needs_input', 'review_pass', 'review_fail', 'escalated',
  ]

  it('server and client status maps produce identical UserStatus for every WorkerStatus', () => {
    for (const ws of workerStatuses) {
      const serverResult = mapOrchTask({
        taskId: 'test', mode: 'implement', status: ws,
        meta: {}, events: [],
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
      }).status
      const clientResult = mapWorkerStatus(ws)
      expect(serverResult).toBe(clientResult)
    }
  })

  it('every UserStatus has a display label', () => {
    const userStatuses: UserStatus[] = [
      'running', 'at_risk', 'completed', 'failed',
      'needs_input', 'review_pass', 'review_fail', 'escalated',
    ]
    for (const us of userStatuses) {
      const label = getStatusLabel(us)
      expect(label).toBeTruthy()
      expect(label).not.toBe(us) // label differs from raw status
    }
  })

  it('every UserStatus has a non-gray color', () => {
    const userStatuses: UserStatus[] = [
      'running', 'at_risk', 'completed', 'failed',
      'needs_input', 'review_pass', 'review_fail', 'escalated',
    ]
    for (const us of userStatuses) {
      expect(getStatusColor(us)).not.toBe('gray')
    }
  })
})

// ── Mock data shape ──

describe('mock data shape matches Task interface contract', () => {
  const requiredFields: (keyof Task)[] = [
    'id', 'userId', 'mode', 'status', 'internalStatus',
    'branch', 'repoPath', 'createdAt', 'updatedAt', 'message', 'meta',
  ]

  it('all mock tasks have required fields', () => {
    for (const task of mockTasks) {
      for (const field of requiredFields) {
        expect(task).toHaveProperty(field)
      }
    }
  })

  it('completed mock task has result struct matching orch-mapper output', () => {
    const completed = mockTasks.find(t => t.status === 'completed')
    expect(completed).toBeDefined()
    expect(completed!.result).toBeDefined()
    expect(completed!.result).toHaveProperty('stdout')
    expect(completed!.result).toHaveProperty('stderr')
    expect(completed!.result).toHaveProperty('truncated')
    expect(completed!.result).toHaveProperty('exitCode')
    expect(completed!.result).toHaveProperty('durationMs')
  })

  it('review_fail mock task has reviewFindings and structuredFindings', () => {
    const reviewFail = mockTasks.find(t => t.status === 'review_fail')
    expect(reviewFail).toBeDefined()
    expect(reviewFail!.reviewFindings).toBeTruthy()
    expect(reviewFail!.structuredFindings?.length).toBeGreaterThan(0)
  })

  it('needs_input mock tasks have question field', () => {
    const niTasks = mockTasks.filter(t => t.status === 'needs_input')
    expect(niTasks.length).toBeGreaterThan(0)
    for (const task of niTasks) {
      expect(task.question).toBeTruthy()
      expect(task.needsInputAt).toBeTruthy()
    }
  })

  it('mock task statuses are valid UserStatus values', () => {
    const validStatuses: UserStatus[] = [
      'running', 'at_risk', 'completed', 'failed',
      'needs_input', 'review_pass', 'review_fail', 'escalated',
    ]
    for (const task of mockTasks) {
      expect(validStatuses).toContain(task.status)
    }
  })

  it('mock task internalStatus values are valid WorkerStatus values', () => {
    const validInternals: WorkerStatus[] = [
      'claimed', 'started', 'progress', 'keepalive', 'context_reset',
      'review_loop_fail', 'risk', 'completed', 'failed', 'timeout',
      'rejected', 'needs_input', 'review_pass', 'review_fail', 'escalated',
    ]
    for (const task of mockTasks) {
      expect(validInternals).toContain(task.internalStatus)
    }
  })

  it('failed mock task exists with non-zero exitCode', () => {
    const failed = mockTasks.find(t => t.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.result).toBeDefined()
    expect(failed!.result!.exitCode).not.toBe(0)
  })

  it('review_fail mock task has reviewIteration in meta (matches orch-api shape)', () => {
    const reviewFail = mockTasks.find(t => t.status === 'review_fail')
    expect(reviewFail).toBeDefined()
    expect(reviewFail!.meta.reviewIteration).toBeDefined()
    expect(typeof reviewFail!.meta.reviewIteration).toBe('number')
  })

  it('escalated mock task has reviewIteration equal to reviewMaxIterations', () => {
    const escalated = mockTasks.find(t => t.status === 'escalated')
    expect(escalated).toBeDefined()
    expect(escalated!.meta.reviewIteration).toBe(escalated!.meta.reviewMaxIterations)
  })

  it('every mock task has createdAt <= updatedAt', () => {
    for (const task of mockTasks) {
      expect(new Date(task.createdAt).getTime()).toBeLessThanOrEqual(new Date(task.updatedAt).getTime())
    }
  })

  it('mock data covers all terminal UserStatus values', () => {
    const terminalStatuses: UserStatus[] = ['completed', 'failed', 'review_pass', 'review_fail', 'escalated']
    const mockStatuses = new Set(mockTasks.map(t => t.status))
    for (const s of terminalStatuses) {
      expect(mockStatuses.has(s)).toBe(true)
    }
  })
})

// ── Orch-mapper edge cases for real data ──

describe('orch-mapper real-data edge cases', () => {
  const baseOrch: OrchTask = {
    taskId: 'edge-1', mode: 'implement', status: 'completed',
    meta: {}, events: [],
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  }

  it('result.durationMs defaults to 0 when meta has no durationMs', () => {
    const orch: OrchTask = {
      ...baseOrch,
      output: { stdout: '', stderr: '', truncated: false },
      meta: { exitCode: 0 },
    }
    const task = mapOrchTask(orch)
    expect(task.result!.durationMs).toBe(0)
  })

  it('result.exitCode defaults to 0 when meta has no exitCode', () => {
    const orch: OrchTask = {
      ...baseOrch,
      output: { stdout: '', stderr: '', truncated: false },
      meta: {},
    }
    const task = mapOrchTask(orch)
    expect(task.result!.exitCode).toBe(0)
  })

  it('needs_input task without needsInputAt still maps cleanly', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'needs_input',
      question: 'Which DB?',
    }
    const task = mapOrchTask(orch)
    expect(task.status).toBe('needs_input')
    expect(task.question).toBe('Which DB?')
    expect(task.needsInputAt).toBeUndefined()
  })

  it('reviewFindings without structuredFindings maps cleanly', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'review_fail',
      reviewFindings: 'Missing error handling',
    }
    const task = mapOrchTask(orch)
    expect(task.reviewFindings).toBe('Missing error handling')
    expect(task.structuredFindings).toBeUndefined()
  })

  it('meta passthrough preserves arbitrary fields', () => {
    const orch: OrchTask = {
      ...baseOrch,
      meta: { reviewIteration: 2, reviewMaxIterations: 3, custom: 'value' },
    }
    const task = mapOrchTask(orch)
    expect(task.meta.reviewIteration).toBe(2)
    expect(task.meta.custom).toBe('value')
  })
})

// ── Cross-page consistency invariants ──

describe('cross-page consistency invariants', () => {
  it('dashboard counts match tasks page filter results', () => {
    const active = mockTasks.filter(t => t.status === 'running' || t.status === 'at_risk')
    const needsInput = mockTasks.filter(t => t.status === 'needs_input')
    const completed = mockTasks.filter(t => t.status === 'completed')
    const failed = mockTasks.filter(t => t.status === 'failed')
    const reviews = mockTasks.filter(t => ['review_pass', 'review_fail', 'escalated'].includes(t.status))

    // sum of all categories = total tasks
    const categorized = active.length + needsInput.length + completed.length + failed.length + reviews.length
    expect(categorized).toBe(mockTasks.length)
  })

  it('review center total matches review filter count', () => {
    const reviewStatuses: UserStatus[] = ['review_pass', 'review_fail', 'escalated']
    const reviews = mockTasks.filter(t => reviewStatuses.includes(t.status))
    const passed = reviews.filter(t => t.status === 'review_pass').length
    const failed = reviews.filter(t => t.status === 'review_fail').length
    const escalated = reviews.filter(t => t.status === 'escalated').length
    expect(passed + failed + escalated).toBe(reviews.length)
  })

  it('every review_fail task has reviewFindings for detail page rendering', () => {
    const reviewFails = mockTasks.filter(t => t.status === 'review_fail')
    for (const task of reviewFails) {
      expect(task.reviewFindings || task.structuredFindings?.length).toBeTruthy()
    }
  })

  it('every escalated task has reviewFindings for detail page rendering', () => {
    const escalated = mockTasks.filter(t => t.status === 'escalated')
    for (const task of escalated) {
      expect(task.reviewFindings || task.structuredFindings?.length).toBeTruthy()
    }
  })
})

// ── formatRelativeTime safety ──

describe('formatRelativeTime edge cases', () => {
  it('returns "unknown" for epoch timestamp (1970-01-01T00:00:00Z)', () => {
    expect(formatRelativeTime('1970-01-01T00:00:00Z')).toBe('unknown')
  })

  it('returns "unknown" for invalid date string', () => {
    expect(formatRelativeTime('not-a-date')).toBe('unknown')
  })

  it('returns "unknown" for empty string', () => {
    expect(formatRelativeTime('')).toBe('unknown')
  })

  it('handles valid recent timestamp normally', () => {
    const recent = new Date(Date.now() - 60000).toISOString()
    expect(formatRelativeTime(recent)).toBe('1m ago')
  })
})
