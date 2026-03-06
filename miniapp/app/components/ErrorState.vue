<script setup lang="ts">
defineProps<{ message: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div role="alert" class="flex flex-col items-center justify-center py-12 text-center">
    <div class="text-4xl mb-4 text-destructive/50" aria-hidden="true">!</div>
    <h3 class="text-lg font-medium text-destructive">Something went wrong</h3>
    <p class="mt-1 text-sm text-muted-foreground">{{ message }}</p>
    <button class="mt-4 rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="$emit('retry')">
      Retry
    </button>
  </div>
</template>
