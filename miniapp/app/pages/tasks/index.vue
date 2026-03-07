<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { applyFilters } from '~/lib/filters'
import { getStatusLabel } from '~/lib/mappers'
import { useTimestampTick } from '~/composables/useTimestampTick'
import type { UserStatus } from '~/lib/types'

const RENDER_BATCH = 20

const statusFilter = ref<UserStatus | ''>('')
const searchQuery = ref('')
const renderLimit = ref(RENDER_BATCH)
const { data, isPending, error, refetch } = useTasksList()

// Force timestamp re-evaluation every 30s
const _tick = useTimestampTick()

const filteredTasks = computed(() => {
  const tasks = data.value?.tasks ?? []
  return applyFilters(tasks, statusFilter.value, searchQuery.value)
})

const visibleTasks = computed(() =>
  filteredTasks.value.slice(0, renderLimit.value)
)

const hasMore = computed(() =>
  filteredTasks.value.length > renderLimit.value
)

const remainingCount = computed(() =>
  filteredTasks.value.length - renderLimit.value
)

// Reset render limit when filters change
watch([statusFilter, searchQuery], () => {
  renderLimit.value = RENDER_BATCH
})

function showMore() {
  renderLimit.value += RENDER_BATCH
}

const statuses: (UserStatus | '')[] = ['', 'running', 'at_risk', 'completed', 'failed', 'needs_input', 'review_pass', 'review_fail', 'escalated']
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Tasks</h1>
    <StaleIndicator />

    <input
      v-model="searchQuery"
      type="text"
      placeholder="Search tasks..."
      aria-label="Search tasks"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-ring"
    >

    <div class="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4" role="group" aria-label="Filter by status">
      <button
        v-for="s in statuses" :key="s"
        class="whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'"
        :aria-pressed="statusFilter === s"
        @click="statusFilter = s"
      >
        {{ s ? getStatusLabel(s) : 'All' }}
      </button>
    </div>

    <div v-if="isPending" class="space-y-3 mt-4">
      <div v-for="i in 5" :key="i" class="h-20 rounded-lg bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!filteredTasks.length" title="No tasks" description="No tasks match the selected filter." />

    <template v-else>
      <div class="text-xs text-muted-foreground mt-3 mb-2">
        {{ filteredTasks.length }} task{{ filteredTasks.length === 1 ? '' : 's' }}
      </div>
      <div class="space-y-3">
        <TaskCard v-for="task in visibleTasks" :key="task.id" :task="task" />
      </div>
      <button
        v-if="hasMore"
        class="w-full mt-3 rounded-lg border p-3 text-sm font-medium text-info hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="showMore"
      >
        Show {{ Math.min(remainingCount, RENDER_BATCH) }} more ({{ remainingCount }} remaining)
      </button>
    </template>
  </div>
</template>
