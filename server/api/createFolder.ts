export default defineEventHandler(async (event) => {
    useAuth(event)
    let fs = await useFS()
    if (event.method === 'POST') {
        let obj = await readBody(event)
        fs.createFolder(obj.path, obj.name)
        return true
    }
})

