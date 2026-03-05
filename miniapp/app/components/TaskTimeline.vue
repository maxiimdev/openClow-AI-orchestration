<script setup lang="ts">
import type { TaskEvent } from '~/lib/types'
import { mapWorkerStatus, getStatusLabel, getStatusColor, formatRelativeTime } from '~/lib/mappers'

defineProps<{ events: TaskEvent[] }>()

const dotColor: Record<string, string> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  gray: 'bg-gray-500',
}

function getDotClass(status: string) {
  const userStatus = mapWorkerStatus(status as Parameters<typeof mapWorkerStatus>[0])
  const color = getStatusColor(userStatus)
  return dotColor[color] || dotColor.gray
}
</script>

<template>
  <div class="space-y-0">
    <div v-for="event in events" :key="event.id" class="relative flex gap-3 pb-4">
      <div class="flex flex-col items-center">
        <div class="h-3 w-3 rounded-full mt-1" :class="getDotClass(event.status)"/>
        <div class="flex-1 w-px bg-gray-200"/>
      </div>
      <div class="flex-1 pb-2">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{{ getStatusLabel(mapWorkerStatus(event.status as any)) }}</span>
          <span class="text-xs text-gray-400">{{ event.phase }}</span>
          <span class="ml-auto text-xs text-gray-400">{{ formatRelativeTime(event.createdAt) }}</span>
        </div>
        <p v-if="event.message" class="text-sm text-gray-600 mt-0.5">{{ event.message }}</p>
      </div>
    </div>
  </div>
</template>
