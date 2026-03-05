import { mockTasks } from '../../../../lib/mock-data'

export default defineEventHandler((event) => {
  const auth = event.context.auth!
  const query = getQuery(event)

  // User-scoped: only return tasks owned by the authenticated user
  let tasks = mockTasks.filter(t => t.userId === auth.userId)

  if (query.status) {
    const statuses = String(query.status).split(',')
    tasks = tasks.filter(t => statuses.includes(t.status))
  }

  return { tasks, total: tasks.length }
})
