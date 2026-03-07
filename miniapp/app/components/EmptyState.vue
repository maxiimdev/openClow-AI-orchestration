<script setup lang="ts">
import { Inbox } from 'lucide-vue-next'

defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <div class="rounded-full bg-muted p-3 mb-4">
      <Inbox class="h-6 w-6 text-muted-foreground" aria-hidden="true" />
    </div>
    <h3 class="text-base font-medium text-foreground">{{ title }}</h3>
    <p v-if="description" class="mt-1.5 text-sm text-muted-foreground max-w-[280px]">{{ description }}</p>
  </div>
</template>
