import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { MigrationDatabase } from "./contracts.js";

const MIGRATION_LOCK_KEY = 73190421;
const MIGRATION_FILENAME = /^(\d{3,})_[a-z0-9_]+\.sql$/;

interface MigrationRecord {
  version: string;
  checksum: string;
}

export async function runMigrations(
  database: MigrationDatabase,
  migrationsDirectory: string,
): Promise<string[]> {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (fileNames.length === 0) {
    throw new Error("No SQL migrations were found.");
  }

  const migrations = await Promise.all(
    fileNames.map(async (fileName) => {
      const match = MIGRATION_FILENAME.exec(fileName);
      if (match === null) {
        throw new Error(`Invalid migration filename: ${fileName}`);
      }
      return {
        fileName,
        version: match[1],
        sql: await readFile(path.join(migrationsDirectory, fileName), "utf8"),
      };
    }),
  );
  const versions = new Set(migrations.map(({ version }) => version));
  if (versions.size !== migrations.length) {
    throw new Error("Migration version numbers must be unique.");
  }

  return database.withAdvisoryLock(MIGRATION_LOCK_KEY, async (connection) => {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS backend_schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL CHECK (char_length(checksum) = 64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await connection.query<MigrationRecord>(
      "SELECT version, checksum FROM backend_schema_migrations",
    );
    const applied = new Map(
      result.rows.map(({ version, checksum }) => [version, checksum]),
    );
    const availableVersions = new Set(
      migrations.map(({ version }) => version),
    );
    for (const version of applied.keys()) {
      if (!availableVersions.has(version)) {
        throw new Error(
          `Applied migration ${version} is missing; restore the migration file before continuing.`,
        );
      }
    }
    const completed: string[] = [];

    for (const migration of migrations) {
      const checksum = createHash("sha256")
        .update(migration.sql)
        .digest("hex");
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) {
          throw new Error(
            `Applied migration ${migration.fileName} has changed; add a new migration instead.`,
          );
        }
        continue;
      }

      await connection.transaction(async (transaction) => {
        await transaction.query(migration.sql);
        await transaction.query(
          "INSERT INTO backend_schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, checksum],
        );
      });
      completed.push(migration.version);
    }

    return completed;
  });
}
