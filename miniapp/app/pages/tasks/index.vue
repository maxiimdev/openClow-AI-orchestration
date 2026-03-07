<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { applyFilters } from '~/lib/filters'
import { getStatusLabel } from '~/lib/mappers'
import type { UserStatus } from '~/lib/types'
import Input from '~/components/ui/input/Input.vue'
import Button from '~/components/ui/button/Button.vue'

const statusFilter = ref<UserStatus | ''>('')
const searchQuery = ref('')
const { data, isPending, error, refetch } = useTasksList()

const filteredTasks = computed(() => {
  const tasks = data.value?.tasks ?? []
  return applyFilters(tasks, statusFilter.value, searchQuery.value)
})

const statuses: (UserStatus | '')[] = ['', 'running', 'at_risk', 'completed', 'failed', 'needs_input', 'review_pass', 'review_fail', 'escalated']
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Tasks</h1>
    <StaleIndicator />

    <Input
      v-model="searchQuery"
      type="text"
      placeholder="Search tasks..."
      aria-label="Search tasks"
      class="mb-3"
    />

    <div class="flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Filter by status">
      <Button
        v-for="s in statuses" :key="s"
        :variant="statusFilter === s ? 'default' : 'secondary'"
        size="sm"
        class="whitespace-nowrap rounded-full"
        :aria-pressed="statusFilter === s"
        @click="statusFilter = s"
      >
        {{ s ? getStatusLabel(s) : 'All' }}
      </Button>
    </div>

    <div v-if="isPending" class="space-y-3 mt-4">
      <div v-for="i in 5" :key="i" class="h-20 rounded-xl bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!filteredTasks.length" title="No tasks" description="No tasks match the selected filter." />

    <div v-else class="space-y-3 mt-4">
      <TaskCard v-for="task in filteredTasks" :key="task.id" :task="task" />
    </div>
  </div>
</template>
