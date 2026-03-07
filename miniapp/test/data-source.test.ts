import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { OrchTask } from '../server/lib/orch-client'

// Mock orch-client before importing data-source
vi.mock('../server/lib/orch-client', () => ({
  orchGetTask: vi.fn(),
  orchResumeTask: vi.fn(),
  configureOrchClient: vi.fn(),
}))

import { orchGetTask, orchResumeTask } from '../server/lib/orch-client'
import { listTasks, getTask, getTaskEvents, resumeTask } from '../server/lib/data-source'
import { resetCache, trackTaskId } from '../server/lib/task-cache'

const mockOrchGetTask = vi.mocked(orchGetTask)
const mockOrchResumeTask = vi.mocked(orchResumeTask)

const sampleOrchTask: OrchTask = {
  taskId: 'orch-task-1',
  mode: 'implement',
  status: 'progress',
  scope: { repoPath: '/repo', branch: 'feature/x' },
  meta: { stepIndex: 1, stepTotal: 3 },
  events: [
    { taskId: 'orch-task-1', status: 'claimed', phase: 'pull', message: 'Claimed', createdAt: '2025-01-01T00:00:00Z' },
    { taskId: 'orch-task-1', status: 'progress', phase: 'claude', message: 'Running', createdAt: '2025-01-01T00:01:00Z' },
  ],
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:01:00Z',
}

const needsInputOrch: OrchTask = {
  taskId: 'orch-ni-1',
  mode: 'implement',
  status: 'needs_input',
  question: 'Which DB?',
  options: ['PG', 'SQLite'],
  needsInputAt: '2025-01-01T00:02:00Z',
  meta: {},
  events: [],
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:02:00Z',
}

describe('data-source (mock mode)', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'mock'
    resetCache()
  })

  it('listTasks returns mock data for userId=1', async () => {
    const result = await listTasks({ userId: 1 })
    expect(result.tasks.length).toBeGreaterThan(0)
    expect(result.tasks.every(t => t.userId === 1)).toBe(true)
  })

  it('listTasks filters by status', async () => {
    const result = await listTasks({ userId: 1, statusFilter: ['needs_input'] })
    expect(result.tasks.every(t => t.status === 'needs_input')).toBe(true)
    expect(result.tasks.length).toBe(2) // task-002 and task-002b
  })

  it('getTask returns task by id', async () => {
    const task = await getTask('task-001-auth-refactor', 1)
    expect(task).not.toBeNull()
    expect(task!.id).toBe('task-001-auth-refactor')
  })

  it('getTask returns null for wrong userId', async () => {
    const task = await getTask('task-001-auth-refactor', 999)
    expect(task).toBeNull()
  })

  it('getTaskEvents returns events', async () => {
    const events = await getTaskEvents('task-001-auth-refactor', 1)
    expect(events).not.toBeNull()
    expect(events!.length).toBe(5)
  })

  it('getTaskEvents returns null for wrong userId', async () => {
    const events = await getTaskEvents('task-001-auth-refactor', 999)
    expect(events).toBeNull()
  })
})

describe('data-source (orch mode)', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'orch'
    process.env.ORCH_API_BASE_URL = 'http://localhost:9999'
    process.env.ORCH_API_TOKEN = 'test-token'
    resetCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.MINIAPP_DATA_MODE
    delete process.env.ORCH_API_BASE_URL
    delete process.env.ORCH_API_TOKEN
  })

  describe('getTask', () => {
    it('fetches from orch-api and maps', async () => {
      mockOrchGetTask.mockResolvedValue(sampleOrchTask)
      const task = await getTask('orch-task-1', 1)
      expect(mockOrchGetTask).toHaveBeenCalledWith('orch-task-1')
      expect(task).not.toBeNull()
      expect(task!.id).toBe('orch-task-1')
      expect(task!.status).toBe('running')
      expect(task!.branch).toBe('feature/x')
    })

    it('returns null on 404', async () => {
      mockOrchGetTask.mockRejectedValue(new Error('orch-api 404: not found'))
      const task = await getTask('nonexistent', 1)
      expect(task).toBeNull()
    })

    it('tracks task ID in cache on success', async () => {
      mockOrchGetTask.mockResolvedValue(sampleOrchTask)
      await getTask('orch-task-1', 1)
      expect(resetCache, 'cache tracks after getTask')
      // Verify by listing — should have the ID in cache
      const ids = (await import('../server/lib/task-cache')).getKnownTaskIds()
      expect(ids).toContain('orch-task-1')
    })
  })

  describe('getTaskEvents', () => {
    it('returns events from inline task.events', async () => {
      mockOrchGetTask.mockResolvedValue(sampleOrchTask)
      const events = await getTaskEvents('orch-task-1', 1)
      expect(events).not.toBeNull()
      expect(events).toHaveLength(2)
      expect(events![0].status).toBe('claimed')
      expect(events![1].status).toBe('progress')
    })

    it('returns null on 404', async () => {
      mockOrchGetTask.mockRejectedValue(new Error('orch-api 404: not found'))
      const events = await getTaskEvents('nonexistent', 1)
      expect(events).toBeNull()
    })
  })

  describe('listTasks', () => {
    it('returns empty with notice when no cached IDs', async () => {
      const result = await listTasks({ userId: 1 })
      expect(result.tasks).toEqual([])
      expect(result.notice).toContain('No tasks in local cache')
    })

    it('fetches each cached ID and aggregates', async () => {
      trackTaskId('orch-task-1')
      trackTaskId('orch-task-2')
      mockOrchGetTask
        .mockResolvedValueOnce(sampleOrchTask)
        .mockResolvedValueOnce({ ...sampleOrchTask, taskId: 'orch-task-2', status: 'completed' })

      const result = await listTasks({ userId: 1 })
      expect(result.tasks).toHaveLength(2)
      expect(result.notice).toContain('local task cache')
    })

    it('filters by status', async () => {
      trackTaskId('orch-task-1')
      mockOrchGetTask.mockResolvedValue({ ...sampleOrchTask, status: 'completed' })

      const result = await listTasks({ userId: 1, statusFilter: ['running'] })
      expect(result.tasks).toHaveLength(0)
    })

    it('removes 404d IDs from cache', async () => {
      trackTaskId('gone-task')
      mockOrchGetTask.mockRejectedValue(new Error('orch-api 404: not found'))

      const result = await listTasks({ userId: 1 })
      expect(result.tasks).toHaveLength(0)

      const { getKnownTaskIds } = await import('../server/lib/task-cache')
      expect(getKnownTaskIds()).not.toContain('gone-task')
    })

    it('reports fetchErrors for non-404 failures', async () => {
      trackTaskId('ok-task')
      trackTaskId('err-task')
      mockOrchGetTask
        .mockResolvedValueOnce(sampleOrchTask)
        .mockRejectedValueOnce(new Error('orch-api 500: internal'))

      const result = await listTasks({ userId: 1 })
      expect(result.tasks).toHaveLength(1)
      expect(result.fetchErrors).toBe(1)
    })

    it('sorts results by updatedAt descending', async () => {
      trackTaskId('old-task')
      trackTaskId('new-task')
      mockOrchGetTask
        .mockResolvedValueOnce({
          ...sampleOrchTask,
          taskId: 'old-task',
          updatedAt: '2025-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          ...sampleOrchTask,
          taskId: 'new-task',
          updatedAt: '2025-06-01T00:00:00Z',
        })

      const result = await listTasks({ userId: 1 })
      expect(result.tasks[0].id).toBe('new-task')
      expect(result.tasks[1].id).toBe('old-task')
    })

    it('does not include fetchErrors when all succeed', async () => {
      trackTaskId('ok-task')
      mockOrchGetTask.mockResolvedValue(sampleOrchTask)

      const result = await listTasks({ userId: 1 })
      expect(result.fetchErrors).toBeUndefined()
    })
  })

  describe('resumeTask', () => {
    it('verifies needs_input status and forwards to orch', async () => {
      const resumed = { ...needsInputOrch, status: 'progress', question: null }
      mockOrchGetTask
        .mockResolvedValueOnce(needsInputOrch)       // pre-check
        .mockResolvedValueOnce(resumed)                // re-fetch after resume
      mockOrchResumeTask.mockResolvedValue({ ok: true })

      const result = await resumeTask('orch-ni-1', 'PostgreSQL', 1)
      expect(result).not.toBeNull()
      expect(result!.ok).toBe(true)
      expect(result!.task.status).toBe('running')
      expect(mockOrchResumeTask).toHaveBeenCalledWith('orch-ni-1', 'PostgreSQL')
    })

    it('throws when task is not needs_input', async () => {
      mockOrchGetTask.mockResolvedValue(sampleOrchTask) // status: progress
      await expect(resumeTask('orch-task-1', 'answer', 1))
        .rejects.toThrow('task_not_awaiting_input')
    })

    it('returns null on 404', async () => {
      mockOrchGetTask.mockRejectedValue(new Error('orch-api 404: not found'))
      const result = await resumeTask('nonexistent', 'answer', 1)
      expect(result).toBeNull()
    })
  })
})
