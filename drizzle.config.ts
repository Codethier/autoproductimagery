import "dotenv/config";
import {defineConfig} from "drizzle-kit";

export default defineConfig({
    schema: "./server/db/schema.ts",
    // Preserve the historical SQLite migrations in drizzle/ unchanged.
    // PostgreSQL has its own generated migration history.
    out: "./drizzle/postgres",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
    dialect: "postgresql",
    verbose: true,
    strict: true,
});
