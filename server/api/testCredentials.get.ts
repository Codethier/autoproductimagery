

export default defineEventHandler(async (event) => {
    let auth= useAuth(event)
    return true
})