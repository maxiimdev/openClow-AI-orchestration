<script setup lang="ts">
import type { UserStatus } from '~/lib/types'
import { getStatusLabel, getStatusColor } from '~/lib/mappers'

const props = defineProps<{ status: UserStatus }>()

const colorClasses: Record<string, string> = {
  blue: 'bg-info-muted text-info-muted-foreground',
  green: 'bg-success-muted text-success-muted-foreground',
  red: 'bg-severity-critical-muted text-severity-critical-foreground',
  amber: 'bg-warning-muted text-warning-muted-foreground',
  orange: 'bg-severity-major-muted text-severity-major-foreground',
  gray: 'bg-muted text-muted-foreground',
}

const badgeClass = computed(() => {
  const color = getStatusColor(props.status)
  return colorClasses[color] || colorClasses.gray
})
</script>

<template>
  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" :class="badgeClass">
    {{ getStatusLabel(status) }}
  </span>
</template>
