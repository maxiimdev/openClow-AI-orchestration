<script setup lang="ts">
import { useTaskDetail } from '~/composables/useTasks'
import { useTaskEvents } from '~/composables/useTaskEvents'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import { getReviewCardSummary } from '~/lib/reviews'

const route = useRoute()
const taskId = computed(() => route.params.id as string)

const { data: task, isPending: taskPending, error: taskError, refetch: refetchTask } = useTaskDetail(taskId)
const { data: eventsData, isPending: eventsPending } = useTaskEvents(taskId)

const events = computed(() => eventsData.value?.events ?? [])
</script>

<template>
  <div class="p-4">
    <StaleIndicator class="mb-2" />
    <NuxtLink to="/tasks" class="text-sm text-info hover:underline mb-4 inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">&larr; Tasks</NuxtLink>

    <div v-if="taskPending" class="space-y-4">
      <div class="h-32 rounded-lg bg-muted animate-pulse" />
      <div class="h-64 rounded-lg bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="taskError" :message="(taskError as Error).message" @retry="refetchTask()" />

    <template v-else-if="task">
      <div class="rounded-lg border p-4 mb-4">
        <div class="flex items-center justify-between">
          <h1 class="text-lg font-bold font-mono">{{ truncateId(task.id, 20) }}</h1>
          <StatusBadge :status="task.status" />
        </div>
        <div class="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <span class="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{{ task.mode }}</span>
          <span v-if="task.branch">{{ task.branch }}</span>
        </div>
        <p v-if="task.message" class="mt-2 text-sm text-muted-foreground">{{ task.message }}</p>
        <div class="mt-2 text-xs text-muted-foreground/70">Updated {{ formatRelativeTime(task.updatedAt) }}</div>
      </div>

      <!-- Needs input form -->
      <ResumeForm
        v-if="task.status === 'needs_input' && task.question"
        :task-id="task.id"
        :question="task.question"
        :options="task.options"
        class="mb-4"
        @resumed="refetchTask()"
      />

      <!-- Result -->
      <div v-if="task.result" class="rounded-lg border p-4 mb-4">
        <h2 class="text-sm font-medium mb-2">Result</h2>
        <div class="flex items-center gap-3 text-sm">
          <span :class="task.result.exitCode === 0 ? 'text-success' : 'text-destructive'" class="font-mono">
            exit {{ task.result.exitCode }}
          </span>
          <span v-if="task.result.durationMs > 0" class="text-muted-foreground">{{ (task.result.durationMs / 1000).toFixed(1) }}s</span>
          <span v-if="task.result.truncated" class="text-warning text-xs">(truncated)</span>
        </div>
        <pre v-if="task.result.stdout" class="mt-2 text-xs bg-muted rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">{{ task.result.stdout }}</pre>
        <pre v-if="task.result.stderr" class="mt-2 text-xs bg-severity-critical-muted text-severity-critical-foreground rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">{{ task.result.stderr }}</pre>
      </div>

      <!-- Review summary (for review_fail / escalated without structured findings) -->
      <div v-if="(task.status === 'review_fail' || task.status === 'escalated') && !task.structuredFindings?.length && task.reviewFindings" class="rounded-lg border border-severity-major p-4 mb-4">
        <h2 class="text-sm font-medium mb-2">Review Findings</h2>
        <p class="text-sm text-muted-foreground">{{ task.reviewFindings }}</p>
      </div>

      <!-- Structured findings -->
      <div v-if="task.structuredFindings?.length" class="mb-4">
        <h2 class="text-sm font-medium mb-2">Review Findings</h2>
        <p v-if="task.status === 'review_fail' || task.status === 'escalated'" class="text-sm text-muted-foreground mb-2">{{ getReviewCardSummary(task) }}</p>
        <FindingsPanel :findings="task.structuredFindings" />
      </div>

      <!-- Timeline -->
      <h2 class="text-sm font-medium mb-2">Event Timeline</h2>
      <div v-if="eventsPending" class="space-y-2">
        <div v-for="i in 5" :key="i" class="h-12 rounded bg-muted animate-pulse" />
      </div>
      <EmptyState v-else-if="!events.length" title="No events yet" />
      <TaskTimeline v-else :events="events" />
    </template>
  </div>
</template>
