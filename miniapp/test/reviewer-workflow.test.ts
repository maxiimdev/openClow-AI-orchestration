import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, computed, ref } from 'vue'
import type { Task, Finding, TaskEvent } from '~/lib/types'
import {
  filterReviewTasks,
  getReviewSummary,
  getReviewCardSummary,
  canRequestPatch,
  canRequestReReview,
  getIterationInfo,
  buildReviewDiffSummary,
  countFindingsBySeverity,
} from '~/lib/reviews'
import { formatRelativeTime, truncateId } from '~/lib/mappers'

// ── Test helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
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

// ── canRequestPatch tests ─────────────────────────────────────────────────

describe('canRequestPatch', () => {
  it('returns true for review_fail with iterations remaining', () => {
    const task = makeTask({
      status: 'review_fail',
      meta: { reviewIteration: 1, reviewMaxIterations: 3 },
    })
    expect(canRequestPatch(task)).toBe(true)
  })

  it('returns false for review_fail at max iterations', () => {
    const task = makeTask({
      status: 'review_fail',
      meta: { reviewIteration: 3, reviewMaxIterations: 3 },
    })
    expect(canRequestPatch(task)).toBe(false)
  })

  it('returns false for review_pass', () => {
    expect(canRequestPatch(makeTask({ status: 'review_pass' }))).toBe(false)
  })

  it('returns false for escalated', () => {
    expect(canRequestPatch(makeTask({ status: 'escalated' }))).toBe(false)
  })

  it('returns false for running', () => {
    expect(canRequestPatch(makeTask({ status: 'running' }))).toBe(false)
  })

  it('defaults maxIterations to 3 when not set', () => {
    const task = makeTask({
      status: 'review_fail',
      meta: { reviewIteration: 2 },
    })
    expect(canRequestPatch(task)).toBe(true)
  })

  it('returns true when meta has no iteration info (iteration defaults to 0 < 3)', () => {
    const task = makeTask({ status: 'review_fail', meta: {} })
    expect(canRequestPatch(task)).toBe(true)
  })
})

// ── canRequestReReview tests ──────────────────────────────────────────────

describe('canRequestReReview', () => {
  it('returns true for review_fail', () => {
    expect(canRequestReReview(makeTask({ status: 'review_fail' }))).toBe(true)
  })

  it('returns true for escalated', () => {
    expect(canRequestReReview(makeTask({ status: 'escalated' }))).toBe(true)
  })

  it('returns false for review_pass', () => {
    expect(canRequestReReview(makeTask({ status: 'review_pass' }))).toBe(false)
  })

  it('returns false for running', () => {
    expect(canRequestReReview(makeTask({ status: 'running' }))).toBe(false)
  })

  it('returns false for completed', () => {
    expect(canRequestReReview(makeTask({ status: 'completed' }))).toBe(false)
  })

  it('returns false for needs_input', () => {
    expect(canRequestReReview(makeTask({ status: 'needs_input' }))).toBe(false)
  })
})

// ── getIterationInfo tests ────────────────────────────────────────────────

describe('getIterationInfo', () => {
  it('returns iteration info when meta has both fields', () => {
    const task = makeTask({ meta: { reviewIteration: 2, reviewMaxIterations: 5 } })
    expect(getIterationInfo(task)).toEqual({ current: 2, max: 5, remaining: 3 })
  })

  it('returns null when meta has no iteration fields', () => {
    expect(getIterationInfo(makeTask({ meta: {} }))).toBeNull()
  })

  it('returns null when only iteration is set', () => {
    expect(getIterationInfo(makeTask({ meta: { reviewIteration: 1 } }))).toBeNull()
  })

  it('returns null when only maxIterations is set', () => {
    expect(getIterationInfo(makeTask({ meta: { reviewMaxIterations: 3 } }))).toBeNull()
  })

  it('handles final iteration with 0 remaining', () => {
    const task = makeTask({ meta: { reviewIteration: 3, reviewMaxIterations: 3 } })
    expect(getIterationInfo(task)).toEqual({ current: 3, max: 3, remaining: 0 })
  })
})

// ── buildReviewDiffSummary tests ──────────────────────────────────────────

describe('buildReviewDiffSummary', () => {
  it('identifies resolved, remaining, and new findings', () => {
    const prev = [
      makeFinding({ id: 'F1', issue: 'Old issue 1' }),
      makeFinding({ id: 'F2', issue: 'Old issue 2' }),
    ]
    const curr = [
      makeFinding({ id: 'F2', issue: 'Old issue 2' }),
      makeFinding({ id: 'F3', issue: 'New issue' }),
    ]
    const diff = buildReviewDiffSummary(prev, curr, 1, 2)

    expect(diff.previousIteration).toBe(1)
    expect(diff.currentIteration).toBe(2)
    expect(diff.findingsResolved).toHaveLength(1)
    expect(diff.findingsResolved[0].id).toBe('F1')
    expect(diff.findingsRemaining).toHaveLength(1)
    expect(diff.findingsRemaining[0].id).toBe('F2')
    expect(diff.findingsNew).toHaveLength(1)
    expect(diff.findingsNew[0].id).toBe('F3')
  })

  it('handles all findings resolved', () => {
    const prev = [makeFinding({ id: 'F1' }), makeFinding({ id: 'F2' })]
    const curr: Finding[] = []
    const diff = buildReviewDiffSummary(prev, curr, 1, 2)

    expect(diff.findingsResolved).toHaveLength(2)
    expect(diff.findingsRemaining).toHaveLength(0)
    expect(diff.findingsNew).toHaveLength(0)
  })

  it('handles all new findings', () => {
    const prev: Finding[] = []
    const curr = [makeFinding({ id: 'F1' })]
    const diff = buildReviewDiffSummary(prev, curr, 0, 1)

    expect(diff.findingsResolved).toHaveLength(0)
    expect(diff.findingsRemaining).toHaveLength(0)
    expect(diff.findingsNew).toHaveLength(1)
  })

  it('handles identical findings (all remaining)', () => {
    const findings = [makeFinding({ id: 'F1' }), makeFinding({ id: 'F2' })]
    const diff = buildReviewDiffSummary(findings, findings, 1, 2)

    expect(diff.findingsResolved).toHaveLength(0)
    expect(diff.findingsRemaining).toHaveLength(2)
    expect(diff.findingsNew).toHaveLength(0)
  })

  it('handles empty previous and current', () => {
    const diff = buildReviewDiffSummary([], [], 0, 1)
    expect(diff.findingsResolved).toHaveLength(0)
    expect(diff.findingsRemaining).toHaveLength(0)
    expect(diff.findingsNew).toHaveLength(0)
  })
})

// ── Status transition scenario matrix ─────────────────────────────────────

describe('reviewer status transition scenarios', () => {
  const scenarios: Array<{
    name: string
    from: Task['status']
    canPatch: boolean
    canReReview: boolean
    meta?: Record<string, unknown>
  }> = [
    { name: 'review_fail iter 1/3 → patch available', from: 'review_fail', canPatch: true, canReReview: true, meta: { reviewIteration: 1, reviewMaxIterations: 3 } },
    { name: 'review_fail iter 2/3 → patch available', from: 'review_fail', canPatch: true, canReReview: true, meta: { reviewIteration: 2, reviewMaxIterations: 3 } },
    { name: 'review_fail iter 3/3 → no patch (at max)', from: 'review_fail', canPatch: false, canReReview: true, meta: { reviewIteration: 3, reviewMaxIterations: 3 } },
    { name: 'escalated → re-review only', from: 'escalated', canPatch: false, canReReview: true },
    { name: 'review_pass → no actions', from: 'review_pass', canPatch: false, canReReview: false },
    { name: 'running → no actions', from: 'running', canPatch: false, canReReview: false },
    { name: 'completed → no actions', from: 'completed', canPatch: false, canReReview: false },
    { name: 'needs_input → no actions', from: 'needs_input', canPatch: false, canReReview: false },
    { name: 'failed → no actions', from: 'failed', canPatch: false, canReReview: false },
  ]

  for (const s of scenarios) {
    it(s.name, () => {
      const task = makeTask({ status: s.from, meta: s.meta ?? {} })
      expect(canRequestPatch(task)).toBe(s.canPatch)
      expect(canRequestReReview(task)).toBe(s.canReReview)
    })
  }
})

// ── Task detail page review actions rendering ─────────────────────────────

const ReviewDetailPage = defineComponent({
  props: {
    task: { type: Object as () => Task, required: true },
    reviewEvents: { type: Array as () => TaskEvent[], default: () => [] },
  },
  setup(props) {
    const reReviewLoading = ref(false)
    const reReviewError = ref<string | null>(null)
    const iterationInfo = computed(() => getIterationInfo(props.task))
    return {
      reReviewLoading,
      reReviewError,
      iterationInfo,
      canRequestPatch,
      canRequestReReview,
      getReviewCardSummary,
      truncateId,
      formatRelativeTime,
      countFindingsBySeverity,
    }
  },
  template: `
    <div>
      <div data-testid="task-status">{{ task.status }}</div>

      <div v-if="task.status === 'review_fail'" data-testid="review-fail-banner">
        <span data-testid="patch-required">Patch Required</span>
        <span v-if="iterationInfo" data-testid="iteration-info">
          iteration {{ iterationInfo.current }} of {{ iterationInfo.max }}, {{ iterationInfo.remaining }} remaining
        </span>
        <button
          v-if="canRequestPatch(task)"
          data-testid="btn-patch-rereview"
          :disabled="reReviewLoading"
        >Request Patch & Re-review</button>
        <button
          v-if="canRequestReReview(task)"
          data-testid="btn-rereview-only"
          :disabled="reReviewLoading"
        >Re-review Only</button>
        <span v-if="reReviewError" data-testid="rereview-error">{{ reReviewError }}</span>
      </div>

      <div v-else-if="task.status === 'escalated'" data-testid="escalated-banner">
        <span>Escalated — Manual Review Needed</span>
        <button
          v-if="canRequestReReview(task)"
          data-testid="btn-force-rereview"
          :disabled="reReviewLoading"
        >Force Re-review</button>
      </div>

      <div v-if="task.structuredFindings?.length" data-testid="findings-section">
        <span data-testid="findings-summary">{{ getReviewCardSummary(task) }}</span>
        <div v-for="f in task.structuredFindings" :key="f.id" :data-testid="'finding-' + f.id" class="finding">
          <span class="severity">{{ f.severity }}</span>
          <span class="issue">{{ f.issue }}</span>
        </div>
      </div>

      <div v-if="reviewEvents.length > 1" data-testid="iteration-history">
        <div v-for="(evt, idx) in reviewEvents" :key="evt.id" :data-testid="'iter-' + idx" class="iter-entry">
          <span class="iter-status">{{ evt.status }}</span>
          <span class="iter-message">{{ evt.message }}</span>
        </div>
      </div>
    </div>
  `,
})

describe('Review detail page rendering', () => {
  it('shows review_fail banner with patch and re-review buttons', () => {
    const task = makeTask({
      status: 'review_fail',
      meta: { reviewIteration: 1, reviewMaxIterations: 3 },
      structuredFindings: [makeFinding()],
    })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="review-fail-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="patch-required"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btn-patch-rereview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btn-rereview-only"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="iteration-info"]').text()).toContain('iteration 1 of 3')
    expect(wrapper.find('[data-testid="iteration-info"]').text()).toContain('2 remaining')
  })

  it('hides patch button at max iterations, still shows re-review', () => {
    const task = makeTask({
      status: 'review_fail',
      meta: { reviewIteration: 3, reviewMaxIterations: 3 },
    })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="btn-patch-rereview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btn-rereview-only"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="iteration-info"]').text()).toContain('0 remaining')
  })

  it('shows escalated banner with force re-review button', () => {
    const task = makeTask({
      status: 'escalated',
      meta: { reviewIteration: 3, reviewMaxIterations: 3 },
      structuredFindings: [makeFinding({ severity: 'critical' })],
    })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="escalated-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btn-force-rereview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="review-fail-banner"]').exists()).toBe(false)
  })

  it('shows no review banners for review_pass', () => {
    const task = makeTask({ status: 'review_pass' })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="review-fail-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="escalated-banner"]').exists()).toBe(false)
  })

  it('shows no review banners for running', () => {
    const task = makeTask({ status: 'running' })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="review-fail-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="escalated-banner"]').exists()).toBe(false)
  })

  it('renders structured findings in detail view', () => {
    const task = makeTask({
      status: 'review_fail',
      structuredFindings: [
        makeFinding({ id: 'F1', severity: 'critical', issue: 'XSS bug' }),
        makeFinding({ id: 'F2', severity: 'minor', issue: 'Style issue' }),
      ],
    })
    const wrapper = mount(ReviewDetailPage, { props: { task } })

    expect(wrapper.find('[data-testid="findings-section"]').exists()).toBe(true)
    expect(wrapper.findAll('.finding')).toHaveLength(2)
    expect(wrapper.find('[data-testid="finding-F1"]').text()).toContain('critical')
    expect(wrapper.find('[data-testid="finding-F1"]').text()).toContain('XSS bug')
    expect(wrapper.find('[data-testid="finding-F2"]').text()).toContain('minor')
  })

  it('renders review iteration history when multiple review events', () => {
    const task = makeTask({ status: 'review_fail', meta: { reviewIteration: 2, reviewMaxIterations: 3 } })
    const reviewEvents: TaskEvent[] = [
      { id: 'e1', taskId: 'task-001', status: 'review_fail', phase: 'review', message: 'Fail iter 1', meta: {}, createdAt: '2025-01-01T00:00:00Z' },
      { id: 'e2', taskId: 'task-001', status: 'review_fail', phase: 'review', message: 'Fail iter 2', meta: {}, createdAt: '2025-01-01T01:00:00Z' },
    ]
    const wrapper = mount(ReviewDetailPage, { props: { task, reviewEvents } })

    expect(wrapper.find('[data-testid="iteration-history"]').exists()).toBe(true)
    expect(wrapper.findAll('.iter-entry')).toHaveLength(2)
    expect(wrapper.find('[data-testid="iter-0"]').text()).toContain('review_fail')
    expect(wrapper.find('[data-testid="iter-0"]').text()).toContain('Fail iter 1')
  })

  it('hides iteration history when only one review event', () => {
    const task = makeTask({ status: 'review_fail' })
    const reviewEvents: TaskEvent[] = [
      { id: 'e1', taskId: 'task-001', status: 'review_fail', phase: 'review', message: 'Fail', meta: {}, createdAt: '2025-01-01T00:00:00Z' },
    ]
    const wrapper = mount(ReviewDetailPage, { props: { task, reviewEvents } })

    expect(wrapper.find('[data-testid="iteration-history"]').exists()).toBe(false)
  })
})

// ── Reviews page action hints rendering ───────────────────────────────────

const ReviewsListPage = defineComponent({
  props: {
    tasks: { type: Array as () => Task[], default: () => [] },
  },
  setup(props) {
    const reviewTasks = computed(() => filterReviewTasks(props.tasks))
    function iterationsLeft(task: Task) {
      const info = getIterationInfo(task)
      return info ? info.remaining : null
    }
    return {
      reviewTasks,
      truncateId,
      getReviewCardSummary,
      canRequestPatch,
      canRequestReReview,
      getIterationInfo,
      iterationsLeft,
    }
  },
  template: `
    <div>
      <div v-for="task in reviewTasks" :key="task.id" :data-testid="'card-' + task.id" class="card">
        <span class="status">{{ task.status }}</span>
        <span class="summary">{{ getReviewCardSummary(task) }}</span>
        <div v-if="task.status === 'review_fail' && canRequestPatch(task)" data-testid="action-patch" class="action-hint">
          Patch available
          <span v-if="iterationsLeft(task) !== null" class="iterations-left">
            {{ iterationsLeft(task) }} iterations left
          </span>
        </div>
        <div v-else-if="task.status === 'escalated'" data-testid="action-escalated" class="action-hint">
          Manual intervention required
        </div>
      </div>
    </div>
  `,
})

describe('Reviews list page action hints', () => {
  it('shows patch hint for review_fail with iterations remaining', () => {
    const tasks = [
      makeTask({ id: 'rf', status: 'review_fail', meta: { reviewIteration: 1, reviewMaxIterations: 3 } }),
    ]
    const wrapper = mount(ReviewsListPage, { props: { tasks } })

    expect(wrapper.find('[data-testid="action-patch"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="action-patch"]').text()).toContain('Patch available')
    expect(wrapper.find('.iterations-left').text()).toContain('2 iterations left')
  })

  it('does not show patch hint for review_fail at max iterations', () => {
    const tasks = [
      makeTask({ id: 'rf', status: 'review_fail', meta: { reviewIteration: 3, reviewMaxIterations: 3 } }),
    ]
    const wrapper = mount(ReviewsListPage, { props: { tasks } })

    expect(wrapper.find('[data-testid="action-patch"]').exists()).toBe(false)
  })

  it('shows escalated hint for escalated tasks', () => {
    const tasks = [
      makeTask({ id: 'esc', status: 'escalated' }),
    ]
    const wrapper = mount(ReviewsListPage, { props: { tasks } })

    expect(wrapper.find('[data-testid="action-escalated"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="action-escalated"]').text()).toContain('Manual intervention required')
  })

  it('shows no action hints for review_pass', () => {
    const tasks = [
      makeTask({ id: 'rp', status: 'review_pass' }),
    ]
    const wrapper = mount(ReviewsListPage, { props: { tasks } })

    expect(wrapper.find('[data-testid="action-patch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="action-escalated"]').exists()).toBe(false)
  })
})
