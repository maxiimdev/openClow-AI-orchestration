<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import { filterReviewTasks, getReviewSummary, getReviewCardSummary, countFindingsBySeverity, canRequestPatch, getIterationInfo } from '~/lib/reviews'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import Badge from '~/components/ui/badge/Badge.vue'
import Skeleton from '~/components/ui/skeleton/Skeleton.vue'
import { Wrench, AlertOctagon } from 'lucide-vue-next'

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

const findingsByTask = computed(() => {
  const map: Record<string, Record<string, number>> = {}
  for (const task of reviewTasks.value) {
    if (task.structuredFindings?.length) {
      map[task.id] = countFindingsBySeverity(task.structuredFindings)
    }
  }
  return map
})
</script>

<template>
  <div class="p-4 sm:p-6">
    <div class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">Review Center</h1>
      <p class="text-sm text-muted-foreground mt-1">Code review results</p>
    </div>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-3 mt-4">
      <Skeleton v-for="i in 3" :key="i" class="h-24 rounded-xl" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!reviewTasks.length" title="No reviews" description="No review results yet." />

    <template v-else>
      <!-- Summary chips -->
      <div class="flex flex-wrap gap-2 mt-4 mb-5">
        <Badge variant="secondary" class="font-medium">{{ summary.total }} total</Badge>
        <Badge v-if="summary.passed" class="bg-success-muted text-success-muted-foreground border-0">{{ summary.passed }} passed</Badge>
        <Badge v-if="summary.failed" class="bg-severity-major-muted text-severity-major-foreground border-0">{{ summary.failed }} failed</Badge>
        <Badge v-if="summary.escalated" class="bg-severity-critical-muted text-severity-critical-foreground border-0">{{ summary.escalated }} escalated</Badge>
      </div>

      <!-- Review cards -->
      <div class="space-y-2">
        <NuxtLink
          v-for="task in reviewTasks" :key="task.id"
          :to="`/tasks/${task.id}`"
          class="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
        >
          <Card class="hover:bg-accent/50 transition-colors">
            <CardContent class="pt-4 pb-4">
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono text-sm text-muted-foreground">{{ truncateId(task.id) }}</span>
                <StatusBadge :status="task.status" />
              </div>

              <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary" class="text-xs font-medium">{{ task.mode }}</Badge>
                <span v-if="task.branch" class="text-muted-foreground text-xs truncate">{{ task.branch }}</span>
              </div>

              <p class="mt-2 text-sm text-muted-foreground leading-relaxed">{{ getReviewCardSummary(task) }}</p>

              <!-- Severity breakdown -->
              <div v-if="findingsByTask[task.id]" class="mt-2 flex gap-1.5">
                <template v-for="(count, sev) in findingsByTask[task.id]" :key="sev">
                  <Badge
                    v-if="count > 0"
                    variant="secondary"
                    :class="[severityClass[sev], 'border-transparent']"
                  >
                    {{ count }} {{ sev }}
                  </Badge>
                </template>
              </div>

              <!-- Action hints -->
              <div v-if="task.status === 'review_fail' && canRequestPatch(task)" class="mt-2.5 flex items-center gap-1.5 text-xs text-severity-major-foreground">
                <Wrench class="h-3 w-3" />
                <span>Patch available</span>
                <span v-if="getIterationInfo(task)" class="text-muted-foreground">({{ getIterationInfo(task)?.remaining }} iterations left)</span>
              </div>
              <div v-else-if="task.status === 'escalated'" class="mt-2.5 flex items-center gap-1.5 text-xs text-severity-critical-foreground">
                <AlertOctagon class="h-3 w-3" />
                Manual intervention required
              </div>

              <div class="mt-2 text-xs text-muted-foreground/70">
                {{ formatRelativeTime(task.updatedAt) }}
              </div>
            </CardContent>
          </Card>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>
