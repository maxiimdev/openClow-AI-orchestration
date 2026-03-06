import { useQuery } from '@tanstack/vue-query'
import { fetchTaskEvents } from '~/lib/api'
import { mergeEvents } from '~/lib/events'
import { useConnectionStore } from '~/stores/connection'
import type { TaskEvent, EventsResponse } from '~/lib/types'

export function useTaskEvents(id: Ref<string> | string) {
  const taskId = isRef(id) ? id : ref(id)
  const connStore = useConnectionStore()

  const pollingInterval = computed(() =>
    connStore.sseState === 'connected' ? false : 5000,
  )

  const mergedEvents = ref<TaskEvent[]>([])
  const lastTaskId = ref(taskId.value)

  // Reset accumulated events when taskId changes to prevent cross-task bleed
  watch(taskId, (newId) => {
    if (newId !== lastTaskId.value) {
      mergedEvents.value = []
      lastTaskId.value = newId
    }
  })

  const query = useQuery({
    queryKey: ['task-events', taskId],
    queryFn: () => fetchTaskEvents(taskId.value, { limit: 100 }),
    refetchInterval: pollingInterval,
    select: (data: EventsResponse) => {
      mergedEvents.value = mergeEvents(mergedEvents.value, data.events)
      return { events: mergedEvents.value }
    },
  })

  return query
}
