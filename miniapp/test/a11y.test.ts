import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, computed } from 'vue'
import type { Task, TaskEvent } from '~/lib/types'
import { applyFilters } from '~/lib/filters'
import { mapWorkerStatus, getStatusLabel, getStatusColor, formatRelativeTime } from '~/lib/mappers'
import { validateResumePayload } from '~/lib/resume'

// Accessibility assertion tests for miniapp UI components.
// Validates aria attributes, roles, focus-visible classes, and semantic HTML.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    mode: 'implement',
    status: 'running',
    internalStatus: 'started',
    branch: 'feature/test',
    repoPath: '/repo',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    message: 'Test task',
    meta: {},
    userId: 1,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'evt-001',
    taskId: 'task-001',
    status: 'progress',
    phase: 'claude',
    message: 'Processing',
    meta: {},
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

// -- Simplified components mirroring real templates with a11y attributes --

const ErrorStateComponent = defineComponent({
  props: { message: { type: String, required: true } },
  template: `
    <div role="alert" class="flex flex-col items-center justify-center py-12 text-center">
      <div aria-hidden="true" class="text-4xl mb-4 text-destructive/50">!</div>
      <h3 class="text-lg font-medium text-destructive">Something went wrong</h3>
      <p class="mt-1 text-sm text-muted-foreground">{{ message }}</p>
      <button class="mt-4 rounded bg-primary px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="$emit('retry')">Retry</button>
    </div>
  `,
})

const EmptyStateComponent = defineComponent({
  props: { title: { type: String, required: true }, description: String },
  template: `
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <div aria-hidden="true" class="text-4xl mb-4 text-muted-foreground/40">--</div>
      <h3 class="text-lg font-medium">{{ title }}</h3>
      <p v-if="description" class="mt-1 text-sm text-muted-foreground">{{ description }}</p>
    </div>
  `,
})

const StaleIndicatorComponent = defineComponent({
  props: { isStale: { type: Boolean, default: false } },
  template: `
    <div v-if="isStale" role="status" aria-live="polite" class="flex items-center gap-1">
      <span aria-hidden="true" class="h-2 w-2 rounded-full bg-warning"/>
      Live updates unavailable
    </div>
  `,
})

const TasksFilterComponent = defineComponent({
  setup() {
    const statusFilter = ref('')
    const searchQuery = ref('')
    const tasks = ref<Task[]>([makeTask()])
    const filteredTasks = computed(() =>
      applyFilters(tasks.value, statusFilter.value as '' | Task['status'], searchQuery.value),
    )
    return { statusFilter, searchQuery, filteredTasks }
  },
  template: `
    <div>
      <input v-model="searchQuery" aria-label="Search tasks" placeholder="Search tasks..." data-testid="search" />
      <div role="group" aria-label="Filter by status">
        <button
          v-for="s in ['', 'running', 'needs_input']" :key="s"
          :aria-pressed="String(statusFilter === s)"
          :data-testid="'filter-' + (s || 'all')"
          class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @click="statusFilter = s"
        >{{ s || 'All' }}</button>
      </div>
    </div>
  `,
})

const ResumeFormComponent = defineComponent({
  props: {
    taskId: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: Array as () => string[], default: () => [] },
  },
  setup(props) {
    const answer = ref('')
    const canSubmit = computed(() => answer.value.trim().length > 0)
    return { answer, canSubmit }
  },
  template: `
    <div>
      <h4 :id="'question-' + taskId">{{ question }}</h4>
      <div v-if="options.length" role="group" :aria-label="'Options for: ' + question">
        <button
          v-for="opt in options" :key="opt"
          :aria-pressed="String(answer === opt)"
          class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @click="answer = opt"
        >{{ opt }}</button>
      </div>
      <textarea
        v-model="answer"
        :aria-labelledby="'question-' + taskId"
        data-testid="answer"
      />
      <button :disabled="!canSubmit" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="submit">
        Send Answer
      </button>
    </div>
  `,
})

const TimelineComponent = defineComponent({
  props: { events: { type: Array as () => TaskEvent[], required: true } },
  setup() {
    return { getStatusLabel, mapWorkerStatus, getStatusColor, formatRelativeTime }
  },
  template: `
    <div role="list" aria-label="Event timeline">
      <div v-for="(event, idx) in events" :key="event.id" role="listitem" class="flex gap-3">
        <div aria-hidden="true">
          <div class="h-3 w-3 rounded-full" />
          <div v-if="idx < events.length - 1" class="w-px bg-border" />
        </div>
        <div>
          <span>{{ getStatusLabel(mapWorkerStatus(event.status)) }}</span>
          <span>{{ event.phase }}</span>
        </div>
      </div>
    </div>
  `,
})

// -- Tests --

describe('Accessibility: ErrorState', () => {
  it('has role="alert" on container', () => {
    const wrapper = mount(ErrorStateComponent, { props: { message: 'Oops' } })
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('decorative icon has aria-hidden', () => {
    const wrapper = mount(ErrorStateComponent, { props: { message: 'Oops' } })
    expect(wrapper.find('[aria-hidden="true"]').text()).toBe('!')
  })

  it('retry button has focus-visible ring class', () => {
    const wrapper = mount(ErrorStateComponent, { props: { message: 'Oops' } })
    const btn = wrapper.find('button')
    expect(btn.classes()).toContain('focus-visible:ring-2')
  })
})

describe('Accessibility: EmptyState', () => {
  it('decorative icon has aria-hidden', () => {
    const wrapper = mount(EmptyStateComponent, { props: { title: 'Nothing here' } })
    expect(wrapper.find('[aria-hidden="true"]').text()).toBe('--')
  })
})

describe('Accessibility: StaleIndicator', () => {
  it('has role="status" and aria-live="polite"', () => {
    const wrapper = mount(StaleIndicatorComponent, { props: { isStale: true } })
    const el = wrapper.find('[role="status"]')
    expect(el.exists()).toBe(true)
    expect(el.attributes('aria-live')).toBe('polite')
  })

  it('decorative dot has aria-hidden', () => {
    const wrapper = mount(StaleIndicatorComponent, { props: { isStale: true } })
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(true)
  })
})

describe('Accessibility: Tasks filter controls', () => {
  it('search input has aria-label', () => {
    const wrapper = mount(TasksFilterComponent)
    const input = wrapper.find('input')
    expect(input.attributes('aria-label')).toBe('Search tasks')
  })

  it('filter group has role="group" and aria-label', () => {
    const wrapper = mount(TasksFilterComponent)
    const group = wrapper.find('[role="group"]')
    expect(group.exists()).toBe(true)
    expect(group.attributes('aria-label')).toBe('Filter by status')
  })

  it('filter buttons have aria-pressed reflecting state', async () => {
    const wrapper = mount(TasksFilterComponent)
    const allBtn = wrapper.find('[data-testid="filter-all"]')
    expect(allBtn.attributes('aria-pressed')).toBe('true')

    const runningBtn = wrapper.find('[data-testid="filter-running"]')
    expect(runningBtn.attributes('aria-pressed')).toBe('false')

    await runningBtn.trigger('click')
    expect(runningBtn.attributes('aria-pressed')).toBe('true')
    expect(allBtn.attributes('aria-pressed')).toBe('false')
  })

  it('filter buttons have focus-visible ring class', () => {
    const wrapper = mount(TasksFilterComponent)
    const buttons = wrapper.findAll('button')
    for (const btn of buttons) {
      expect(btn.classes()).toContain('focus-visible:ring-2')
    }
  })
})

describe('Accessibility: ResumeForm', () => {
  it('textarea has aria-labelledby pointing to question heading', () => {
    const wrapper = mount(ResumeFormComponent, {
      props: { taskId: 'task-1', question: 'Which DB?' },
    })
    const textarea = wrapper.find('textarea')
    expect(textarea.attributes('aria-labelledby')).toBe('question-task-1')
    expect(wrapper.find('#question-task-1').text()).toBe('Which DB?')
  })

  it('option buttons have aria-pressed', async () => {
    const wrapper = mount(ResumeFormComponent, {
      props: { taskId: 'task-1', question: 'Pick one', options: ['A', 'B'] },
    })
    const buttons = wrapper.findAll('[role="group"] button')
    expect(buttons[0].attributes('aria-pressed')).toBe('false')
    expect(buttons[1].attributes('aria-pressed')).toBe('false')

    await buttons[0].trigger('click')
    expect(buttons[0].attributes('aria-pressed')).toBe('true')
    expect(buttons[1].attributes('aria-pressed')).toBe('false')
  })

  it('options group has role="group" with descriptive aria-label', () => {
    const wrapper = mount(ResumeFormComponent, {
      props: { taskId: 'task-1', question: 'Pick one', options: ['A'] },
    })
    const group = wrapper.find('[role="group"]')
    expect(group.attributes('aria-label')).toBe('Options for: Pick one')
  })
})

describe('Accessibility: TaskTimeline', () => {
  it('timeline container has role="list" and aria-label', () => {
    const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })]
    const wrapper = mount(TimelineComponent, { props: { events } })
    const list = wrapper.find('[role="list"]')
    expect(list.exists()).toBe(true)
    expect(list.attributes('aria-label')).toBe('Event timeline')
  })

  it('each timeline entry has role="listitem"', () => {
    const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })]
    const wrapper = mount(TimelineComponent, { props: { events } })
    expect(wrapper.findAll('[role="listitem"]')).toHaveLength(2)
  })

  it('connector line is hidden on last event', () => {
    const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })]
    const wrapper = mount(TimelineComponent, { props: { events } })
    const items = wrapper.findAll('[role="listitem"]')
    // First item should have connector
    expect(items[0].find('.bg-border').exists()).toBe(true)
    // Last item should not have connector
    expect(items[1].find('.bg-border').exists()).toBe(false)
  })

  it('timeline dot decoration is aria-hidden', () => {
    const events = [makeEvent({ id: 'e1' })]
    const wrapper = mount(TimelineComponent, { props: { events } })
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(true)
  })
})
