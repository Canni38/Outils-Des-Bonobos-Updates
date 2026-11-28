import { loadBackendConfig } from "./config.js";
import { PostgresDatabase } from "./db/postgresDatabase.js";
import { PostgresSessionAuthenticationProvider } from "./db/sessionService.js";
import { loadBackendEnvironment } from "./loadEnvironment.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  loadBackendEnvironment();
  const config = loadBackendConfig();
  const database = new PostgresDatabase(
    config.databaseUrl,
    config.databaseSsl,
  );
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  try {
    app = await     buildServer({
      database,
      transactions: database,
      authentication: new PostgresSessionAuthenticationProvider(database),
      corsOrigins: config.corsOrigins,
      initialAdminSteamIds: config.initialAdminSteamIds,
      steamApiKey: config.steamApiKey,
      steamOpenIdReturnUrl: config.steamOpenIdReturnUrl,
      steamAuthRateLimit: config.steamAuthRateLimit,
      accountCreationRateLimit: config.accountCreationRateLimit,
    });
    app.addHook("onClose", async () => {
      await database.close();
    });
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { configuredInitialAdminCount: config.initialAdminSteamIds.length },
      "Initial administrator configuration loaded",
    );

    const shutdown = (signal: string) => {
      app?.log.info({ signal }, "Shutting down backend");
      void app?.close().catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Unknown shutdown error.";
        console.error(`Backend shutdown failed: ${message}`);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    if (app === null) {
      await database.close();
    } else {
      await app.close();
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown startup error.";
  console.error(`Backend startup failed: ${message}`);
  process.exitCode = 1;
});
