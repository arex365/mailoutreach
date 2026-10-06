import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env by itself, hence the dotenv import above.
// Relative paths here resolve against this file, i.e. the project root.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/app.db",
  },
});
