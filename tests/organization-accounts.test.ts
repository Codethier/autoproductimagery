import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {cp, mkdir, readdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq} from 'drizzle-orm'
import {accountSessions, aiGatewayLog, organizations, systemPrompt, users} from '../server/db/schema.ts'
import {createAccountRepository} from '../server/utils/accountRepository.ts'
import {ACCOUNT_SESSION_TTL_SECONDS, createAccountSessionToken, hashAccountSessionToken, publicAccountProfile} from '../server/utils/accountSession.ts'
import {createAuthSessionToken} from '../server/utils/authSession.ts'
import {hashPassword, PasswordCapacityError, verifyPassword} from '../server/utils/passwords.ts'
import {CreateOrganizationUserSchema, UpdateOrganizationUserSchema} from '../schemas/accounts.ts'

const migrationsFolder = fileURLToPath(new URL('../drizzle/postgres', import.meta.url))
const bootstrap = {username: 'owner-preview', password: 'owner-password-for-tests'}
const userData = (username: string, role: 'owner' | 'user' = 'user') => ({username, displayName: username, password: `${username}-password-tests`, role})
const status = (expected: number) => (error: unknown) => (error as {statusCode?: number}).statusCode === expected

test('password hashes are salted, bounded, verified with scrypt and never contain a plaintext password', async () => {
    const password = 'a-long-test-password'
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    assert.match(first, /^scrypt-v2\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
    assert.notEqual(first, second)
    assert.equal(first.includes(password), false)
    assert.equal(await verifyPassword(password, first), true)
    assert.equal(await verifyPassword('wrong-password', first), false)
    assert.equal(await verifyPassword(password, undefined), false)
    assert.equal(await verifyPassword(password, 'malformed-hash'), false)
    assert.equal(await verifyPassword(password, first.replace('$16384$8$5$', '$99999999$8$5$')), false)
    assert.equal(await verifyPassword(password, first.replace('scrypt-v2$16384$8$5', 'scrypt-v1')), false)
    await assert.rejects(hashPassword('x'.repeat(4097)), /length/)
})

test('account tokens are random opaque values and legacy global authentication cookies are rejected', () => {
    const token = createAccountSessionToken()
    assert.match(token, /^a2_[A-Za-z0-9_-]{43}$/)
    assert.notEqual(token, createAccountSessionToken())
    const tokenHash = hashAccountSessionToken(token)
    assert.match(tokenHash!, /^[a-f0-9]{64}$/)
    assert.notEqual(tokenHash, token)
    assert.equal(hashAccountSessionToken(`${token}x`), undefined)
    assert.equal(hashAccountSessionToken('a2_invalid'), undefined)
    assert.equal(hashAccountSessionToken(createAuthSessionToken('legacy-user', 'legacy-password')), undefined)
})

test('password verification bounds process memory and queued work under concurrent credential attempts', async () => {
    const results = await Promise.allSettled(Array.from({length: 25}, () => hashPassword('bounded-hashing-password')))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 20)
    const rejected = results.filter(result => result.status === 'rejected')
    assert.equal(rejected.length, 5)
    assert.ok(rejected.every(result => result.status === 'rejected' && result.reason instanceof PasswordCapacityError))
    assert.ok(await verifyPassword('next-hashing-password', await hashPassword('next-hashing-password')))
})

test('account request schemas reject unsupported roles, weak passwords, unknown fields and empty changes', () => {
    assert.equal(CreateOrganizationUserSchema.safeParse(userData('alice')).success, true)
    assert.equal(CreateOrganizationUserSchema.safeParse({...userData('alice'), password: 'short'}).success, false)
    assert.equal(CreateOrganizationUserSchema.safeParse({...userData('alice'), role: 'admin'}).success, false)
    assert.equal(CreateOrganizationUserSchema.safeParse({...userData('alice'), organizationId: randomUUID()}).success, false)
    assert.equal(CreateOrganizationUserSchema.safeParse({...userData('alice'), username: '../other'}).success, false)
    assert.equal(UpdateOrganizationUserSchema.safeParse({}).success, false)
    assert.equal(UpdateOrganizationUserSchema.safeParse({username: 'rename'}).success, false)
})

async function fixture() {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `accounts_test_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1, connectionTimeoutMillis: 5000})
    await administrator.query(`CREATE SCHEMA "${schema}"`)
    const pool = new Pool({connectionString, max: 3, connectionTimeoutMillis: 5000, options: `-c search_path=${schema} -c timezone=UTC`})
    const db = drizzle({client: pool})
    return {db, pool, schema, async cleanup() {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }}
}

test('existing PostgreSQL history migrates without data loss; exactly one bootstrap owner claims nullable legacy rows', {skip: !process.env.TEST_DATABASE_URL, timeout: 60000}, async () => {
    const context = await fixture()
    const temporaryFolder = fileURLToPath(new URL(`../.codex/artifacts/2026-10-12-org-workspaces/old-migrations-${randomUUID()}`, import.meta.url))
    try {
        await mkdir(temporaryFolder, {recursive: true})
        const migrationFolders = (await readdir(migrationsFolder)).filter(folder => /^\d{14}_/.test(folder)).sort()
        const accountsMigration = migrationFolders.find(folder => folder.endsWith('_organization_accounts_and_sharing'))
        assert.ok(accountsMigration)
        // Only the actual predecessor history belongs in the upgrade fixture.
        // Later migrations can depend on account tables and must run afterwards.
        for (const folder of migrationFolders.filter(folder => folder < accountsMigration!)) await cp(join(migrationsFolder, folder), join(temporaryFolder, folder), {recursive: true})
        await migrate(context.db, {migrationsFolder: temporaryFolder, migrationsSchema: context.schema})
        await context.pool.query(`INSERT INTO "systemPrompt" ("TextPrompt", "outputImage", "status") VALUES ('Legacy saved prompt', '/images/output/legacy.png', 'succeeded')`)
        await context.pool.query(`INSERT INTO "aiGatewayLog" ("status", "model", "prompt") VALUES ('success', 'legacy-model', 'Legacy saved prompt')`)
        await migrate(context.db, {migrationsFolder, migrationsSchema: context.schema})
        await migrate(context.db, {migrationsFolder, migrationsSchema: context.schema})
        const accounts = createAccountRepository(context.db)
        await assert.rejects(accounts.authenticate(bootstrap.username, 'incorrect', bootstrap), status(401))
        assert.equal((await context.db.select().from(users)).length, 0)
        const owners = await Promise.all([accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap), accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap)])
        assert.equal(owners[0]!.userId, owners[1]!.userId)
        assert.equal((await context.db.select().from(organizations)).length, 1)
        assert.equal((await context.db.select().from(users)).length, 1)
        assert.equal(owners[0]!.isBootstrapOwner, true)
        const [legacy] = await context.db.select().from(systemPrompt)
        assert.equal(legacy!.TextPrompt, 'Legacy saved prompt')
        assert.equal(legacy!.outputImage, '/images/output/legacy.png')
        assert.equal(legacy!.userId, owners[0]!.userId)
        assert.equal(legacy!.organizationId, owners[0]!.organizationId)
        const [log] = await context.db.select().from(aiGatewayLog)
        assert.equal(log!.userId, owners[0]!.userId)
        const member = await accounts.addUser(owners[0]!, userData('member-preview'))
        assert.equal(member.role, 'user')
        assert.equal((await context.db.select().from(systemPrompt))[0]!.userId, owners[0]!.userId)
        assert.equal(Object.hasOwn(member, 'passwordHash'), false)
    } finally {
        await context.cleanup()
        await rm(temporaryFolder, {recursive: true, force: true})
    }
})

test('multi-user sessions are hashed, durable, expiring and immediately revoked on logout, password change or account disable', {skip: !process.env.TEST_DATABASE_URL, timeout: 60000}, async () => {
    const context = await fixture()
    try {
        await migrate(context.db, {migrationsFolder, migrationsSchema: context.schema})
        const accounts = createAccountRepository(context.db)
        const owner = await accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap)
        const memberData = userData('session-member')
        const member = await accounts.addUser(owner, memberData)
        const identity = await accounts.authenticate(memberData.username.toUpperCase(), memberData.password)
        assert.equal(identity.userId, member.id)
        const now = Date.now()
        const token = await accounts.issueSession(identity, now)
        const [stored] = await context.db.select().from(accountSessions)
        assert.equal(stored!.tokenHash, hashAccountSessionToken(token))
        assert.equal(JSON.stringify(stored).includes(token), false)
        const anotherInstance = createAccountRepository(context.db)
        assert.equal((await anotherInstance.sessionContext(token, now))!.userId, member.id)
        assert.equal(await anotherInstance.sessionContext(token, now + ACCOUNT_SESSION_TTL_SECONDS * 1000), undefined)
        assert.equal(await anotherInstance.sessionContext(createAuthSessionToken(bootstrap.username, bootstrap.password)), undefined)
        await accounts.revokeSession(token)
        assert.equal(await anotherInstance.sessionContext(token), undefined)
        const priorToken = await accounts.issueSession(identity)
        // The Team form includes the unchanged role/disabled fields while
        // updating a name. Only actual credential or access changes revoke.
        await accounts.updateUser(owner, member.id, {displayName: 'Renamed member', role: 'user', disabled: false})
        assert.equal((await accounts.sessionContext(priorToken))?.displayName, 'Renamed member')
        assert.equal((await accounts.sessionContext(priorToken))?.authVersion, identity.authVersion)
        await assert.rejects(accounts.changePassword(identity, 'incorrect', 'replacement-password'), status(401))
        assert.ok(await accounts.sessionContext(priorToken))
        await accounts.changePassword(identity, memberData.password, 'replacement-password')
        assert.equal(await accounts.sessionContext(priorToken), undefined)
        // An old successful password check cannot create a fresh session after a reset.
        await assert.rejects(accounts.issueSession(identity), status(401))
        await assert.rejects(accounts.authenticate(memberData.username, memberData.password), status(401))
        const changed = await accounts.authenticate(memberData.username, 'replacement-password')
        const disabledToken = await accounts.issueSession(changed)
        await accounts.updateUser(owner, member.id, {disabled: true})
        assert.equal(await accounts.sessionContext(disabledToken), undefined)
        await assert.rejects(accounts.authenticate(memberData.username, 'replacement-password'), status(401))
        await accounts.updateUser(owner, member.id, {disabled: false})
        assert.equal(await accounts.sessionContext(disabledToken), undefined)
        assert.equal((await accounts.authenticate(memberData.username, 'replacement-password')).userId, member.id)
        await accounts.changePassword(owner, bootstrap.password, 'owner-new-password-tests')
        await assert.rejects(accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap), status(401))
        assert.equal((await accounts.authenticate(bootstrap.username, 'owner-new-password-tests', bootstrap)).userId, owner.userId)
        assert.deepEqual(Object.keys(publicAccountProfile(changed)).sort(), ['displayName', 'organizationId', 'organizationName', 'role', 'userId', 'username'].sort())
    } finally { await context.cleanup() }
})

test('organization owners manage only their own organization; normal users cannot manage accounts and concurrent changes retain one owner', {skip: !process.env.TEST_DATABASE_URL, timeout: 60000}, async () => {
    const context = await fixture()
    try {
        await migrate(context.db, {migrationsFolder, migrationsSchema: context.schema})
        const accounts = createAccountRepository(context.db)
        const owner = await accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap)
        const member = await accounts.addUser(owner, userData('ordinary-member'))
        const ordinary = await accounts.authenticate('ordinary-member', 'ordinary-member-password-tests')
        await assert.rejects(accounts.listUsers(ordinary), status(403))
        await assert.rejects(accounts.addUser(ordinary, userData('unauthorized-new-user')), status(403))
        await assert.rejects(accounts.updateUser(ordinary, owner.userId, {disabled: true}), status(403))
        assert.equal((await accounts.listUsers(owner, 1, 1)).users.length, 1)
        assert.equal((await accounts.listUsers(owner)).total, 2)
        await assert.rejects(accounts.addUser(owner, userData('ORDINARY-MEMBER')), status(409))
        await assert.rejects(accounts.updateUser(owner, owner.userId, {role: 'user'}), status(409))
        await assert.rejects(accounts.updateUser(owner, owner.userId, {disabled: true}), status(409))
        const secondOwner = await accounts.addUser(owner, userData('other-owner', 'owner'))
        const secondOwnerContext = await accounts.authenticate('other-owner', 'other-owner-password-tests')
        const result = await Promise.allSettled([
            accounts.updateUser(owner, owner.userId, {role: 'user'}),
            accounts.updateUser(secondOwnerContext, secondOwner.id, {role: 'user'}),
        ])
        assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
        assert.equal((await context.db.select().from(users)).filter(user => user.role === 'owner' && !user.disabledAt).length, 1)
        const remaining = (await context.db.select().from(users)).find(user => user.role === 'owner')!
        const remainingContext = await accounts.authenticate(remaining.username, remaining.username === bootstrap.username ? bootstrap.password : `${remaining.username}-password-tests`)
        const foreignOrganizationId = randomUUID()
        await context.db.insert(organizations).values({id: foreignOrganizationId, name: 'Other organization'})
        const [foreignUser] = await context.db.insert(users).values({id: randomUUID(), organizationId: foreignOrganizationId, username: 'foreign-user', normalizedUsername: 'foreign-user', displayName: 'Foreign user', passwordHash: await hashPassword('foreign-password-tests'), role: 'owner'}).returning()
        await assert.rejects(accounts.updateUser(remainingContext, foreignUser!.id, {disabled: true}), status(404))
        assert.equal((await context.db.select().from(users).where(eq(users.id, foreignUser!.id)))[0]!.disabledAt, null)
        assert.equal((await accounts.listUsers(remainingContext)).users.some(user => user.id === foreignUser!.id), false)
        assert.equal((await context.db.select().from(users).where(eq(users.id, member.id)))[0]!.role, 'user')
    } finally { await context.cleanup() }
})

test('account sessions remain bounded and a role change revokes existing sessions', {skip: !process.env.TEST_DATABASE_URL, timeout: 60000}, async () => {
    const context = await fixture()
    try {
        await migrate(context.db, {migrationsFolder, migrationsSchema: context.schema})
        const accounts = createAccountRepository(context.db)
        const owner = await accounts.authenticate(bootstrap.username, bootstrap.password, bootstrap)
        const member = await accounts.addUser(owner, userData('bounded-member'))
        const identity = await accounts.authenticate('bounded-member', 'bounded-member-password-tests')
        const tokens: string[] = []
        for (let index = 0; index < 22; index++) tokens.push(await accounts.issueSession(identity))
        assert.equal((await context.db.select().from(accountSessions).where(eq(accountSessions.userId, identity.userId))).length, 20)
        assert.equal(await accounts.sessionContext(tokens[0]!), undefined)
        assert.equal(await accounts.sessionContext(tokens[1]!), undefined)
        assert.ok(await accounts.sessionContext(tokens.at(-1)!))
        await accounts.updateUser(owner, member.id, {role: 'owner'})
        assert.equal(await accounts.sessionContext(tokens.at(-1)!), undefined)
        await assert.rejects(accounts.issueSession(identity), status(401))
        assert.equal((await accounts.authenticate('bounded-member', 'bounded-member-password-tests')).role, 'owner')
    } finally { await context.cleanup() }
})
