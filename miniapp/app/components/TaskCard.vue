<script setup lang="ts">
import type { Task } from '~/lib/types'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import Badge from '~/components/ui/badge/Badge.vue'

defineProps<{ task: Task }>()
</script>

<template>
  <NuxtLink :to="`/tasks/${task.id}`" class="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
    <Card class="hover:bg-accent/50 transition-colors">
      <CardContent class="pt-4">
        <div class="flex items-center justify-between">
          <span class="font-mono text-sm text-muted-foreground">{{ truncateId(task.id) }}</span>
          <StatusBadge :status="task.status" />
        </div>
        <div class="mt-2 flex items-center gap-2 text-sm">
          <Badge variant="secondary" class="text-xs">{{ task.mode }}</Badge>
          <span v-if="task.branch" class="text-muted-foreground truncate">{{ task.branch }}</span>
        </div>
        <p v-if="task.message" class="mt-1 text-sm text-muted-foreground line-clamp-2">{{ task.message }}</p>
        <div class="mt-2 text-xs text-muted-foreground/70">{{ formatRelativeTime(task.updatedAt) }}</div>
      </CardContent>
    </Card>
  </NuxtLink>
</template>
