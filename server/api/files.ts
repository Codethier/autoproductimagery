import {DirectoryListingQuerySchema} from '~~/schemas/image-storage'

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "GET")

    const fs = await useFS()
    const parsed = DirectoryListingQuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: 'Invalid file listing pagination'})
    }
    const {path, cursor, limit} = parsed.data
    const directory = await fs.readDir(path, {cursor, limit})
    const selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files, path)
    return {
        dirs: directory.dirs.map(directoryEntry => ({ name: directoryEntry.name })),
        files: selectableFiles,
        nextCursor: directory.nextCursor,
    }
})
