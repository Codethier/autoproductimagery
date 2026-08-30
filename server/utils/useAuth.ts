import type { H3Event } from 'h3'
import { createError, getCookie } from 'h3'
import { useRuntimeConfig } from '#imports'
import { AUTH_COOKIE_NAME, verifyAuthSessionToken } from './authSession'

/**
 * Validates incoming request against credentials stored in env (runtimeConfig).
 *
 * Validates the opaque, signed session cookie issued by /api/login.
 * Throws 401 Unauthorized if validation fails.
 */
export function useAuth(event: H3Event): void {
  const { authUser, authPassword } = useRuntimeConfig()

  const expectedUser = String(authUser || '')
  const expectedPass = String(authPassword || '')

  if (!expectedUser || !expectedPass) {
    // Misconfiguration: fail closed
    throw createError({ statusCode: 500, statusMessage: 'Server auth not configured' })
  }

  const sessionToken = getCookie(event, AUTH_COOKIE_NAME) || ''
  if (verifyAuthSessionToken(sessionToken, expectedUser, expectedPass)) return

  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
}
