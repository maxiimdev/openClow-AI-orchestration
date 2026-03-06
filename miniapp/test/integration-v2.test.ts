/**
 * Phase 3 integration tests — v2 result contract, feature flags,
 * backward compatibility with v1 tasks, and observability.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { OrchTask } from '../server/lib/orch-client'

// Mock orch-client before importing data-source
vi.mock('../server/lib/orch-client', () => ({
  orchGetTask: vi.fn(),
  orchResumeTask: vi.fn(),
  configureOrchClient: vi.fn(),
}))

import { orchGetTask } from '../server/lib/orch-client'
import { getTask, getTaskDisplay } from '../server/lib/data-source'
import { resetCache, trackTaskId } from '../server/lib/task-cache'
import { setDb, closeDb } from '../server/lib/search-db'
import { getIndexedArtifacts } from '../server/lib/indexer'
import { getFeatureFlags } from '../server/lib/feature-flags'

const mockOrchGetTask = vi.mocked(orchGetTask)

// ── Fixtures ──────────────────────────────────────────────────────────────

const v1Task: OrchTask = {
  taskId: 'v1-old-task',
  mode: 'implement',
  status: 'completed',
  scope: { repoPath: '/repo', branch: 'main' },
  output: { stdout: 'All done. Tests pass.', stderr: '', truncated: false },
  meta: { exitCode: 0, durationMs: 5000 },
  events: [
    { taskId: 'v1-old-task', status: 'claimed', phase: 'pull', message: 'Claimed', createdAt: '2025-01-01T00:00:00Z' },
    { taskId: 'v1-old-task', status: 'completed', phase: 'result', message: 'Done', createdAt: '2025-01-01T00:05:00Z' },
  ],
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:05:00Z',
}

const v2Task: OrchTask = {
  taskId: 'v2-new-task',
  mode: 'implement',
  status: 'completed',
  scope: { repoPath: '/repo', branch: 'feature/v2' },
  resultVersion: 2,
  output: { stdout: 'truncated inline...', stderr: '', truncated: true },
  artifacts: [
    {
      name: 'stdout.txt',
      kind: 'stdout',
      path: 'data/artifacts/v2-new-task/stdout.txt',
      bytes: 16384,
      sha256: 'abc123def456',
      preview: 'Full task output summary with details about implementation...',
    },
    {
      name: 'report.md',
      kind: 'markdown',
      path: 'data/artifacts/v2-new-task/report.md',
      bytes: 4096,
      sha256: 'def789ghi012',
      preview: '## Summary\nAll tests passed. Code quality improved.',
    },
  ],
  meta: { exitCode: 0, durationMs: 12000 },
  events: [
    { taskId: 'v2-new-task', status: 'claimed', phase: 'pull', message: 'Claimed', createdAt: '2025-02-01T00:00:00Z' },
    { taskId: 'v2-new-task', status: 'completed', phase: 'result', message: 'Done', createdAt: '2025-02-01T00:10:00Z' },
  ],
  createdAt: '2025-02-01T00:00:00Z',
  updatedAt: '2025-02-01T00:10:00Z',
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Phase 3: v1 backward compatibility', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'orch'
    process.env.ORCH_API_BASE_URL = 'http://localhost:9999'
    process.env.ORCH_API_TOKEN = 'test-token'
    resetCache()
    vi.clearAllMocks()
    const db = new Database(':memory:')
    setDb(db)
  })

  afterEach(() => {
    closeDb()
    delete process.env.MINIAPP_DATA_MODE
    delete process.env.ORCH_API_BASE_URL
    delete process.env.ORCH_API_TOKEN
    delete process.env.RESULT_V2_ENABLED
    delete process.env.ARTIFACT_INDEXING_ENABLED
    delete process.env.SEARCH_ENDPOINT_ENABLED
    delete process.env.LEGACY_STDOUT_CAP_BYTES
  })

  it('v1 task returns result with stdout/stderr and no artifacts', async () => {
    mockOrchGetTask.mockResolvedValue(v1Task)
    const task = await getTask('v1-old-task', 0)
    expect(task).not.toBeNull()
    expect(task!.result).toEqual({
      stdout: 'All done. Tests pass.',
      stderr: '',
      truncated: false,
      exitCode: 0,
      durationMs: 5000,
    })
    expect(task!.resultVersion).toBeUndefined()
    expect(task!.artifacts).toBeUndefined()
  })

  it('v1 task display uses v1_stdout source', async () => {
    mockOrchGetTask.mockResolvedValue(v1Task)
    const display = await getTaskDisplay('v1-old-task', 0)
    expect(display).not.toBeNull()
    expect(display!.resultSource).toBe('v1_stdout')
    expect(display!.displayOutput).toBe('All done. Tests pass.')
    expect(display!.obs.compression_ratio).toBe(1)
  })

  it('v1 task does not trigger artifact indexing', async () => {
    mockOrchGetTask.mockResolvedValue(v1Task)
    await getTask('v1-old-task', 0)
    const indexed = getIndexedArtifacts('v1-old-task')
    expect(indexed).toEqual([])
  })
})

describe('Phase 3: v2 result integration', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'orch'
    process.env.ORCH_API_BASE_URL = 'http://localhost:9999'
    process.env.ORCH_API_TOKEN = 'test-token'
    resetCache()
    vi.clearAllMocks()
    const db = new Database(':memory:')
    setDb(db)
  })

  afterEach(() => {
    closeDb()
    delete process.env.MINIAPP_DATA_MODE
    delete process.env.ORCH_API_BASE_URL
    delete process.env.ORCH_API_TOKEN
    delete process.env.RESULT_V2_ENABLED
    delete process.env.ARTIFACT_INDEXING_ENABLED
  })

  it('v2 task maps artifacts correctly', async () => {
    mockOrchGetTask.mockResolvedValue(v2Task)
    const task = await getTask('v2-new-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBe(2)
    expect(task!.artifacts).toHaveLength(2)
    expect(task!.artifacts![0].name).toBe('stdout.txt')
    expect(task!.artifacts![1].name).toBe('report.md')
  })

  it('v2 task triggers artifact indexing', async () => {
    mockOrchGetTask.mockResolvedValue(v2Task)
    await getTask('v2-new-task', 0)
    const indexed = getIndexedArtifacts('v2-new-task')
    expect(indexed).toHaveLength(2)
    expect(indexed.map(a => a.name).sort()).toEqual(['report.md', 'stdout.txt'])
  })

  it('v2 task display prefers summary over raw stdout', async () => {
    mockOrchGetTask.mockResolvedValue(v2Task)
    const display = await getTaskDisplay('v2-new-task', 0)
    expect(display).not.toBeNull()
    expect(display!.resultSource).toBe('v2_summary')
    expect(display!.displayOutput).toContain('Full task output summary')
    expect(display!.displayOutput).toContain('All tests passed')
    expect(display!.obs.raw_output_bytes).toBeGreaterThan(0)
    expect(display!.obs.summary_bytes).toBeGreaterThan(0)
  })

  it('repeated getTask does not re-index (idempotent)', async () => {
    mockOrchGetTask.mockResolvedValue(v2Task)
    await getTask('v2-new-task', 0)
    await getTask('v2-new-task', 0)
    const indexed = getIndexedArtifacts('v2-new-task')
    expect(indexed).toHaveLength(2)
  })
})

describe('Phase 3: feature flags', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'orch'
    process.env.ORCH_API_BASE_URL = 'http://localhost:9999'
    process.env.ORCH_API_TOKEN = 'test-token'
    resetCache()
    vi.clearAllMocks()
    const db = new Database(':memory:')
    setDb(db)
  })

  afterEach(() => {
    closeDb()
    delete process.env.MINIAPP_DATA_MODE
    delete process.env.ORCH_API_BASE_URL
    delete process.env.ORCH_API_TOKEN
    delete process.env.RESULT_V2_ENABLED
    delete process.env.ARTIFACT_INDEXING_ENABLED
    delete process.env.SEARCH_ENDPOINT_ENABLED
    delete process.env.LEGACY_STDOUT_CAP_BYTES
  })

  it('defaults all flags to enabled', () => {
    const flags = getFeatureFlags()
    expect(flags.resultV2Enabled).toBe(true)
    expect(flags.artifactIndexingEnabled).toBe(true)
    expect(flags.searchEndpointEnabled).toBe(true)
    expect(flags.legacyStdoutCapBytes).toBe(64 * 1024)
  })

  it('respects RESULT_V2_ENABLED=false', async () => {
    process.env.RESULT_V2_ENABLED = 'false'
    mockOrchGetTask.mockResolvedValue(v2Task)
    const display = await getTaskDisplay('v2-new-task', 0)
    // Should fall back to v1 stdout even though task has v2 data
    expect(display!.resultSource).toBe('v1_stdout')
  })

  it('ARTIFACT_INDEXING_ENABLED=false skips indexing', async () => {
    process.env.ARTIFACT_INDEXING_ENABLED = 'false'
    mockOrchGetTask.mockResolvedValue(v2Task)
    await getTask('v2-new-task', 0)
    const indexed = getIndexedArtifacts('v2-new-task')
    expect(indexed).toEqual([])
  })

  it('LEGACY_STDOUT_CAP_BYTES truncates v1 output', async () => {
    process.env.RESULT_V2_ENABLED = 'false'
    process.env.LEGACY_STDOUT_CAP_BYTES = '10'
    const bigV1: OrchTask = {
      ...v1Task,
      output: { stdout: 'A'.repeat(100), stderr: '', truncated: false },
    }
    mockOrchGetTask.mockResolvedValue(bigV1)
    const display = await getTaskDisplay('v1-old-task', 0)
    expect(display!.displayOutput).toBe('A'.repeat(10) + '\n[truncated]')
  })

  it('getTaskDisplay returns none source for task with no result', async () => {
    const noResult: OrchTask = {
      ...v1Task,
      status: 'progress',
      output: undefined,
      meta: {},
    }
    mockOrchGetTask.mockResolvedValue(noResult)
    const display = await getTaskDisplay('v1-old-task', 0)
    expect(display!.resultSource).toBe('none')
    expect(display!.displayOutput).toBe('')
  })
})

describe('Phase 3: orch-api v2 result contract round-trip', () => {
  beforeEach(() => {
    process.env.MINIAPP_DATA_MODE = 'orch'
    process.env.ORCH_API_BASE_URL = 'http://localhost:9999'
    process.env.ORCH_API_TOKEN = 'test-token'
    resetCache()
    vi.clearAllMocks()
    const db = new Database(':memory:')
    setDb(db)
  })

  afterEach(() => {
    closeDb()
    delete process.env.MINIAPP_DATA_MODE
    delete process.env.ORCH_API_BASE_URL
    delete process.env.ORCH_API_TOKEN
    delete process.env.RESULT_V2_ENABLED
    delete process.env.ARTIFACT_INDEXING_ENABLED
  })

  it('v2 result with resultVersion and artifacts round-trips via getTask', async () => {
    mockOrchGetTask.mockResolvedValue(v2Task)
    const task = await getTask('v2-new-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBe(2)
    expect(task!.artifacts).toHaveLength(2)
    expect(task!.artifacts![0]).toEqual({
      name: 'stdout.txt',
      kind: 'stdout',
      path: 'data/artifacts/v2-new-task/stdout.txt',
      bytes: 16384,
      sha256: 'abc123def456',
      preview: 'Full task output summary with details about implementation...',
    })
    expect(task!.artifacts![1]).toEqual({
      name: 'report.md',
      kind: 'markdown',
      path: 'data/artifacts/v2-new-task/report.md',
      bytes: 4096,
      sha256: 'def789ghi012',
      preview: '## Summary\nAll tests passed. Code quality improved.',
    })
    // v1 result field also present alongside v2
    expect(task!.result).toEqual({
      stdout: 'truncated inline...',
      stderr: '',
      truncated: true,
      exitCode: 0,
      durationMs: 12000,
    })
  })

  it('v1 result payload persists without v2 fields', async () => {
    mockOrchGetTask.mockResolvedValue(v1Task)
    const task = await getTask('v1-old-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBeUndefined()
    expect(task!.artifacts).toBeUndefined()
    expect(task!.result).toEqual({
      stdout: 'All done. Tests pass.',
      stderr: '',
      truncated: false,
      exitCode: 0,
      durationMs: 5000,
    })
  })

  it('v2 result with empty artifacts array yields no artifacts on task', async () => {
    const emptyArtifacts: OrchTask = {
      ...v2Task,
      artifacts: [],
    }
    mockOrchGetTask.mockResolvedValue(emptyArtifacts)
    const task = await getTask('v2-new-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBe(2)
    expect(task!.artifacts).toBeUndefined() // empty array not mapped
  })

  it('v2 result with null artifacts yields no artifacts on task', async () => {
    const nullArtifacts: OrchTask = {
      ...v2Task,
      artifacts: null,
    }
    mockOrchGetTask.mockResolvedValue(nullArtifacts)
    const task = await getTask('v2-new-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBe(2)
    expect(task!.artifacts).toBeUndefined()
  })

  it('v2 result with missing artifacts field yields no artifacts on task', async () => {
    const noArtifacts: OrchTask = {
      ...v2Task,
      artifacts: undefined,
    }
    mockOrchGetTask.mockResolvedValue(noArtifacts)
    const task = await getTask('v2-new-task', 0)
    expect(task).not.toBeNull()
    expect(task!.resultVersion).toBe(2)
    expect(task!.artifacts).toBeUndefined()
  })

  it('v2 result with single artifact round-trips correctly', async () => {
    const singleArtifact: OrchTask = {
      ...v2Task,
      artifacts: [v2Task.artifacts![0]],
    }
    mockOrchGetTask.mockResolvedValue(singleArtifact)
    const task = await getTask('v2-new-task', 0)
    expect(task!.artifacts).toHaveLength(1)
    expect(task!.artifacts![0].name).toBe('stdout.txt')
  })
})
