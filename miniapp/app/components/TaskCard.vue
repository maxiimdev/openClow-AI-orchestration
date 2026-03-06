<script setup lang="ts">
import type { Task } from '~/lib/types'
import { truncateId, formatRelativeTime } from '~/lib/mappers'

defineProps<{ task: Task }>()
</script>

<template>
  <NuxtLink :to="`/tasks/${task.id}`" class="block rounded-lg border p-4 hover:bg-accent transition-colors">
    <div class="flex items-center justify-between">
      <span class="font-mono text-sm text-muted-foreground">{{ truncateId(task.id) }}</span>
      <StatusBadge :status="task.status" />
    </div>
    <div class="mt-2 flex items-center gap-2 text-sm">
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{{ task.mode }}</span>
      <span v-if="task.branch" class="text-muted-foreground truncate">{{ task.branch }}</span>
    </div>
    <p v-if="task.message" class="mt-1 text-sm text-muted-foreground line-clamp-2">{{ task.message }}</p>
    <div class="mt-2 text-xs text-muted-foreground/70">{{ formatRelativeTime(task.updatedAt) }}</div>
  </NuxtLink>
</template>
