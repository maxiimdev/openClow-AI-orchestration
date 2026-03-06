import { getTask } from '../../../../lib/data-source'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')

  const task = await getTask(id!, auth.userId)
  if (!task) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  return task
})
