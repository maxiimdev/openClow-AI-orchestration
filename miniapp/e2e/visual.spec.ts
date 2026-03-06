/**
 * Visual regression baseline tests.
 *
 * These tests capture full-page screenshots for key pages and compare them
 * against committed baselines using Playwright's built-in toHaveScreenshot().
 *
 * Baseline update workflow:
 *   npx playwright test e2e/visual.spec.ts --update-snapshots
 *
 * Thresholds are set in playwright.config.ts (maxDiffPixelRatio / threshold).
 */
import { test, expect } from '@playwright/test'

/* ── Mock layer (same data as smoke.spec.ts) ─────────────────────────── */

const MOCK_TASKS = {
  tasks: [
    {
      id: 'task-001-abc',
      status: 'running',
      internalStatus: 'progress',
      mode: 'implement',
      branch: 'feature/test-branch',
      message: 'Implementing feature X',
      question: null,
      options: null,
      needsInputAt: null,
      result: null,
      structuredFindings: null,
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:05:00.000Z',
    },
    {
      id: 'task-002-def',
      status: 'needs_input',
      internalStatus: 'needs_input',
      mode: 'implement',
      branch: 'feature/another',
      message: 'Need clarification on API design',
      question: 'Should we use REST or GraphQL?',
      options: ['REST', 'GraphQL'],
      needsInputAt: '2026-01-15T10:10:00.000Z',
      result: null,
      structuredFindings: null,
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:10:00.000Z',
    },
    {
      id: 'task-003-ghi',
      status: 'review_pass',
      internalStatus: 'completed',
      mode: 'review',
      branch: 'feature/reviewed',
      message: 'Code review passed',
      question: null,
      options: null,
      needsInputAt: null,
      result: { exitCode: 0, stdout: 'All checks passed', stderr: '', durationMs: 5200, truncated: false },
      structuredFindings: [
        { severity: 'minor', file: 'src/app.ts', line: 42, message: 'Consider using const', category: 'style' },
        { severity: 'critical', file: 'src/auth.ts', line: 10, message: 'Hardcoded secret', category: 'security' },
      ],
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:03:00.000Z',
    },
    {
      id: 'task-004-jkl',
      status: 'review_fail',
      internalStatus: 'completed',
      mode: 'review',
      branch: 'feature/failed-review',
      message: 'Review found issues',
      question: null,
      options: null,
      needsInputAt: null,
      result: { exitCode: 1, stdout: '', stderr: 'Tests failing', durationMs: 3100, truncated: false },
      structuredFindings: [
        { severity: 'major', file: 'src/db.ts', line: 5, message: 'SQL injection risk', category: 'security' },
      ],
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:02:00.000Z',
    },
  ],
  total: 4,
}

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/miniapp/tasks**', async (route) => {
    const url = route.request().url()
    if (url.includes('/tasks/task-')) {
      const id = url.match(/tasks\/(task-[^/?]+)/)?.[1]
      const task = MOCK_TASKS.tasks.find(t => t.id === id)
      return route.fulfill({ json: task ?? MOCK_TASKS.tasks[0] })
    }
    if (url.includes('status=needs_input')) {
      return route.fulfill({
        json: {
          tasks: MOCK_TASKS.tasks.filter(t => t.status === 'needs_input'),
          total: 1,
        },
      })
    }
    return route.fulfill({ json: MOCK_TASKS })
  })
  await page.route('**/api/v1/miniapp/tasks/*/events**', async (route) => {
    return route.fulfill({
      json: {
        events: [
          { id: 'evt-1', type: 'task_started', taskId: 'task-001-abc', timestamp: '2026-01-15T10:00:00.000Z', data: {} },
          { id: 'evt-2', type: 'task_progress', taskId: 'task-001-abc', timestamp: '2026-01-15T10:00:01.000Z', data: { message: 'Running tests' } },
        ],
      },
    })
  })
  await page.route('**/api/v1/miniapp/stream**', (route) => route.abort())
}

/* ── Visual baseline tests ───────────────────────────────────────────── */

test.describe('Visual baselines', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page)
  })

  test('dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Dashboard')
    await expect(page.locator('nav')).toBeVisible()
    await expect(page).toHaveScreenshot('dashboard.png', { fullPage: true })
  })

  test('tasks list', async ({ page }) => {
    await page.goto('/tasks')
    await expect(page.locator('a[href*="/tasks/task-"]').first()).toBeVisible()
    await expect(page).toHaveScreenshot('tasks-list.png', { fullPage: true })
  })

  test('task detail', async ({ page }) => {
    await page.goto('/tasks/task-003-ghi')
    await expect(page.locator('text=task-003-ghi').first()).toBeVisible()
    await expect(page.locator('text=Review Findings')).toBeVisible()
    await expect(page).toHaveScreenshot('task-detail.png', { fullPage: true })
  })

  test('inbox', async ({ page }) => {
    await page.goto('/inbox')
    await expect(page.locator('text=Should we use REST or GraphQL?')).toBeVisible()
    await expect(page).toHaveScreenshot('inbox.png', { fullPage: true })
  })

  test('reviews', async ({ page }) => {
    await page.goto('/reviews')
    await expect(page.locator('h1')).toHaveText('Review Center')
    await expect(page).toHaveScreenshot('reviews.png', { fullPage: true })
  })
})
