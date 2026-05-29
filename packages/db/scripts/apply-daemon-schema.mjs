#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(scriptDir, "../src/daemon.sql");
const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL;

if (!existsSync(schemaPath)) {
  console.error("daemon.sql not found");
  process.exit(1);
}

if (!databaseUrl) {
  console.error([
    "Missing database connection string.",
    "Set DATABASE_URL, SUPABASE_DB_URL, POSTGRES_URL, or POSTGRES_PRISMA_URL.",
    "Example:",
    "  DATABASE_URL='postgresql://postgres:...@db.<project>.supabase.co:5432/postgres' pnpm --filter @zano/db apply:daemon",
  ].join("\n"));
  process.exit(1);
}

const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", schemaPath], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
