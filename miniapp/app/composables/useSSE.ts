import { useQueryClient } from '@tanstack/vue-query'
import { SSEClient } from '~/lib/sse'
import { fetchStreamTicket } from '~/lib/api'
import type { SSEMessage } from '~/lib/types'
import { useConnectionStore } from '~/stores/connection'
import { useAuthStore } from '~/stores/auth'

export function useSSE() {
  const qc = useQueryClient()
  const connStore = useConnectionStore()
  const authStore = useAuthStore()
  let client: SSEClient | null = null

  function connect() {
    if (!authStore.token) return
    client?.disconnect()

    client = new SSEClient({
      url: '/api/v1/miniapp/stream',
      getTicket: async () => {
        const { ticket } = await fetchStreamTicket()
        return ticket
      },
      onMessage: (msg: SSEMessage) => {
        qc.invalidateQueries({ queryKey: ['task', msg.taskId] })
        qc.invalidateQueries({ queryKey: ['task-events', msg.taskId] })
        qc.invalidateQueries({ queryKey: ['tasks'] })
      },
      onResetRequired: () => {
        qc.invalidateQueries()
      },
      onStateChange: (state) => {
        connStore.setSseState(state)
      },
    })
    client.connect()
  }

  function disconnect() {
    client?.disconnect()
    client = null
  }

  return { connect, disconnect, state: computed(() => connStore.sseState) }
}
