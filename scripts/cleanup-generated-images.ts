import "dotenv/config"
import {parseArgs} from "node:util"
import {closeDatabasePool, getDatabasePool} from "../server/utils/lib/db.ts"
import {parseRetentionDays, runGeneratedImageRetention} from "../server/utils/generatedImageRetention.ts"
import {closeImageStorage, useFS} from "../server/utils/useFS.ts"
import {verifyRetentionRuntime} from "../server/utils/retentionRuntime.ts"

let storage: Awaited<ReturnType<typeof useFS>> | undefined
try {
    const {values} = parseArgs({options: {
        "dry-run": {type: "boolean", default: false},
        apply: {type: "boolean", default: false},
    }})
    if (values.apply && values["dry-run"]) throw new Error("Choose either --apply or --dry-run.")
    const dryRun = !values.apply
    const retentionDays = parseRetentionDays(process.env.GENERATED_IMAGE_RETENTION_DAYS)
    await verifyRetentionRuntime()
    // Disabled jobs and dry runs do not need S3 credentials or initialize its client.
    storage = retentionDays !== 0 && !dryRun ? await useFS() : undefined
    const result = await runGeneratedImageRetention({
        pool: retentionDays === 0 ? {connect: async () => { throw new Error("Disabled cleanup must not connect.") }} : getDatabasePool(),
        storage: storage ?? {removeGeneratedImage: async () => { throw new Error("Dry run must not delete objects.") }},
        retentionDays,
        dryRun,
    })
    // Counts and cutoff only: never log object URLs, driver errors or credentials.
    console.log(JSON.stringify(result))
    if (result.failed) process.exitCode = 1
} catch {
    console.error("Generated image cleanup failed. Check retention, PostgreSQL and S3 configuration and service health.")
    process.exitCode = 1
} finally {
    try {
        closeImageStorage()
        await closeDatabasePool()
    } catch {
        console.error("Generated image cleanup could not close its connections cleanly.")
        process.exitCode = 1
    }
}
