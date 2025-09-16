import type {SelectableFile, typeFileUploadDTO} from "~~/schemas/main.dto";


export default defineEventHandler(async (event) => {
    useAuth(event)
    let fs = await useFS()
    if (event.method === 'GET') {
        let queries = getQuery(event)
        let path = String(queries.path ?? '/')
        let directory = await fs.readDir(path)
        let selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files)
        return {dirs: directory.dirs, files: selectableFiles}
    }
});