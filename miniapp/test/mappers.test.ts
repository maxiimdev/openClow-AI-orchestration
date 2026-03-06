import { describe, it, expect } from 'vitest'
import {
  mapWorkerStatus,
  getStatusCategory,
  getStatusLabel,
  getStatusColor,
  formatRelativeTime,
  truncateId,
} from '../app/lib/mappers'

describe('mapWorkerStatus', () => {
  it('maps active statuses to running', () => {
    expect(mapWorkerStatus('claimed')).toBe('running')
    expect(mapWorkerStatus('started')).toBe('running')
    expect(mapWorkerStatus('progress')).toBe('running')
    expect(mapWorkerStatus('keepalive')).toBe('running')
    expect(mapWorkerStatus('context_reset')).toBe('running')
    expect(mapWorkerStatus('review_loop_fail')).toBe('running')
  })

  it('maps risk to at_risk', () => {
    expect(mapWorkerStatus('risk')).toBe('at_risk')
  })

  it('maps terminal statuses correctly', () => {
    expect(mapWorkerStatus('completed')).toBe('completed')
    expect(mapWorkerStatus('failed')).toBe('failed')
    expect(mapWorkerStatus('timeout')).toBe('failed')
    expect(mapWorkerStatus('rejected')).toBe('failed')
    expect(mapWorkerStatus('needs_input')).toBe('needs_input')
    expect(mapWorkerStatus('review_pass')).toBe('review_pass')
    expect(mapWorkerStatus('review_fail')).toBe('review_fail')
    expect(mapWorkerStatus('escalated')).toBe('escalated')
  })

  it('returns running for unknown status', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mapWorkerStatus('unknown' as any)).toBe('running')
  })
})

describe('getStatusCategory', () => {
  it('categorizes active statuses', () => {
    expect(getStatusCategory('running')).toBe('active')
    expect(getStatusCategory('at_risk')).toBe('active')
  })

  it('categorizes final statuses', () => {
    expect(getStatusCategory('completed')).toBe('final')
    expect(getStatusCategory('failed')).toBe('final')
    expect(getStatusCategory('review_pass')).toBe('final')
    expect(getStatusCategory('review_fail')).toBe('final')
    expect(getStatusCategory('escalated')).toBe('final')
  })

  it('categorizes blocked statuses', () => {
    expect(getStatusCategory('needs_input')).toBe('blocked')
  })
})

describe('getStatusLabel', () => {
  it('returns human-readable labels', () => {
    expect(getStatusLabel('running')).toBe('Running')
    expect(getStatusLabel('needs_input')).toBe('Awaiting Input')
    expect(getStatusLabel('review_pass')).toBe('Review Passed')
    expect(getStatusLabel('at_risk')).toBe('At Risk')
    expect(getStatusLabel('escalated')).toBe('Escalated')
  })
})

describe('getStatusColor', () => {
  it('returns correct colors', () => {
    expect(getStatusColor('running')).toBe('blue')
    expect(getStatusColor('completed')).toBe('green')
    expect(getStatusColor('failed')).toBe('red')
    expect(getStatusColor('needs_input')).toBe('amber')
    expect(getStatusColor('at_risk')).toBe('orange')
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps (< 5s)', () => {
    const justNow = new Date(Date.now() - 1000).toISOString()
    expect(formatRelativeTime(justNow)).toBe('just now')
  })

  it('returns "just now" for 0s diff instead of "0s ago"', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('formats seconds', () => {
    const recent = new Date(Date.now() - 30000).toISOString()
    expect(formatRelativeTime(recent)).toBe('30s ago')
  })

  it('formats minutes', () => {
    const fiveMin = new Date(Date.now() - 300000).toISOString()
    expect(formatRelativeTime(fiveMin)).toBe('5m ago')
  })

  it('formats hours', () => {
    const twoHrs = new Date(Date.now() - 7200000).toISOString()
    expect(formatRelativeTime(twoHrs)).toBe('2h ago')
  })

  it('formats days', () => {
    const twoDays = new Date(Date.now() - 172800000).toISOString()
    expect(formatRelativeTime(twoDays)).toBe('2d ago')
  })
})

describe('truncateId', () => {
  it('truncates long IDs', () => {
    expect(truncateId('task-001-auth-refactor')).toBe('task-001-aut…')
  })

  it('keeps short IDs', () => {
    expect(truncateId('task-001')).toBe('task-001')
  })

  it('supports custom length', () => {
    expect(truncateId('task-001-auth-refactor', 8)).toBe('task-001…')
  })
})
