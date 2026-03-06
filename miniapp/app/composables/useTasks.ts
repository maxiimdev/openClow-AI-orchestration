import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { fetchTasks, fetchTask, resumeTask, retryTask, cancelTask } from '~/lib/api'
import type { Task, TasksResponse } from '~/lib/types'
import { useConnectionStore } from '~/stores/connection'

export function useTasksList(params?: { status?: string }) {
  const connStore = useConnectionStore()
  const pollingInterval = computed(() =>
    connStore.sseState === 'connected' ? false : 10000,
  )
  return useQuery({
    queryKey: ['tasks', params?.status ?? 'all'],
    queryFn: () => fetchTasks(params),
    refetchInterval: pollingInterval,
  })
}

export function useTaskDetail(id: Ref<string> | string) {
  const taskId = isRef(id) ? id : ref(id)
  const connStore = useConnectionStore()
  const pollingInterval = computed(() =>
    connStore.sseState === 'connected' ? false : 5000,
  )
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => fetchTask(taskId.value),
    refetchInterval: pollingInterval,
  })
}

export function useResumeTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: string }) => resumeTask(id, answer),
    onMutate: async (vars) => {
      // Cancel in-flight queries to prevent overwriting optimistic update
      await qc.cancelQueries({ queryKey: ['task', vars.id] })
      await qc.cancelQueries({ queryKey: ['tasks'] })

      // Snapshot previous state for rollback
      const previousTask = qc.getQueryData<Task>(['task', vars.id])
      const previousLists = qc.getQueriesData<TasksResponse>({ queryKey: ['tasks'] })

      // Optimistically update task detail to running
      if (previousTask) {
        qc.setQueryData<Task>(['task', vars.id], {
          ...previousTask,
          status: 'running',
          internalStatus: 'progress',
          question: null,
          options: null,
          needsInputAt: null,
          message: `Resumed with answer: ${vars.answer}`,
        })
      }

      // Optimistically remove from needs_input lists / update in all-tasks lists
      for (const [key, data] of previousLists) {
        if (!data) continue
        qc.setQueryData<TasksResponse>(key, {
          ...data,
          tasks: data.tasks
            .map(t => t.id === vars.id ? { ...t, status: 'running' as const, internalStatus: 'progress' as const, question: null, options: null, needsInputAt: null } : t)
            .filter(t => !(key[1] === 'needs_input' && t.id === vars.id)),
          total: key[1] === 'needs_input' ? data.total - 1 : data.total,
        })
      }

      return { previousTask, previousLists }
    },
    onError: (_err, vars, context) => {
      // Rollback on failure
      if (context?.previousTask) {
        qc.setQueryData(['task', vars.id], context.previousTask)
      }
      if (context?.previousLists) {
        for (const [key, data] of context.previousLists) {
          qc.setQueryData(key, data)
        }
      }
    },
    onSettled: (_data, _err, vars) => {
      // Always refetch to ensure consistency with server
      qc.invalidateQueries({ queryKey: ['task', vars.id] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export function useRetryTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => retryTask(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['task', id] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export function useCancelTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelTask(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['task', id] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
