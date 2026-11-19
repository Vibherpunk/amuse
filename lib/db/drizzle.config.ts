import { defineConfig } from "drizzle-kit";

// Only needed to generate new migrations after changing the schema: pnpm db:generate
// Paths are relative to this folder (drizzle-kit runs here and mishandles absolute paths).
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
});
