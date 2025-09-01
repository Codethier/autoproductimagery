import {users} from "~~/schemas/db/schema";

export default defineEventHandler(async (event) => {
    let db = await useDrizzle()
    let auth= useAuth(event)

    let q = await db.insert(users).values({name: 'asd',}).returning()
    console.log({q})
    return q
})