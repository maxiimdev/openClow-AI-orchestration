import { mockTasks } from '../../../../lib/mock-data'

export default defineEventHandler((event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')

  const task = mockTasks.find(t => t.id === id)
  if (!task) throw createError({ statusCode: 404, statusMessage: 'Task not found' })

  // User-scoped: deny access to tasks owned by other users
  if (task.userId !== auth.userId) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  return task
})
