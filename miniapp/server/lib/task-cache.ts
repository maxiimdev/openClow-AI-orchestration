/**
 * In-memory task ID cache for hybrid list policy.
 *
 * Since orch-api v0.3.0 has no GET /api/tasks list endpoint,
 * we maintain a local set of known task IDs gathered from:
 *   1. Tasks viewed via detail page (GET /tasks/:id)
 *   2. Tasks resumed (POST /tasks/:id/resume)
 *   3. Operator-seeded IDs via ORCH_SEED_TASK_IDS env var
 *
 * This cache is ephemeral (process memory). A persistent backing
 * store can be added when needed.
 *
 * TTL: entries expire after TASK_CACHE_TTL_MS (default 1h).
 * Max size: capped at TASK_CACHE_MAX_SIZE (default 500).
 * When max size is exceeded, oldest entries are evicted first.
 */

interface CacheEntry {
  trackedAt: number
}

const knownTasks = new Map<string, CacheEntry>()
let _seeded = false

/** Default TTL: 1 hour */
const DEFAULT_TTL_MS = 60 * 60 * 1000
/** Default max cache size */
const DEFAULT_MAX_SIZE = 500

function getTtlMs(): number {
  const env = process.env.TASK_CACHE_TTL_MS
  if (env) {
    const n = parseInt(env, 10)
    if (n > 0) return n
  }
  return DEFAULT_TTL_MS
}

function getMaxSize(): number {
  const env = process.env.TASK_CACHE_MAX_SIZE
  if (env) {
    const n = parseInt(env, 10)
    if (n > 0) return n
  }
  return DEFAULT_MAX_SIZE
}

/** Seed from env var on first access */
function ensureSeeded() {
  if (_seeded) return
  _seeded = true
  const seeds = process.env.ORCH_SEED_TASK_IDS
  if (seeds) {
    const now = Date.now()
    for (const id of seeds.split(',')) {
      const trimmed = id.trim()
      if (trimmed) knownTasks.set(trimmed, { trackedAt: now })
    }
  }
}

/** Remove expired entries */
function evictExpired(): void {
  const ttl = getTtlMs()
  const cutoff = Date.now() - ttl
  for (const [id, entry] of knownTasks) {
    if (entry.trackedAt < cutoff) {
      knownTasks.delete(id)
    }
  }
}

/** Evict oldest entries if over max size */
function evictOverflow(): void {
  const max = getMaxSize()
  if (knownTasks.size <= max) return

  // Map preserves insertion order — oldest entries are first
  const toRemove = knownTasks.size - max
  let removed = 0
  for (const id of knownTasks.keys()) {
    if (removed >= toRemove) break
    knownTasks.delete(id)
    removed++
  }
}

/** Track a task ID as known (refreshes TTL and moves to end for LRU eviction) */
export function trackTaskId(taskId: string) {
  ensureSeeded()
  // Delete first to move to end of Map insertion order
  knownTasks.delete(taskId)
  knownTasks.set(taskId, { trackedAt: Date.now() })
  evictOverflow()
}

/** Get all known task IDs (excludes expired) */
export function getKnownTaskIds(): string[] {
  ensureSeeded()
  evictExpired()
  return [...knownTasks.keys()]
}

/** Remove a task ID (e.g., if 404'd) */
export function removeTaskId(taskId: string) {
  knownTasks.delete(taskId)
}

/** Check if any IDs are tracked (excludes expired) */
export function hasKnownTasks(): boolean {
  ensureSeeded()
  evictExpired()
  return knownTasks.size > 0
}

/** Get cache size (for observability) */
export function getCacheSize(): number {
  return knownTasks.size
}

/** Reset cache (for testing) */
export function resetCache() {
  knownTasks.clear()
  _seeded = false
}
