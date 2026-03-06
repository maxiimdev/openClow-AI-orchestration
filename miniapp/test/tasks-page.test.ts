import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, computed, defineComponent } from 'vue'
import { applyFilters } from '~/lib/filters'
import type { Task } from '~/lib/types'

// Smoke test: verifies /tasks page rendering logic with mocked API data.
// We test a simplified TasksPage component that mirrors the real page's
// template and logic, avoiding Nuxt auto-import complexity.

function makeTask(overrides: Partial<Task>): Task {
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

const mockTasks: Task[] = [
  makeTask({ id: 'task-001-auth', status: 'running', message: 'Add auth module', branch: 'feature/auth' }),
  makeTask({ id: 'task-002-db', status: 'needs_input', message: 'Database migration', branch: 'feature/db' }),
  makeTask({ id: 'task-003-api', status: 'review_pass', message: 'API review', branch: 'feature/api' }),
]

// Lightweight component mirroring the real tasks/index.vue template logic
const TasksPage = defineComponent({
  props: {
    tasks: { type: Array as () => Task[], default: () => [] },
    isPending: { type: Boolean, default: false },
    error: { type: Object as () => Error | null, default: null },
  },
  setup(props) {
    const statusFilter = ref('')
    const searchQuery = ref('')
    const filteredTasks = computed(() =>
      applyFilters(props.tasks, statusFilter.value as '' | Task['status'], searchQuery.value),
    )
    return { statusFilter, searchQuery, filteredTasks }
  },
  template: `
    <div class="p-4">
      <h1 class="text-2xl font-bold mb-4">Tasks</h1>
      <input v-model="searchQuery" data-testid="search" placeholder="Search tasks..." />
      <div class="flex gap-2">
        <button
          v-for="s in ['', 'running', 'needs_input', 'review_pass']"
          :key="s"
          :data-testid="'filter-' + (s || 'all')"
          :class="{ active: statusFilter === s }"
          @click="statusFilter = s"
        >{{ s || 'All' }}</button>
      </div>
      <div v-if="isPending" data-testid="loading">Loading...</div>
      <div v-else-if="error" data-testid="error">{{ error.message }}</div>
      <div v-else-if="!filteredTasks.length" data-testid="empty">No tasks</div>
      <div v-else data-testid="task-list">
        <div v-for="task in filteredTasks" :key="task.id" :data-testid="'task-' + task.id" class="task-card">
          <span class="task-id">{{ task.id }}</span>
          <span class="task-status">{{ task.status }}</span>
          <span class="task-message">{{ task.message }}</span>
        </div>
      </div>
    </div>
  `,
})

describe('Tasks page smoke test', () => {
  it('renders task list with mock data', () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    expect(wrapper.find('[data-testid="task-list"]').exists()).toBe(true)
    expect(wrapper.findAll('.task-card')).toHaveLength(3)
    expect(wrapper.find('[data-testid="task-task-001-auth"]').text()).toContain('Add auth module')
  })

  it('shows loading state', () => {
    const wrapper = mount(TasksPage, { props: { isPending: true } })
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-list"]').exists()).toBe(false)
  })

  it('shows error state', () => {
    const wrapper = mount(TasksPage, { props: { error: new Error('Network error') } })
    expect(wrapper.find('[data-testid="error"]').text()).toContain('Network error')
  })

  it('shows empty state when no tasks match', async () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    const input = wrapper.find('[data-testid="search"]')
    await input.setValue('nonexistent-xyz')
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(true)
  })

  it('filters by status when pill is clicked', async () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    await wrapper.find('[data-testid="filter-running"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(1)
    expect(wrapper.find('[data-testid="task-task-001-auth"]').exists()).toBe(true)
  })

  it('filters by search query', async () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    await wrapper.find('[data-testid="search"]').setValue('migration')
    expect(wrapper.findAll('.task-card')).toHaveLength(1)
    expect(wrapper.find('[data-testid="task-task-002-db"]').exists()).toBe(true)
  })

  it('combines status and search filters', async () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    await wrapper.find('[data-testid="filter-running"]').trigger('click')
    await wrapper.find('[data-testid="search"]').setValue('auth')
    expect(wrapper.findAll('.task-card')).toHaveLength(1)

    // Now search for something that doesn't match the status-filtered results
    await wrapper.find('[data-testid="search"]').setValue('migration')
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(true)
  })

  it('resets to all tasks when All filter is clicked', async () => {
    const wrapper = mount(TasksPage, { props: { tasks: mockTasks } })
    await wrapper.find('[data-testid="filter-running"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(1)

    await wrapper.find('[data-testid="filter-all"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(3)
  })
})
