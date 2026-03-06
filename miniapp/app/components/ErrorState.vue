<script setup lang="ts">
defineProps<{ message: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <div class="text-4xl mb-4 text-red-300">!</div>
    <h3 class="text-lg font-medium text-red-900">Something went wrong</h3>
    <p class="mt-1 text-sm text-gray-500">{{ message }}</p>
    <button class="mt-4 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" @click="$emit('retry')">
      Retry
    </button>
  </div>
</template>
