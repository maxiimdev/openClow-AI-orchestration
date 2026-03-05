import type { WorkerStatus, UserStatus, StatusCategory } from './types'

const STATUS_MAP: Record<WorkerStatus, UserStatus> = {
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

const CATEGORY_MAP: Record<UserStatus, StatusCategory> = {
  running: 'active',
  at_risk: 'active',
  completed: 'final',
  failed: 'final',
  review_pass: 'final',
  review_fail: 'final',
  escalated: 'final',
  needs_input: 'blocked',
}

const DISPLAY_LABELS: Record<UserStatus, string> = {
  running: 'Running',
  at_risk: 'At Risk',
  completed: 'Completed',
  failed: 'Failed',
  needs_input: 'Awaiting Input',
  review_pass: 'Review Passed',
  review_fail: 'Review Failed',
  escalated: 'Escalated',
}

const STATUS_COLORS: Record<UserStatus, string> = {
  running: 'blue',
  at_risk: 'orange',
  completed: 'green',
  failed: 'red',
  needs_input: 'amber',
  review_pass: 'green',
  review_fail: 'orange',
  escalated: 'red',
}

export function mapWorkerStatus(status: WorkerStatus): UserStatus {
  return STATUS_MAP[status] ?? 'running'
}

export function getStatusCategory(status: UserStatus): StatusCategory {
  return CATEGORY_MAP[status] ?? 'active'
}

export function getStatusLabel(status: UserStatus): string {
  return DISPLAY_LABELS[status] ?? status
}

export function getStatusColor(status: UserStatus): string {
  return STATUS_COLORS[status] ?? 'gray'
}

export function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

export function truncateId(id: string, len = 12): string {
  return id.length > len ? id.slice(0, len) + '…' : id
}
