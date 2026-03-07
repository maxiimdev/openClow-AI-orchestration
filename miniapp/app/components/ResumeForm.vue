<script setup lang="ts">
import { useResumeTask } from '~/composables/useTasks'
import { validateResumePayload } from '~/lib/resume'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import CardHeader from '~/components/ui/card/CardHeader.vue'
import CardTitle from '~/components/ui/card/CardTitle.vue'
import Button from '~/components/ui/button/Button.vue'
import Textarea from '~/components/ui/textarea/Textarea.vue'

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
  <Card class="border-warning/30 bg-warning-muted">
    <CardHeader class="pb-2">
      <CardTitle :id="`question-${taskId}`" class="text-base text-warning-muted-foreground">{{ question }}</CardTitle>
    </CardHeader>
    <CardContent>
      <div v-if="options?.length" class="space-y-2" role="group" :aria-label="`Options for: ${question}`">
        <Button
          v-for="opt in options" :key="opt"
          variant="outline"
          class="w-full justify-start text-left"
          :class="answer === opt ? 'border-warning bg-warning-muted' : ''"
          :aria-pressed="answer === opt"
          @click="answer = opt"
        >
          {{ opt }}
        </Button>
      </div>
      <Textarea
        v-model="answer"
        :placeholder="options?.length ? 'Or type a custom answer...' : 'Type your answer...'"
        :aria-labelledby="`question-${taskId}`"
        class="mt-3"
      />
      <div class="mt-2 flex items-center gap-2">
        <Button
          :disabled="!canSubmit"
          size="sm"
          @click="submit"
        >
          {{ isPending ? 'Sending...' : 'Send Answer' }}
        </Button>
        <span v-if="validationError" class="text-xs text-destructive">{{ validationError }}</span>
        <span v-else-if="error" class="text-xs text-destructive">{{ (error as Error).message }}</span>
      </div>
    </CardContent>
  </Card>
</template>
