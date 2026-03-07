/**
 * Unified data source — delegates to mock or orch based on MINIAPP_DATA_MODE.
 *
 * MINIAPP_DATA_MODE=mock  → in-memory mock data (default)
 * MINIAPP_DATA_MODE=orch  → live orch-api via orch-client + mapper
 */

import type { Task, TaskEvent } from '../../app/lib/types'
import { mockTasks, mockEvents } from './mock-data'
import { orchGetTask, orchResumeTask } from './orch-client'
import { mapOrchTask, mapOrchEvents } from './orch-mapper'
import { trackTaskId, getKnownTaskIds, removeTaskId, hasKnownTasks } from './task-cache'
import { getFeatureFlags } from './feature-flags'
import { indexTaskArtifacts } from './indexer'
import { log } from './logger'

export type DataMode = 'mock' | 'orch'

export function getDataMode(): DataMode {
  const mode = process.env.MINIAPP_DATA_MODE || 'mock'
  if (mode !== 'mock' && mode !== 'orch') return 'mock'
  return mode
}

function isOrch(): boolean {
  return getDataMode() === 'orch'
}

// ── LIST TASKS ─────────────────────────────────────────────────────────────

export interface ListTasksOptions {
  userId: number
  statusFilter?: string[]
}

export interface ListTasksResult {
  tasks: Task[]
  total: number
  /** Present in orch mode when no list endpoint is available */
  notice?: string
  /** Count of tasks that failed to fetch (non-404 errors) in orch mode */
  fetchErrors?: number
}

/** Max concurrent orch-api fetches during list assembly */
const LIST_FETCH_CONCURRENCY = 10

async function fetchWithConcurrencyLimit<T>(
  items: string[],
  fn: (id: string) => Promise<T>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) }
      } catch (reason) {
        results[idx] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export async function listTasks(opts: ListTasksOptions): Promise<ListTasksResult> {
  if (!isOrch()) {
    let tasks = mockTasks.filter(t => t.userId === opts.userId)
    if (opts.statusFilter?.length) {
      tasks = tasks.filter(t => opts.statusFilter!.includes(t.status))
    }
    return { tasks, total: tasks.length }
  }

  // Orch mode: hybrid list via local cache
  if (!hasKnownTasks()) {
    return {
      tasks: [],
      total: 0,
      notice: 'No tasks in local cache. Task list endpoint unavailable in orch-api v0.3.0. View a task by ID to populate the cache.',
    }
  }

  const ids = getKnownTaskIds()
  const results: Task[] = []
  let fetchErrors = 0

  // Fetch each known task with concurrency limit; drop 404s from cache
  const settled = await fetchWithConcurrencyLimit(
    ids,
    async (id) => {
      const orch = await orchGetTask(id)
      return mapOrchTask(orch)
    },
    LIST_FETCH_CONCURRENCY,
  )

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      results.push(s.value)
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      if (msg.includes('404')) {
        removeTaskId(ids[i])
      } else {
        fetchErrors++
        log('warn', 'listTasks fetch error', { taskId: ids[i], error: msg })
      }
    }
  }

  // Sort by updatedAt descending for deterministic ordering
  results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  let tasks = results
  if (opts.statusFilter?.length) {
    tasks = tasks.filter(t => opts.statusFilter!.includes(t.status))
  }

  return {
    tasks,
    total: tasks.length,
    ...(fetchErrors > 0 ? { fetchErrors } : {}),
    notice: 'List assembled from local task cache. Full listing requires GET /api/tasks (not yet available in orch-api v0.3.0).',
  }
}

// ── GET TASK ───────────────────────────────────────────────────────────────

export async function getTask(taskId: string, userId: number): Promise<Task | null> {
  if (!isOrch()) {
    const task = mockTasks.find(t => t.id === taskId)
    if (!task || task.userId !== userId) return null
    return task
  }

  try {
    const orch = await orchGetTask(taskId)
    trackTaskId(taskId) // remember for list cache
    const task = mapOrchTask(orch)
    tryIndexArtifacts(task)
    return task
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404')) return null
    throw err
  }
}

// ── ARTIFACT INDEXING ─────────────────────────────────────────────────────

/**
 * Best-effort artifact indexing: if the task has v2 artifacts and indexing
 * is enabled, index them using preview content (full content requires
 * a file-serving endpoint on orch-api, not yet available).
 */
function tryIndexArtifacts(task: Task): void {
  const flags = getFeatureFlags()
  if (!flags.resultV2Enabled || !flags.artifactIndexingEnabled) return
  if (!task.artifacts?.length) return

  try {
    const result = indexTaskArtifacts(task.id, task.artifacts, (a) => a.preview)
    log('info', 'artifacts indexed', {
      taskId: task.id,
      indexed_chunks_count: result.totalChunks,
      artifact_count: result.indexed,
    })
  } catch (err) {
    log('warn', 'artifact indexing failed', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── GET TASK DISPLAY ──────────────────────────────────────────────────────

export interface TaskDisplay {
  task: Task
  /** Preferred output: v2 summary when available, v1 stdout fallback */
  displayOutput: string
  /** Which result version was used */
  resultSource: 'v2_summary' | 'v1_stdout' | 'none'
  /** Observability fields */
  obs: {
    raw_output_bytes: number
    summary_bytes: number
    compression_ratio: number
  }
}

/**
 * Get task with v2-preferred display output. Consumer-facing reads
 * should use this instead of raw getTask for notification content.
 */
export async function getTaskDisplay(taskId: string, userId: number): Promise<TaskDisplay | null> {
  const task = await getTask(taskId, userId)
  if (!task) return null

  const flags = getFeatureFlags()

  // v2 summary: use artifact preview concatenation as display output
  if (flags.resultV2Enabled && task.resultVersion === 2 && task.artifacts?.length) {
    const summary = task.artifacts
      .map(a => a.preview)
      .filter(Boolean)
      .join('\n---\n')

    const rawBytes = task.result
      ? Buffer.byteLength(task.result.stdout + task.result.stderr, 'utf8')
      : 0
    const summaryBytes = Buffer.byteLength(summary, 'utf8')

    return {
      task,
      displayOutput: summary,
      resultSource: 'v2_summary',
      obs: {
        raw_output_bytes: rawBytes,
        summary_bytes: summaryBytes,
        compression_ratio: rawBytes > 0 ? summaryBytes / rawBytes : 1,
      },
    }
  }

  // v1 fallback: raw stdout, capped if configured
  const stdout = task.result?.stdout ?? ''
  const cap = flags.legacyStdoutCapBytes
  const capped = stdout.length > cap ? stdout.slice(0, cap) + '\n[truncated]' : stdout
  const rawBytes = Buffer.byteLength(stdout, 'utf8')

  return {
    task,
    displayOutput: capped,
    resultSource: stdout ? 'v1_stdout' : 'none',
    obs: {
      raw_output_bytes: rawBytes,
      summary_bytes: Buffer.byteLength(capped, 'utf8'),
      compression_ratio: 1,
    },
  }
}

// ── GET EVENTS ─────────────────────────────────────────────────────────────

export async function getTaskEvents(taskId: string, userId: number): Promise<TaskEvent[] | null> {
  if (!isOrch()) {
    const task = mockTasks.find(t => t.id === taskId)
    if (!task || task.userId !== userId) return null
    return mockEvents[taskId] || []
  }

  // In orch mode, events are inline in the task response
  try {
    const orch = await orchGetTask(taskId)
    trackTaskId(taskId)
    return mapOrchEvents(orch)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404')) return null
    throw err
  }
}

// ── REQUEST RE-REVIEW ─────────────────────────────────────────────────────

export interface ReReviewResult {
  ok: boolean
  task: Task
}

export async function requestReReview(taskId: string, userId: number): Promise<ReReviewResult | null> {
  if (!isOrch()) {
    const task = mockTasks.find(t => t.id === taskId)
    if (!task || task.userId !== userId) return null

    if (task.status !== 'review_fail' && task.status !== 'escalated') {
      throw new Error('task_not_eligible_for_rereview')
    }

    // Mock: transition to running (simulates re-review being queued)
    task.status = 'running'
    task.internalStatus = 'progress'
    task.message = 'Re-review requested'
    task.updatedAt = new Date().toISOString()
    return { ok: true, task }
  }

  // Orch mode: verify eligibility, then POST re-review request
  try {
    const orch = await orchGetTask(taskId)
    trackTaskId(taskId)

    if (orch.status !== 'review_fail' && orch.status !== 'escalated') {
      throw new Error('task_not_eligible_for_rereview')
    }

    // Forward to orch API re-review endpoint
    const res = await orchResumeTask(taskId, '__rereview__')
    if (!res.ok) {
      throw new Error('orch re-review returned ok:false')
    }

    const updated = await orchGetTask(taskId)
    return { ok: true, task: mapOrchTask(updated) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404')) return null
    throw err
  }
}

// ── RESUME TASK ────────────────────────────────────────────────────────────

export interface ResumeResult {
  ok: boolean
  task: Task
}

export async function resumeTask(taskId: string, answer: string, userId: number): Promise<ResumeResult | null> {
  if (!isOrch()) {
    const task = mockTasks.find(t => t.id === taskId)
    if (!task || task.userId !== userId) return null

    if (task.status !== 'needs_input') {
      throw new Error('task_not_awaiting_input')
    }

    // Mock: mutate in-memory
    task.status = 'running'
    task.internalStatus = 'progress'
    task.message = `Resumed with answer: ${answer}`
    task.question = null
    task.options = null
    task.needsInputAt = null
    return { ok: true, task }
  }

  // Orch mode: verify task exists and is needs_input, then forward resume
  try {
    const orch = await orchGetTask(taskId)
    trackTaskId(taskId)

    if (orch.status !== 'needs_input') {
      throw new Error('task_not_awaiting_input')
    }

    const res = await orchResumeTask(taskId, answer)
    if (!res.ok) {
      throw new Error('orch resume returned ok:false')
    }

    // Re-fetch to get updated state
    const updated = await orchGetTask(taskId)
    return { ok: true, task: mapOrchTask(updated) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('404')) return null
    throw err
  }
}
