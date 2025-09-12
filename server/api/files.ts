export default defineEventHandler(async (event) => {
    if (event.method === 'GET') {
        let queries = getQuery(event)
        useAuth(event)
        let fs = await useFS()
        let path = String(queries.path ?? '/')
        return await fs.readDir(path)
    }
    if (event.method === 'POST') {

    }
});