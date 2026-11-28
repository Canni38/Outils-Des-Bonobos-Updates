import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackendConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresDatabase } from "./db/postgresDatabase.js";
import { loadBackendEnvironment } from "./loadEnvironment.js";

const backendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  loadBackendEnvironment();
  const config = loadBackendConfig();
  const database = new PostgresDatabase(
    config.databaseUrl,
    config.databaseSsl,
  );
  try {
    const applied = await runMigrations(
      database,
      path.join(backendDirectory, "migrations"),
    );
    console.info(
      applied.length === 0
        ? "Database schema is already up to date."
        : `Applied migrations: ${applied.join(", ")}`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown migration error.";
  console.error(`Database migration failed: ${message}`);
  process.exitCode = 1;
});
