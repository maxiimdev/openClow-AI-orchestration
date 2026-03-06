import { resumeTask } from '../../../../../lib/data-source'

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

  try {
    const result = await resumeTask(id!, answer, auth.userId)
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: 'Task not found' })
    }
    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'task_not_awaiting_input') {
      throw createError({ statusCode: 409, statusMessage: 'task_not_awaiting_input' })
    }
    throw err
  }
})
