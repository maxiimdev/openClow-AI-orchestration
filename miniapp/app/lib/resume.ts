export interface ResumePayload {
  answer: string
}

export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate a resume payload before submission.
 * Rules:
 *  - answer must be a non-empty string after trimming
 *  - answer must not exceed 5000 characters
 */
export function validateResumePayload(payload: unknown): ValidationResult {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Invalid payload' }
  }

  const { answer } = payload as Record<string, unknown>

  if (typeof answer !== 'string') {
    return { valid: false, error: 'Answer must be a string' }
  }

  const trimmed = answer.trim()

  if (trimmed.length === 0) {
    return { valid: false, error: 'Answer cannot be empty' }
  }

  if (trimmed.length > 5000) {
    return { valid: false, error: 'Answer must be 5000 characters or fewer' }
  }

  return { valid: true }
}

/**
 * Build a sanitized resume payload from raw user input.
 * Returns null if validation fails.
 */
export function buildResumePayload(answer: string): ResumePayload | null {
  const result = validateResumePayload({ answer })
  if (!result.valid) return null
  return { answer: answer.trim() }
}
