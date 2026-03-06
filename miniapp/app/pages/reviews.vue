<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import { filterReviewTasks, getReviewSummary, getReviewCardSummary, countFindingsBySeverity } from '~/lib/reviews'

const { data, isPending, error, refetch } = useTasksList()

const reviewTasks = computed(() =>
  filterReviewTasks(data.value?.tasks ?? []),
)

const summary = computed(() =>
  getReviewSummary(data.value?.tasks ?? []),
)

const severityClass: Record<string, string> = {
  critical: 'bg-severity-critical-muted text-severity-critical-foreground',
  major: 'bg-severity-major-muted text-severity-major-foreground',
  minor: 'bg-severity-minor-muted text-severity-minor-foreground',
}
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Review Center</h1>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-3 mt-4">
      <div v-for="i in 3" :key="i" class="h-24 rounded-lg bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!reviewTasks.length" title="No reviews" description="No review results yet." />

    <template v-else>
      <!-- Summary chips -->
      <div class="flex gap-2 mt-4 mb-4">
        <span class="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          {{ summary.total }} total
        </span>
        <span v-if="summary.passed" class="rounded-full bg-success-muted px-3 py-1 text-xs font-medium text-success-muted-foreground">
          {{ summary.passed }} passed
        </span>
        <span v-if="summary.failed" class="rounded-full bg-severity-major-muted px-3 py-1 text-xs font-medium text-severity-major-foreground">
          {{ summary.failed }} failed
        </span>
        <span v-if="summary.escalated" class="rounded-full bg-severity-critical-muted px-3 py-1 text-xs font-medium text-severity-critical-foreground">
          {{ summary.escalated }} escalated
        </span>
      </div>

      <!-- Review cards -->
      <div class="space-y-3">
        <NuxtLink
          v-for="task in reviewTasks" :key="task.id"
          :to="`/tasks/${task.id}`"
          class="block rounded-lg border p-4 hover:bg-accent transition-colors"
        >
          <div class="flex items-center justify-between">
            <span class="font-mono text-sm text-muted-foreground">{{ truncateId(task.id) }}</span>
            <StatusBadge :status="task.status" />
          </div>

          <div class="mt-2 flex items-center gap-2 text-sm">
            <span class="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{{ task.mode }}</span>
            <span v-if="task.branch" class="text-muted-foreground truncate">{{ task.branch }}</span>
          </div>

          <p class="mt-2 text-sm text-muted-foreground">{{ getReviewCardSummary(task) }}</p>

          <!-- Severity breakdown for tasks with structured findings -->
          <div v-if="task.structuredFindings?.length" class="mt-2 flex gap-1.5">
            <template v-for="(count, sev) in countFindingsBySeverity(task.structuredFindings)" :key="sev">
              <span
                v-if="count > 0"
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="severityClass[sev]"
              >
                {{ count }} {{ sev }}
              </span>
            </template>
          </div>

          <div class="mt-2 text-xs text-muted-foreground/70">
            {{ formatRelativeTime(task.updatedAt) }}
          </div>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>
