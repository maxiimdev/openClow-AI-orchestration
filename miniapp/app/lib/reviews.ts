import type { Task, Finding, UserStatus, ReviewDiffSummary } from './types'

/** Statuses that appear in the Review Center */
export const REVIEW_STATUSES: UserStatus[] = ['review_pass', 'review_fail', 'escalated']

/** Filter tasks to only review-relevant statuses */
export function filterReviewTasks(tasks: Task[]): Task[] {
  return tasks.filter(t => REVIEW_STATUSES.includes(t.status))
}

/** Summary counts for review center header */
export interface ReviewSummary {
  total: number
  passed: number
  failed: number
  escalated: number
}

export function getReviewSummary(tasks: Task[]): ReviewSummary {
  const review = filterReviewTasks(tasks)
  return {
    total: review.length,
    passed: review.filter(t => t.status === 'review_pass').length,
    failed: review.filter(t => t.status === 'review_fail').length,
    escalated: review.filter(t => t.status === 'escalated').length,
  }
}

/** Count findings by severity */
export interface SeverityCounts {
  critical: number
  major: number
  minor: number
}

export function countFindingsBySeverity(findings: Finding[]): SeverityCounts {
  return {
    critical: findings.filter(f => f.severity === 'critical').length,
    major: findings.filter(f => f.severity === 'major').length,
    minor: findings.filter(f => f.severity === 'minor').length,
  }
}

/** Get the highest severity from a list of findings */
export function getHighestSeverity(findings: Finding[]): Finding['severity'] | null {
  if (!findings.length) return null
  if (findings.some(f => f.severity === 'critical')) return 'critical'
  if (findings.some(f => f.severity === 'major')) return 'major'
  return 'minor'
}

/** Short description for a review task card */
export function getReviewCardSummary(task: Task): string {
  if (task.status === 'review_pass') return 'Review passed — no issues found'
  const count = task.structuredFindings?.length ?? 0
  if (task.status === 'escalated') return `Escalated — ${count} finding${count !== 1 ? 's' : ''} unresolved`
  if (count > 0) return `${count} finding${count !== 1 ? 's' : ''} require${count === 1 ? 's' : ''} attention`
  return task.reviewFindings ?? 'Review failed'
}

/** Whether a task can trigger a patch/re-review cycle */
export function canRequestPatch(task: Task): boolean {
  if (task.status !== 'review_fail') return false
  const iteration = Number(task.meta?.reviewIteration) || 0
  const maxIterations = Number(task.meta?.reviewMaxIterations) || 3
  return iteration < maxIterations
}

/** Whether a task can be manually re-reviewed */
export function canRequestReReview(task: Task): boolean {
  return task.status === 'review_fail' || task.status === 'escalated'
}

/** Get iteration progress info */
export function getIterationInfo(task: Task): { current: number; max: number; remaining: number } | null {
  const current = Number(task.meta?.reviewIteration)
  const max = Number(task.meta?.reviewMaxIterations)
  if (!current || !max) return null
  return { current, max, remaining: max - current }
}

/** Build a diff summary between previous and current findings */
export function buildReviewDiffSummary(
  previousFindings: Finding[],
  currentFindings: Finding[],
  previousIteration: number,
  currentIteration: number,
): ReviewDiffSummary {
  const prevIds = new Set(previousFindings.map(f => f.id))
  const currIds = new Set(currentFindings.map(f => f.id))

  return {
    previousIteration,
    currentIteration,
    findingsResolved: previousFindings.filter(f => !currIds.has(f.id)),
    findingsRemaining: currentFindings.filter(f => prevIds.has(f.id)),
    findingsNew: currentFindings.filter(f => !prevIds.has(f.id)),
  }
}
