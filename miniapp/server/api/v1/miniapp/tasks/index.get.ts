import { listTasks } from '../../../../lib/data-source'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const query = getQuery(event)

  const statusFilter = query.status
    ? String(query.status).split(',')
    : undefined

  return await listTasks({ userId: auth.userId, statusFilter })
})
