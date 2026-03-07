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

  it('uses stable fallback timestamp when createdAt/updatedAt missing', () => {
    const orch: OrchTask = {
      ...baseOrch,
      createdAt: undefined,
      updatedAt: undefined,
      events: [
        { taskId: 'task-abc-123', status: 'claimed', phase: 'pull', message: 'Claimed', createdAt: '2025-06-01T00:00:00Z' },
      ],
    }
    const task1 = mapOrchTask(orch)
    const task2 = mapOrchTask(orch)
    // Must be deterministic (not Date.now())
    expect(task1.createdAt).toBe('2025-06-01T00:00:00Z')
    expect(task2.createdAt).toBe('2025-06-01T00:00:00Z')
    expect(task1.updatedAt).toBe('2025-06-01T00:00:00Z')
  })

  it('uses epoch when no timestamps and no events', () => {
    const orch: OrchTask = {
      ...baseOrch,
      createdAt: undefined,
      updatedAt: undefined,
      events: undefined,
    }
    const task = mapOrchTask(orch)
    expect(task.createdAt).toBe('1970-01-01T00:00:00Z')
    expect(task.updatedAt).toBe('1970-01-01T00:00:00Z')
  })

  it('uses createdAt as updatedAt fallback when only updatedAt is missing', () => {
    const orch: OrchTask = {
      ...baseOrch,
      createdAt: '2025-03-01T12:00:00Z',
      updatedAt: undefined,
    }
    const task = mapOrchTask(orch)
    expect(task.updatedAt).toBe('2025-03-01T12:00:00Z')
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

  // ── Validation guards ──

  it('throws when taskId is missing', () => {
    expect(() => mapOrchTask({ ...baseOrch, taskId: '' }))
      .toThrow('taskId is required')
  })

  it('throws when mode is missing', () => {
    expect(() => mapOrchTask({ ...baseOrch, mode: '' }))
      .toThrow('mode is required')
  })

  // ── v2 result contract tests ──

  it('passes through resultVersion when present', () => {
    const orch: OrchTask = { ...baseOrch, status: 'completed', resultVersion: 2 }
    const task = mapOrchTask(orch)
    expect(task.resultVersion).toBe(2)
  })

  it('omits resultVersion for v1 tasks (no resultVersion field)', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.resultVersion).toBeUndefined()
  })

  it('maps artifacts array from orch to task', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'completed',
      resultVersion: 2,
      artifacts: [
        { name: 'stdout.txt', kind: 'stdout', path: 'data/artifacts/task-abc-123/stdout.txt', bytes: 16384, sha256: 'abc123', preview: 'first 512...' },
      ],
      output: { stdout: 'truncated...', stderr: '', truncated: true },
      meta: { exitCode: 0, durationMs: 5000 },
    }
    const task = mapOrchTask(orch)
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts![0]).toEqual({
      name: 'stdout.txt',
      kind: 'stdout',
      path: 'data/artifacts/task-abc-123/stdout.txt',
      bytes: 16384,
      sha256: 'abc123',
      preview: 'first 512...',
    })
  })

  it('omits artifacts for v1 tasks (no artifacts field)', () => {
    const task = mapOrchTask(baseOrch)
    expect(task.artifacts).toBeUndefined()
  })

  it('handles empty artifacts array gracefully', () => {
    const orch: OrchTask = { ...baseOrch, resultVersion: 2, artifacts: [] }
    const task = mapOrchTask(orch)
    expect(task.artifacts).toBeUndefined() // empty array not mapped
  })

  it('v1→v2 backward compat: v1 task with output still maps result correctly', () => {
    const orch: OrchTask = {
      ...baseOrch,
      status: 'completed',
      output: { stdout: 'full output here', stderr: '', truncated: false },
      meta: { exitCode: 0, durationMs: 3000 },
    }
    const task = mapOrchTask(orch)
    // v1 fields still work
    expect(task.result).toEqual({
      stdout: 'full output here',
      stderr: '',
      truncated: false,
      exitCode: 0,
      durationMs: 3000,
    })
    // v2 fields absent
    expect(task.resultVersion).toBeUndefined()
    expect(task.artifacts).toBeUndefined()
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

  it('uses stable epoch fallback when createdAt missing', () => {
    const ev: OrchEvent = {
      taskId: 'task-1',
      status: 'claimed',
      phase: 'pull',
      message: 'Claimed',
    }
    const mapped1 = mapOrchEvent(ev, 0)
    const mapped2 = mapOrchEvent(ev, 0)
    expect(mapped1.createdAt).toBe('1970-01-01T00:00:00Z')
    expect(mapped2.createdAt).toBe('1970-01-01T00:00:00Z')
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
