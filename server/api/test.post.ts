import prisma from "~~/lib/prisma";

export default defineEventHandler(async (event) => {
    const body = await readBody(event)
    const path = body.path

    return 'asd'
}