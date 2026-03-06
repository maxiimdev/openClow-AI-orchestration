/**
 * POST /api/v1/miniapp/tasks/:id/search
 *
 * Full-text search over indexed task artifacts.
 * Body: { query: string, limit?: number }
 * Returns: { results: SearchResult[] }
 */

import { getTask } from '../../../../../lib/data-source'
import { searchTaskArtifacts } from '../../../../../lib/indexer'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const taskId = getRouterParam(event, 'id')!

  const task = await getTask(taskId, auth.userId)
  if (!task) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  const body = await readBody<{ query?: string; limit?: number }>(event)

  if (!body?.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'query is required' })
  }

  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50)

  const results = searchTaskArtifacts(taskId, body.query.trim(), limit)

  return { results }
})
