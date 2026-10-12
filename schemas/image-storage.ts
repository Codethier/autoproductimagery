import {z} from 'zod'
import type {SelectableFile} from './main.dto'

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

export const AssetListingQuerySchema = z.object({
    scope: z.enum(['all', 'uploads', 'generated']).default('all'),
    path: logicalPath.default('/'),
    query: z.string().trim().max(200).regex(/^[^\x00-\x1f\x7f]*$/).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(60),
    cursor: z.string().min(1).max(8192).regex(/^[a-zA-Z\d_-]+$/).optional(),
}).strict()

export type AssetFile = SelectableFile & {folder: string; bytes?: number; modifiedAt?: string}
export type AssetListingPage = {files: AssetFile[]; nextCursor?: string}
