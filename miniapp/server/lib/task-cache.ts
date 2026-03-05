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
 */

const knownTaskIds = new Set<string>()
let _seeded = false

/** Seed from env var on first access */
function ensureSeeded() {
  if (_seeded) return
  _seeded = true
  const seeds = process.env.ORCH_SEED_TASK_IDS
  if (seeds) {
    for (const id of seeds.split(',')) {
      const trimmed = id.trim()
      if (trimmed) knownTaskIds.add(trimmed)
    }
  }
}

/** Track a task ID as known */
export function trackTaskId(taskId: string) {
  ensureSeeded()
  knownTaskIds.add(taskId)
}

/** Get all known task IDs */
export function getKnownTaskIds(): string[] {
  ensureSeeded()
  return [...knownTaskIds]
}

/** Remove a task ID (e.g., if 404'd) */
export function removeTaskId(taskId: string) {
  knownTaskIds.delete(taskId)
}

/** Check if any IDs are tracked */
export function hasKnownTasks(): boolean {
  ensureSeeded()
  return knownTaskIds.size > 0
}

/** Reset cache (for testing) */
export function resetCache() {
  knownTaskIds.clear()
  _seeded = false
}
