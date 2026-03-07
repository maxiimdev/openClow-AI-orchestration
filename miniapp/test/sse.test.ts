import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SSEClient, backoffWithJitter } from '../app/lib/sse'
import type { SSEState } from '../app/lib/sse'

// Mock EventSource
type EventHandler = (...args: unknown[]) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners: Record<string, EventHandler> = {}
  onopen: EventHandler | null = null
  onerror: EventHandler | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: EventHandler) {
    this.listeners[type] = fn
  }

  close() {
    this.closed = true
  }

  // Helpers for testing
  simulateOpen() { this.onopen?.({}) }
  simulateError() { this.onerror?.({}) }
  simulateMessage(type: string, data: Record<string, unknown>, id?: string) {
    this.listeners[type]?.({ data: JSON.stringify(data), lastEventId: id || '' })
  }
}

const mockGetTicket = () => Promise.resolve('test-ticket')

beforeEach(() => {
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
})

describe('SSEClient', () => {
  it('connects using ticket and reports connected state', async () => {
    const states: SSEState[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
    })

    await client.connect()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('/stream')
    expect(MockEventSource.instances[0].url).toContain('ticket=test-ticket')
    expect(MockEventSource.instances[0].url).not.toContain('token=')

    MockEventSource.instances[0].simulateOpen()
    expect(states).toContain('connected')
  })

  it('passes messages to onMessage callback', async () => {
    const messages: unknown[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: (msg) => messages.push(msg),
    })

    await client.connect()
    const es = MockEventSource.instances[0]
    es.simulateOpen()
    es.simulateMessage('task_update', { taskId: 'task-1', status: 'progress' }, 'evt-1')

    expect(messages).toHaveLength(1)
    expect((messages[0] as { taskId: string }).taskId).toBe('task-1')
  })

  it('calls onHeartbeat on heartbeat events', async () => {
    const heartbeats: boolean[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onHeartbeat: () => heartbeats.push(true),
    })

    await client.connect()
    MockEventSource.instances[0].simulateOpen()
    MockEventSource.instances[0].simulateMessage('heartbeat', {})
    expect(heartbeats).toHaveLength(1)
  })

  it('calls onResetRequired on reset_required event', async () => {
    let resetCalled = false
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onResetRequired: () => { resetCalled = true },
    })

    await client.connect()
    MockEventSource.instances[0].simulateOpen()
    MockEventSource.instances[0].simulateMessage('reset_required', {})
    expect(resetCalled).toBe(true)
  })

  it('reconnects on error with backoff', async () => {
    vi.useFakeTimers()
    const states: SSEState[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
      maxRetries: 3,
    })

    await client.connect()
    MockEventSource.instances[0].simulateError()
    expect(states).toContain('reconnecting')

    // After 1250ms (base 1000 + max 25% jitter), should trigger reconnect
    await vi.advanceTimersByTimeAsync(1250)
    expect(MockEventSource.instances).toHaveLength(2)

    vi.useRealTimers()
  })

  it('falls back to polling after max retries', async () => {
    vi.useFakeTimers()
    const states: SSEState[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
      maxRetries: 2,
    })

    await client.connect()
    // Fail 3 times (exceeds maxRetries of 2)
    MockEventSource.instances[0].simulateError()
    await vi.advanceTimersByTimeAsync(1250) // base 1000 + 25% jitter
    MockEventSource.instances[1].simulateError()
    await vi.advanceTimersByTimeAsync(2500) // base 2000 + 25% jitter
    MockEventSource.instances[2].simulateError()

    expect(states[states.length - 1]).toBe('polling')
    vi.useRealTimers()
  })

  it('disconnects cleanly', async () => {
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
    })

    await client.connect()
    client.disconnect()
    expect(MockEventSource.instances[0].closed).toBe(true)
    expect(client.state).toBe('disconnected')
  })

  it('sends lastEventId on reconnect', async () => {
    vi.useFakeTimers()
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      maxRetries: 3,
    })

    await client.connect()
    const es = MockEventSource.instances[0]
    es.simulateOpen()
    es.simulateMessage('task_update', { taskId: 't1', status: 'progress' }, 'evt-42')

    // Trigger reconnect
    es.simulateError()
    await vi.advanceTimersByTimeAsync(2000)

    const reconnectedUrl = MockEventSource.instances[1].url
    expect(reconnectedUrl).toContain('lastEventId=evt-42')
    vi.useRealTimers()
  })

  it('recovers from polling mode after pollingRecoveryMs', async () => {
    vi.useFakeTimers()
    const states: SSEState[] = []
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
      maxRetries: 0, // fail immediately to polling
      pollingRecoveryMs: 5000,
    })

    await client.connect()
    MockEventSource.instances[0].simulateError()
    expect(states[states.length - 1]).toBe('polling')

    // After pollingRecoveryMs, should retry SSE connection
    await vi.advanceTimersByTimeAsync(5000)
    const recoveryInstance = MockEventSource.instances[MockEventSource.instances.length - 1]
    expect(recoveryInstance).toBeDefined()
    expect(recoveryInstance.closed).toBe(false)

    // Simulate successful reconnection
    recoveryInstance.simulateOpen()
    expect(states[states.length - 1]).toBe('connected')

    vi.useRealTimers()
  })

  it('does not attempt recovery after disconnect', async () => {
    vi.useFakeTimers()
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      maxRetries: 0,
      pollingRecoveryMs: 1000,
    })

    await client.connect()
    MockEventSource.instances[0].simulateError() // enters polling
    const countBefore = MockEventSource.instances.length
    client.disconnect()
    await vi.advanceTimersByTimeAsync(2000) // recovery timer fires but should be cleared
    expect(MockEventSource.instances.length).toBe(countBefore) // no new EventSource

    vi.useRealTimers()
  })

  it('disables polling recovery when pollingRecoveryMs is 0', async () => {
    vi.useFakeTimers()
    const client = new SSEClient({
      url: '/stream',
      getTicket: mockGetTicket,
      onMessage: () => {},
      maxRetries: 0,
      pollingRecoveryMs: 0,
    })

    await client.connect()
    MockEventSource.instances[0].simulateError()
    const countAfterPolling = MockEventSource.instances.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockEventSource.instances.length).toBe(countAfterPolling)

    vi.useRealTimers()
  })

  it('falls back to polling when getTicket fails', async () => {
    const states: SSEState[] = []
    let ticketCallCount = 0
    const failingGetTicket = () => {
      ticketCallCount++
      return Promise.reject(new Error('auth failed'))
    }

    vi.useFakeTimers()
    const client = new SSEClient({
      url: '/stream',
      getTicket: failingGetTicket,
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
      maxRetries: 1,
    })

    // First attempt — ticket fails
    await client.connect()
    expect(states).toContain('reconnecting')

    // Retry — ticket fails again, exceeds maxRetries
    await vi.advanceTimersByTimeAsync(1250)
    expect(states[states.length - 1]).toBe('polling')
    expect(ticketCallCount).toBe(2)
    expect(MockEventSource.instances).toHaveLength(0) // No EventSource created

    vi.useRealTimers()
  })
})

describe('backoffWithJitter', () => {
  it('returns value >= base delay for attempt 1', () => {
    for (let i = 0; i < 20; i++) {
      const delay = backoffWithJitter(1, 1000, 30000)
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThanOrEqual(1250) // base + 25% jitter
    }
  })

  it('increases delay exponentially', () => {
    // attempt 3 base = 4000, even with jitter should be ≥ 4000
    const d3 = backoffWithJitter(3, 1000, 30000)
    expect(d3).toBeGreaterThanOrEqual(4000)
  })

  it('caps at maximum delay', () => {
    for (let i = 0; i < 20; i++) {
      const delay = backoffWithJitter(100, 1000, 30000)
      // cap is 30000, jitter adds up to 25% → max 37500
      expect(delay).toBeLessThanOrEqual(37500)
      expect(delay).toBeGreaterThanOrEqual(30000)
    }
  })

  it('always returns an integer', () => {
    for (let i = 1; i <= 10; i++) {
      expect(Number.isInteger(backoffWithJitter(i))).toBe(true)
    }
  })
})
