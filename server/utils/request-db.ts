import {drizzle} from 'drizzle-orm/libsql'
import * as schema from '../../schemas/db/schema'
import {createClient} from "@libsql/client";

export async function useDrizzle() {

    // Create the libsql client (env vars or literals)
    const client = createClient({url: "file:./sqlite.db"})
    return drizzle(client, {schema})
}