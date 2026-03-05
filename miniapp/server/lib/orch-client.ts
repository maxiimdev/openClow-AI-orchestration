/**
 * Orch-API HTTP adapter client.
 *
 * Endpoints used (v0.3.0 contract):
 *   GET  /api/task/:taskId      — fetch single task (includes events array)
 *   POST /api/task/resume       — resume a needs_input task
 *
 * NOT available (documented limitation):
 *   GET /api/tasks              — no list endpoint
 *   GET /api/task/:taskId/events — events are inline in task response
 */

interface OrchClientConfig {
  baseUrl: string
  token: string
  timeoutMs?: number
}

export interface OrchTask {
  taskId: string
  mode: string
  status: string
  scope?: { repoPath?: string; branch?: string }
  instructions?: string
  question?: string | null
  options?: string[] | null
  needsInputAt?: string | null
  pendingAnswer?: string | null
  reviewFindings?: string | null
  structuredFindings?: Array<{
    id: string
    severity: string
    file: string
    issue: string
    risk: string
    required_fix: string
    acceptance_check: string
  }> | null
  output?: {
    stdout: string
    stderr: string
    truncated: boolean
  } | null
  meta?: Record<string, unknown>
  events?: OrchEvent[]
  createdAt?: string
  updatedAt?: string
}

export interface OrchEvent {
  id?: string
  taskId: string
  workerId?: string
  status: string
  phase: string
  message: string
  meta?: Record<string, unknown>
  createdAt?: string
}

export interface OrchResumeResponse {
  ok: boolean
  task?: OrchTask
}

let _config: OrchClientConfig | null = null

export function configureOrchClient(config: OrchClientConfig) {
  _config = config
}

function getConfig(): OrchClientConfig {
  if (_config) return _config

  const baseUrl = process.env.ORCH_API_BASE_URL
  const token = process.env.ORCH_API_TOKEN
  if (!baseUrl || !token) {
    throw new Error('ORCH_API_BASE_URL and ORCH_API_TOKEN are required in orch mode')
  }
  return { baseUrl, token, timeoutMs: 15_000 }
}

async function orchFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cfg = getConfig()
  const url = `${cfg.baseUrl}${path}`

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`orch-api ${res.status}: ${text.slice(0, 300)}`)
  }

  return res.json() as Promise<T>
}

/** GET /api/task/:taskId — returns full task with inline events array */
export async function orchGetTask(taskId: string): Promise<OrchTask> {
  return orchFetch<OrchTask>('GET', `/api/task/${encodeURIComponent(taskId)}`)
}

/** POST /api/task/resume — resume a needs_input task with user answer */
export async function orchResumeTask(taskId: string, answer: string): Promise<OrchResumeResponse> {
  return orchFetch<OrchResumeResponse>('POST', '/api/task/resume', { taskId, answer })
}
