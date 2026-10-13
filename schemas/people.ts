import {z} from 'zod'
import {ImagePathSchema} from './image-generation'
import type {AssetPermissions, AssetSource} from './image-storage'

const PersonNameSchema = z.string().trim().min(1).max(80)
const PersonDescriptionSchema = z.string().trim().max(4000)
export const CreatePersonSchema = z.object({name: PersonNameSchema, description: PersonDescriptionSchema.default('')}).strict()
export const UpdatePersonSchema = z.object({name: PersonNameSchema.optional(), description: PersonDescriptionSchema.optional()}).strict()
  .refine(value => value.name !== undefined || value.description !== undefined, 'A name or description is required')
export const AddPersonPhotosSchema = z.object({urls: z.array(ImagePathSchema).min(1).max(20)}).strict()
export const PeopleListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(512).optional(),
  search: z.string().trim().max(100).default(''),
  scope: z.enum(['mine', 'shared']).default('mine'),
  sourceId: z.string().uuid().optional(),
}).strict().refine(value => value.sourceId === undefined || value.scope === 'shared', 'A source applies only to shared people')
export const SharePersonSchema = z.object({recipientUserId: z.string().uuid()}).strict()
export const PersonPhotosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(512).optional(),
}).strict()
export type PersonPhoto = {
  id: string
  url: string
  name: string
  priceUsd: string | null
  priceSource: string | null
  generationId: number | null
}
export type Person = {
  id: string
  ownerUserId: string
  permissions: AssetPermissions
  sharedBy?: AssetSource
  name: string
  description: string
  photoCount: number
  cover: PersonPhoto | null
  createdAt: string
  updatedAt: string
}
export type PersonShare = {id: string; recipientUserId: string; username: string; displayName: string; permission: 'view'; createdAt: string}
export type PersonShareTarget = {id: string; username: string; displayName: string}
export type PeopleList = {people: Person[]; nextCursor: string | null; sources: AssetSource[]}
export type PersonDetail = {person: Person; photos: PersonPhoto[]; nextCursor: string | null; pendingCount: number; failedCount: number}
