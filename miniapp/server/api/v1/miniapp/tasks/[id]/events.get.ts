import { getTaskEvents } from '../../../../../lib/data-source'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')

  const events = await getTaskEvents(id!, auth.userId)
  if (events === null) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  return { events }
})
