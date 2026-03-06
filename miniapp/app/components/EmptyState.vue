<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <div class="text-4xl mb-4 text-muted-foreground/40">--</div>
    <h3 class="text-lg font-medium text-foreground">{{ title }}</h3>
    <p v-if="description" class="mt-1 text-sm text-muted-foreground">{{ description }}</p>
  </div>
</template>
