<script setup lang="ts">
import { useResumeTask } from '~/composables/useTasks'
import { validateResumePayload } from '~/lib/resume'

const props = defineProps<{
  taskId: string
  question: string
  options?: string[] | null
}>()

const emit = defineEmits<{ resumed: [] }>()

const answer = ref('')
const validationError = ref<string | null>(null)
const { mutate, isPending, error } = useResumeTask()

const canSubmit = computed(() => answer.value.trim().length > 0 && !isPending.value)

function submit() {
  validationError.value = null
  const result = validateResumePayload({ answer: answer.value })
  if (!result.valid) {
    validationError.value = result.error ?? 'Invalid input'
    return
  }
  mutate({ id: props.taskId, answer: answer.value.trim() }, {
    onSuccess: () => { answer.value = ''; emit('resumed') }
  })
}
</script>

<template>
  <div class="rounded-lg border border-warning/30 bg-warning-muted p-4">
    <h4 class="font-medium text-warning-muted-foreground">{{ question }}</h4>
    <div v-if="options?.length" class="mt-3 space-y-2">
      <button
        v-for="opt in options" :key="opt"
        class="block w-full rounded border px-3 py-2 text-left text-sm hover:bg-warning-muted transition-colors"
        :class="answer === opt ? 'border-warning bg-warning-muted' : 'border-border'"
        @click="answer = opt"
      >
        {{ opt }}
      </button>
    </div>
    <textarea
      v-model="answer"
      :placeholder="options?.length ? 'Or type a custom answer...' : 'Type your answer...'"
      class="mt-3 w-full rounded border border-input p-2 text-sm"
      rows="2"
    />
    <div class="mt-2 flex items-center gap-2">
      <button
        :disabled="!canSubmit"
        class="rounded bg-warning px-4 py-1.5 text-sm text-warning-foreground hover:bg-warning/90 disabled:opacity-50"
        @click="submit"
      >
        {{ isPending ? 'Sending...' : 'Send Answer' }}
      </button>
      <span v-if="validationError" class="text-xs text-destructive">{{ validationError }}</span>
      <span v-else-if="error" class="text-xs text-destructive">{{ (error as Error).message }}</span>
    </div>
  </div>
</template>
