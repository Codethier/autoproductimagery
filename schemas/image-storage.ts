import {z} from 'zod'

const logicalPath = z.string().max(4096)

export const DirectoryListingQuerySchema = z.object({
    path: logicalPath.default('/'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().min(1).max(8192).regex(/^[a-zA-Z\d_-]+$/).optional(),
}).strict()

export const CreateImageFolderSchema = z.object({
    path: logicalPath.default('/'),
    name: z.string().min(1).max(255),
}).strict()

export const DeleteImageEntrySchema = z.object({
    path: logicalPath.min(1),
    entryType: z.enum(['file', 'directory']).optional(),
}).strict()
