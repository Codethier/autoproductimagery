import {createHash, randomBytes} from 'node:crypto'
import type {AccountProfile} from '../../schemas/accounts'

export type AuthContext = AccountProfile & {isBootstrapOwner: boolean; authVersion: number}
export const ACCOUNT_SESSION_TTL_SECONDS = 12 * 60 * 60
export function createAccountSessionToken(): string {
    return `a2_${randomBytes(32).toString('base64url')}`
}
export function hashAccountSessionToken(token: string): string | undefined {
    if (!/^a2_[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    return createHash('sha256').update('autoproductimagery/account-session/v2\0').update(token, 'ascii').digest('hex')
}
export function publicAccountProfile(context: AuthContext): AccountProfile {
    const {userId, organizationId, username, displayName, role, organizationName} = context
    return {userId, organizationId, username, displayName, role, organizationName}
}
