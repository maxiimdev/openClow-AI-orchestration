<script setup lang="ts">
import { useTaskDetail } from '~/composables/useTasks'
import { useTaskEvents } from '~/composables/useTaskEvents'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import { getReviewCardSummary, canRequestPatch, canRequestReReview, getIterationInfo } from '~/lib/reviews'
import { requestReReview } from '~/lib/api'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import CardHeader from '~/components/ui/card/CardHeader.vue'
import Badge from '~/components/ui/badge/Badge.vue'
import Button from '~/components/ui/button/Button.vue'
import Skeleton from '~/components/ui/skeleton/Skeleton.vue'

const route = useRoute()
const taskId = computed(() => route.params.id as string)

const { data: task, isPending: taskPending, error: taskError, refetch: refetchTask } = useTaskDetail(taskId)
const { data: eventsData, isPending: eventsPending } = useTaskEvents(taskId)

const events = computed(() => eventsData.value?.events ?? [])

const reReviewLoading = ref(false)
const reReviewError = ref<string | null>(null)

async function handleReReview() {
  if (!task.value || reReviewLoading.value) return
  reReviewLoading.value = true
  reReviewError.value = null
  try {
    await requestReReview(task.value.id)
    await refetchTask()
  } catch (err) {
    reReviewError.value = err instanceof Error ? err.message : 'Re-review request failed'
  } finally {
    reReviewLoading.value = false
  }
}

const iterationInfo = computed(() => task.value ? getIterationInfo(task.value) : null)

const reviewDiffEvents = computed(() => {
  if (!task.value) return []
  return events.value.filter(e =>
    e.status === 'review_fail' || e.status === 'review_pass' || e.status === 'escalated'
  )
})
</script>

<template>
  <div class="p-4">
    <StaleIndicator class="mb-2" />
    <NuxtLink to="/tasks" class="text-sm text-info hover:underline mb-4 inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">&larr; Tasks</NuxtLink>

    <div v-if="taskPending" class="space-y-4">
      <Skeleton class="h-32 rounded-xl" />
      <Skeleton class="h-64 rounded-xl" />
    </div>

    <ErrorState v-else-if="taskError" :message="(taskError as Error).message" @retry="refetchTask()" />

    <template v-else-if="task">
      <Card class="mb-4">
        <CardHeader class="pb-2">
          <div class="flex items-center justify-between">
            <h1 class="text-lg font-bold font-mono">{{ truncateId(task.id, 20) }}</h1>
            <StatusBadge :status="task.status" />
          </div>
        </CardHeader>
        <CardContent>
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary" class="text-xs">{{ task.mode }}</Badge>
            <span v-if="task.branch">{{ task.branch }}</span>
          </div>
          <p v-if="task.message" class="mt-2 text-sm text-muted-foreground">{{ task.message }}</p>
          <div class="mt-2 flex items-center gap-3 text-xs text-muted-foreground/70">
            <span>Created {{ formatRelativeTime(task.createdAt) }}</span>
            <span>Updated {{ formatRelativeTime(task.updatedAt) }}</span>
          </div>
        </CardContent>
      </Card>

      <!-- Reviewer action banner: review_fail with patch path -->
      <Card v-if="task.status === 'review_fail'" class="mb-4 border-severity-major bg-severity-major-muted">
        <CardContent class="pt-4">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-medium text-severity-major-foreground text-sm">Patch Required</span>
            <span v-if="iterationInfo" class="text-xs text-muted-foreground">
              (iteration {{ iterationInfo.current }} of {{ iterationInfo.max }}, {{ iterationInfo.remaining }} remaining)
            </span>
          </div>
          <p class="text-xs text-muted-foreground mb-3">This review found issues that must be fixed. A patch task will address the findings below, then trigger a re-review.</p>
          <div class="flex items-center gap-2">
            <Button
              v-if="canRequestPatch(task)"
              size="sm"
              :disabled="reReviewLoading"
              @click="handleReReview"
            >
              {{ reReviewLoading ? 'Requesting...' : 'Request Patch & Re-review' }}
            </Button>
            <Button
              v-if="canRequestReReview(task)"
              variant="outline"
              size="sm"
              :disabled="reReviewLoading"
              @click="handleReReview"
            >
              {{ reReviewLoading ? 'Requesting...' : 'Re-review Only' }}
            </Button>
          </div>
          <p v-if="reReviewError" class="mt-2 text-xs text-destructive">{{ reReviewError }}</p>
        </CardContent>
      </Card>

      <!-- Reviewer action banner: escalated -->
      <Card v-else-if="task.status === 'escalated'" class="mb-4 border-severity-critical bg-severity-critical-muted">
        <CardContent class="pt-4">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-medium text-severity-critical-foreground text-sm">Escalated — Manual Review Needed</span>
          </div>
          <p class="text-xs text-muted-foreground mb-3">Max review iterations reached. The findings below could not be auto-resolved and require human intervention.</p>
          <div class="flex items-center gap-2">
            <Button
              v-if="canRequestReReview(task)"
              variant="outline"
              size="sm"
              :disabled="reReviewLoading"
              @click="handleReReview"
            >
              {{ reReviewLoading ? 'Requesting...' : 'Force Re-review' }}
            </Button>
          </div>
          <p v-if="reReviewError" class="mt-2 text-xs text-destructive">{{ reReviewError }}</p>
        </CardContent>
      </Card>

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
      <Card v-if="task.result" class="mb-4">
        <CardHeader class="pb-2">
          <h2 class="text-sm font-medium">Result</h2>
        </CardHeader>
        <CardContent>
          <div class="flex items-center gap-3 text-sm">
            <span :class="task.result.exitCode === 0 ? 'text-success' : 'text-destructive'" class="font-mono">
              exit {{ task.result.exitCode }}
            </span>
            <span v-if="task.result.durationMs > 0" class="text-muted-foreground">{{ (task.result.durationMs / 1000).toFixed(1) }}s</span>
            <span v-if="task.result.truncated" class="text-warning text-xs">(truncated)</span>
          </div>
          <pre v-if="task.result.stdout" class="mt-2 text-xs bg-muted rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">{{ task.result.stdout }}</pre>
          <pre v-if="task.result.stderr" class="mt-2 text-xs bg-severity-critical-muted text-severity-critical-foreground rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">{{ task.result.stderr }}</pre>
        </CardContent>
      </Card>

      <!-- Review summary (for review_fail / escalated without structured findings) -->
      <Card v-if="(task.status === 'review_fail' || task.status === 'escalated') && !task.structuredFindings?.length && task.reviewFindings" class="mb-4 border-severity-major">
        <CardHeader class="pb-2">
          <h2 class="text-sm font-medium">Review Findings</h2>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-muted-foreground">{{ task.reviewFindings }}</p>
        </CardContent>
      </Card>

      <!-- Structured findings -->
      <div v-if="task.structuredFindings?.length" class="mb-4">
        <h2 class="text-sm font-medium mb-2">Review Findings</h2>
        <p v-if="task.status === 'review_fail' || task.status === 'escalated'" class="text-sm text-muted-foreground mb-2">{{ getReviewCardSummary(task) }}</p>
        <FindingsPanel :findings="task.structuredFindings" />
      </div>

      <!-- Review iteration history (diff summary) -->
      <Card v-if="reviewDiffEvents.length > 1" class="mb-4">
        <CardHeader class="pb-2">
          <h2 class="text-sm font-medium">Review Iteration History</h2>
        </CardHeader>
        <CardContent>
          <div class="space-y-2">
            <div v-for="(evt, idx) in reviewDiffEvents" :key="evt.id" class="flex items-center gap-2 text-xs">
              <Badge variant="outline" class="rounded-full w-5 h-5 flex items-center justify-center text-[10px] p-0">
                {{ idx + 1 }}
              </Badge>
              <Badge
                variant="secondary"
                class="border-transparent"
                :class="{
                  'bg-success-muted text-success-muted-foreground': evt.status === 'review_pass',
                  'bg-severity-major-muted text-severity-major-foreground': evt.status === 'review_fail',
                  'bg-severity-critical-muted text-severity-critical-foreground': evt.status === 'escalated',
                }"
              >
                {{ evt.status === 'review_pass' ? 'Passed' : evt.status === 'escalated' ? 'Escalated' : 'Failed' }}
              </Badge>
              <span class="text-muted-foreground">{{ evt.message }}</span>
              <span class="text-muted-foreground/70 ml-auto">{{ formatRelativeTime(evt.createdAt) }}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Timeline -->
      <h2 class="text-sm font-medium mb-2">Event Timeline</h2>
      <div v-if="eventsPending" class="space-y-2">
        <Skeleton v-for="i in 5" :key="i" class="h-12" />
      </div>
      <EmptyState v-else-if="!events.length" title="No events yet" />
      <TaskTimeline v-else :events="events" />
    </template>
  </div>
</template>
