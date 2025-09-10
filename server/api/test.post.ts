import prisma from "~~/lib/prisma";

export default defineEventHandler(async (event) => {
    let  q = await prisma.test.create({
        data: {
            name: 'test'
        }
    })
    return q
})