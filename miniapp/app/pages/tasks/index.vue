<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { applyFilters } from '~/lib/filters'
import type { UserStatus } from '~/lib/types'

const statusFilter = ref<UserStatus | ''>('')
const searchQuery = ref('')
const { data, isPending, error, refetch } = useTasksList()

const filteredTasks = computed(() => {
  const tasks = data.value?.tasks ?? []
  return applyFilters(tasks, statusFilter.value, searchQuery.value)
})

const statuses = ['', 'running', 'completed', 'failed', 'needs_input', 'review_pass', 'review_fail', 'escalated']
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Tasks</h1>
    <StaleIndicator />

    <input
      v-model="searchQuery"
      type="text"
      placeholder="Search tasks..."
      class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >

    <div class="flex gap-2 overflow-x-auto pb-2">
      <button
        v-for="s in statuses" :key="s"
        class="whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors"
        :class="statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
        @click="statusFilter = s"
      >
        {{ s || 'All' }}
      </button>
    </div>

    <div v-if="isPending" class="space-y-3 mt-4">
      <div v-for="i in 5" :key="i" class="h-20 rounded-lg bg-gray-100 animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!filteredTasks.length" title="No tasks" description="No tasks match the selected filter." />

    <div v-else class="space-y-3 mt-4">
      <TaskCard v-for="task in filteredTasks" :key="task.id" :task="task" />
    </div>
  </div>
</template>
