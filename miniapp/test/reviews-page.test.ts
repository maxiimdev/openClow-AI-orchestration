import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, computed } from 'vue'
import type { Task, Finding } from '~/lib/types'
import { filterReviewTasks, getReviewSummary, getReviewCardSummary, countFindingsBySeverity } from '~/lib/reviews'
import { truncateId, formatRelativeTime } from '~/lib/mappers'

// Smoke test: verifies review center page rendering logic.
// Uses a simplified component mirroring the real reviews.vue template.

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-001',
    mode: 'review',
    status: 'review_pass',
    internalStatus: 'review_pass',
    branch: 'feature/test',
    repoPath: '/repo',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    message: 'Review passed',
    meta: {},
    userId: 1,
    ...overrides,
  }
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F1',
    severity: 'major',
    file: 'src/test.ts',
    issue: 'Test issue',
    risk: 'Test risk',
    required_fix: 'Fix it',
    acceptance_check: 'Check it',
    ...overrides,
  }
}

const severityClass: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  major: 'bg-orange-100 text-orange-800',
  minor: 'bg-yellow-100 text-yellow-800',
}

const ReviewsPage = defineComponent({
  props: {
    tasks: { type: Array as () => Task[], default: () => [] },
    isPending: { type: Boolean, default: false },
    error: { type: Object as () => Error | null, default: null },
  },
  setup(props) {
    const reviewTasks = computed(() => filterReviewTasks(props.tasks))
    const summary = computed(() => getReviewSummary(props.tasks))
    return { reviewTasks, summary, truncateId, formatRelativeTime, getReviewCardSummary, countFindingsBySeverity, severityClass }
  },
  template: `
    <div class="p-4">
      <h1>Review Center</h1>
      <div v-if="isPending" data-testid="loading">Loading...</div>
      <div v-else-if="error" data-testid="error">{{ error.message }}</div>
      <div v-else-if="!reviewTasks.length" data-testid="empty">No reviews</div>
      <template v-else>
        <div data-testid="summary" class="summary">
          <span data-testid="total">{{ summary.total }} total</span>
          <span v-if="summary.passed" data-testid="passed">{{ summary.passed }} passed</span>
          <span v-if="summary.failed" data-testid="failed">{{ summary.failed }} failed</span>
          <span v-if="summary.escalated" data-testid="escalated">{{ summary.escalated }} escalated</span>
        </div>
        <div data-testid="review-list">
          <div v-for="task in reviewTasks" :key="task.id" :data-testid="'review-' + task.id" class="review-card">
            <span class="task-id">{{ truncateId(task.id) }}</span>
            <span class="task-status">{{ task.status }}</span>
            <span class="task-mode">{{ task.mode }}</span>
            <span v-if="task.branch" class="task-branch">{{ task.branch }}</span>
            <span class="card-summary">{{ getReviewCardSummary(task) }}</span>
            <div v-if="task.structuredFindings?.length" class="severity-chips">
              <template v-for="(count, sev) in countFindingsBySeverity(task.structuredFindings)" :key="sev">
                <span v-if="count > 0" :data-testid="'sev-' + sev" class="severity-chip" :class="severityClass[sev]">
                  {{ count }} {{ sev }}
                </span>
              </template>
            </div>
            <span class="updated">{{ formatRelativeTime(task.updatedAt) }}</span>
          </div>
        </div>
      </template>
    </div>
  `,
})

const allMockTasks: Task[] = [
  makeTask({ id: 'task-pass', status: 'review_pass' }),
  makeTask({
    id: 'task-fail',
    status: 'review_fail',
    reviewFindings: 'Missing error handling',
    structuredFindings: [
      makeFinding({ id: 'F1', severity: 'critical' }),
      makeFinding({ id: 'F2', severity: 'major' }),
    ],
  }),
  makeTask({
    id: 'task-esc',
    status: 'escalated',
    structuredFindings: [makeFinding({ id: 'F1', severity: 'critical' })],
  }),
  makeTask({ id: 'task-running', status: 'running' }),
]

describe('Reviews page smoke test', () => {
  it('shows loading state', () => {
    const wrapper = mount(ReviewsPage, { props: { isPending: true } })
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="review-list"]').exists()).toBe(false)
  })

  it('shows empty state with no review tasks', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: [] } })
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(true)
  })

  it('shows empty state when only non-review tasks exist', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: [makeTask({ status: 'running' })] } })
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(true)
  })

  it('shows error state', () => {
    const wrapper = mount(ReviewsPage, { props: { error: new Error('Server error') } })
    expect(wrapper.find('[data-testid="error"]').text()).toContain('Server error')
  })

  it('renders review cards for review-status tasks only', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    expect(wrapper.findAll('.review-card')).toHaveLength(3)
    expect(wrapper.find('[data-testid="review-task-pass"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="review-task-fail"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="review-task-esc"]').exists()).toBe(true)
    // running task should not appear
    expect(wrapper.find('[data-testid="review-task-running"]').exists()).toBe(false)
  })

  it('displays summary chips with correct counts', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    expect(wrapper.find('[data-testid="total"]').text()).toBe('3 total')
    expect(wrapper.find('[data-testid="passed"]').text()).toBe('1 passed')
    expect(wrapper.find('[data-testid="failed"]').text()).toBe('1 failed')
    expect(wrapper.find('[data-testid="escalated"]').text()).toBe('1 escalated')
  })

  it('shows card summary text for each card type', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    const passCard = wrapper.find('[data-testid="review-task-pass"]')
    expect(passCard.find('.card-summary').text()).toContain('no issues found')

    const failCard = wrapper.find('[data-testid="review-task-fail"]')
    expect(failCard.find('.card-summary').text()).toContain('2 findings require attention')

    const escCard = wrapper.find('[data-testid="review-task-esc"]')
    expect(escCard.find('.card-summary').text()).toContain('Escalated')
  })

  it('displays severity chips for tasks with structured findings', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    const failCard = wrapper.find('[data-testid="review-task-fail"]')
    expect(failCard.find('[data-testid="sev-critical"]').text()).toBe('1 critical')
    expect(failCard.find('[data-testid="sev-major"]').text()).toBe('1 major')
  })

  it('does not show severity chips for pass tasks', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    const passCard = wrapper.find('[data-testid="review-task-pass"]')
    expect(passCard.find('.severity-chips').exists()).toBe(false)
  })

  it('shows mode and branch on review cards', () => {
    const wrapper = mount(ReviewsPage, { props: { tasks: allMockTasks } })
    const failCard = wrapper.find('[data-testid="review-task-fail"]')
    expect(failCard.find('.task-mode').text()).toBe('review')
    expect(failCard.find('.task-branch').text()).toBe('feature/test')
  })

  it('hides passed/failed/escalated chips when count is zero', () => {
    const tasks = [makeTask({ id: 'only-pass', status: 'review_pass' })]
    const wrapper = mount(ReviewsPage, { props: { tasks } })
    expect(wrapper.find('[data-testid="passed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="failed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="escalated"]').exists()).toBe(false)
  })
})
