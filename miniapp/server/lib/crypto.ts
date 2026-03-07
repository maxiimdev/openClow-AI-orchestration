import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Config — reads from Nuxt runtimeConfig (set via NUXT_MINIAPP_JWT_SECRET /
// NUXT_TELEGRAM_BOT_TOKEN env vars, or nuxt.config.ts defaults).
// Falls back to process.env for non-Nuxt test harnesses.
// ---------------------------------------------------------------------------

function getBotToken(): string {
  try {
    const cfg = useRuntimeConfig()
    if (cfg.telegramBotToken) return cfg.telegramBotToken as string
  } catch { /* outside Nitro runtime — fall back */ }
  return process.env.TELEGRAM_BOT_TOKEN || process.env.NUXT_TELEGRAM_BOT_TOKEN || ''
}

function getJwtSecret(): string {
  try {
    const cfg = useRuntimeConfig()
    if (cfg.miniappJwtSecret) return cfg.miniappJwtSecret as string
  } catch { /* outside Nitro runtime — fall back */ }
  return process.env.MINIAPP_JWT_SECRET || process.env.NUXT_MINIAPP_JWT_SECRET || 'dev-jwt-secret-do-not-use-in-prod'
}

const BOT_TOKEN = () => getBotToken()
const JWT_SECRET = () => getJwtSecret()
const TOKEN_TTL_S = 86400 // 24 h
const TICKET_TTL_MS = 30_000 // 30 s

// ---------------------------------------------------------------------------
// 1. Telegram initData HMAC-SHA256 validation
//    https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number
  first_name: string
  username?: string
}

export interface InitDataPayload {
  user: TelegramUser
  authDate: number
  hash: string
  raw: Record<string, string>
}

/**
 * Validate Telegram WebApp initData string.
 * Returns parsed payload on success, null on failure.
 *
 * In dev mode (no TELEGRAM_BOT_TOKEN set), accepts any initData and
 * returns a mock user — matching previous MVP behavior.
 */
export function validateInitData(initData: string): InitDataPayload | null {
  const botToken = BOT_TOKEN()

  // Dev mode: no bot token configured — accept anything, return mock
  if (!botToken) {
    return parseInitDataDev(initData)
  }

  // Production validation
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  // Build data-check-string: sorted key=value pairs (excluding hash), joined by \n
  params.delete('hash')
  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n')

  // secret_key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()

  // computed_hash = HMAC-SHA256(secret_key, data_check_string)
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  // Timing-safe comparison
  if (!timingSafeCompare(computed, hash)) return null

  // Check auth_date is not too old (allow 1 hour)
  const authDate = Number(params.get('auth_date') || '0')
  if (!authDate || Date.now() / 1000 - authDate > 3600) return null

  // Parse user JSON
  const userStr = params.get('user')
  if (!userStr) return null
  try {
    const user: TelegramUser = JSON.parse(userStr)
    if (!user.id || !user.first_name) return null
    const raw = Object.fromEntries(entries)
    return { user, authDate, hash, raw }
  } catch {
    return null
  }
}

function parseInitDataDev(initData: string): InitDataPayload | null {
  // Try to parse as URL params in dev mode
  try {
    const params = new URLSearchParams(initData)
    const userStr = params.get('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      return { user, authDate: Math.floor(Date.now() / 1000), hash: 'dev', raw: {} }
    }
  } catch { /* ignore */ }
  // Fallback: mock user for pure dev
  return {
    user: { id: 1, first_name: 'Dev', username: 'dev_user' },
    authDate: Math.floor(Date.now() / 1000),
    hash: 'dev',
    raw: {},
  }
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// ---------------------------------------------------------------------------
// 2. Lightweight signed token (HMAC-based, not full JWT)
// ---------------------------------------------------------------------------

export interface TokenPayload {
  userId: number
  username: string
  firstName: string
  iat: number
  exp: number
}

/**
 * Sign a token payload → base64url string.
 * Format: base64(payload).base64(hmac)
 */
export function signToken(userId: number, username: string, firstName: string): string {
  const payload: TokenPayload = {
    userId,
    username,
    firstName,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', JWT_SECRET()).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
}

/**
 * Verify and decode a signed token.
 * Returns payload on success, null on failure.
 */
export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadB64, sig] = parts
  const expectedSig = createHmac('sha256', JWT_SECRET()).update(payloadB64).digest('base64url')

  if (!timingSafeCompare(expectedSig, sig)) return null

  try {
    const payload: TokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    if (!payload.userId || !payload.exp) return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 3. SSE ticket store (short-lived, single-use)
// ---------------------------------------------------------------------------

interface Ticket {
  userId: number
  createdAt: number
}

const ticketStore = new Map<string, Ticket>()

/** Issue a short-lived single-use ticket for SSE connection. */
export function issueTicket(userId: number): string {
  // Cleanup expired tickets on each issue
  const now = Date.now()
  for (const [k, v] of ticketStore) {
    if (now - v.createdAt > TICKET_TTL_MS) ticketStore.delete(k)
  }

  const ticket = randomBytes(32).toString('hex')
  ticketStore.set(ticket, { userId, createdAt: now })
  return ticket
}

/** Redeem a ticket — returns userId if valid, null otherwise. Single-use: deleted after redemption. */
export function redeemTicket(ticket: string): number | null {
  const entry = ticketStore.get(ticket)
  if (!entry) return null

  // Always delete (single-use)
  ticketStore.delete(ticket)

  // Check expiry
  if (Date.now() - entry.createdAt > TICKET_TTL_MS) return null

  return entry.userId
}
