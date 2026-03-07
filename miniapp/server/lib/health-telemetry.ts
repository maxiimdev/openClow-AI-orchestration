/**
 * Runtime health telemetry for miniapp server.
 *
 * Tracks: SSE connection state, polling fallback events,
 * stale-data windows, cache hit/miss, API latency,
 * and generates concise operator health reports.
 */

import { getCacheSize } from './task-cache'
import { getDataMode } from './data-source'
import { getFeatureFlags } from './feature-flags'

// ── Telemetry counters ────────────────────────────────────────────────────

interface TelemetryState {
  bootedAt: number
  sseConnectionsTotal: number
  sseDisconnectsTotal: number
  sseCurrentConnections: number
  pollingFallbacksTotal: number
  apiRequestsTotal: number
  apiErrorsTotal: number
  apiLatencySamples: number[]
  cacheHits: number
  cacheMisses: number
  lastHealthCheck: number
  degradations: Degradation[]
}

interface Degradation {
  what: string
  why: string
  when: string
}

const state: TelemetryState = {
  bootedAt: Date.now(),
  sseConnectionsTotal: 0,
  sseDisconnectsTotal: 0,
  sseCurrentConnections: 0,
  pollingFallbacksTotal: 0,
  apiRequestsTotal: 0,
  apiErrorsTotal: 0,
  apiLatencySamples: [],
  cacheHits: 0,
  cacheMisses: 0,
  lastHealthCheck: 0,
  degradations: [],
}

/** Max latency samples retained (rolling window) */
const MAX_LATENCY_SAMPLES = 200

// ── Recording functions ──────────────────────────────────────────────────

export function recordSSEConnect() {
  state.sseConnectionsTotal++
  state.sseCurrentConnections++
  clearDegradation('sse_down')
}

export function recordSSEDisconnect() {
  state.sseDisconnectsTotal++
  state.sseCurrentConnections = Math.max(0, state.sseCurrentConnections - 1)
  if (state.sseCurrentConnections === 0) {
    addDegradation('sse_down', 'All SSE connections lost — clients fall back to polling')
  }
}

export function recordPollingFallback() {
  state.pollingFallbacksTotal++
  addDegradation('polling_fallback', 'Client entered polling fallback after SSE retries exhausted')
}

export function recordAPIRequest(latencyMs: number, error: boolean) {
  state.apiRequestsTotal++
  if (error) state.apiErrorsTotal++

  state.apiLatencySamples.push(latencyMs)
  if (state.apiLatencySamples.length > MAX_LATENCY_SAMPLES) {
    state.apiLatencySamples.shift()
  }

  // Degrade if error rate exceeds 10% over last 50 requests
  const recent = Math.min(50, state.apiRequestsTotal)
  if (state.apiErrorsTotal / recent > 0.1 && state.apiRequestsTotal >= 10) {
    addDegradation('api_errors_high', `API error rate elevated: ${state.apiErrorsTotal} errors / ${state.apiRequestsTotal} total`)
  }
}

export function recordCacheHit() { state.cacheHits++ }
export function recordCacheMiss() { state.cacheMisses++ }

// ── Degradation tracking ─────────────────────────────────────────────────

function addDegradation(what: string, why: string) {
  // Deduplicate by `what`
  const existing = state.degradations.findIndex(d => d.what === what)
  const entry: Degradation = { what, why, when: new Date().toISOString() }
  if (existing >= 0) {
    state.degradations[existing] = entry
  } else {
    state.degradations.push(entry)
  }
}

function clearDegradation(what: string) {
  state.degradations = state.degradations.filter(d => d.what !== what)
}

// ── Health report ────────────────────────────────────────────────────────

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime_seconds: number
  data_mode: string
  feature_flags: Record<string, unknown>
  sse: {
    connections_total: number
    disconnects_total: number
    current_connections: number
    polling_fallbacks_total: number
  }
  api: {
    requests_total: number
    errors_total: number
    error_rate_pct: number
    latency_p50_ms: number
    latency_p95_ms: number
    latency_p99_ms: number
  }
  cache: {
    size: number
    hits: number
    misses: number
    hit_rate_pct: number
  }
  degradations: Degradation[]
  checked_at: string
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

export function getHealthReport(): HealthReport {
  state.lastHealthCheck = Date.now()

  const sortedLatency = [...state.apiLatencySamples].sort((a, b) => a - b)
  const totalCacheOps = state.cacheHits + state.cacheMisses

  const errorRate = state.apiRequestsTotal > 0
    ? (state.apiErrorsTotal / state.apiRequestsTotal) * 100
    : 0

  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
  if (state.degradations.length > 0) status = 'degraded'
  if (errorRate > 25 || state.sseCurrentConnections === 0 && state.sseConnectionsTotal > 0) {
    status = state.degradations.length > 2 ? 'unhealthy' : 'degraded'
  }

  return {
    status,
    uptime_seconds: Math.round((Date.now() - state.bootedAt) / 1000),
    data_mode: getDataMode(),
    feature_flags: getFeatureFlags() as unknown as Record<string, unknown>,
    sse: {
      connections_total: state.sseConnectionsTotal,
      disconnects_total: state.sseDisconnectsTotal,
      current_connections: state.sseCurrentConnections,
      polling_fallbacks_total: state.pollingFallbacksTotal,
    },
    api: {
      requests_total: state.apiRequestsTotal,
      errors_total: state.apiErrorsTotal,
      error_rate_pct: Math.round(errorRate * 100) / 100,
      latency_p50_ms: percentile(sortedLatency, 50),
      latency_p95_ms: percentile(sortedLatency, 95),
      latency_p99_ms: percentile(sortedLatency, 99),
    },
    cache: {
      size: getCacheSize(),
      hits: state.cacheHits,
      misses: state.cacheMisses,
      hit_rate_pct: totalCacheOps > 0 ? Math.round((state.cacheHits / totalCacheOps) * 10000) / 100 : 0,
    },
    degradations: [...state.degradations],
    checked_at: new Date().toISOString(),
  }
}

/** Reset all telemetry (for testing) */
export function resetTelemetry() {
  state.bootedAt = Date.now()
  state.sseConnectionsTotal = 0
  state.sseDisconnectsTotal = 0
  state.sseCurrentConnections = 0
  state.pollingFallbacksTotal = 0
  state.apiRequestsTotal = 0
  state.apiErrorsTotal = 0
  state.apiLatencySamples = []
  state.cacheHits = 0
  state.cacheMisses = 0
  state.lastHealthCheck = 0
  state.degradations = []
}
