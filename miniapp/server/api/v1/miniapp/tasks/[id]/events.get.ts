import { mockTasks, mockEvents } from '../../../../../lib/mock-data'

export default defineEventHandler((event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')

  // User-scoped: verify task ownership before returning events
  const task = mockTasks.find(t => t.id === id)
  if (!task || task.userId !== auth.userId) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  const events = mockEvents[id!] || []
  return { events }
})
