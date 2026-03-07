<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'
import { useSSE } from '~/composables/useSSE'

const authStore = useAuthStore()
const sse = useSSE()

// Ensure dark class is set as early as possible (SSR head injection avoids FOUC)
useHead({
  htmlAttrs: { class: 'dark' },
})

onMounted(() => {
  // Listen for auth state changes from api.ts auto-login interceptor
  window.addEventListener('miniapp:auth-updated', ((e: CustomEvent) => {
    const { token, user, tokenVersion } = e.detail
    authStore.setAuth(token, user, tokenVersion)
    // Reconnect SSE with fresh credentials
    sse.disconnect()
    sse.connect()
  }) as EventListener)

  window.addEventListener('miniapp:auth-cleared', () => {
    authStore.clearAuth()
    sse.disconnect()
  })

  // Restore any existing token from localStorage into Pinia store.
  // Auth bootstrap (Telegram auto-login when no token exists) is handled
  // by api.ts ensureAuth() before the first protected API call, so there
  // is no race between page queries and auth initialization.
  authStore.restoreFromStorage()

  if (authStore.isAuthenticated) {
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
