import { verifyToken } from '../lib/crypto'
import type { TokenPayload } from '../lib/crypto'

declare module 'h3' {
  interface H3EventContext {
    auth?: TokenPayload
  }
}

/**
 * Auth middleware for /api/v1/miniapp/* routes.
 * Skips auth for the login endpoint and non-miniapp routes.
 * Attaches decoded token to event.context.auth.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname

  // Only guard miniapp API routes
  if (!path.startsWith('/api/v1/miniapp')) return

  // Skip auth endpoint
  if (path.startsWith('/api/v1/miniapp/auth/')) return

  // SSE stream uses ticket-based auth (validated in the handler itself)
  if (path === '/api/v1/miniapp/stream') return

  // Extract Bearer token
  const authHeader = getRequestHeader(event, 'authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw createError({ statusCode: 401, statusMessage: 'missing_token' })
  }

  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) {
    throw createError({ statusCode: 401, statusMessage: 'invalid_token' })
  }

  // Attach user context for downstream handlers
  event.context.auth = payload
})
