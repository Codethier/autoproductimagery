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
        let path = formData.filter((part)=> part.name === 'path')[0].data.toString('utf-8')
        let filesForm = formData.filter((part)=> part.name === 'files')
        for (let file of filesForm) {

        }
        return true

    }
});