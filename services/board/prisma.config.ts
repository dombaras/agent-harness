import { defineConfig } from "prisma/config";

// Load `.env` when present (Node's built-in loader — no dotenv dependency).
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env — rely on the ambient environment (CI) */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
