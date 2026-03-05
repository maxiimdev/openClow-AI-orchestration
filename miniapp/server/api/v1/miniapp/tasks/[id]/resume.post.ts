import { mockTasks } from '../../../../../lib/mock-data'

const MAX_ANSWER_LENGTH = 5000

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)

  // Server-side answer validation
  if (!body || typeof body.answer !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'answer_must_be_string' })
  }

  const answer = body.answer.trim()

  if (answer.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'answer_cannot_be_empty' })
  }

  if (answer.length > MAX_ANSWER_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: 'answer_too_long' })
  }

  const task = mockTasks.find(t => t.id === id)
  if (!task) throw createError({ statusCode: 404, statusMessage: 'Task not found' })

  // User-scoped: deny access to tasks owned by other users
  if (task.userId !== auth.userId) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  if (task.status !== 'needs_input') {
    throw createError({ statusCode: 409, statusMessage: 'task_not_awaiting_input' })
  }

  // Mock: update task status
  task.status = 'running'
  task.internalStatus = 'progress'
  task.message = `Resumed with answer: ${answer}`
  task.question = null
  task.options = null
  task.needsInputAt = null

  return { ok: true, task }
})
