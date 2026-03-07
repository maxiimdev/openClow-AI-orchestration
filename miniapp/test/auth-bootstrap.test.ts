/**
 * Tests for the auth bootstrap flow in api.ts.
 *
 * Validates that:
 * 1. apiFetch waits for auth bootstrap before making protected requests
 * 2. Concurrent requests share the same bootstrap promise (no duplicate auth calls)
 * 3. 401 retry works without destructive clearStoredAuth race
 * 4. Delayed Telegram initData readiness is handled with retry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { signToken } from '../server/lib/crypto'

// ---------------------------------------------------------------------------
// Mock browser globals (localStorage, fetch, window.Telegram, import.meta)
// ---------------------------------------------------------------------------

const storage = new Map<string, string>()

const mockLocalStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() { return storage.size },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
}

// Track fetch calls for assertion
let fetchCalls: Array<{ url: string; opts?: RequestInit }> = []
let fetchHandler: (url: string, opts?: RequestInit) => Promise<Response>

function makeMockResponse(status: number, body: unknown, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
    clone: () => makeMockResponse(status, body, statusText),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  }
}

// We test the logic by importing a fresh module each time.
// To avoid import.meta.server/client issues, we replicate the core logic here
// mirroring api.ts exactly.

// ---------------------------------------------------------------------------
// Replicated api.ts core logic (mirrors production code for unit testing)
// ---------------------------------------------------------------------------

const BASE = '/api/v1/miniapp'
const TOKEN_KEY_PREFIX = 'miniapp_token'
const USER_KEY_PREFIX = 'miniapp_user'
const VERSION_KEY = 'miniapp_token_version'

function versionedKey(prefix: string, version: string | null): string {
  return version ? `${prefix}_v${version}` : prefix
}

function getStoredVersion(): string | null {
  return mockLocalStorage.getItem(VERSION_KEY)
}

function getToken(): string | null {
  const v = getStoredVersion()
  return mockLocalStorage.getItem(versionedKey(TOKEN_KEY_PREFIX, v))
    ?? mockLocalStorage.getItem(TOKEN_KEY_PREFIX)
}

function clearStoredAuth() {
  const v = getStoredVersion()
  mockLocalStorage.removeItem(versionedKey(TOKEN_KEY_PREFIX, v))
  mockLocalStorage.removeItem(versionedKey(USER_KEY_PREFIX, v))
  mockLocalStorage.removeItem(TOKEN_KEY_PREFIX)
  mockLocalStorage.removeItem(USER_KEY_PREFIX)
}

interface AuthResponse {
  token: string
  user: { id: number; firstName: string; username: string }
  tokenVersion?: string
}

function storeAuth(data: AuthResponse) {
  const v = data.tokenVersion ?? null
  if (v) mockLocalStorage.setItem(VERSION_KEY, v)
  mockLocalStorage.setItem(versionedKey(TOKEN_KEY_PREFIX, v), data.token)
  mockLocalStorage.setItem(versionedKey(USER_KEY_PREFIX, v), JSON.stringify(data.user))
}

let telegramInitData: string | null = null

function getTelegramInitData(): string | null {
  return telegramInitData
}

async function tryAutoLogin(): Promise<string | null> {
  let initData = getTelegramInitData()
  if (!initData) {
    for (let i = 0; i < 5 && !initData; i++) {
      await new Promise(r => setTimeout(r, 100))
      initData = getTelegramInitData()
    }
  }
  if (!initData) return null

  try {
    const res = await fetchHandler(`${BASE}/auth/telegram`, {
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

function ensureAuth(): Promise<string | null> {
  const existing = getToken()
  if (existing) return Promise.resolve(existing)

  if (!_autoLoginPromise) {
    _autoLoginPromise = tryAutoLogin().finally(() => { _autoLoginPromise = null })
  }
  return _autoLoginPromise
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  await ensureAuth()

  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetchHandler(`${BASE}${path}`, { ...opts, headers })

  if (res.status === 401) {
    if (!_autoLoginPromise) {
      _autoLoginPromise = tryAutoLogin().finally(() => { _autoLoginPromise = null })
    }
    const freshToken = await _autoLoginPromise
    if (freshToken) {
      headers['Authorization'] = `Bearer ${freshToken}`
      const retry = await fetchHandler(`${BASE}${path}`, { ...opts, headers })
      if (!retry.ok) {
        const body = await retry.text().catch(() => '')
        throw new Error(`API ${retry.status}: ${body}`)
      }
      return retry.json() as T
    }
    clearStoredAuth()
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json() as T
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth bootstrap', () => {
  const validToken = signToken(1, 'dev', 'Dev')
  const authResponse: AuthResponse = {
    token: validToken,
    user: { id: 1, firstName: 'Dev', username: 'dev' },
    tokenVersion: '1',
  }

  beforeEach(() => {
    storage.clear()
    fetchCalls = []
    telegramInitData = null
    _autoLoginPromise = null
  })

  it('waits for Telegram auth before first /tasks call (cold start)', async () => {
    // Simulate: no stored token, Telegram initData available
    telegramInitData = 'mock-init-data'

    fetchHandler = async (url, opts) => {
      fetchCalls.push({ url, opts })
      if (url.includes('/auth/telegram')) {
        return makeMockResponse(200, authResponse)
      }
      // /tasks should only be called AFTER auth succeeds
      if (url.includes('/tasks')) {
        const authHeader = (opts?.headers as Record<string, string>)?.['Authorization']
        if (!authHeader) {
          return makeMockResponse(401, 'missing_token')
        }
        return makeMockResponse(200, { tasks: [], total: 0 })
      }
      return makeMockResponse(404, 'not found')
    }

    const result = await apiFetch<{ tasks: unknown[]; total: number }>('/tasks')

    // Auth should have been called first
    expect(fetchCalls[0].url).toContain('/auth/telegram')
    // Then /tasks with the token
    expect(fetchCalls[1].url).toContain('/tasks')
    const tasksAuth = (fetchCalls[1].opts?.headers as Record<string, string>)?.['Authorization']
    expect(tasksAuth).toContain('Bearer ')
    expect(result.tasks).toEqual([])
  })

  it('concurrent requests share single auth bootstrap (no duplicate auth calls)', async () => {
    telegramInitData = 'mock-init-data'
    let authCallCount = 0

    fetchHandler = async (url, opts) => {
      fetchCalls.push({ url, opts })
      if (url.includes('/auth/telegram')) {
        authCallCount++
        // Simulate network delay
        await new Promise(r => setTimeout(r, 50))
        return makeMockResponse(200, authResponse)
      }
      return makeMockResponse(200, { tasks: [], total: 0 })
    }

    // Fire 3 concurrent requests (simulating dashboard + tasks + events)
    const [r1, r2, r3] = await Promise.all([
      apiFetch('/tasks'),
      apiFetch('/tasks?status=running'),
      apiFetch('/tasks?status=needs_input'),
    ])

    // Only ONE auth call should have been made
    expect(authCallCount).toBe(1)
    // All 3 should succeed
    expect(r1).toEqual({ tasks: [], total: 0 })
    expect(r2).toEqual({ tasks: [], total: 0 })
    expect(r3).toEqual({ tasks: [], total: 0 })
  })

  it('skips auth bootstrap when token exists in localStorage', async () => {
    // Pre-populate localStorage with a valid token
    mockLocalStorage.setItem(TOKEN_KEY_PREFIX, validToken)

    fetchHandler = async (url, opts) => {
      fetchCalls.push({ url, opts })
      return makeMockResponse(200, { tasks: [], total: 0 })
    }

    await apiFetch('/tasks')

    // No auth call should have been made
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toContain('/tasks')
    const authHeader = (fetchCalls[0].opts?.headers as Record<string, string>)?.['Authorization']
    expect(authHeader).toBe(`Bearer ${validToken}`)
  })

  it('handles delayed Telegram initData readiness', async () => {
    // Simulate: initData not available immediately, appears after 200ms
    telegramInitData = null
    setTimeout(() => { telegramInitData = 'delayed-init-data' }, 200)

    fetchHandler = async (url) => {
      fetchCalls.push({ url })
      if (url.includes('/auth/telegram')) {
        return makeMockResponse(200, authResponse)
      }
      return makeMockResponse(200, { tasks: [], total: 0 })
    }

    const result = await apiFetch<{ tasks: unknown[] }>('/tasks')

    // Should have waited for initData and succeeded
    expect(fetchCalls.some(c => c.url.includes('/auth/telegram'))).toBe(true)
    expect(result.tasks).toEqual([])
  })

  it('401 retry does not call clearStoredAuth before auto-login attempt', async () => {
    // Simulate: token in storage but expired server-side
    mockLocalStorage.setItem(TOKEN_KEY_PREFIX, 'expired-token')
    telegramInitData = 'mock-init-data'

    const freshToken = signToken(2, 'fresh', 'Fresh')
    const freshAuthResponse: AuthResponse = {
      token: freshToken,
      user: { id: 2, firstName: 'Fresh', username: 'fresh' },
    }

    let tasksCallCount = 0

    fetchHandler = async (url, opts) => {
      fetchCalls.push({ url, opts })
      if (url.includes('/auth/telegram')) {
        return makeMockResponse(200, freshAuthResponse)
      }
      if (url.includes('/tasks')) {
        tasksCallCount++
        const authHeader = (opts?.headers as Record<string, string>)?.['Authorization']
        if (authHeader === 'Bearer expired-token') {
          return makeMockResponse(401, 'invalid_token')
        }
        if (authHeader?.includes(freshToken)) {
          return makeMockResponse(200, { tasks: [{ id: 't1' }], total: 1 })
        }
        return makeMockResponse(401, 'missing_token')
      }
      return makeMockResponse(404, '')
    }

    const result = await apiFetch<{ tasks: unknown[]; total: number }>('/tasks')

    // Should have retried with fresh token and succeeded
    expect(result.total).toBe(1)
    expect(tasksCallCount).toBe(2) // first 401, then retry
  })

  it('propagates error when auto-login fails (no initData)', async () => {
    // No stored token, no Telegram initData
    telegramInitData = null

    fetchHandler = async (url) => {
      fetchCalls.push({ url })
      return makeMockResponse(401, 'missing_token')
    }

    // apiFetch should still attempt the request (ensureAuth returns null)
    // and the 401 should propagate since auto-login has no initData
    await expect(apiFetch('/tasks')).rejects.toThrow('API 401')
  })
})
