import type { SSEMessage } from './types'

/** Exponential backoff with jitter: base * 2^(attempt-1) + random jitter up to 25% */
export function backoffWithJitter(attempt: number, base = 1000, cap = 30000): number {
  const exponential = Math.min(base * Math.pow(2, attempt - 1), cap)
  const jitter = exponential * 0.25 * Math.random()
  return Math.round(exponential + jitter)
}

export interface SSEClientOptions {
  url: string
  getTicket: () => Promise<string>
  onMessage: (msg: SSEMessage) => void
  onHeartbeat?: () => void
  onResetRequired?: () => void
  onStateChange?: (state: SSEState) => void
  maxRetries?: number
  /** Interval (ms) to periodically retry SSE after falling back to polling (default 60000) */
  pollingRecoveryMs?: number
}

export type SSEState = 'connected' | 'reconnecting' | 'disconnected' | 'polling'

export class SSEClient {
  private es: EventSource | null = null
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private lastEventId = ''
  private opts: Required<SSEClientOptions>
  private _state: SSEState = 'disconnected'
  private disposed = false

  constructor(opts: SSEClientOptions) {
    this.opts = { maxRetries: 3, pollingRecoveryMs: 60_000, onHeartbeat: () => {}, onResetRequired: () => {}, onStateChange: () => {}, ...opts }
  }

  get state() { return this._state }

  async connect() {
    if (this.disposed) return
    this.cleanup()

    // Fetch a short-lived, single-use ticket for this SSE connection
    let ticket: string
    try {
      ticket = await this.opts.getTicket()
    } catch {
      // Ticket fetch failed — treat as connection error
      this.retryCount++
      if (this.retryCount > this.opts.maxRetries) {
        this.enterPollingMode()
        return
      }
      this.setState('reconnecting')
      const delay = backoffWithJitter(this.retryCount)
      this.retryTimer = setTimeout(() => this.connect(), delay)
      return
    }

    const url = new URL(this.opts.url, window.location.origin)
    url.searchParams.set('ticket', ticket)
    if (this.lastEventId) url.searchParams.set('lastEventId', this.lastEventId)

    const es = new EventSource(url.toString())
    this.es = es

    es.addEventListener('task_update', (e: MessageEvent) => {
      this.retryCount = 0
      if (e.lastEventId) this.lastEventId = e.lastEventId
      try {
        const msg: SSEMessage = JSON.parse(e.data)
        this.opts.onMessage(msg)
      } catch { /* ignore parse errors */ }
    })

    es.addEventListener('heartbeat', () => {
      this.retryCount = 0
      this.opts.onHeartbeat!()
    })

    es.addEventListener('reset_required', () => {
      this.opts.onResetRequired!()
    })

    es.onopen = () => {
      this.retryCount = 0
      this.setState('connected')
    }

    es.onerror = () => {
      this.cleanup()
      this.retryCount++
      if (this.retryCount > this.opts.maxRetries) {
        this.enterPollingMode()
        return
      }
      this.setState('reconnecting')
      const delay = backoffWithJitter(this.retryCount)
      this.retryTimer = setTimeout(() => this.connect(), delay)
    }
  }

  disconnect() {
    this.disposed = true
    this.cleanup()
    this.setState('disconnected')
  }

  /** Enter polling fallback with periodic SSE recovery attempts */
  private enterPollingMode() {
    this.setState('polling')
    if (this.disposed || this.opts.pollingRecoveryMs <= 0) return
    this.recoveryTimer = setTimeout(() => {
      if (this.disposed) return
      this.retryCount = 0
      this.connect()
    }, this.opts.pollingRecoveryMs)
  }

  private cleanup() {
    if (this.es) {
      this.es.close()
      this.es = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }

  private setState(s: SSEState) {
    if (this._state !== s) {
      this._state = s
      this.opts.onStateChange!(s)
    }
  }
}
