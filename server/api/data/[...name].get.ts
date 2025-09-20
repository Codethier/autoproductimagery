import fs from "fs"
import path from "node:path";
export default defineEventHandler(async (event)=> {
    let base = 'data'
    const filePath = path.join(base,event.context.params!.name)
    return sendStream(event, fs.createReadStream(filePath))
})