<script setup lang="ts">
import type { Finding } from '~/lib/types'

defineProps<{ findings: Finding[] }>()

const severityColor: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  major: 'bg-orange-100 text-orange-800',
  minor: 'bg-yellow-100 text-yellow-800',
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="f in findings" :key="f.id" class="rounded-lg border p-3">
      <div class="flex items-center gap-2">
        <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="severityColor[f.severity] || severityColor.major">
          {{ f.severity }}
        </span>
        <span class="font-mono text-xs text-muted-foreground">{{ f.file }}</span>
      </div>
      <p class="mt-1 text-sm font-medium">{{ f.issue }}</p>
      <p class="mt-1 text-xs text-muted-foreground">Risk: {{ f.risk }}</p>
      <p class="mt-1 text-xs text-muted-foreground">Fix: {{ f.required_fix }}</p>
    </div>
  </div>
</template>
