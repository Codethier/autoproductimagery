import { H3Event, getCookie, createError, getHeader } from 'h3'
import { useRuntimeConfig } from '#imports'

/**
 * Validates incoming request against credentials stored in env (runtimeConfig).
 *
 * Sources (checked in order):
 * - Cookie named "auth" with value "user:pass" (URL safe base64 also supported)
 * - Authorization header with Basic auth
 *
 * Throws 401 Unauthorized if validation fails. Returns void on success.
 */
export function useAuth(event: H3Event): void {
  const { authUser, authPassword } = useRuntimeConfig()

  const expectedUser = String(authUser || '')
  const expectedPass = String(authPassword || '')

  if (!expectedUser || !expectedPass) {
    // Misconfiguration: fail closed
    throw createError({ statusCode: 500, statusMessage: 'Server auth not configured' })
  }

  // 1) Try cookie: "auth" = "user:pass"
  const rawCookie = getCookie(event, 'auth') || ''
    if (rawCookie === `${expectedUser}:${expectedPass}`) {
      return
    }

  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
}
