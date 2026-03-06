import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SSEState } from '~/lib/sse'

export const useConnectionStore = defineStore('connection', () => {
  const sseState = ref<SSEState>('disconnected')
  const isStale = ref(false)

  function setSseState(state: SSEState) {
    sseState.value = state
    isStale.value = state !== 'connected'
  }

  return { sseState, isStale, setSseState }
})
