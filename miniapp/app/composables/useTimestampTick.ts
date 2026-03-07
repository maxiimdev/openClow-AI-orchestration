import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Returns a reactive tick counter that increments every `intervalMs`.
 * Components that depend on `tick` in computed properties will
 * re-evaluate their relative timestamps automatically.
 */
export function useTimestampTick(intervalMs = 30_000) {
  const tick = ref(0)
  let timer: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    timer = setInterval(() => {
      tick.value++
    }, intervalMs)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  return tick
}
