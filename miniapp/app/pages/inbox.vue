<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { formatRelativeTime } from '~/lib/mappers'

const { data, isPending, error, refetch } = useTasksList({ status: 'needs_input' })
const tasks = computed(() => data.value?.tasks ?? [])
</script>

<template>
  <div class="p-4">
    <h1 class="text-2xl font-bold mb-4">Awaiting Input</h1>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-3 mt-4">
      <div v-for="i in 3" :key="i" class="h-32 rounded-lg bg-muted animate-pulse" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!tasks.length" title="No pending questions" description="All tasks are running smoothly." />

    <div v-else class="space-y-4 mt-4">
      <div v-for="task in tasks" :key="task.id" class="rounded-lg border p-4">
        <div class="flex items-center justify-between mb-2">
          <NuxtLink :to="`/tasks/${task.id}`" class="font-mono text-sm text-info hover:underline">
            {{ task.id }}
          </NuxtLink>
          <span v-if="task.needsInputAt" class="text-xs text-muted-foreground">
            waiting {{ formatRelativeTime(task.needsInputAt) }}
          </span>
        </div>
        <ResumeForm
          v-if="task.question"
          :task-id="task.id"
          :question="task.question"
          :options="task.options"
          @resumed="refetch()"
        />
      </div>
    </div>
  </div>
</template>
