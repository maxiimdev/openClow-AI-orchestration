// User-facing status values
export type UserStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'review_pass'
  | 'review_fail'
  | 'escalated'
  | 'at_risk'

// Internal worker status values
export type WorkerStatus =
  | 'claimed'
  | 'started'
  | 'progress'
  | 'keepalive'
  | 'risk'
  | 'context_reset'
  | 'review_loop_fail'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'rejected'
  | 'needs_input'
  | 'review_pass'
  | 'review_fail'
  | 'escalated'

export type StatusCategory = 'active' | 'final' | 'blocked'

export interface Finding {
  id: string
  severity: 'critical' | 'major' | 'minor'
  file: string
  issue: string
  risk: string
  required_fix: string
  acceptance_check: string
}

export interface Artifact {
  name: string
  kind: string
  path: string
  bytes: number
  sha256: string
  preview: string
}

export interface Task {
  id: string
  userId: number
  mode: string
  status: UserStatus
  internalStatus: WorkerStatus
  branch: string
  repoPath: string
  createdAt: string
  updatedAt: string
  message: string
  meta: Record<string, unknown>
  instructions?: string
  question?: string | null
  options?: string[] | null
  needsInputAt?: string | null
  reviewFindings?: string | null
  structuredFindings?: Finding[] | null
  result?: {
    stdout: string
    stderr: string
    truncated: boolean
    exitCode: number
    durationMs: number
  } | null
  resultVersion?: number
  artifacts?: Artifact[] | null
}

export interface TaskEvent {
  id: string
  taskId: string
  status: WorkerStatus
  phase: string
  message: string
  meta: Record<string, unknown>
  createdAt: string
}

export interface TasksResponse {
  tasks: Task[]
  total: number
}

export interface EventsResponse {
  events: TaskEvent[]
}

export interface AuthResponse {
  token: string
  user: { id: number; firstName: string; username: string }
}

export interface SSEMessage {
  taskId: string
  status: WorkerStatus
  phase: string
  message: string
  meta: Record<string, unknown>
  updatedAt: string
}

export interface ReviewDiffSummary {
  previousIteration: number
  currentIteration: number
  findingsResolved: Finding[]
  findingsRemaining: Finding[]
  findingsNew: Finding[]
}
