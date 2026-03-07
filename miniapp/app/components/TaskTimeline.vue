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
  <div class="rounded-xl border border-border bg-card p-4" role="list" aria-label="Event timeline">
    <div v-for="(event, idx) in events" :key="event.id" role="listitem" class="relative flex gap-3 pb-4 last:pb-0">
      <div class="flex flex-col items-center" aria-hidden="true">
        <div class="h-2.5 w-2.5 rounded-full mt-1.5 ring-2 ring-card shrink-0" :class="getDotClass(event.status)"/>
        <div v-if="idx < events.length - 1" class="flex-1 w-px bg-border/80 mt-1"/>
      </div>
      <div class="flex-1 min-w-0" :class="idx < events.length - 1 ? 'pb-3' : ''">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[0.8125rem] font-semibold">{{ getStatusLabel(mapWorkerStatus(event.status as any)) }}</span>
          <span v-if="event.phase" class="text-[0.6875rem] text-muted-foreground capitalize bg-muted px-1.5 py-0.5 rounded font-medium">{{ event.phase.replace(/_/g, ' ') }}</span>
          <span class="ml-auto text-[0.6875rem] text-muted-foreground whitespace-nowrap tabular-nums">{{ formatRelativeTime(event.createdAt) }}</span>
        </div>
        <p v-if="event.message" class="text-[0.8125rem] text-muted-foreground mt-0.5 leading-relaxed">{{ event.message }}</p>
      </div>
    </div>
  </div>
</template>
