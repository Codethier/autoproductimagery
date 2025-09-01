// drizzle.config.ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './schemas/db',
  out: './drizzle',
  dialect: 'sqlite',
  // Use the same path as your runtime client below
  dbCredentials: { url: 'file:./sqlite.db' },
  casing: 'snake_case',
});