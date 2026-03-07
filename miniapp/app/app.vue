<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'
import { useAuth } from '~/composables/useAuth'
import { useSSE } from '~/composables/useSSE'

const authStore = useAuthStore()
const { login } = useAuth()
const sse = useSSE()

onMounted(async () => {
  // Default to dark theme (shadcn convention: class on <html>)
  document.documentElement.classList.add('dark')

  authStore.restoreFromStorage()

  // Auto-login via Telegram WebApp initData when no valid token is stored
  if (!authStore.isAuthenticated) {
    const tg = (window as Record<string, unknown>).Telegram as
      | { WebApp?: { initData?: string } }
      | undefined
    const initData = tg?.WebApp?.initData
    if (initData) {
      try {
        await login(initData)
      } catch { /* auth will be retried on 401 via api.ts interceptor */ }
    }
  }

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
