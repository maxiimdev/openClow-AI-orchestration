<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { applyFilters } from '~/lib/filters'
import { getStatusLabel } from '~/lib/mappers'
import type { UserStatus } from '~/lib/types'
import Input from '~/components/ui/input/Input.vue'
import Button from '~/components/ui/button/Button.vue'
import Skeleton from '~/components/ui/skeleton/Skeleton.vue'
import { Search } from 'lucide-vue-next'

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
  <div class="p-4 sm:p-6">
    <div class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">Tasks</h1>
      <p class="text-sm text-muted-foreground mt-1">All worker tasks</p>
    </div>
    <StaleIndicator />

    <div class="relative mb-3">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        v-model="searchQuery"
        type="text"
        placeholder="Search tasks..."
        aria-label="Search tasks"
        class="pl-9"
      />
    </div>

    <div class="flex gap-1.5 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filter by status">
      <Button
        v-for="s in statuses" :key="s"
        :variant="statusFilter === s ? 'default' : 'secondary'"
        size="sm"
        class="whitespace-nowrap rounded-full h-7 text-xs px-3"
        :aria-pressed="statusFilter === s"
        @click="statusFilter = s"
      >
        {{ s ? getStatusLabel(s) : 'All' }}
      </Button>
    </div>

    <div v-if="isPending" class="space-y-2 mt-4">
      <Skeleton v-for="i in 5" :key="i" class="h-20 rounded-xl" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!filteredTasks.length" title="No tasks" description="No tasks match the selected filter." />

    <div v-else class="space-y-2 mt-4">
      <TaskCard v-for="task in filteredTasks" :key="task.id" :task="task" />
    </div>
  </div>
</template>
