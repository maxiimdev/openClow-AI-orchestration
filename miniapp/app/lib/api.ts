import type { TasksResponse, Task, EventsResponse, AuthResponse } from './types'

const BASE = '/api/v1/miniapp'

function getToken(): string | null {
  if (import.meta.server) return null
  return localStorage.getItem('miniapp_token')
}

function clearStoredAuth() {
  if (import.meta.client) {
    localStorage.removeItem('miniapp_token')
    localStorage.removeItem('miniapp_user')
  }
}

/**
 * Try to obtain a fresh token via Telegram WebApp initData.
 * Returns the new token on success, null otherwise.
 */
async function tryAutoLogin(): Promise<string | null> {
  if (import.meta.server) return null
  const tg = (window as Record<string, unknown>).Telegram as
    | { WebApp?: { initData?: string } }
    | undefined
  const initData = tg?.WebApp?.initData
  if (!initData) return null

  try {
    const res = await fetch(`${BASE}/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
    if (!res.ok) return null
    const data: AuthResponse = await res.json()
    localStorage.setItem('miniapp_token', data.token)
    localStorage.setItem('miniapp_user', JSON.stringify(data.user))
    return data.token
  } catch {
    return null
  }
}

let _autoLoginPromise: Promise<string | null> | null = null

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...opts, headers })

  // On 401, attempt auto-login once and retry
  if (res.status === 401 && import.meta.client) {
    clearStoredAuth()
    // Deduplicate concurrent auto-login attempts
    if (!_autoLoginPromise) {
      _autoLoginPromise = tryAutoLogin().finally(() => { _autoLoginPromise = null })
    }
    const freshToken = await _autoLoginPromise
    if (freshToken) {
      headers['Authorization'] = `Bearer ${freshToken}`
      const retry = await fetch(`${BASE}${path}`, { ...opts, headers })
      if (!retry.ok) {
        const body = await retry.text().catch(() => '')
        throw new Error(`API ${retry.status}: ${body}`)
      }
      return retry.json()
    }
    // Auto-login failed — propagate original error
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }

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

export function requestReReview(id: string): Promise<{ ok: boolean; task: Task }> {
  return apiFetch(`/tasks/${encodeURIComponent(id)}/rereview`, { method: 'POST', body: '{}' })
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
