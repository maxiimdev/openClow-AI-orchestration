<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'
import { useSSE } from '~/composables/useSSE'

const auth = useAuthStore()
const sse = useSSE()

onMounted(() => {
  auth.restoreFromStorage()
  if (auth.isAuthenticated) {
    sse.connect()
  }
})

onUnmounted(() => {
  sse.disconnect()
})
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <nav class="border-b border-border px-4 py-2">
      <div class="flex items-center justify-between">
        <NuxtLink to="/" class="text-lg font-bold">Worker</NuxtLink>
        <div class="flex gap-3 text-sm">
          <NuxtLink to="/tasks" class="text-muted-foreground hover:text-foreground">Tasks</NuxtLink>
          <NuxtLink to="/inbox" class="text-muted-foreground hover:text-foreground">Inbox</NuxtLink>
          <NuxtLink to="/reviews" class="text-muted-foreground hover:text-foreground">Reviews</NuxtLink>
        </div>
      </div>
    </nav>
    <NuxtPage />
  </div>
</template>
