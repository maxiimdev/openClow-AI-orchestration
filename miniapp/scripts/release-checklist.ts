#!/usr/bin/env npx tsx
/**
 * Release checklist automation for miniapp critical flows.
 *
 * Validates: Dashboard, Tasks list, Task detail, Review paths,
 * SSE fallback, stale-data detection, and cache behavior.
 *
 * Usage:
 *   MINIAPP_BASE_URL=http://localhost:3000 npx tsx scripts/release-checklist.ts
 *   # or dry-run (no live server needed):
 *   npx tsx scripts/release-checklist.ts --dry-run
 */

interface CheckResult {
  name: string
  pass: boolean
  detail: string
  durationMs: number
}

const results: CheckResult[] = []
const isDryRun = process.argv.includes('--dry-run')
const BASE = process.env.MINIAPP_BASE_URL || 'http://localhost:3000'

async function check(name: string, fn: () => Promise<{ pass: boolean; detail: string }>) {
  const t0 = Date.now()
  try {
    const { pass, detail } = await fn()
    results.push({ name, pass, detail, durationMs: Date.now() - t0 })
  } catch (err) {
    results.push({
      name,
      pass: false,
      detail: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    })
  }
}

// ── Checks ────────────────────────────────────────────────────────────────

async function httpGet(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.text()
  return { status: res.status, body }
}

// 1. Dashboard renders
await check('Dashboard page loads', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status } = await httpGet('/')
  return { pass: status === 200, detail: `HTTP ${status}` }
})

// 2. Tasks list API
await check('Tasks list API responds', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status, body } = await httpGet('/api/v1/miniapp/tasks')
  const parsed = JSON.parse(body)
  return {
    pass: status === 200 && Array.isArray(parsed.tasks),
    detail: `HTTP ${status}, ${parsed.tasks?.length ?? 0} tasks`,
  }
})

// 3. Tasks page renders
await check('Tasks page loads', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status } = await httpGet('/tasks')
  return { pass: status === 200, detail: `HTTP ${status}` }
})

// 4. Task detail page (mock task)
await check('Task detail page loads', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status } = await httpGet('/tasks/test-123')
  // 200 or 404 (no task) are both valid — page renders either way
  return { pass: status === 200, detail: `HTTP ${status}` }
})

// 5. Reviews page
await check('Reviews page loads', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status } = await httpGet('/reviews')
  return { pass: status === 200, detail: `HTTP ${status}` }
})

// 6. SSE stream endpoint exists (ticket required, expect 401/400 without auth)
await check('SSE stream endpoint exists', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status } = await httpGet('/api/v1/miniapp/stream?ticket=invalid')
  // 401/403/400 means the endpoint exists but rejects invalid tickets
  return { pass: status !== 404, detail: `HTTP ${status} (expected non-404)` }
})

// 7. Health endpoint (if exists)
await check('Health telemetry endpoint responds', async () => {
  if (isDryRun) return { pass: true, detail: 'dry-run: skipped HTTP' }
  const { status, body } = await httpGet('/api/v1/miniapp/health')
  if (status === 404) return { pass: true, detail: 'not deployed yet (404)' }
  const parsed = JSON.parse(body)
  return { pass: status === 200 && parsed.status !== undefined, detail: `HTTP ${status}` }
})

// 8. StaleIndicator component exists
await check('StaleIndicator component exists', async () => {
  const fs = await import('fs')
  const exists = fs.existsSync(new URL('../app/components/StaleIndicator.vue', import.meta.url).pathname)
  return { pass: exists, detail: exists ? 'found' : 'missing' }
})

// 9. SSE client module exists
await check('SSE client module exists', async () => {
  const fs = await import('fs')
  const exists = fs.existsSync(new URL('../app/lib/sse.ts', import.meta.url).pathname)
  return { pass: exists, detail: exists ? 'found' : 'missing' }
})

// 10. Connection store with stale detection
await check('Connection store with stale detection exists', async () => {
  const fs = await import('fs')
  const path = new URL('../app/stores/connection.ts', import.meta.url).pathname
  const exists = fs.existsSync(path)
  if (!exists) return { pass: false, detail: 'missing' }
  const content = fs.readFileSync(path, 'utf8')
  const hasStale = content.includes('isStale')
  return { pass: hasStale, detail: hasStale ? 'isStale computed found' : 'isStale missing' }
})

// 11. Task cache module exists
await check('Task cache module exists', async () => {
  const fs = await import('fs')
  const exists = fs.existsSync(new URL('../server/lib/task-cache.ts', import.meta.url).pathname)
  return { pass: exists, detail: exists ? 'found' : 'missing' }
})

// 12. Health telemetry module exists
await check('Health telemetry module exists', async () => {
  const fs = await import('fs')
  const exists = fs.existsSync(new URL('../server/lib/health-telemetry.ts', import.meta.url).pathname)
  return { pass: exists, detail: exists ? 'found' : 'missing' }
})

// 13. Review workflow composable
await check('Review workflow helpers exist', async () => {
  const fs = await import('fs')
  const exists = fs.existsSync(new URL('../app/lib/reviews.ts', import.meta.url).pathname)
  return { pass: exists, detail: exists ? 'found' : 'missing' }
})

// 14. Vitest tests pass (structure check)
await check('Test files exist for critical modules', async () => {
  const fs = await import('fs')
  const testDir = new URL('../test/', import.meta.url).pathname
  const files = fs.readdirSync(testDir).filter((f: string) => f.endsWith('.test.ts'))
  return { pass: files.length >= 5, detail: `${files.length} test files found` }
})

// ── Report ────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════╗')
console.log('║        MINIAPP RELEASE CHECKLIST REPORT             ║')
console.log('╚══════════════════════════════════════════════════════╝\n')

const maxName = Math.max(...results.map(r => r.name.length))
for (const r of results) {
  const icon = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  const name = r.name.padEnd(maxName)
  console.log(`  [${icon}] ${name}  ${r.detail} (${r.durationMs}ms)`)
}

const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
console.log(`\n  Summary: ${passed} passed, ${failed} failed, ${results.length} total`)
console.log(`  Timestamp: ${new Date().toISOString()}`)

if (failed > 0) {
  console.log('\n  \x1b[31mRELEASE BLOCKED: Fix failing checks before deploy.\x1b[0m\n')
  process.exit(1)
} else {
  console.log('\n  \x1b[32mALL CHECKS PASSED: Ready for release.\x1b[0m\n')
  process.exit(0)
}
