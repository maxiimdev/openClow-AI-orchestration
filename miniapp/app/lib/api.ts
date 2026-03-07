import type { TasksResponse, Task, EventsResponse, AuthResponse } from './types'

const BASE = '/api/v1/miniapp'

const TOKEN_KEY_PREFIX = 'miniapp_token'
const USER_KEY_PREFIX = 'miniapp_user'
const VERSION_KEY = 'miniapp_token_version'

function versionedKey(prefix: string, version: string | null): string {
  return version ? `${prefix}_v${version}` : prefix
}

function getStoredVersion(): string | null {
  if (import.meta.server) return null
  return localStorage.getItem(VERSION_KEY)
}

function getToken(): string | null {
  if (import.meta.server) return null
  const v = getStoredVersion()
  return localStorage.getItem(versionedKey(TOKEN_KEY_PREFIX, v))
    ?? localStorage.getItem(TOKEN_KEY_PREFIX) // legacy fallback
}

function clearStoredAuth() {
  if (!import.meta.client) return
  const v = getStoredVersion()
  localStorage.removeItem(versionedKey(TOKEN_KEY_PREFIX, v))
  localStorage.removeItem(versionedKey(USER_KEY_PREFIX, v))
  // Also remove legacy unversioned keys
  localStorage.removeItem(TOKEN_KEY_PREFIX)
  localStorage.removeItem(USER_KEY_PREFIX)
  // Notify Pinia store via custom event
  window.dispatchEvent(new CustomEvent('miniapp:auth-cleared'))
}

function storeAuth(data: AuthResponse) {
  if (!import.meta.client) return
  const v = data.tokenVersion ?? null
  if (v) {
    // Clean up old versioned keys
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if ((key.startsWith(TOKEN_KEY_PREFIX) || key.startsWith(USER_KEY_PREFIX)) &&
          key !== versionedKey(TOKEN_KEY_PREFIX, v) &&
          key !== versionedKey(USER_KEY_PREFIX, v) &&
          key !== VERSION_KEY) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) localStorage.removeItem(key)
    localStorage.setItem(VERSION_KEY, v)
  }
  localStorage.setItem(versionedKey(TOKEN_KEY_PREFIX, v), data.token)
  localStorage.setItem(versionedKey(USER_KEY_PREFIX, v), JSON.stringify(data.user))
  // Notify Pinia store via custom event
  window.dispatchEvent(new CustomEvent('miniapp:auth-updated', {
    detail: { token: data.token, user: data.user, tokenVersion: v },
  }))
}

function getTelegramInitData(): string | null {
  if (import.meta.server) return null
  const tg = (window as Record<string, unknown>).Telegram as
    | { WebApp?: { initData?: string } }
    | undefined
  return tg?.WebApp?.initData ?? null
}

/**
 * Try to obtain a fresh token via Telegram WebApp initData.
 * Returns the new token on success, null otherwise.
 */
async function tryAutoLogin(): Promise<string | null> {
  if (import.meta.server) return null

  // Telegram WebApp.initData may not be ready immediately on cold start.
  // Wait up to 500ms (5 x 100ms) for it to become available.
  let initData = getTelegramInitData()
  if (!initData) {
    for (let i = 0; i < 5 && !initData; i++) {
      await new Promise(r => setTimeout(r, 100))
      initData = getTelegramInitData()
    }
  }
  if (!initData) return null

  try {
    const res = await fetch(`${BASE}/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
    if (!res.ok) return null
    const data: AuthResponse = await res.json()
    storeAuth(data)
    return data.token
  } catch {
    return null
  }
}

let _autoLoginPromise: Promise<string | null> | null = null

/**
 * Auth bootstrap gate. Ensures a token is available (from localStorage or
 * Telegram auto-login) before any protected API call proceeds.
 * All concurrent callers share the same promise.
 */
function ensureAuth(): Promise<string | null> {
  if (import.meta.server) return Promise.resolve(null)

  // Fast path: token already in localStorage
  const existing = getToken()
  if (existing) return Promise.resolve(existing)

  // Deduplicate: all callers share one auto-login attempt
  if (!_autoLoginPromise) {
    _autoLoginPromise = tryAutoLogin().finally(() => { _autoLoginPromise = null })
  }
  return _autoLoginPromise
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  // Wait for auth bootstrap before making the request
  if (import.meta.client) {
    await ensureAuth()
  }

  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...opts, headers })

  // On 401, attempt auto-login once and retry (handles token expiry)
  if (res.status === 401 && import.meta.client) {
    // Don't clear auth before retry — avoids race with concurrent requests
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
    // Auto-login failed — clear stale auth and propagate error
    clearStoredAuth()
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
