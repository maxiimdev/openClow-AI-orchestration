/**
 * Artifact indexer — stores artifact metadata and FTS5 chunks in SQLite.
 */

import type { Artifact } from '../../app/lib/types'
import { getDb } from './search-db'
import { chunkContent } from './chunker'

export interface IndexArtifactInput {
  taskId: string
  artifact: Artifact
  /** Full text content of the artifact (preview is only a snippet). */
  content: string
}

/**
 * Index a single artifact: insert metadata row + FTS5 chunks.
 * Uses a transaction for atomicity. Skips if already indexed (same task_id + name).
 */
export function indexArtifact(input: IndexArtifactInput): { artifactId: number; chunkCount: number } {
  const db = getDb()

  const existing = db.prepare(
    'SELECT id FROM artifacts WHERE task_id = ? AND name = ?',
  ).get(input.taskId, input.artifact.name) as { id: number } | undefined

  if (existing) {
    // Already indexed — return existing
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM fts_chunk_meta WHERE artifact_id = ?',
    ).get(existing.id) as { cnt: number }
    return { artifactId: existing.id, chunkCount: count.cnt }
  }

  const chunks = chunkContent(input.content, input.artifact.kind)

  const result = db.transaction(() => {
    const insertArtifact = db.prepare(`
      INSERT INTO artifacts (task_id, name, kind, path, bytes, sha256, preview)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const res = insertArtifact.run(
      input.taskId,
      input.artifact.name,
      input.artifact.kind,
      input.artifact.path,
      input.artifact.bytes,
      input.artifact.sha256,
      input.artifact.preview,
    )

    const artifactId = Number(res.lastInsertRowid)

    const insertMeta = db.prepare(`
      INSERT INTO fts_chunk_meta (artifact_id, section, body, chunk_index)
      VALUES (?, ?, ?, ?)
    `)

    const insertFts = db.prepare(`
      INSERT INTO fts_chunks (rowid, artifact_id, section, body)
      VALUES (?, ?, ?, ?)
    `)

    for (const chunk of chunks) {
      const metaRes = insertMeta.run(artifactId, chunk.section, chunk.body, chunk.index)
      const rowid = Number(metaRes.lastInsertRowid)
      insertFts.run(rowid, String(artifactId), chunk.section, chunk.body)
    }

    return { artifactId, chunkCount: chunks.length }
  })()

  return result
}

/**
 * Index all artifacts for a task. Accepts the artifact list + a content resolver
 * that provides the full text for each artifact.
 */
export function indexTaskArtifacts(
  taskId: string,
  artifacts: Artifact[],
  contentResolver: (artifact: Artifact) => string,
): { indexed: number; totalChunks: number } {
  let indexed = 0
  let totalChunks = 0

  for (const artifact of artifacts) {
    const content = contentResolver(artifact)
    const result = indexArtifact({ taskId, artifact, content })
    indexed++
    totalChunks += result.chunkCount
  }

  return { indexed, totalChunks }
}

// ── Query ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  artifactName: string
  artifactKind: string
  section: string
  snippet: string
  rank: number
}

/**
 * Search indexed artifacts for a task using FTS5 MATCH.
 * Returns ranked snippets with artifact context.
 */
export function searchTaskArtifacts(
  taskId: string,
  query: string,
  limit: number = 10,
): SearchResult[] {
  const db = getDb()

  const rows = db.prepare(`
    SELECT
      a.name   AS artifact_name,
      a.kind   AS artifact_kind,
      m.section,
      snippet(fts_chunks, 2, '<mark>', '</mark>', '...', 32) AS snippet,
      fts_chunks.rank
    FROM fts_chunks
    JOIN fts_chunk_meta m ON m.rowid = fts_chunks.rowid
    JOIN artifacts a ON a.id = m.artifact_id
    WHERE a.task_id = ?
      AND fts_chunks MATCH ?
    ORDER BY fts_chunks.rank
    LIMIT ?
  `).all(taskId, query, limit) as Array<{
    artifact_name: string
    artifact_kind: string
    section: string
    snippet: string
    rank: number
  }>

  return rows.map(r => ({
    artifactName: r.artifact_name,
    artifactKind: r.artifact_kind,
    section: r.section,
    snippet: r.snippet,
    rank: r.rank,
  }))
}

/**
 * Get artifact list for a task from the index.
 */
export function getIndexedArtifacts(taskId: string): Array<{
  name: string
  kind: string
  path: string
  bytes: number
  preview: string
}> {
  const db = getDb()
  return db.prepare(
    'SELECT name, kind, path, bytes, preview FROM artifacts WHERE task_id = ?',
  ).all(taskId) as Array<{
    name: string
    kind: string
    path: string
    bytes: number
    preview: string
  }>
}
