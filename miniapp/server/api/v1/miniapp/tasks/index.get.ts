import { listTasks } from '../../../../lib/data-source'
import { recordAPIRequest } from '../../../../lib/health-telemetry'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const query = getQuery(event)

  const statusFilter = query.status
    ? String(query.status).split(',')
    : undefined

  const t0 = Date.now()
  let error = false
  try {
    return await listTasks({ userId: auth.userId, statusFilter })
  } catch (err) {
    error = true
    throw err
  } finally {
    recordAPIRequest(Date.now() - t0, error)
  }
})
