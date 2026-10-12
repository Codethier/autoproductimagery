import {randomUUID} from 'node:crypto'
import {and, asc, count, desc, eq, gt, isNull, lt, ne, sql} from 'drizzle-orm'
import {createError} from 'h3'
import {accountSessions, aiGatewayLog, organizations, systemPrompt, users} from '../db/schema'
import {getDatabase} from './lib/db'
import {credentialsMatch} from './authSession'
import {hashPassword, verifyPassword} from './passwords'
import {ACCOUNT_SESSION_TTL_SECONDS, createAccountSessionToken, hashAccountSessionToken, type AuthContext} from './accountSession'
import {UsernameSchema, type CreateOrganizationUser, type OrganizationUser, type UpdateOrganizationUser} from '../../schemas/accounts'

type Database = ReturnType<typeof getDatabase>
export type BootstrapAccountConfig = {username: string; password: string; organizationName?: string}
export function normalizeUsername(username: string) { return username.trim().toLocaleLowerCase('en-US') }
function publicUser(user: typeof users.$inferSelect): OrganizationUser {
    return {id: user.id, username: user.username, displayName: user.displayName, role: user.role, disabled: Boolean(user.disabledAt), createdAt: new Date(user.createdAt).toISOString()}
}
function accountContext(user: typeof users.$inferSelect, organization: typeof organizations.$inferSelect): AuthContext {
    return {userId: user.id, organizationId: organization.id, username: user.username, displayName: user.displayName, role: user.role, organizationName: organization.name, isBootstrapOwner: user.isBootstrapOwner, authVersion: user.authVersion}
}
function invalidCredentials(): never { throw createError({statusCode: 401, statusMessage: 'Invalid credentials'}) }
function missingUser(): never { throw createError({statusCode: 404, statusMessage: 'User not found'}) }

export function createAccountRepository(db: Database = getDatabase()) {
    async function accountByUsername(username: string) {
        const [record] = await db.select({user: users, organization: organizations}).from(users)
            .innerJoin(organizations, eq(users.organizationId, organizations.id))
            .where(eq(users.normalizedUsername, normalizeUsername(username))).limit(1)
        return record
    }

    async function bootstrapOwner(username: string, password: string, config: BootstrapAccountConfig) {
        if (!config.username || !config.password || !credentialsMatch(username, password, config.username, config.password)) return undefined
        const parsed = UsernameSchema.safeParse(config.username)
        if (!parsed.success) throw createError({statusCode: 500, statusMessage: 'Initial account username is not configured correctly'})
        const passwordHash = await hashPassword(password)
        return db.transaction(async tx => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('autoproductimagery:account-bootstrap:v1', 0))`)
            const [existing] = await tx.select({id: users.id}).from(users).limit(1)
            // Environment credentials may initialize an empty account store once;
            // they never bypass account passwords after that first initialization.
            if (existing) return undefined
            const organizationId = randomUUID()
            const userId = randomUUID()
            const [organization] = await tx.insert(organizations).values({id: organizationId, name: config.organizationName?.trim().slice(0, 80) || 'Product imagery', isBootstrap: true}).returning()
            const [user] = await tx.insert(users).values({id: userId, organizationId, username: parsed.data, normalizedUsername: normalizeUsername(parsed.data), displayName: parsed.data, passwordHash, role: 'owner', isBootstrapOwner: true}).returning()
            if (!user || !organization) throw new Error('Initial account was not created')
            // Existing global history belongs exclusively to the original owner.
            await tx.update(systemPrompt).set({organizationId, userId}).where(and(isNull(systemPrompt.organizationId), isNull(systemPrompt.userId)))
            await tx.update(aiGatewayLog).set({organizationId, userId}).where(and(isNull(aiGatewayLog.organizationId), isNull(aiGatewayLog.userId)))
            return {user, organization}
        })
    }

    async function authenticate(username: string, password: string, config?: BootstrapAccountConfig): Promise<AuthContext> {
        let record = await accountByUsername(username)
        if (!record && config) {
            record = await bootstrapOwner(username, password, config)
            // A concurrent valid initialization may have won the advisory lock.
            if (!record) record = await accountByUsername(username)
        }
        const matches = await verifyPassword(password, record?.user.passwordHash)
        if (!record || !matches || record.user.disabledAt) return invalidCredentials()
        return accountContext(record.user, record.organization)
    }

    async function issueSession(context: AuthContext, now = Date.now()): Promise<string> {
        const token = createAccountSessionToken()
        const tokenHash = hashAccountSessionToken(token)!
        await db.transaction(async tx => {
            const [user] = await tx.select().from(users).where(and(eq(users.id, context.userId), eq(users.organizationId, context.organizationId))).for('update').limit(1)
            if (!user || user.disabledAt || user.authVersion !== context.authVersion) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
            await tx.delete(accountSessions).where(and(eq(accountSessions.userId, user.id), lt(accountSessions.expiresAt, new Date(now).toISOString())))
            // Bound active tokens per account; signing in evicts the oldest token.
            const older = await tx.select({id: accountSessions.id}).from(accountSessions).where(eq(accountSessions.userId, user.id)).orderBy(desc(accountSessions.createdAt), desc(accountSessions.id)).offset(19)
            for (const row of older) await tx.delete(accountSessions).where(eq(accountSessions.id, row.id))
            await tx.insert(accountSessions).values({id: randomUUID(), userId: user.id, tokenHash, authVersion: user.authVersion, expiresAt: new Date(now + ACCOUNT_SESSION_TTL_SECONDS * 1000).toISOString()})
        })
        return token
    }

    async function sessionContext(token: string, now = Date.now()): Promise<AuthContext | undefined> {
        const tokenHash = hashAccountSessionToken(token)
        if (!tokenHash) return undefined
        const [record] = await db.select({user: users, organization: organizations}).from(accountSessions)
            .innerJoin(users, and(eq(accountSessions.userId, users.id), eq(accountSessions.authVersion, users.authVersion)))
            .innerJoin(organizations, eq(users.organizationId, organizations.id))
            .where(and(eq(accountSessions.tokenHash, tokenHash), gt(accountSessions.expiresAt, new Date(now).toISOString()), isNull(users.disabledAt))).limit(1)
        return record ? accountContext(record.user, record.organization) : undefined
    }

    async function revokeSession(token: string) {
        const tokenHash = hashAccountSessionToken(token)
        if (tokenHash) await db.delete(accountSessions).where(eq(accountSessions.tokenHash, tokenHash))
    }

    async function assertOrganizationOwner(tx: Parameters<Parameters<Database['transaction']>[0]>[0], context: AuthContext) {
        // Serializing account administration per organization protects the last
        // enabled owner against concurrent demotions or disables.
        const [organization] = await tx.select({id: organizations.id}).from(organizations).where(eq(organizations.id, context.organizationId)).for('update').limit(1)
        const [actor] = await tx.select().from(users).where(and(eq(users.id, context.userId), eq(users.organizationId, context.organizationId))).limit(1)
        if (!organization || !actor || actor.disabledAt || actor.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
        return actor
    }

    async function listUsers(context: AuthContext, limit = 50, offset = 0) {
        return db.transaction(async tx => {
            await assertOrganizationOwner(tx, context)
            const records = await tx.select().from(users).where(eq(users.organizationId, context.organizationId)).orderBy(asc(users.createdAt), asc(users.id)).limit(Math.max(1, Math.min(100, limit))).offset(Math.max(0, offset))
            const [total] = await tx.select({value: count()}).from(users).where(eq(users.organizationId, context.organizationId))
            return {users: records.map(publicUser), total: Number(total?.value || 0)}
        })
    }

    async function addUser(context: AuthContext, data: CreateOrganizationUser) {
        const passwordHash = await hashPassword(data.password)
        return db.transaction(async tx => {
            await assertOrganizationOwner(tx, context)
            const [existing] = await tx.select({id: users.id}).from(users).where(eq(users.normalizedUsername, normalizeUsername(data.username))).limit(1)
            if (existing) throw createError({statusCode: 409, statusMessage: 'Username is already in use'})
            const [user] = await tx.insert(users).values({id: randomUUID(), organizationId: context.organizationId, username: data.username, normalizedUsername: normalizeUsername(data.username), displayName: data.displayName, passwordHash, role: data.role}).returning()
            if (!user) throw new Error('Account was not created')
            return publicUser(user)
        }).catch(error => {
            if ((error as {cause?: {code?: string}; code?: string}).cause?.code === '23505' || (error as {code?: string}).code === '23505') throw createError({statusCode: 409, statusMessage: 'Username is already in use'})
            throw error
        })
    }

    async function updateUser(context: AuthContext, id: string, data: UpdateOrganizationUser) {
        const passwordHash = data.password ? await hashPassword(data.password) : undefined
        return db.transaction(async tx => {
            await assertOrganizationOwner(tx, context)
            const [target] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, context.organizationId))).limit(1)
            if (!target) return missingUser()
            if (target.role === 'owner' && !target.disabledAt && (data.disabled === true || data.role === 'user')) {
                const [otherOwner] = await tx.select({id: users.id}).from(users).where(and(eq(users.organizationId, context.organizationId), ne(users.id, target.id), eq(users.role, 'owner'), isNull(users.disabledAt))).limit(1)
                if (!otherOwner) throw createError({statusCode: 409, statusMessage: 'Keep at least one enabled organization owner'})
            }
            const revoke = Boolean(passwordHash)
                || (data.disabled !== undefined && data.disabled !== Boolean(target.disabledAt))
                || (data.role !== undefined && data.role !== target.role)
            const [updated] = await tx.update(users).set({
                ...(data.displayName !== undefined ? {displayName: data.displayName} : {}),
                ...(data.role !== undefined ? {role: data.role} : {}),
                ...(data.disabled !== undefined ? {disabledAt: data.disabled ? new Date().toISOString() : null} : {}),
                ...(passwordHash ? {passwordHash} : {}),
                ...(revoke ? {authVersion: sql`${users.authVersion} + 1`} : {}),
                updatedAt: sql`CURRENT_TIMESTAMP`,
            }).where(eq(users.id, target.id)).returning()
            if (revoke) await tx.delete(accountSessions).where(eq(accountSessions.userId, target.id))
            if (!updated) return missingUser()
            return publicUser(updated)
        })
    }

    async function changePassword(context: AuthContext, currentPassword: string, newPassword: string) {
        const [candidate] = await db.select().from(users).where(and(eq(users.id, context.userId), eq(users.organizationId, context.organizationId), isNull(users.disabledAt))).limit(1)
        if (!await verifyPassword(currentPassword, candidate?.passwordHash) || !candidate) return invalidCredentials()
        const passwordHash = await hashPassword(newPassword)
        await db.transaction(async tx => {
            const [updated] = await tx.update(users).set({passwordHash, authVersion: sql`${users.authVersion} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(users.id, candidate.id), eq(users.passwordHash, candidate.passwordHash), isNull(users.disabledAt))).returning({id: users.id})
            if (!updated) return invalidCredentials()
            await tx.delete(accountSessions).where(eq(accountSessions.userId, candidate.id))
        })
    }

    return {authenticate, issueSession, sessionContext, revokeSession, listUsers, addUser, updateUser, changePassword}
}
