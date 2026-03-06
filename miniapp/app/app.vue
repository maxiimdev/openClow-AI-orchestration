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
    <nav aria-label="Main navigation" class="border-b border-border px-4 py-2">
      <div class="flex items-center justify-between">
        <NuxtLink to="/" class="text-lg font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">Worker</NuxtLink>
        <div class="flex gap-3 text-sm">
          <NuxtLink to="/tasks" class="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1">Tasks</NuxtLink>
          <NuxtLink to="/inbox" class="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1">Inbox</NuxtLink>
          <NuxtLink to="/reviews" class="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1">Reviews</NuxtLink>
        </div>
      </div>
    </nav>
    <NuxtPage />
  </div>
</template>
