export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "GET")

    const fs = await useFS()
    const queries = getQuery(event)
    const path = String(queries.path ?? "/")
    const directory = await fs.readDir(path)
    const selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files)
    return { dirs: directory.dirs, files: selectableFiles }
})
