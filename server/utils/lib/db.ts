import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

const url = process.env.DATABASE_URL as string | undefined;

if (!url) {
  console.warn("DATABASE_URL is not set. Drizzle DB client will not be initialized correctly.");
}

export const client = createClient({ url: url || "file:./prisma.db", });
export const db = drizzle(client);

export default db;
