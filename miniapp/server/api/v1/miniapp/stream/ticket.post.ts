import { issueTicket } from '../../../../lib/crypto'

/**
 * POST /api/v1/miniapp/stream/ticket
 * Issues a short-lived, single-use ticket for SSE connection.
 * Requires valid auth (enforced by middleware).
 */
export default defineEventHandler((event) => {
  const auth = event.context.auth
  if (!auth) {
    throw createError({ statusCode: 401, statusMessage: 'missing_auth' })
  }

  const ticket = issueTicket(auth.userId)
  return { ticket }
})
