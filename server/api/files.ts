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
    if (event.method === 'POST') {
        let formData = await readMultipartFormData(event)
        if (!formData) {
            return false
        }
        let files = []
        for (let part of formData) {
            console.log(part)
        }
        return true

    }
});