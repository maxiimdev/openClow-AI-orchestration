import { test, expect } from '@playwright/test'

// Fixed timestamps for deterministic ordering
const T1 = '2026-01-15T10:00:00.000Z'
const T2 = '2026-01-15T10:01:00.000Z'
const T3 = '2026-01-15T10:02:00.000Z'
const T4 = '2026-01-15T10:03:00.000Z'

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
      createdAt: T1,
      updatedAt: T2,
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
      needsInputAt: T2,
      result: null,
      structuredFindings: null,
      createdAt: T1,
      updatedAt: T2,
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
        { id: 'f-1', severity: 'minor', file: 'src/app.ts', issue: 'Consider using const', risk: 'Low readability', required_fix: 'Use const declaration', acceptance_check: 'No let used' },
        { id: 'f-2', severity: 'critical', file: 'src/auth.ts', issue: 'Hardcoded secret', risk: 'Credential leak', required_fix: 'Use env variable', acceptance_check: 'No hardcoded strings' },
      ],
      createdAt: T1,
      updatedAt: T3,
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
        { id: 'f-3', severity: 'major', file: 'src/db.ts', issue: 'SQL injection risk', risk: 'Data breach', required_fix: 'Use parameterized queries', acceptance_check: 'No string concat in queries' },
      ],
      createdAt: T1,
      updatedAt: T4,
    },
    {
      id: 'task-005-mno',
      status: 'completed',
      internalStatus: 'completed',
      mode: 'implement',
      branch: 'feature/done-task',
      message: 'Feature completed successfully',
      question: null,
      options: null,
      needsInputAt: null,
      result: { exitCode: 0, stdout: 'Done', stderr: '', durationMs: 1200, truncated: false },
      structuredFindings: null,
      createdAt: T1,
      updatedAt: T3,
    },
  ],
  total: 5,
}

const MOCK_EVENTS = {
  events: [
    { id: 'evt-1', taskId: 'task-003-ghi', status: 'claimed', phase: 'init', message: 'Task claimed', createdAt: T1, meta: {} },
    { id: 'evt-2', taskId: 'task-003-ghi', status: 'started', phase: 'execute', message: 'Execution started', createdAt: T2, meta: {} },
    { id: 'evt-3', taskId: 'task-003-ghi', status: 'progress', phase: 'execute', message: 'Running tests', createdAt: T3, meta: {} },
    { id: 'evt-4', taskId: 'task-003-ghi', status: 'review_pass', phase: 'review', message: 'All checks passed', createdAt: T4, meta: {} },
  ],
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
    return route.fulfill({ json: MOCK_EVENTS })
  })
  await page.route('**/api/v1/miniapp/stream**', (route) => route.abort())
}

test.describe('UI interaction assertions', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page)
  })

  // ── 1. Dashboard counters ────────────────────────────────────
  test('dashboard counters show correct values', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Dashboard')

    // Active = 1 (running), Awaiting Input = 1 (needs_input), Reviews = 2 (review_pass + review_fail)
    const tiles = page.locator('.grid.grid-cols-3 > a')
    await expect(tiles).toHaveCount(3)

    // Active tile: counter value
    const activeTile = tiles.nth(0)
    const activeCount = activeTile.locator('.text-3xl')
    await expect(activeCount).toHaveText('1')
    await expect(activeTile).toContainText('Active')

    // Awaiting Input tile: counter value
    const inputTile = tiles.nth(1)
    const inputCount = inputTile.locator('.text-3xl')
    await expect(inputCount).toHaveText('1')
    await expect(inputTile).toContainText('Awaiting Input')

    // Reviews tile: counter value (review_pass + review_fail = 2)
    const reviewTile = tiles.nth(2)
    const reviewCount = reviewTile.locator('.text-3xl')
    await expect(reviewCount).toHaveText('2')
    await expect(reviewTile).toContainText('Reviews')

    // Counter values are non-negative integers
    for (let i = 0; i < 3; i++) {
      const text = await tiles.nth(i).locator('.text-3xl').textContent()
      const num = Number(text)
      expect(num).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(num)).toBe(true)
    }
  })

  test('dashboard tiles link to correct pages', async ({ page }) => {
    await page.goto('/')
    const tiles = page.locator('.grid.grid-cols-3 > a')
    await expect(tiles.nth(0)).toHaveAttribute('href', '/tasks')
    await expect(tiles.nth(1)).toHaveAttribute('href', '/inbox')
    await expect(tiles.nth(2)).toHaveAttribute('href', '/reviews')
  })

  // ── 2. Tasks filter interactions ─────────────────────────────
  test('tasks filter pills change visible cards', async ({ page }) => {
    await page.goto('/tasks')
    await expect(page.locator('h1')).toHaveText('Tasks')

    // "All" shows all 5 tasks
    const cards = page.locator('a[href*="/tasks/task-"]')
    await expect(cards).toHaveCount(5)

    // Click "Running" filter
    await page.locator('button', { hasText: 'Running' }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('feature/test-branch')

    // Click "Awaiting Input" filter
    await page.locator('button', { hasText: 'Awaiting Input' }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('feature/another')

    // Click "Review Passed" filter
    await page.locator('button', { hasText: 'Review Passed' }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('feature/reviewed')

    // Click "Completed" filter
    await page.locator('button', { hasText: 'Completed' }).click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('feature/done-task')

    // Click "All" to restore
    await page.locator('button', { hasText: 'All' }).click()
    await expect(cards).toHaveCount(5)
  })

  test('tasks search filters by text', async ({ page }) => {
    await page.goto('/tasks')
    const cards = page.locator('a[href*="/tasks/task-"]')
    await expect(cards).toHaveCount(5)

    // Search for "clarification"
    await page.locator('input[placeholder="Search tasks..."]').fill('clarification')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('feature/another')

    // Clear search restores all
    await page.locator('input[placeholder="Search tasks..."]').fill('')
    await expect(cards).toHaveCount(5)
  })

  test('active filter pill has distinct styling', async ({ page }) => {
    await page.goto('/tasks')
    const allBtn = page.locator('button', { hasText: 'All' }).first()

    // "All" is active by default
    await expect(allBtn).toHaveClass(/bg-primary/)

    // Click "Running" — it becomes active, "All" becomes inactive
    const runningBtn = page.locator('button', { hasText: 'Running' })
    await runningBtn.click()
    await expect(runningBtn).toHaveClass(/bg-primary/)
    await expect(allBtn).toHaveClass(/bg-muted/)
  })

  // ── 3. Task detail timeline ordering ─────────────────────────
  test('task detail timeline renders events in stable order', async ({ page }) => {
    await page.goto('/tasks/task-003-ghi')

    // Wait for timeline to render
    await expect(page.locator('text=Event Timeline')).toBeVisible()

    // Timeline events should be rendered (4 events in mock)
    const timelineItems = page.locator('.space-y-0 > div')
    await expect(timelineItems).toHaveCount(4)

    // Verify ordering: events appear in sequence (first→last)
    const labels = await timelineItems.locator('.text-sm.font-medium').allTextContents()
    expect(labels).toEqual(['Running', 'Running', 'Running', 'Review Passed'])

    // Verify phases are present
    const phases = await timelineItems.locator('.text-xs.text-muted-foreground').first().textContent()
    expect(phases).toBeTruthy()

    // Verify timestamps are present and visible on each event
    for (let i = 0; i < 4; i++) {
      const ts = timelineItems.nth(i).locator('.ml-auto.text-xs')
      await expect(ts).toBeVisible()
      const text = await ts.textContent()
      expect(text).toBeTruthy()
    }
  })

  test('task detail shows meta, result, and findings sections', async ({ page }) => {
    await page.goto('/tasks/task-003-ghi')

    // Meta block: status badge, mode tag, branch
    await expect(page.locator('text=review').first()).toBeVisible()
    await expect(page.locator('text=feature/reviewed')).toBeVisible()

    // Result section
    await expect(page.locator('text=Result')).toBeVisible()
    await expect(page.locator('text=exit 0')).toBeVisible()
    await expect(page.locator('text=5.2s')).toBeVisible()

    // Findings section
    await expect(page.locator('text=Review Findings')).toBeVisible()
    await expect(page.locator('text=Hardcoded secret')).toBeVisible()
    await expect(page.locator('text=Consider using const')).toBeVisible()
  })

  // ── 4. Reviews page navigation and CTAs ──────────────────────
  test('reviews page shows summary chips with correct counts', async ({ page }) => {
    await page.goto('/reviews')
    await expect(page.locator('h1')).toHaveText('Review Center')

    // Summary chips: 2 total, 1 passed, 1 failed
    await expect(page.locator('text=2 total')).toBeVisible()
    await expect(page.locator('text=1 passed')).toBeVisible()
    await expect(page.locator('text=1 failed')).toBeVisible()
  })

  test('reviews cards link to task detail', async ({ page }) => {
    await page.goto('/reviews')
    const reviewCards = page.locator('a[href*="/tasks/task-"]')
    await expect(reviewCards).toHaveCount(2)

    // Each card should have a StatusBadge and branch info
    for (let i = 0; i < 2; i++) {
      const card = reviewCards.nth(i)
      await expect(card.locator('.rounded-full').first()).toBeVisible() // StatusBadge
      await expect(card).toContainText('review')
    }

    // Severity chips should be visible on cards with findings
    await expect(page.locator('text=1 critical')).toBeVisible()
    await expect(page.locator('text=1 minor')).toBeVisible()
    await expect(page.locator('text=1 major')).toBeVisible()
  })

  test('reviews card navigates to task detail on click', async ({ page }) => {
    await page.goto('/reviews')
    const firstCard = page.locator('a[href*="/tasks/task-"]').first()
    await firstCard.click()
    await page.waitForURL(/\/tasks\/task-/)
    await expect(page.locator('text=Event Timeline')).toBeVisible()
  })

  // ── 5. Inbox navigation and CTA visibility ──────────────────
  test('inbox shows needs_input tasks with question and option CTAs', async ({ page }) => {
    await page.goto('/inbox')
    await expect(page.locator('h1')).toHaveText('Awaiting Input')

    // Question text
    await expect(page.locator('text=Should we use REST or GraphQL?')).toBeVisible()

    // Option buttons as CTAs
    await expect(page.locator('button', { hasText: 'REST' })).toBeVisible()
    await expect(page.locator('button', { hasText: 'GraphQL' })).toBeVisible()

    // Task link to detail page
    const taskLink = page.locator('a[href*="/tasks/task-002-def"]')
    await expect(taskLink).toBeVisible()
  })

  test('inbox task link navigates to detail page', async ({ page }) => {
    await page.goto('/inbox')
    const taskLink = page.locator('a[href*="/tasks/task-002-def"]')
    await taskLink.click()
    await page.waitForURL(/\/tasks\/task-002-def/)
    await expect(page.locator('text=task-002-def')).toBeVisible()
  })

  // ── 6. Cross-page navigation via nav bar ─────────────────────
  test('nav bar navigates between all sections', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Dashboard')

    // Nav → Tasks
    await page.locator('nav >> text=Tasks').click()
    await page.waitForURL('/tasks')
    await expect(page.locator('h1')).toHaveText('Tasks')

    // Nav → Inbox
    await page.locator('nav >> text=Inbox').click()
    await page.waitForURL('/inbox')
    await expect(page.locator('h1')).toHaveText('Awaiting Input')

    // Nav → Reviews
    await page.locator('nav >> text=Reviews').click()
    await page.waitForURL('/reviews')
    await expect(page.locator('h1')).toHaveText('Review Center')
  })
})
