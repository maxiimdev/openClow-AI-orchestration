import { describe, it, expect } from 'vitest'
import { mapOrchTask, mapOrchEvent, mapOrchEvents } from '../server/lib/orch-mapper'
import type { OrchTask, OrchEvent } from '../server/lib/orch-client'

describe('mapOrchTask', () => {
  const baseOrch: OrchTask = {
    taskId: 'task-abc-123',
    mode: 'implement',
    status: 'progress',
    scope: { repoPath: '/app', branch: 'feature/test' },
    meta: { stepIndex: 2, stepTotal: 4 },
    events: [
      { taskId: 'task-abc-123', status: 'claimed', phase: 'pull', message: 'Task claimed', createdAt: '2025-01-01T00:00:00Z' },
      { taskId: 'task-abc-123', status: 'progress', phase: 'claude', message: 'Claude running', createdAt: '2025-01-01T00:01:00Z' },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:01:00Z',
  }

  it('maps taskId → id', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.id).toBe('task-abc-123')
  })

  it('maps scope fields to flat fields', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.repoPath).toBe('/app')
    expect(task.branch).toBe('feature/test')
  })

  it('maps worker status → user status', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.status).toBe('running') // progress → running
    expect(task.internalStatus).toBe('progress')
  })

  it('assigns userId=0 (MVP no ownership)', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.userId).toBe(0)
  })

  it('extracts latest message from events', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.message).toBe('Claude running')
  })

  it('preserves timestamps', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.createdAt).toBe('2025-01-01T00:00:00Z')
    expect(task.updatedAt).toBe('2025-01-01T00:01:00Z')
  })

  it('maps needs_input with question/options', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'needs_input',
      question: 'Which DB?',
      options: ['PostgreSQL', 'MySQL'],
      needsInputAt: '2025-01-01T00:02:00Z',
    }
    const task = mapOrchTask(orch)
    expect(task.status).toBe('needs_input')
    expect(task.question).toBe('Which DB?')
    expect(task.options).toEqual(['PostgreSQL', 'MySQL'])
    expect(task.needsInputAt).toBe('2025-01-01T00:02:00Z')
  })

  it('maps review_fail with structuredFindings', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'review_fail',
      structuredFindings: [
        { id: 'F1', severity: 'critical', file: 'src/a.ts', issue: 'XSS', risk: 'Injection', required_fix: 'Sanitize', acceptance_check: 'Escaped' },
      ],
      reviewFindings: 'XSS vulnerability found',
    }
    const task = mapOrchTask(orch)
    expect(task.status).toBe('review_fail')
    expect(task.structuredFindings).toHaveLength(1)
    expect(task.structuredFindings![0].severity).toBe('critical')
    expect(task.reviewFindings).toBe('XSS vulnerability found')
  })

  it('maps output → result', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'completed',
      output: { stdout: 'done', stderr: '', truncated: false },
      meta: { exitCode: 0, durationMs: 5000 },
    }
    const task = mapOrchTask(orch)
    expect(task.result).toEqual({
      stdout: 'done',
      stderr: '',
      truncated: false,
      exitCode: 0,
      durationMs: 5000,
    })
  })

  it('handles missing scope gracefully', () => {
    const orch: OrchTask = { ...baseOrch, scope: undefined }
    const task = mapOrchTask(orch)
    expect(task.branch).toBe('')
    expect(task.repoPath).toBe('')
  })

  it('handles missing events gracefully', () => {
    const orch: OrchTask = { ...baseOrch, events: undefined }
    const task = mapOrchTask(orch)
    expect(task.message).toBe('Status: progress')
  })

  it('maps all worker statuses correctly', () => {
    const cases: Array<[string, string]> = [
      ['claimed', 'running'],
      ['started', 'running'],
      ['progress', 'running'],
      ['keepalive', 'running'],
      ['context_reset', 'running'],
      ['review_loop_fail', 'running'],
      ['risk', 'at_risk'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['timeout', 'failed'],
      ['rejected', 'failed'],
      ['needs_input', 'needs_input'],
      ['review_pass', 'review_pass'],
      ['review_fail', 'review_fail'],
      ['escalated', 'escalated'],
    ]
    for (const [worker, user] of cases) {
      const task = mapOrchTask({ ...baseOrch, status: worker })
      expect(task.status).toBe(user)
    }
  })

  it('defaults unknown status to running', () => {
    const task = mapOrchTask({ ...baseOrch, status: 'mysterious' })
    expect(task.status).toBe('running')
  })
})

describe('mapOrchEvent', () => {
  it('maps event fields', () => {
    const ev: OrchEvent = {
      id: 'evt-1',
      taskId: 'task-1',
      status: 'progress',
      phase: 'claude',
      message: 'Running',
      meta: { stepIndex: 1 },
      createdAt: '2025-01-01T00:00:00Z',
    }
    const mapped = mapOrchEvent(ev, 0)
    expect(mapped.id).toBe('evt-1')
    expect(mapped.taskId).toBe('task-1')
    expect(mapped.status).toBe('progress')
    expect(mapped.phase).toBe('claude')
    expect(mapped.message).toBe('Running')
    expect(mapped.meta).toEqual({ stepIndex: 1 })
  })

  it('generates id from index when missing', () => {
    const ev: OrchEvent = {
      taskId: 'task-1',
      status: 'claimed',
      phase: 'pull',
      message: 'Claimed',
    }
    const mapped = mapOrchEvent(ev, 3)
    expect(mapped.id).toBe('evt-3')
  })
})

describe('mapOrchEvents', () => {
  it('maps array of events', () => {
    const orch: OrchTask = {
      taskId: 'task-1',
      mode: 'implement',
      status: 'progress',
      events: [
        { taskId: 'task-1', status: 'claimed', phase: 'pull', message: 'Claimed' },
        { taskId: 'task-1', status: 'progress', phase: 'claude', message: 'Running' },
      ],
    }
    const events = mapOrchEvents(orch)
    expect(events).toHaveLength(2)
    expect(events[0].status).toBe('claimed')
    expect(events[1].status).toBe('progress')
  })

  it('returns empty array when no events', () => {
    const orch: OrchTask = { taskId: 'task-1', mode: 'implement', status: 'progress' }
    expect(mapOrchEvents(orch)).toEqual([])
  })
})
