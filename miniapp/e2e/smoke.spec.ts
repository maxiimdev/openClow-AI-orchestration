import { test, expect } from '@playwright/test'

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      needsInputAt: new Date().toISOString(),
      result: null,
      structuredFindings: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
          { id: 'evt-1', type: 'task_started', taskId: 'task-001-abc', timestamp: new Date().toISOString(), data: {} },
          { id: 'evt-2', type: 'task_progress', taskId: 'task-001-abc', timestamp: new Date().toISOString(), data: { message: 'Running tests' } },
        ],
      },
    })
  })
  await page.route('**/api/v1/miniapp/stream**', (route) => route.abort())
}

test.describe('Visual smoke tests', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page)
  })

  test('dashboard renders with stats', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Dashboard')
    // Stat tiles should render
    await expect(page.locator('text=Active')).toBeVisible()
    await expect(page.locator('text=Awaiting Input')).toBeVisible()
    await expect(page.locator('.text-sm.text-muted-foreground:has-text("Reviews")')).toBeVisible()
    // Nav bar present
    await expect(page.locator('nav')).toBeVisible()
    await expect(page.locator('nav >> text=Tasks')).toBeVisible()
    // CSS sanity: body should have non-zero height, nav has border
    const nav = page.locator('nav')
    const navBox = await nav.boundingBox()
    expect(navBox).toBeTruthy()
    expect(navBox!.height).toBeGreaterThan(20)
  })

  test('tasks list renders with cards', async ({ page }) => {
    await page.goto('/tasks')
    await expect(page.locator('h1')).toHaveText('Tasks')
    // Search input
    await expect(page.locator('input[placeholder="Search tasks..."]')).toBeVisible()
    // Filter pills
    await expect(page.locator('text=All')).toBeVisible()
    // Task cards should appear (NuxtLink renders as <a> which IS the card)
    const cards = page.locator('a[href*="/tasks/task-"]')
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBeGreaterThanOrEqual(4)
  })

  test('task detail renders with result pane', async ({ page }) => {
    await page.goto('/tasks/task-003-ghi')
    // Back link
    await expect(page.locator('text=Tasks').first()).toBeVisible()
    // Task ID visible
    await expect(page.locator('text=task-003-ghi').first()).toBeVisible()
    // Result section with exit code
    await expect(page.locator('text=exit 0')).toBeVisible()
    // Findings section
    await expect(page.locator('text=Review Findings')).toBeVisible()
  })

  test('inbox renders needs_input tasks', async ({ page }) => {
    await page.goto('/inbox')
    await expect(page.locator('h1')).toHaveText('Awaiting Input')
    // Should show the question
    await expect(page.locator('text=Should we use REST or GraphQL?')).toBeVisible()
  })

  test('reviews page renders with summary chips', async ({ page }) => {
    await page.goto('/reviews')
    await expect(page.locator('h1')).toHaveText('Review Center')
    // Summary chips
    await expect(page.locator('text=total').first()).toBeVisible()
    // Review cards
    await expect(page.locator('text=review').first()).toBeVisible()
  })

  test('CSS pipeline: tailwind utilities applied', async ({ page }) => {
    await page.goto('/')
    // Verify that Tailwind CSS is actually loaded by checking computed styles
    const heading = page.locator('h1')
    const fontWeight = await heading.evaluate(el => getComputedStyle(el).fontWeight)
    // font-bold = 700
    expect(Number(fontWeight)).toBeGreaterThanOrEqual(700)

    // Check min-h-screen applies (computed value resolves vh to px)
    const root = page.locator('div.min-h-screen')
    await expect(root).toBeVisible()
    const rootMinHeight = await root.evaluate(el => parseFloat(getComputedStyle(el).minHeight))
    expect(rootMinHeight).toBeGreaterThanOrEqual(600)
  })
})
