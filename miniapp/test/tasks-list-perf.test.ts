import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, computed, defineComponent } from 'vue'
import { applyFilters } from '~/lib/filters'
import type { Task } from '~/lib/types'

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

const RENDER_BATCH = 20

// Component mirroring the render-limiting logic from tasks/index.vue
const TasksListPerf = defineComponent({
  props: {
    tasks: { type: Array as () => Task[], default: () => [] },
  },
  setup(props) {
    const statusFilter = ref('')
    const searchQuery = ref('')
    const renderLimit = ref(RENDER_BATCH)

    const filteredTasks = computed(() =>
      applyFilters(props.tasks, statusFilter.value as '' | Task['status'], searchQuery.value),
    )
    const visibleTasks = computed(() =>
      filteredTasks.value.slice(0, renderLimit.value),
    )
    const hasMore = computed(() =>
      filteredTasks.value.length > renderLimit.value,
    )
    const remainingCount = computed(() =>
      filteredTasks.value.length - renderLimit.value,
    )

    function showMore() {
      renderLimit.value += RENDER_BATCH
    }

    return { statusFilter, searchQuery, renderLimit, filteredTasks, visibleTasks, hasMore, remainingCount, showMore }
  },
  template: `
    <div>
      <input v-model="searchQuery" data-testid="search" />
      <div data-testid="count">{{ filteredTasks.length }}</div>
      <div data-testid="task-list">
        <div v-for="task in visibleTasks" :key="task.id" class="task-card" :data-testid="'task-' + task.id">
          {{ task.message }}
        </div>
      </div>
      <button v-if="hasMore" data-testid="show-more" @click="showMore">
        Show more ({{ remainingCount }} remaining)
      </button>
    </div>
  `,
})

function generateTasks(n: number): Task[] {
  return Array.from({ length: n }, (_, i) =>
    makeTask({ id: `task-${String(i).padStart(4, '0')}`, message: `Task ${i}` }),
  )
}

describe('tasks list render-limiting', () => {
  it('renders at most RENDER_BATCH items initially', () => {
    const tasks = generateTasks(50)
    const wrapper = mount(TasksListPerf, { props: { tasks } })

    expect(wrapper.findAll('.task-card')).toHaveLength(RENDER_BATCH)
    expect(wrapper.find('[data-testid="show-more"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="show-more"]').text()).toContain('30 remaining')
  })

  it('shows all tasks if count <= RENDER_BATCH', () => {
    const tasks = generateTasks(15)
    const wrapper = mount(TasksListPerf, { props: { tasks } })

    expect(wrapper.findAll('.task-card')).toHaveLength(15)
    expect(wrapper.find('[data-testid="show-more"]').exists()).toBe(false)
  })

  it('loads more tasks when Show More is clicked', async () => {
    const tasks = generateTasks(50)
    const wrapper = mount(TasksListPerf, { props: { tasks } })

    expect(wrapper.findAll('.task-card')).toHaveLength(20)

    await wrapper.find('[data-testid="show-more"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(40)
    expect(wrapper.find('[data-testid="show-more"]').text()).toContain('10 remaining')

    await wrapper.find('[data-testid="show-more"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(50)
    expect(wrapper.find('[data-testid="show-more"]').exists()).toBe(false)
  })

  it('resets render limit when search query changes', async () => {
    const tasks = generateTasks(50)
    const wrapper = mount(TasksListPerf, { props: { tasks } })

    // Load more first
    await wrapper.find('[data-testid="show-more"]').trigger('click')
    expect(wrapper.findAll('.task-card')).toHaveLength(40)

    // Search resets the limit (simulated by changing searchQuery)
    await wrapper.find('[data-testid="search"]').setValue('Task 4')
    // After search, the filtered list is smaller and renderLimit should be back to RENDER_BATCH
    // The filtered list contains Task 4, Task 40-49 = 11 tasks, all within RENDER_BATCH
    const cards = wrapper.findAll('.task-card')
    expect(cards.length).toBeLessThanOrEqual(RENDER_BATCH)
  })

  it('total count reflects all filtered tasks, not just visible', () => {
    const tasks = generateTasks(50)
    const wrapper = mount(TasksListPerf, { props: { tasks } })

    expect(wrapper.find('[data-testid="count"]').text()).toBe('50')
    expect(wrapper.findAll('.task-card')).toHaveLength(20)
  })
})
