import type {SelectableFile} from "~~/schemas/main.dto";


export default defineEventHandler(async (event) => {
    if (event.method === 'GET') {
        let queries = getQuery(event)
        useAuth(event)
        let fs = await useFS()
        let path = String(queries.path ?? '/')
        let directory = await fs.readDir(path)
        let selectableFiles = fs.parseFileDirEntToSelectableFile(directory.files)
        return {dirs:directory.dirs,files:selectableFiles}
    }
    if (event.method === 'POST') {

    }
});