<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { getReviewSummary } from '~/lib/reviews'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import Button from '~/components/ui/button/Button.vue'
import Skeleton from '~/components/ui/skeleton/Skeleton.vue'
import { Activity, MessageCircleQuestion, CheckCircle2, XCircle, ClipboardCheck } from 'lucide-vue-next'

const { data: allTasks, isPending, error, refetch } = useTasksList()

const tasks = computed(() => allTasks.value?.tasks ?? [])
const activeTasks = computed(() =>
  tasks.value.filter(t => t.status === 'running' || t.status === 'at_risk').length
)
const pendingInput = computed(() =>
  tasks.value.filter(t => t.status === 'needs_input').length
)
const completedTasks = computed(() =>
  tasks.value.filter(t => t.status === 'completed').length
)
const failedTasks = computed(() =>
  tasks.value.filter(t => t.status === 'failed').length
)
const reviewSummary = computed(() =>
  getReviewSummary(tasks.value)
)
</script>

<template>
  <div class="p-4 sm:p-6 space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>
      <p class="text-sm text-muted-foreground mt-1">Worker task overview</p>
    </div>
    <StaleIndicator />

    <div v-if="isPending" class="grid grid-cols-3 gap-3">
      <Skeleton v-for="i in 3" :key="i" class="h-[7.5rem] rounded-xl" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <template v-else>
      <div class="grid grid-cols-3 gap-3">
        <NuxtLink to="/tasks" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="card-interactive h-full">
            <CardContent class="pt-5 pb-4 px-4">
              <div class="mb-3">
                <div class="rounded-lg bg-info-muted p-2 w-fit">
                  <Activity class="h-4 w-4 text-info-muted-foreground" />
                </div>
              </div>
              <div class="text-2xl font-bold tabular-nums tracking-tight text-foreground">{{ activeTasks }}</div>
              <div class="text-[0.6875rem] font-medium text-muted-foreground mt-0.5 uppercase tracking-wide">Active</div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/inbox" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="card-interactive h-full">
            <CardContent class="pt-5 pb-4 px-4">
              <div class="mb-3">
                <div class="rounded-lg bg-warning-muted p-2 w-fit">
                  <MessageCircleQuestion class="h-4 w-4 text-warning-muted-foreground" />
                </div>
              </div>
              <div class="text-2xl font-bold tabular-nums tracking-tight text-foreground">{{ pendingInput }}</div>
              <div class="text-[0.6875rem] font-medium text-muted-foreground mt-0.5 uppercase tracking-wide">Awaiting</div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/reviews" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="card-interactive h-full">
            <CardContent class="pt-5 pb-4 px-4">
              <div class="mb-3">
                <div class="rounded-lg p-2 w-fit" :class="reviewSummary.escalated ? 'bg-severity-critical-muted' : reviewSummary.failed ? 'bg-severity-major-muted' : 'bg-success-muted'">
                  <ClipboardCheck class="h-4 w-4" :class="reviewSummary.escalated ? 'text-severity-critical-foreground' : reviewSummary.failed ? 'text-severity-major-foreground' : 'text-success-muted-foreground'" />
                </div>
              </div>
              <div class="text-2xl font-bold tabular-nums tracking-tight text-foreground">{{ reviewSummary.total }}</div>
              <div class="text-[0.6875rem] font-medium text-muted-foreground mt-0.5 uppercase tracking-wide">Reviews</div>
            </CardContent>
          </Card>
        </NuxtLink>
      </div>

      <div v-if="completedTasks || failedTasks" class="grid grid-cols-2 gap-3">
        <NuxtLink to="/tasks?status=completed" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="card-interactive">
            <CardContent class="pt-4 pb-3 px-4">
              <div class="flex items-center gap-3">
                <div class="rounded-lg bg-success-muted p-2">
                  <CheckCircle2 class="h-4 w-4 text-success-muted-foreground" />
                </div>
                <div>
                  <div class="text-xl font-bold tabular-nums tracking-tight text-foreground">{{ completedTasks }}</div>
                  <div class="text-[0.6875rem] font-medium text-muted-foreground uppercase tracking-wide">Completed</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/tasks?status=failed" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="card-interactive">
            <CardContent class="pt-4 pb-3 px-4">
              <div class="flex items-center gap-3">
                <div class="rounded-lg bg-severity-critical-muted p-2">
                  <XCircle class="h-4 w-4 text-severity-critical-foreground" />
                </div>
                <div>
                  <div class="text-xl font-bold tabular-nums tracking-tight text-foreground">{{ failedTasks }}</div>
                  <div class="text-[0.6875rem] font-medium text-muted-foreground uppercase tracking-wide">Failed</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </NuxtLink>
      </div>

      <div class="flex gap-2.5">
        <NuxtLink to="/tasks" class="flex-1">
          <Button variant="outline" class="w-full h-10">All Tasks</Button>
        </NuxtLink>
        <NuxtLink to="/reviews" class="flex-1">
          <Button variant="outline" class="w-full h-10">Review Center</Button>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>
