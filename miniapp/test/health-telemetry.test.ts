import { describe, it, expect, beforeEach } from 'vitest'
import {
  getHealthReport,
  resetTelemetry,
  recordSSEConnect,
  recordSSEDisconnect,
  recordPollingFallback,
  recordAPIRequest,
  recordCacheHit,
  recordCacheMiss,
} from '../server/lib/health-telemetry'

beforeEach(() => {
  resetTelemetry()
})

describe('health-telemetry', () => {
  it('returns healthy status with no activity', () => {
    const report = getHealthReport()
    expect(report.status).toBe('healthy')
    expect(report.uptime_seconds).toBeGreaterThanOrEqual(0)
    expect(report.sse.connections_total).toBe(0)
    expect(report.api.requests_total).toBe(0)
    expect(report.cache.size).toBeGreaterThanOrEqual(0)
    expect(report.degradations).toEqual([])
    expect(report.checked_at).toBeTruthy()
  })

  it('tracks SSE connections and disconnections', () => {
    recordSSEConnect()
    recordSSEConnect()
    let report = getHealthReport()
    expect(report.sse.connections_total).toBe(2)
    expect(report.sse.current_connections).toBe(2)
    expect(report.status).toBe('healthy')

    recordSSEDisconnect()
    recordSSEDisconnect()
    report = getHealthReport()
    expect(report.sse.disconnects_total).toBe(2)
    expect(report.sse.current_connections).toBe(0)
    // All connections lost after having had connections → degraded
    expect(report.status).toBe('degraded')
  })

  it('tracks polling fallback as degradation', () => {
    recordPollingFallback()
    const report = getHealthReport()
    expect(report.sse.polling_fallbacks_total).toBe(1)
    expect(report.degradations.some(d => d.what === 'polling_fallback')).toBe(true)
    expect(report.status).toBe('degraded')
  })

  it('computes API latency percentiles', () => {
    // Record various latencies
    for (let i = 1; i <= 100; i++) {
      recordAPIRequest(i, false)
    }
    const report = getHealthReport()
    expect(report.api.requests_total).toBe(100)
    expect(report.api.errors_total).toBe(0)
    expect(report.api.error_rate_pct).toBe(0)
    expect(report.api.latency_p50_ms).toBe(50)
    expect(report.api.latency_p95_ms).toBe(95)
    expect(report.api.latency_p99_ms).toBe(99)
  })

  it('tracks cache hit/miss rates', () => {
    recordCacheHit()
    recordCacheHit()
    recordCacheHit()
    recordCacheMiss()
    const report = getHealthReport()
    expect(report.cache.hits).toBe(3)
    expect(report.cache.misses).toBe(1)
    expect(report.cache.hit_rate_pct).toBe(75)
  })

  it('marks degraded on high API error rate', () => {
    // 5 errors out of 10 requests = 50% error rate
    for (let i = 0; i < 5; i++) recordAPIRequest(10, true)
    for (let i = 0; i < 5; i++) recordAPIRequest(10, false)
    const report = getHealthReport()
    expect(report.api.error_rate_pct).toBe(50)
    expect(report.degradations.some(d => d.what === 'api_errors_high')).toBe(true)
  })

  it('clears SSE degradation on reconnect', () => {
    recordSSEConnect()
    recordSSEDisconnect()
    let report = getHealthReport()
    expect(report.degradations.some(d => d.what === 'sse_down')).toBe(true)

    recordSSEConnect()
    report = getHealthReport()
    expect(report.degradations.some(d => d.what === 'sse_down')).toBe(false)
  })

  it('includes data_mode and feature_flags', () => {
    const report = getHealthReport()
    expect(report.data_mode).toBeTruthy()
    expect(report.feature_flags).toBeTruthy()
  })

  it('deduplicates degradation entries by what', () => {
    recordPollingFallback()
    recordPollingFallback()
    recordPollingFallback()
    const report = getHealthReport()
    const pfEntries = report.degradations.filter(d => d.what === 'polling_fallback')
    expect(pfEntries.length).toBe(1)
  })
})
