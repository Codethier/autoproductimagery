import type {GenerateOptions} from "~~/schemas/main.dto";
import {useGeminiBatch} from "~~/server/utils/geminiBatch";

export default defineEventHandler(async (event) => {
    const body = await readBody<GenerateOptions>(event)
    if (!body?.prompt) {
        throw createError({statusCode: 400, statusMessage: 'Missing prompt'})
    }
    let batcher = useGeminiBatch()
    let req = batcher.generateFetchRequest(body, 'test')
    let res = await req
    console.log(res)
    return res
})
