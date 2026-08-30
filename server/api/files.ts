export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "GET")

    const fs = await useFS()
    const queries = getQuery(event)
    const path = String(queries.path ?? "/")
    const directory = await fs.readDir(path)
    const selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files, path)
    return {
        dirs: directory.dirs.map(directoryEntry => ({ name: directoryEntry.name })),
        files: selectableFiles,
    }
})
