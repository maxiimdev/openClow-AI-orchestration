<script setup lang="ts">
import type { Finding } from '~/lib/types'
import Badge from '~/components/ui/badge/Badge.vue'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'

defineProps<{ findings: Finding[] }>()

const severityColor: Record<string, string> = {
  critical: 'bg-severity-critical-muted text-severity-critical-foreground border-transparent',
  major: 'bg-severity-major-muted text-severity-major-foreground border-transparent',
  minor: 'bg-severity-minor-muted text-severity-minor-foreground border-transparent',
}
</script>

<template>
  <div class="space-y-3">
    <Card v-for="f in findings" :key="f.id">
      <CardContent class="pt-4">
        <div class="flex items-center gap-2">
          <Badge variant="secondary" :class="severityColor[f.severity] || severityColor.major">
            {{ f.severity }}
          </Badge>
          <span class="font-mono text-xs text-muted-foreground">{{ f.file }}</span>
        </div>
        <p class="mt-1 text-sm font-medium">{{ f.issue }}</p>
        <p class="mt-1 text-xs text-muted-foreground">Risk: {{ f.risk }}</p>
        <p class="mt-1 text-xs text-muted-foreground">Fix: {{ f.required_fix }}</p>
      </CardContent>
    </Card>
  </div>
</template>
