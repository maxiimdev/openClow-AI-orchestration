<script setup lang="ts">
import type { Task } from '~/lib/types'
import { truncateId, formatRelativeTime } from '~/lib/mappers'

defineProps<{ task: Task }>()
</script>

<template>
  <NuxtLink :to="`/tasks/${task.id}`" class="block rounded-lg border p-4 hover:bg-gray-50 transition-colors">
    <div class="flex items-center justify-between">
      <span class="font-mono text-sm text-gray-600">{{ truncateId(task.id) }}</span>
      <StatusBadge :status="task.status" />
    </div>
    <div class="mt-2 flex items-center gap-2 text-sm">
      <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium">{{ task.mode }}</span>
      <span v-if="task.branch" class="text-gray-500 truncate">{{ task.branch }}</span>
    </div>
    <p v-if="task.message" class="mt-1 text-sm text-gray-500 line-clamp-2">{{ task.message }}</p>
    <div class="mt-2 text-xs text-gray-400">{{ formatRelativeTime(task.updatedAt) }}</div>
  </NuxtLink>
</template>
