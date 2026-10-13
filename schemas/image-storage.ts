import {z} from 'zod'
import type {SelectableFile} from './main.dto'

const logicalPath = z.string().max(4096)

export const DirectoryListingQuerySchema = z.object({
    path: logicalPath.default('/'),
    folderId: z.string().uuid().optional(),
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
    scope: z.enum(['all', 'uploads', 'generated', 'shared']).default('all'),
    path: logicalPath.default('/'),
    folderId: z.string().uuid().optional(),
    sourceUserId: z.string().uuid().optional(),
    query: z.string().trim().max(200).regex(/^[^\x00-\x1f\x7f]*$/).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(60),
    cursor: z.string().min(1).max(8192).regex(/^[a-zA-Z\d_-]+$/).optional(),
}).strict()

export type AssetSource = {userId: string; username: string; displayName: string}
export type AssetPermissions = {view: boolean; edit: boolean; share: boolean}
export type AssetFile = SelectableFile & {
    folder: string; bytes?: number; modifiedAt?: string; id?: string; kind?: 'file' | 'folder';
    ownerUserId?: string; permissions?: AssetPermissions; source?: AssetSource; sharedBy?: AssetSource;
    category?: 'uploaded' | 'generated'; priceUsd?: string | null; priceSource?: string | null;
    billingState?: 'pending' | 'awaiting' | 'confirmed' | 'released' | null;
}
export type AssetFolder = Pick<AssetFile, 'name' | 'url' | 'id' | 'kind' | 'ownerUserId' | 'permissions' | 'source' | 'sharedBy'> & {path: string}
export type AssetListingPage = {files: AssetFile[]; dirs?: AssetFolder[]; sources?: AssetSource[]; folder?: AssetFolder; nextCursor?: string}

export const ShareAssetSchema = z.object({
    recipientUserId: z.string().uuid(),
    permission: z.literal('view').default('view'),
}).strict()
