import {users} from "~~/schemas/db/schema";

export default defineEventHandler(async (event) => {
    let db = await useDrizzle()
    let auth= useAuth(event)

    return true
})