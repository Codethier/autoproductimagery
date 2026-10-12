import type { H3Event } from 'h3'
import { createError, getCookie } from 'h3'
import { useRuntimeConfig } from '#imports'
import { AUTH_COOKIE_NAME, getAuthSessionSecret, verifyAuthSessionToken } from './authSession'

/**
 * Validates incoming request against credentials stored in env (runtimeConfig).
 *
 * Validates the opaque, signed session cookie issued by /api/login.
 * Throws 401 Unauthorized if validation fails.
 */
export function useAuth(event: H3Event): void {
  const runtimeConfig = useRuntimeConfig()
  const { authUser, authPassword } = runtimeConfig

  const expectedUser = String(authUser || '')
  const expectedPass = String(authPassword || '')

  if (!expectedUser || !expectedPass) {
    // Misconfiguration: fail closed
    throw createError({ statusCode: 500, statusMessage: 'Server auth not configured' })
  }

  const sessionToken = getCookie(event, AUTH_COOKIE_NAME) || ''
  let sessionSecret: string
  try {
    sessionSecret = getAuthSessionSecret(runtimeConfig as unknown as Record<string, unknown>)
  } catch {
    throw createError({ statusCode: 500, statusMessage: 'Server auth not configured' })
  }
  if (verifyAuthSessionToken(sessionToken, expectedUser, expectedPass, Date.now(), sessionSecret)) return

  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
}
