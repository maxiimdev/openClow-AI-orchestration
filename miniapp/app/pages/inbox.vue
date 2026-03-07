<script setup lang="ts">
import { useTasksList } from '~/composables/useTasks'
import { truncateId, formatRelativeTime } from '~/lib/mappers'
import Card from '~/components/ui/card/Card.vue'
import CardContent from '~/components/ui/card/CardContent.vue'
import CardHeader from '~/components/ui/card/CardHeader.vue'
import Skeleton from '~/components/ui/skeleton/Skeleton.vue'
import { Clock } from 'lucide-vue-next'

const { data, isPending, error, refetch } = useTasksList({ status: 'needs_input' })
const tasks = computed(() => data.value?.tasks ?? [])
</script>

<template>
  <div class="p-4 sm:p-6">
    <div class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">Awaiting Input</h1>
      <p class="text-sm text-muted-foreground mt-1">Tasks waiting for your response</p>
    </div>
    <StaleIndicator />

    <div v-if="isPending" class="space-y-3 mt-4">
      <Skeleton v-for="i in 3" :key="i" class="h-32 rounded-xl" />
    </div>

    <ErrorState v-else-if="error" :message="(error as Error).message" @retry="refetch()" />

    <EmptyState v-else-if="!tasks.length" title="No pending questions" description="All tasks are running smoothly." />

    <div v-else class="space-y-3 mt-4">
      <Card v-for="task in tasks" :key="task.id">
        <CardHeader class="pb-2">
          <div class="flex items-center justify-between">
            <NuxtLink :to="`/tasks/${task.id}`" class="font-mono text-sm text-info-muted-foreground hover:text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
              {{ truncateId(task.id) }}
            </NuxtLink>
            <span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock class="h-3 w-3" />
              {{ formatRelativeTime(task.needsInputAt ?? task.updatedAt) }}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <ResumeForm
            v-if="task.status === 'needs_input' && task.question"
            :task-id="task.id"
            :question="task.question"
            :options="task.options"
            @resumed="refetch()"
          />
        </CardContent>
      </Card>
    </div>
  </div>
</template>
