import { validateInitData, signToken } from '../../../../lib/crypto'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body?.initData || typeof body.initData !== 'string') {
    throw createError({ statusCode: 401, statusMessage: 'invalid_init_data' })
  }

  const parsed = validateInitData(body.initData)
  if (!parsed) {
    throw createError({ statusCode: 401, statusMessage: 'hmac_verification_failed' })
  }

  const { user } = parsed
  const token = signToken(user.id, user.username || '', user.first_name)

  return {
    token,
    user: { id: user.id, firstName: user.first_name, username: user.username || '' },
  }
})
