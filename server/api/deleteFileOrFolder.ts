export default defineEventHandler(async (event) => {
    useAuth(event)
    let fs = await useFS()
    if (event.method === 'DELETE') {
        let obj = await readBody(event)
        await fs.deleteFileOrFolder(obj.path)
        return true
    }
})