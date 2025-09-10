import prisma from "~~/lib/prisma";


export default defineEventHandler(async (event) => {
    let auth= useAuth(event)
    return prisma.test.findMany()
})