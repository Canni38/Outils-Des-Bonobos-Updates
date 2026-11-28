import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function loadBackendEnvironment(
  directory = backendDirectory,
): void {
  // Node preserves values already in process.env, so load local overrides first.
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(directory, fileName);
    if (existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  }
}
