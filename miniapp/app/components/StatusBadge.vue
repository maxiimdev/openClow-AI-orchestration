<script setup lang="ts">
import type { UserStatus } from '~/lib/types'
import { getStatusLabel, getStatusColor } from '~/lib/mappers'

const props = defineProps<{ status: UserStatus }>()

const colorClasses: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  orange: 'bg-orange-100 text-orange-800',
  gray: 'bg-gray-100 text-gray-800',
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
