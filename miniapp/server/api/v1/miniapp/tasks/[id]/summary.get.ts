/**
 * GET /api/v1/miniapp/tasks/:id/summary
 *
 * Returns compact task summary with proof info and artifact list.
 * Prefers v2 result data when available, falls back to v1 safely.
 */

import { getTaskDisplay } from '../../../../../lib/data-source'
import { getIndexedArtifacts } from '../../../../../lib/indexer'
import { getFeatureFlags } from '../../../../../lib/feature-flags'
import { log } from '../../../../../lib/logger'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth!
  const taskId = getRouterParam(event, 'id')!

  const display = await getTaskDisplay(taskId, auth.userId)
  if (!display) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }

  const { task, resultSource, obs } = display
  const flags = getFeatureFlags()

  // Build compact summary
  const summary = {
    id: task.id,
    mode: task.mode,
    status: task.status,
    branch: task.branch,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    resultVersion: task.resultVersion ?? 1,
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
  const indexedArtifacts = flags.artifactIndexingEnabled
    ? getIndexedArtifacts(taskId)
    : []
  const artifacts = indexedArtifacts.length > 0
    ? indexedArtifacts
    : (task.artifacts || []).map(a => ({
        name: a.name,
        kind: a.kind,
        path: a.path,
        bytes: a.bytes,
        preview: a.preview,
      }))

  log('info', 'summary served', {
    taskId,
    resultSource,
    raw_output_bytes: obs.raw_output_bytes,
    summary_bytes: obs.summary_bytes,
    compression_ratio: obs.compression_ratio,
    indexed_chunks_count: indexedArtifacts.length,
  })

  return {
    summary,
    proof,
    artifacts,
    indexed: indexedArtifacts.length > 0,
    resultSource,
  }
})
