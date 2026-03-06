import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import type { Task } from '~/lib/types'
import { validateResumePayload } from '~/lib/resume'

// Smoke test: verifies inbox page rendering + resume flow logic.
// Uses a simplified component mirroring the real inbox.vue template.

function makeNeedsInputTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-002-db',
    mode: 'implement',
    status: 'needs_input',
    internalStatus: 'needs_input',
    branch: 'feature/db',
    repoPath: '/app',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T01:00:00Z',
    message: 'Waiting for user input',
    meta: {},
    question: 'Which database engine?',
    options: ['PostgreSQL', 'SQLite', 'MySQL'],
    needsInputAt: '2025-01-01T01:00:00Z',
    userId: 1,
    ...overrides,
  }
}

// Simplified InboxPage component mirroring real inbox.vue + ResumeForm logic
const InboxPage = defineComponent({
  props: {
    tasks: { type: Array as () => Task[], default: () => [] },
    isPending: { type: Boolean, default: false },
    error: { type: Object as () => Error | null, default: null },
    onResume: { type: Function, default: () => Promise.resolve() },
  },
  setup(props) {
    const answers = ref<Record<string, string>>({})
    const submitting = ref<Record<string, boolean>>({})
    const submitError = ref<Record<string, string>>({})
    const validationErrors = ref<Record<string, string>>({})
    const resumed = ref<string[]>([])

    async function submit(taskId: string) {
      validationErrors.value[taskId] = ''
      submitError.value[taskId] = ''
      const answer = answers.value[taskId] || ''
      const result = validateResumePayload({ answer })
      if (!result.valid) {
        validationErrors.value[taskId] = result.error || 'Invalid'
        return
      }
      submitting.value[taskId] = true
      try {
        await props.onResume(taskId, answer.trim())
        resumed.value.push(taskId)
        answers.value[taskId] = ''
      } catch (e) {
        submitError.value[taskId] = (e as Error).message
      } finally {
        submitting.value[taskId] = false
      }
    }

    function selectOption(taskId: string, option: string) {
      answers.value[taskId] = option
    }

    return { answers, submitting, submitError, validationErrors, resumed, submit, selectOption }
  },
  template: `
    <div class="p-4">
      <h1>Awaiting Input</h1>
      <div v-if="isPending" data-testid="loading">Loading...</div>
      <div v-else-if="error" data-testid="error">{{ error.message }}</div>
      <div v-else-if="!tasks.length" data-testid="empty">No pending questions</div>
      <div v-else data-testid="inbox-list">
        <div v-for="task in tasks" :key="task.id" :data-testid="'inbox-' + task.id" class="inbox-card">
          <span class="task-id">{{ task.id }}</span>
          <div v-if="task.question" class="resume-form">
            <span class="question">{{ task.question }}</span>
            <div v-if="task.options?.length" class="options">
              <button
                v-for="opt in task.options" :key="opt"
                :data-testid="'opt-' + opt"
                :class="{ selected: answers[task.id] === opt }"
                @click="selectOption(task.id, opt)"
              >{{ opt }}</button>
            </div>
            <textarea
              v-model="answers[task.id]"
              :data-testid="'answer-' + task.id"
              placeholder="Type your answer..."
            />
            <button
              :data-testid="'submit-' + task.id"
              :disabled="!(answers[task.id] || '').trim() || submitting[task.id]"
              @click="submit(task.id)"
            >{{ submitting[task.id] ? 'Sending...' : 'Send Answer' }}</button>
            <span v-if="validationErrors[task.id]" data-testid="validation-error" class="error">{{ validationErrors[task.id] }}</span>
            <span v-if="submitError[task.id]" data-testid="submit-error" class="error">{{ submitError[task.id] }}</span>
            <span v-if="resumed.includes(task.id)" data-testid="resumed-badge">Resumed</span>
          </div>
        </div>
      </div>
    </div>
  `,
})

describe('Inbox page smoke test', () => {
  it('shows loading state', () => {
    const wrapper = mount(InboxPage, { props: { isPending: true } })
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)
  })

  it('shows empty state with no tasks', () => {
    const wrapper = mount(InboxPage, { props: { tasks: [] } })
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(true)
  })

  it('shows error state', () => {
    const wrapper = mount(InboxPage, { props: { error: new Error('Failed to fetch') } })
    expect(wrapper.find('[data-testid="error"]').text()).toContain('Failed to fetch')
  })

  it('renders needs_input tasks with questions', () => {
    const tasks = [
      makeNeedsInputTask({ id: 'task-A' }),
      makeNeedsInputTask({ id: 'task-B', question: 'Config path?', options: null }),
    ]
    const wrapper = mount(InboxPage, { props: { tasks } })
    expect(wrapper.findAll('.inbox-card')).toHaveLength(2)
    expect(wrapper.find('[data-testid="inbox-task-A"]').text()).toContain('Which database engine?')
    expect(wrapper.find('[data-testid="inbox-task-B"]').text()).toContain('Config path?')
  })

  it('displays option buttons for tasks with options', () => {
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()] } })
    expect(wrapper.find('[data-testid="opt-PostgreSQL"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="opt-SQLite"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="opt-MySQL"]').exists()).toBe(true)
  })

  it('selecting option fills the answer', async () => {
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()] } })
    await wrapper.find('[data-testid="opt-PostgreSQL"]').trigger('click')
    // Verify by checking the textarea value reflects the selected option
    const textarea = wrapper.find('[data-testid="answer-task-002-db"]')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('PostgreSQL')
  })

  it('submit button is disabled when answer is empty', () => {
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()] } })
    const btn = wrapper.find('[data-testid="submit-task-002-db"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('submit button is enabled after entering answer', async () => {
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()] } })
    await wrapper.find('[data-testid="answer-task-002-db"]').setValue('PostgreSQL')
    const btn = wrapper.find('[data-testid="submit-task-002-db"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('successful resume shows resumed badge', async () => {
    const onResume = vi.fn().mockResolvedValue(undefined)
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()], onResume } })
    await wrapper.find('[data-testid="answer-task-002-db"]').setValue('PostgreSQL')
    await wrapper.find('[data-testid="submit-task-002-db"]').trigger('click')
    await nextTick()
    // Wait for async onResume to resolve
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="resumed-badge"]').exists()).toBe(true)
    })
    expect(onResume).toHaveBeenCalledWith('task-002-db', 'PostgreSQL')
  })

  it('failed resume shows error message', async () => {
    const onResume = vi.fn().mockRejectedValue(new Error('API 409: task_not_awaiting_input'))
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()], onResume } })
    await wrapper.find('[data-testid="answer-task-002-db"]').setValue('PostgreSQL')
    await wrapper.find('[data-testid="submit-task-002-db"]').trigger('click')
    await nextTick()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="submit-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-testid="submit-error"]').text()).toContain('task_not_awaiting_input')
  })

  it('prevents submission of whitespace-only answer', async () => {
    const onResume = vi.fn()
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()], onResume } })
    await wrapper.find('[data-testid="answer-task-002-db"]').setValue('   ')
    await nextTick()
    // Button should remain disabled for whitespace-only input
    const btn = wrapper.find('[data-testid="submit-task-002-db"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('disables submit button while pending', async () => {
    let resolveResume!: () => void
    const onResume = vi.fn().mockImplementation(() => new Promise<void>(r => { resolveResume = r }))
    const wrapper = mount(InboxPage, { props: { tasks: [makeNeedsInputTask()], onResume } })
    await wrapper.find('[data-testid="answer-task-002-db"]').setValue('PostgreSQL')
    await wrapper.find('[data-testid="submit-task-002-db"]').trigger('click')
    await nextTick()
    // Button should be disabled while submitting
    expect((wrapper.find('[data-testid="submit-task-002-db"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="submit-task-002-db"]').text()).toBe('Sending...')
    resolveResume()
  })
})
