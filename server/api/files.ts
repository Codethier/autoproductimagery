import {DirectoryListingQuerySchema} from '~~/schemas/image-storage'

export default defineEventHandler(async (event) => {
    const actor = await useAuth(event)
    assertMethod(event, "GET")

    const fs = await useUserFS(actor)
    const parsed = DirectoryListingQuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: 'Invalid file listing pagination'})
    }
    const {path, cursor, limit, folderId} = parsed.data
    const directory = await fs.readDir(path, {cursor, limit, folderId})
    const selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files)
    return {
        dirs: directory.dirs,
        files: selectableFiles,
        nextCursor: directory.nextCursor,
        folder: directory.folder,
    }
})
