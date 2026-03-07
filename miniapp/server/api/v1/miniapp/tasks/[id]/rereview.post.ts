import { requestReReview } from '../../../../../lib/data-source'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const id = getRouterParam(event, 'id')

  try {
    const result = await requestReReview(id!, auth.userId)
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: 'Task not found' })
    }
    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'task_not_eligible_for_rereview') {
      throw createError({ statusCode: 409, statusMessage: 'task_not_eligible_for_rereview' })
    }
    throw err
  }
})
