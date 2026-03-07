import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SSEState } from '~/lib/sse'

/** Threshold (ms) after which data is considered stale even if SSE is connected */
const STALE_THRESHOLD_MS = 120_000

export const useConnectionStore = defineStore('connection', () => {
  const sseState = ref<SSEState>('disconnected')
  const lastDataAt = ref<number>(0)

  const isStale = computed(() => {
    if (sseState.value !== 'connected') return true
    if (lastDataAt.value === 0) return false
    return Date.now() - lastDataAt.value > STALE_THRESHOLD_MS
  })

  function setSseState(state: SSEState) {
    sseState.value = state
  }

  function markDataReceived() {
    lastDataAt.value = Date.now()
  }

  return { sseState, isStale, lastDataAt, setSseState, markDataReceived }
})
