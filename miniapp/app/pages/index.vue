<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { getReviewSummary } from '~/lib/reviews'

const { data: allTasks, isPending, error, refetch } = useTasksList()

const activeTasks = computed(() =>
  allTasks.value?.tasks.filter(t => t.status === 'running' || t.status === 'at_risk').length ?? 0
)
const pendingInput = computed(() =>
  allTasks.value?.tasks.filter(t => t.status === 'needs_input').length ?? 0
)
const reviewSummary = computed(() =>
  getReviewSummary(allTasks.value?.tasks ?? [])
)
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Dashboard</h1>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-4 mt-4">
      <div v-for="i in 3" :key="i" class="h-24 rounded-lg bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <div v-else class="grid grid-cols-3 gap-4 mt-4">
      <NuxtLink to="/tasks" class="rounded-lg border p-4 text-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Active tasks">
        <div class="text-3xl font-bold text-info">{{ activeTasks }}</div>
        <div class="text-sm text-muted-foreground mt-1">Active</div>
      </NuxtLink>
      <NuxtLink to="/inbox" class="rounded-lg border p-4 text-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Tasks awaiting input">
        <div class="text-3xl font-bold text-warning">{{ pendingInput }}</div>
        <div class="text-sm text-muted-foreground mt-1">Awaiting Input</div>
      </NuxtLink>
      <NuxtLink to="/reviews" class="rounded-lg border p-4 text-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Review tasks">
        <div class="text-3xl font-bold" :class="reviewSummary.escalated ? 'text-destructive' : reviewSummary.failed ? 'text-severity-major' : 'text-success'">
          {{ reviewSummary.total }}
        </div>
        <div class="text-sm text-muted-foreground mt-1">Reviews</div>
      </NuxtLink>
    </div>

    <div class="mt-6 space-y-2">
      <NuxtLink to="/tasks" class="block rounded-lg border p-3 text-center text-sm font-medium text-info hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        All Tasks
      </NuxtLink>
      <NuxtLink to="/reviews" class="block rounded-lg border p-3 text-center text-sm font-medium text-info hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Review Center
      </NuxtLink>
    </div>
  </div>
</template>
