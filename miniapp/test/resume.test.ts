import { describe, it, expect } from 'vitest'
import { validateResumePayload, buildResumePayload } from '~/lib/resume'

describe('validateResumePayload', () => {
  it('accepts a valid answer', () => {
    expect(validateResumePayload({ answer: 'PostgreSQL' })).toEqual({ valid: true })
  })

  it('accepts a long answer within limit', () => {
    const answer = 'a'.repeat(5000)
    expect(validateResumePayload({ answer })).toEqual({ valid: true })
  })

  it('rejects null payload', () => {
    const result = validateResumePayload(null)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Invalid payload')
  })

  it('rejects undefined payload', () => {
    const result = validateResumePayload(undefined)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Invalid payload')
  })

  it('rejects non-object payload', () => {
    const result = validateResumePayload('just a string')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Invalid payload')
  })

  it('rejects missing answer field', () => {
    const result = validateResumePayload({})
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer must be a string')
  })

  it('rejects numeric answer', () => {
    const result = validateResumePayload({ answer: 42 })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer must be a string')
  })

  it('rejects empty string answer', () => {
    const result = validateResumePayload({ answer: '' })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer cannot be empty')
  })

  it('rejects whitespace-only answer', () => {
    const result = validateResumePayload({ answer: '   \n\t  ' })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer cannot be empty')
  })

  it('rejects answer exceeding 5000 characters', () => {
    const result = validateResumePayload({ answer: 'a'.repeat(5001) })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer must be 5000 characters or fewer')
  })
})

describe('buildResumePayload', () => {
  it('returns trimmed payload for valid answer', () => {
    expect(buildResumePayload('  PostgreSQL  ')).toEqual({ answer: 'PostgreSQL' })
  })

  it('returns null for empty answer', () => {
    expect(buildResumePayload('')).toBeNull()
  })

  it('returns null for whitespace-only answer', () => {
    expect(buildResumePayload('   ')).toBeNull()
  })

  it('returns null for oversized answer', () => {
    expect(buildResumePayload('a'.repeat(5001))).toBeNull()
  })

  it('preserves internal whitespace', () => {
    expect(buildResumePayload('use  PostgreSQL  database')).toEqual({ answer: 'use  PostgreSQL  database' })
  })
})
