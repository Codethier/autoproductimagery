import {z} from 'zod'

export const AccountRoleSchema = z.enum(['owner', 'user'])
export const UsernameSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/, 'Use letters, numbers, dots, underscores, or dashes')
export const DisplayNameSchema = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use a valid display name')
export const NewPasswordSchema = z.string().min(10, 'Use at least 10 characters').max(256)
export const CreateOrganizationUserSchema = z.object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    password: NewPasswordSchema,
    role: AccountRoleSchema.default('user'),
}).strict()
export const UpdateOrganizationUserSchema = z.object({
    displayName: DisplayNameSchema.optional(),
    role: AccountRoleSchema.optional(),
    disabled: z.boolean().optional(),
    password: NewPasswordSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'No changes provided')
export const ChangeAccountPasswordSchema = z.object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: NewPasswordSchema,
}).strict()
export const OrganizationUserListSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict()

export type AccountProfile = {
    userId: string
    organizationId: string
    username: string
    displayName: string
    role: z.infer<typeof AccountRoleSchema>
    organizationName: string
}
export type OrganizationUser = {
    id: string
    username: string
    displayName: string
    role: z.infer<typeof AccountRoleSchema>
    disabled: boolean
    createdAt: string
}
export type CreateOrganizationUser = z.infer<typeof CreateOrganizationUserSchema>
export type UpdateOrganizationUser = z.infer<typeof UpdateOrganizationUserSchema>
