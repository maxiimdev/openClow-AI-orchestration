import type { Task, UserStatus } from './types'

export function filterByStatus(tasks: Task[], status: UserStatus | ''): Task[] {
  if (!status) return tasks
  return tasks.filter(t => t.status === status)
}

export function filterBySearch(tasks: Task[], query: string): Task[] {
  if (!query) return tasks
  const q = query.toLowerCase()
  return tasks.filter(t =>
    t.id.toLowerCase().includes(q)
    || t.message?.toLowerCase().includes(q)
    || t.branch?.toLowerCase().includes(q),
  )
}

export function applyFilters(tasks: Task[], status: UserStatus | '', search: string): Task[] {
  return filterBySearch(filterByStatus(tasks, status), search)
}
