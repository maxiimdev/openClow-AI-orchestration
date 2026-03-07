import { redeemTicket } from '../../../lib/crypto'
import { mockTasks } from '../../../lib/mock-data'
import { recordSSEConnect, recordSSEDisconnect } from '../../../lib/health-telemetry'

let eventCounter = 100

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const ticket = query.ticket as string | undefined
  const _lastEventId = (query.lastEventId as string) || ''

  // Validate single-use ticket (replaces long-lived token in URL)
  if (!ticket) {
    throw createError({ statusCode: 401, statusMessage: 'missing_ticket' })
  }

  const userId = redeemTicket(ticket)
  if (userId === null) {
    throw createError({ statusCode: 401, statusMessage: 'invalid_or_expired_ticket' })
  }

  const { res } = event.node

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  recordSSEConnect()

  // Send initial heartbeat
  res.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)

  // Simulate task_update events every 10s for running tasks owned by this user
  const updateInterval = setInterval(() => {
    const running = mockTasks.find((t) => t.userId === userId && t.status === 'running')
    if (running) {
      eventCounter++
      const evtId = `evt-${eventCounter}`
      const data = JSON.stringify({
        taskId: running.id,
        status: running.internalStatus,
        phase: 'claude',
        message: `Progress update (${evtId})`,
        meta: {},
        updatedAt: new Date().toISOString(),
      })
      res.write(`id: ${evtId}\nevent: task_update\ndata: ${data}\n\n`)
    }
  }, 10000)

  // Send heartbeat every 30s
  const heartbeatInterval = setInterval(() => {
    res.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)
  }, 30000)

  event.node.req.on('close', () => {
    clearInterval(updateInterval)
    clearInterval(heartbeatInterval)
    recordSSEDisconnect()
  })
})
