import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null)
  const user = ref<{ id: number; firstName: string; username: string } | null>(null)

  const isAuthenticated = computed(() => !!token.value)

  function setAuth(t: string, u: { id: number; firstName: string; username: string }) {
    token.value = t
    user.value = u
    if (import.meta.client) {
      localStorage.setItem('miniapp_token', t)
      localStorage.setItem('miniapp_user', JSON.stringify(u))
    }
  }

  function clearAuth() {
    token.value = null
    user.value = null
    if (import.meta.client) {
      localStorage.removeItem('miniapp_token')
      localStorage.removeItem('miniapp_user')
    }
  }

  function restoreFromStorage() {
    if (import.meta.client) {
      const stored = localStorage.getItem('miniapp_token')
      if (stored) {
        token.value = stored
        const userJson = localStorage.getItem('miniapp_user')
        if (userJson) {
          try { user.value = JSON.parse(userJson) } catch { /* ignore corrupt data */ }
        }
      }
    }
  }

  return { token, user, isAuthenticated, setAuth, clearAuth, restoreFromStorage }
})
