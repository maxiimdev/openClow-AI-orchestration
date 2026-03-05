import { useAuthStore } from '~/stores/auth'
import { authenticate } from '~/lib/api'

export function useAuth() {
  const store = useAuthStore()

  async function login(initData: string) {
    const res = await authenticate(initData)
    store.setAuth(res.token, res.user)
    return res
  }

  function logout() {
    store.clearAuth()
  }

  return {
    token: computed(() => store.token),
    user: computed(() => store.user),
    isAuthenticated: computed(() => store.isAuthenticated),
    login,
    logout,
  }
}
