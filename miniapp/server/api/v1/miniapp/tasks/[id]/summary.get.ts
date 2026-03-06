/**
 * GET /api/v1/miniapp/tasks/:id/summary
 *
 * Returns compact task summary with proof info and artifact list.
 */

import { getTask } from '../../../../../lib/data-source'
import { getIndexedArtifacts } from '../../../../../lib/indexer'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const taskId = getRouterParam(event, 'id')!

  const task = await getTask(taskId, auth.userId)
  if (!task) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  // Build compact summary
  const summary = {
    id: task.id,
    mode: task.mode,
    status: task.status,
    branch: task.branch,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }

  // Proof info from result
  const proof = task.result
    ? {
        exitCode: task.result.exitCode,
        durationMs: task.result.durationMs,
        truncated: task.result.truncated,
      }
    : null

  // Artifact list — prefer indexed artifacts, fall back to task.artifacts
  const indexedArtifacts = getIndexedArtifacts(taskId)
  const artifacts = indexedArtifacts.length > 0
    ? indexedArtifacts
    : (task.artifacts || []).map(a => ({
        name: a.name,
        kind: a.kind,
        path: a.path,
        bytes: a.bytes,
        preview: a.preview,
      }))

  return {
    summary,
    proof,
    artifacts,
    indexed: indexedArtifacts.length > 0,
  }
})
