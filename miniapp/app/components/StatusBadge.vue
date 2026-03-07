<script setup lang="ts">
import type { UserStatus } from '~/lib/types'
import { getStatusLabel, getStatusColor } from '~/lib/mappers'
import Badge from '~/components/ui/badge/Badge.vue'

const props = defineProps<{ status: UserStatus }>()

const colorClasses: Record<string, string> = {
  blue: 'bg-info-muted text-info-muted-foreground border-transparent',
  green: 'bg-success-muted text-success-muted-foreground border-transparent',
  red: 'bg-severity-critical-muted text-severity-critical-foreground border-transparent',
  amber: 'bg-warning-muted text-warning-muted-foreground border-transparent',
  orange: 'bg-severity-major-muted text-severity-major-foreground border-transparent',
  gray: 'bg-muted text-muted-foreground border-transparent',
}

const badgeClass = computed(() => {
  const color = getStatusColor(props.status)
  return colorClasses[color] || colorClasses.gray
})
</script>

<template>
  <Badge variant="secondary" :class="badgeClass">
    {{ getStatusLabel(status) }}
  </Badge>
</template>
