<script setup lang="ts">
import type { Finding } from '~/lib/types'
import Badge from '~/components/ui/badge/Badge.vue'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import { FileCode } from 'lucide-vue-next'

defineProps<{ findings: Finding[] }>()

const severityColor: Record<string, string> = {
  critical: 'bg-severity-critical-muted text-severity-critical-foreground border-transparent',
  major: 'bg-severity-major-muted text-severity-major-foreground border-transparent',
  minor: 'bg-severity-minor-muted text-severity-minor-foreground border-transparent',
}
</script>

<template>
  <div class="space-y-2">
    <Card v-for="f in findings" :key="f.id">
      <CardContent class="pt-4 pb-4">
        <div class="flex items-center gap-2">
          <Badge variant="secondary" :class="severityColor[f.severity] || severityColor.major">
            {{ f.severity }}
          </Badge>
          <span class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground truncate">
            <FileCode class="h-3 w-3 shrink-0" />
            {{ f.file }}
          </span>
        </div>
        <p class="mt-2 text-sm font-medium leading-snug">{{ f.issue }}</p>
        <div class="mt-2 space-y-1">
          <p class="text-xs text-muted-foreground"><span class="font-medium text-muted-foreground">Risk:</span> {{ f.risk }}</p>
          <p class="text-xs text-muted-foreground"><span class="font-medium text-muted-foreground">Fix:</span> {{ f.required_fix }}</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
