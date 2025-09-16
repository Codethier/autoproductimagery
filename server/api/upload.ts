export default defineEventHandler(async (event) => {
    useAuth(event)
    let fs = await useFS()
    if (event.method === 'POST') {
        let formData = await readMultipartFormData(event)
        if (!formData) {
            return false
        }
        let files = []
        let path = formData.filter((part) => part.name === 'path')[0].data.toString('utf-8')
        let filesForm = formData.filter((part) => part.name === 'files')
        for (let file of filesForm) {
            let savedFile = await fs.saveFile(path, file)
        }
        return true
    }
})

