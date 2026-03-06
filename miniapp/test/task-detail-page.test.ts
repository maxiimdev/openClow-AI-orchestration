import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { Task, TaskEvent } from '~/lib/types'
import { mapWorkerStatus, getStatusLabel, getStatusColor, formatRelativeTime, truncateId } from '~/lib/mappers'

// Smoke test: verifies /tasks/[id] detail page rendering logic.
// Uses a simplified component mirroring the real page's template.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001-auth-refactor',
    mode: 'implement',
    status: 'running',
    internalStatus: 'progress',
    branch: 'feature/auth-refactor',
    repoPath: '/app',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:05:00Z',
    message: 'Claude subprocess spawned',
    meta: {},
    userId: 1,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'evt-001',
    taskId: 'task-001-auth-refactor',
    status: 'progress',
    phase: 'claude',
    message: 'Processing',
    meta: {},
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

// Simplified detail page component mirroring the real [id].vue
const TaskDetailPage = defineComponent({
  props: {
    task: { type: Object as () => Task | null, default: null },
    events: { type: Array as () => TaskEvent[], default: () => [] },
    isPending: { type: Boolean, default: false },
    error: { type: Object as () => Error | null, default: null },
    isStale: { type: Boolean, default: false },
  },
  setup() {
    return { truncateId, formatRelativeTime, getStatusLabel, mapWorkerStatus, getStatusColor }
  },
  template: `
    <div class="p-4">
      <div v-if="isStale" data-testid="stale-indicator" class="stale-banner">Live updates unavailable</div>
      <a data-testid="back-link" href="/tasks">&larr; Tasks</a>

      <div v-if="isPending" data-testid="loading">
        <div class="skeleton" />
      </div>

      <div v-else-if="error" data-testid="error">{{ error.message }}</div>

      <template v-else-if="task">
        <div data-testid="task-meta" class="task-meta">
          <span data-testid="task-id">{{ truncateId(task.id, 20) }}</span>
          <span data-testid="task-status">{{ task.status }}</span>
          <span data-testid="task-mode">{{ task.mode }}</span>
          <span v-if="task.branch" data-testid="task-branch">{{ task.branch }}</span>
          <span v-if="task.message" data-testid="task-message">{{ task.message }}</span>
          <span data-testid="task-updated">{{ formatRelativeTime(task.updatedAt) }}</span>
        </div>

        <div v-if="task.result" data-testid="result-block" class="result-block">
          <span data-testid="exit-code">exit {{ task.result.exitCode }}</span>
          <span data-testid="duration">{{ (task.result.durationMs / 1000).toFixed(1) }}s</span>
          <span v-if="task.result.truncated" data-testid="truncated">(truncated)</span>
          <pre v-if="task.result.stdout" data-testid="stdout">{{ task.result.stdout }}</pre>
          <pre v-if="task.result.stderr" data-testid="stderr">{{ task.result.stderr }}</pre>
        </div>

        <div v-if="!events.length" data-testid="no-events">No events yet</div>
        <div v-else data-testid="timeline">
          <div v-for="event in events" :key="event.id" :data-testid="'event-' + event.id" class="timeline-event">
            <span class="event-label">{{ getStatusLabel(mapWorkerStatus(event.status)) }}</span>
            <span class="event-phase">{{ event.phase }}</span>
            <span class="event-message">{{ event.message }}</span>
          </div>
        </div>
      </template>
    </div>
  `,
})

describe('Task detail page smoke test', () => {
  it('renders task meta block', () => {
    const task = makeTask()
    const wrapper = mount(TaskDetailPage, { props: { task } })
    expect(wrapper.find('[data-testid="task-meta"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-id"]').text()).toContain('task-001-auth-refact')
    expect(wrapper.find('[data-testid="task-status"]').text()).toBe('running')
    expect(wrapper.find('[data-testid="task-mode"]').text()).toBe('implement')
    expect(wrapper.find('[data-testid="task-branch"]').text()).toBe('feature/auth-refactor')
  })

  it('shows loading state', () => {
    const wrapper = mount(TaskDetailPage, { props: { isPending: true } })
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-meta"]').exists()).toBe(false)
  })

  it('shows error state', () => {
    const wrapper = mount(TaskDetailPage, { props: { error: new Error('Not found') } })
    expect(wrapper.find('[data-testid="error"]').text()).toContain('Not found')
  })

  it('shows empty events state', () => {
    const task = makeTask()
    const wrapper = mount(TaskDetailPage, { props: { task, events: [] } })
    expect(wrapper.find('[data-testid="no-events"]').exists()).toBe(true)
  })

  it('renders event timeline', () => {
    const task = makeTask()
    const events = [
      makeEvent({ id: 'evt-001', status: 'claimed', phase: 'pull', message: 'Task claimed' }),
      makeEvent({ id: 'evt-002', status: 'progress', phase: 'claude', message: 'Working' }),
    ]
    const wrapper = mount(TaskDetailPage, { props: { task, events } })
    expect(wrapper.find('[data-testid="timeline"]').exists()).toBe(true)
    expect(wrapper.findAll('.timeline-event')).toHaveLength(2)
    expect(wrapper.find('[data-testid="event-evt-001"]').text()).toContain('Task claimed')
  })

  it('shows stale indicator when SSE is disconnected', () => {
    const task = makeTask()
    const wrapper = mount(TaskDetailPage, { props: { task, isStale: true } })
    expect(wrapper.find('[data-testid="stale-indicator"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stale-indicator"]').text()).toContain('Live updates unavailable')
  })

  it('hides stale indicator when SSE is connected', () => {
    const task = makeTask()
    const wrapper = mount(TaskDetailPage, { props: { task, isStale: false } })
    expect(wrapper.find('[data-testid="stale-indicator"]').exists()).toBe(false)
  })

  it('renders result block for completed task', () => {
    const task = makeTask({
      status: 'completed',
      internalStatus: 'completed',
      result: { stdout: 'Done!', stderr: '', truncated: false, exitCode: 0, durationMs: 12345 },
    })
    const wrapper = mount(TaskDetailPage, { props: { task } })
    expect(wrapper.find('[data-testid="result-block"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="exit-code"]').text()).toBe('exit 0')
    expect(wrapper.find('[data-testid="duration"]').text()).toBe('12.3s')
    expect(wrapper.find('[data-testid="stdout"]').text()).toBe('Done!')
  })

  it('shows truncated badge when result is truncated', () => {
    const task = makeTask({
      status: 'completed',
      internalStatus: 'completed',
      result: { stdout: '...', stderr: '', truncated: true, exitCode: 0, durationMs: 5000 },
    })
    const wrapper = mount(TaskDetailPage, { props: { task } })
    expect(wrapper.find('[data-testid="truncated"]').exists()).toBe(true)
  })

  it('renders stderr in result block', () => {
    const task = makeTask({
      status: 'failed',
      internalStatus: 'failed',
      result: { stdout: '', stderr: 'Error: something broke', truncated: false, exitCode: 1, durationMs: 2000 },
    })
    const wrapper = mount(TaskDetailPage, { props: { task } })
    expect(wrapper.find('[data-testid="stderr"]').text()).toContain('Error: something broke')
    expect(wrapper.find('[data-testid="exit-code"]').text()).toBe('exit 1')
  })

  it('has back link to tasks list', () => {
    const task = makeTask()
    const wrapper = mount(TaskDetailPage, { props: { task } })
    expect(wrapper.find('[data-testid="back-link"]').attributes('href')).toBe('/tasks')
  })
})
