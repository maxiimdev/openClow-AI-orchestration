/**
 * Maps orch-api task schema → miniapp Task / TaskEvent schema.
 *
 * Key differences:
 *   - Orch uses `taskId`, miniapp uses `id`
 *   - Orch uses `scope.repoPath` / `scope.branch`, miniapp uses flat `repoPath` / `branch`
 *   - Orch status values are WorkerStatus (internal), miniapp exposes both
 *   - Orch events are inline in task.events[], miniapp expects separate EventsResponse
 *   - Orch has no userId — miniapp assigns a placeholder (see MVP visibility policy)
 */

import type { Task, TaskEvent, UserStatus, WorkerStatus, Artifact } from '../../app/lib/types'
import type { OrchTask, OrchEvent } from './orch-client'

const WORKER_TO_USER_STATUS: Record<string, UserStatus> = {
  claimed: 'running',
  started: 'running',
  progress: 'running',
  keepalive: 'running',
  context_reset: 'running',
  review_loop_fail: 'running',
  risk: 'at_risk',
  completed: 'completed',
  failed: 'failed',
  timeout: 'failed',
  rejected: 'failed',
  needs_input: 'needs_input',
  review_pass: 'review_pass',
  review_fail: 'review_fail',
  escalated: 'escalated',
}

function mapStatus(orchStatus: string): UserStatus {
  return WORKER_TO_USER_STATUS[orchStatus] ?? 'running'
}

/** Stable fallback timestamp: derive from earliest event or use epoch */
function fallbackTimestamp(orch: OrchTask): string {
  if (orch.events?.length) {
    const first = orch.events[0]
    if (first.createdAt) return first.createdAt
  }
  return '1970-01-01T00:00:00Z'
}

/**
 * Map an orch-api task to the miniapp Task interface.
 *
 * MVP visibility policy: The orch-api has no per-user ownership.
 * All tasks are visible to all authenticated miniapp users.
 * A placeholder userId=0 is assigned. When the orch-api adds user
 * ownership (e.g., via `createdBy`), this mapper should read it.
 */
export function mapOrchTask(orch: OrchTask): Task {
  if (!orch.taskId) throw new Error('orch-mapper: taskId is required')
  if (!orch.mode) throw new Error('orch-mapper: mode is required')

  const userStatus = mapStatus(orch.status)

  const task: Task = {
    id: orch.taskId,
    userId: 0, // MVP: no per-user ownership in orch-api
    mode: orch.mode,
    status: userStatus,
    internalStatus: orch.status as WorkerStatus,
    branch: orch.scope?.branch ?? '',
    repoPath: orch.scope?.repoPath ?? '',
    createdAt: orch.createdAt ?? fallbackTimestamp(orch),
    updatedAt: orch.updatedAt ?? orch.createdAt ?? fallbackTimestamp(orch),
    message: latestMessage(orch),
    meta: orch.meta ?? {},
  }

  if (orch.instructions) task.instructions = orch.instructions
  if (orch.question !== undefined) task.question = orch.question
  if (orch.options !== undefined) task.options = orch.options
  if (orch.needsInputAt !== undefined) task.needsInputAt = orch.needsInputAt

  if (orch.reviewFindings) task.reviewFindings = orch.reviewFindings
  if (orch.structuredFindings?.length) {
    task.structuredFindings = orch.structuredFindings.map(f => ({
      id: f.id,
      severity: f.severity as 'critical' | 'major' | 'minor',
      file: f.file,
      issue: f.issue,
      risk: f.risk,
      required_fix: f.required_fix,
      acceptance_check: f.acceptance_check,
    }))
  }

  if (orch.output) {
    task.result = {
      stdout: orch.output.stdout,
      stderr: orch.output.stderr,
      truncated: orch.output.truncated,
      exitCode: (orch.meta?.exitCode as number) ?? 0,
      durationMs: (orch.meta?.durationMs as number) ?? 0,
    }
  }

  // v2 result fields — pass through when present
  if (orch.resultVersion) task.resultVersion = orch.resultVersion
  if (orch.artifacts?.length) {
    task.artifacts = orch.artifacts.map((a): Artifact => ({
      name: a.name,
      kind: a.kind,
      path: a.path,
      bytes: a.bytes,
      sha256: a.sha256,
      preview: a.preview,
    }))
  }

  return task
}

/** Extract a human-readable message from the orch task's latest event or meta */
function latestMessage(orch: OrchTask): string {
  if (orch.events?.length) {
    const last = orch.events[orch.events.length - 1]
    if (last.message) return last.message
  }
  if (orch.status === 'needs_input') return 'Waiting for user input'
  if (orch.status === 'completed') return 'Task completed'
  if (orch.status === 'failed' || orch.status === 'timeout') return 'Task failed'
  if (orch.status === 'review_pass') return 'Review passed'
  if (orch.status === 'review_fail') return 'Review failed'
  if (orch.status === 'escalated') return 'Escalated'
  return `Status: ${orch.status}`
}

/** Map an orch-api event to the miniapp TaskEvent interface */
export function mapOrchEvent(ev: OrchEvent, index: number): TaskEvent {
  return {
    id: ev.id ?? `evt-${index}`,
    taskId: ev.taskId,
    status: ev.status as WorkerStatus,
    phase: ev.phase ?? '',
    message: ev.message ?? '',
    meta: ev.meta ?? {},
    createdAt: ev.createdAt ?? '1970-01-01T00:00:00Z',
  }
}

/** Extract TaskEvent[] from an orch task's inline events array */
export function mapOrchEvents(orch: OrchTask): TaskEvent[] {
  if (!orch.events?.length) return []
  return orch.events.map((ev, i) => mapOrchEvent(ev, i))
}
