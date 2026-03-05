import type { TasksResponse, Task, EventsResponse, AuthResponse } from './types'

const BASE = '/api/v1/miniapp'

function getToken(): string | null {
  if (import.meta.server) return null
  return localStorage.getItem('miniapp_token')
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...opts, headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json()
}

export function fetchTasks(params?: { status?: string; limit?: number; offset?: number }): Promise<TasksResponse> {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.offset) q.set('offset', String(params.offset))
  const qs = q.toString()
  return apiFetch(`/tasks${qs ? '?' + qs : ''}`)
}

export function fetchTask(id: string): Promise<Task> {
  return apiFetch(`/tasks/${encodeURIComponent(id)}`)
}

export function fetchTaskEvents(id: string, params?: { limit?: number }): Promise<EventsResponse> {
  const q = new URLSearchParams()
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return apiFetch(`/tasks/${encodeURIComponent(id)}/events${qs ? '?' + qs : ''}`)
}

export function resumeTask(id: string, answer: string): Promise<{ ok: boolean; task: Task }> {
  return apiFetch(`/tasks/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  })
}

export function retryTask(id: string): Promise<{ ok: boolean; task: Task }> {
  return apiFetch(`/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' })
}

export function cancelTask(id: string): Promise<{ ok: boolean; task: Task }> {
  return apiFetch(`/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' })
}

export function authenticate(initData: string): Promise<AuthResponse> {
  return apiFetch('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  })
}

export function fetchStreamTicket(): Promise<{ ticket: string }> {
  return apiFetch('/stream/ticket', { method: 'POST' })
}
