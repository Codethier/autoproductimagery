import {defineConfig} from "drizzle-kit";

export default defineConfig({
    schema: "./server/db/schema.ts",
    out: "./drizzle",
    dbCredentials: {
        url: process.env.DATABASE_URL as string | undefined,
    },
    dialect: "sqlite",
    verbose: true,
    strict: true,
});
