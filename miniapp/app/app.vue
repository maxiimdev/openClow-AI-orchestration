<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'
import { useSSE } from '~/composables/useSSE'
import Separator from '~/components/ui/separator/Separator.vue'

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
    <nav aria-label="Main navigation" class="sticky top-0 z-50 bg-background/80 backdrop-blur-lg supports-[backdrop-filter]:bg-background/60">
      <div class="flex h-14 items-center justify-between px-4 max-w-screen-lg mx-auto">
        <NuxtLink to="/" class="text-base font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
          <span class="text-foreground">Worker</span>
        </NuxtLink>
        <div class="flex items-center gap-1">
          <NuxtLink
            v-for="link in [{ to: '/tasks', label: 'Tasks' }, { to: '/inbox', label: 'Inbox' }, { to: '/reviews', label: 'Reviews' }]"
            :key="link.to"
            :to="link.to"
            class="relative px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            active-class="!text-foreground bg-accent"
          >
            {{ link.label }}
          </NuxtLink>
        </div>
      </div>
    </nav>
    <Separator />
    <main class="max-w-screen-lg mx-auto">
      <NuxtPage />
    </main>
  </div>
</template>
