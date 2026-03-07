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
