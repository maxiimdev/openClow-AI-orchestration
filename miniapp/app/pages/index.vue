<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { getReviewSummary } from '~/lib/reviews'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import Button from '~/components/ui/button/Button.vue'

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
  <div class="p-4 space-y-4">
    <h1 class="text-2xl font-bold">Dashboard</h1>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-4">
      <div v-for="i in 3" :key="i" class="h-24 rounded-xl bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <template v-else>
      <div class="grid grid-cols-3 gap-3">
        <NuxtLink to="/tasks" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="h-full text-center hover:bg-accent/50 transition-colors">
            <CardContent class="pt-6">
              <div class="text-3xl font-bold text-info">{{ activeTasks }}</div>
              <div class="text-sm text-muted-foreground mt-1">Active</div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/inbox" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="h-full text-center hover:bg-accent/50 transition-colors">
            <CardContent class="pt-6">
              <div class="text-3xl font-bold text-warning">{{ pendingInput }}</div>
              <div class="text-sm text-muted-foreground mt-1">Awaiting Input</div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/reviews" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="h-full text-center hover:bg-accent/50 transition-colors">
            <CardContent class="pt-6">
              <div class="text-3xl font-bold" :class="reviewSummary.escalated ? 'text-destructive' : reviewSummary.failed ? 'text-severity-major' : 'text-success'">
                {{ reviewSummary.total }}
              </div>
              <div class="text-sm text-muted-foreground mt-1">Reviews</div>
            </CardContent>
          </Card>
        </NuxtLink>
      </div>

      <div v-if="completedTasks || failedTasks" class="grid grid-cols-2 gap-3">
        <NuxtLink to="/tasks?status=completed" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="text-center hover:bg-accent/50 transition-colors">
            <CardContent class="pt-6 pb-4">
              <div class="text-2xl font-bold text-success">{{ completedTasks }}</div>
              <div class="text-xs text-muted-foreground mt-1">Completed</div>
            </CardContent>
          </Card>
        </NuxtLink>
        <NuxtLink to="/tasks?status=failed" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
          <Card class="text-center hover:bg-accent/50 transition-colors">
            <CardContent class="pt-6 pb-4">
              <div class="text-2xl font-bold text-destructive">{{ failedTasks }}</div>
              <div class="text-xs text-muted-foreground mt-1">Failed</div>
            </CardContent>
          </Card>
        </NuxtLink>
      </div>

      <div class="space-y-2">
        <NuxtLink to="/tasks">
          <Button variant="outline" class="w-full">All Tasks</Button>
        </NuxtLink>
        <NuxtLink to="/reviews">
          <Button variant="outline" class="w-full">Review Center</Button>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>
