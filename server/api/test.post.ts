import prisma from "~~/lib/prisma";
import {useFS} from "~~/server/utils/useFS";

export default defineEventHandler(async (event) => {

    let fs = await useFS()
    const body = await readBody(event)
    const path = body.path
    let dirs = await fs.readDir(path)
    return dirs
})