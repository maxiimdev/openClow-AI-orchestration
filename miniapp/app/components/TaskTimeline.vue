<script setup lang="ts">
import type { TaskEvent } from '~/lib/types'
import { mapWorkerStatus, getStatusLabel, getStatusColor, formatRelativeTime } from '~/lib/mappers'

defineProps<{ events: TaskEvent[] }>()

const dotColor: Record<string, string> = {
  blue: 'bg-info',
  green: 'bg-success',
  red: 'bg-severity-critical',
  amber: 'bg-warning',
  orange: 'bg-severity-major',
  gray: 'bg-muted-foreground',
}

function getDotClass(status: string) {
  const userStatus = mapWorkerStatus(status as Parameters<typeof mapWorkerStatus>[0])
  const color = getStatusColor(userStatus)
  return dotColor[color] || dotColor.gray
}
</script>

<template>
  <div class="space-y-0" role="list" aria-label="Event timeline">
    <div v-for="(event, idx) in events" :key="event.id" role="listitem" class="relative flex gap-3 pb-4">
      <div class="flex flex-col items-center" aria-hidden="true">
        <div class="h-3 w-3 rounded-full mt-1" :class="getDotClass(event.status)"/>
        <div v-if="idx < events.length - 1" class="flex-1 w-px bg-border"/>
      </div>
      <div class="flex-1 pb-2">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{{ getStatusLabel(mapWorkerStatus(event.status as any)) }}</span>
          <span v-if="event.phase" class="text-xs text-muted-foreground capitalize">{{ event.phase.replace(/_/g, ' ') }}</span>
          <span class="ml-auto text-xs text-muted-foreground">{{ formatRelativeTime(event.createdAt) }}</span>
        </div>
        <p v-if="event.message" class="text-sm text-muted-foreground mt-0.5">{{ event.message }}</p>
      </div>
    </div>
  </div>
</template>
