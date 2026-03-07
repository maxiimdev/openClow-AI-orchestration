import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const TOKEN_KEY_PREFIX = 'miniapp_token'
const USER_KEY_PREFIX = 'miniapp_user'
const VERSION_KEY = 'miniapp_token_version'

function versionedKey(prefix: string, version: string | null): string {
  return version ? `${prefix}_v${version}` : prefix
}

/** Remove any old versioned or unversioned token/user keys from localStorage */
function cleanupOldKeys(currentVersion: string | null) {
  if (!import.meta.client) return
  const currentTokenKey = versionedKey(TOKEN_KEY_PREFIX, currentVersion)
  const currentUserKey = versionedKey(USER_KEY_PREFIX, currentVersion)
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if ((key.startsWith(TOKEN_KEY_PREFIX) || key.startsWith(USER_KEY_PREFIX)) &&
        key !== currentTokenKey && key !== currentUserKey && key !== VERSION_KEY) {
      toRemove.push(key)
    }
  }
  for (const key of toRemove) localStorage.removeItem(key)
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null)
  const user = ref<{ id: number; firstName: string; username: string } | null>(null)
  const tokenVersion = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)

  function setAuth(t: string, u: { id: number; firstName: string; username: string }, version?: string) {
    // If version changed, clean up old keys
    if (version && version !== tokenVersion.value) {
      cleanupOldKeys(version)
    }
    token.value = t
    user.value = u
    tokenVersion.value = version ?? tokenVersion.value
    if (import.meta.client) {
      const v = tokenVersion.value
      localStorage.setItem(versionedKey(TOKEN_KEY_PREFIX, v), t)
      localStorage.setItem(versionedKey(USER_KEY_PREFIX, v), JSON.stringify(u))
      if (v) localStorage.setItem(VERSION_KEY, v)
    }
  }

  function clearAuth() {
    if (import.meta.client) {
      const v = tokenVersion.value
      localStorage.removeItem(versionedKey(TOKEN_KEY_PREFIX, v))
      localStorage.removeItem(versionedKey(USER_KEY_PREFIX, v))
      // Also remove unversioned legacy keys
      localStorage.removeItem(TOKEN_KEY_PREFIX)
      localStorage.removeItem(USER_KEY_PREFIX)
    }
    token.value = null
    user.value = null
  }

  function restoreFromStorage() {
    if (!import.meta.client) return

    // Read stored version
    const storedVersion = localStorage.getItem(VERSION_KEY)
    tokenVersion.value = storedVersion

    const tokenKey = versionedKey(TOKEN_KEY_PREFIX, storedVersion)
    const stored = localStorage.getItem(tokenKey)
    if (stored) {
      token.value = stored
      const userKey = versionedKey(USER_KEY_PREFIX, storedVersion)
      const userJson = localStorage.getItem(userKey)
      if (userJson) {
        try { user.value = JSON.parse(userJson) } catch { /* ignore corrupt data */ }
      }
    } else {
      // Try legacy unversioned key as fallback (one-time migration)
      const legacy = localStorage.getItem(TOKEN_KEY_PREFIX)
      if (legacy) {
        token.value = legacy
        const userJson = localStorage.getItem(USER_KEY_PREFIX)
        if (userJson) {
          try { user.value = JSON.parse(userJson) } catch { /* ignore */ }
        }
        // Will be migrated to versioned key on next setAuth
      }
    }
  }

  return { token, user, tokenVersion, isAuthenticated, setAuth, clearAuth, restoreFromStorage }
})
