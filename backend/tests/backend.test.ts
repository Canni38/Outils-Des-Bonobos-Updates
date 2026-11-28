import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import type {
  AuthenticatedPrincipal,
  PermissionCode,
} from "../src/authorization.js";
import { hasPermission } from "../src/authorization.js";
import type { AuthenticationProvider } from "../src/authentication.js";
import { loadBackendConfig } from "../src/config.js";
import {
  BootstrapServiceError,
  claimInitialAdministrator,
} from "../src/db/bootstrapService.js";
import type {
  MigrationConnection,
  MigrationDatabase,
  SqlExecutor,
  SqlResult,
  TransactionalSqlExecutor,
} from "../src/db/contracts.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  AccountServiceError,
  updateUserAccount,
} from "../src/db/accountService.js";
import { RoleServiceError, changeGlobalRole } from "../src/db/roleService.js";
import {
  createDesktopCodeChallenge,
} from "../src/db/desktopAuthService.js";
import {
  hashSessionToken,
  loginWithVerifiedSteamIdentity,
  PostgresSessionAuthenticationProvider,
} from "../src/db/sessionService.js";
import { loadBackendEnvironment } from "../src/loadEnvironment.js";
import { FixedWindowRateLimiter } from "../src/rateLimiter.js";
import { buildServer } from "../src/server.js";
import {
  SteamOpenIdError,
  steamOpenIdEndpoint,
  verifySteamOpenIdResponse,
} from "../src/steamOpenId.js";
import {
  csrfCookieName,
  sessionCookieName,
  steamStateCookieName,
} from "../src/httpCookies.js";

class InProcessPostgres
  implements
    SqlExecutor,
    TransactionalSqlExecutor,
    MigrationConnection,
    MigrationDatabase
{
  private readonly postgres = new PGlite();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<SqlResult<Row>> {
    if (values !== undefined && values.length > 0) {
      const result = await this.postgres.query<Row>(statement, values);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    }

    const results = await this.postgres.exec(statement);
    const lastResult = results.at(-1);
    const rows = (lastResult?.rows ?? []) as Row[];
    return {
      rows,
      rowCount: lastResult?.affectedRows ?? rows.length,
    };
  }

  async transaction<T>(
    operation: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.postgres.transaction((transaction) =>
      operation({
        query: async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(
          statement: string,
          values?: unknown[],
        ): Promise<SqlResult<Row>> => {
          if (values !== undefined && values.length > 0) {
            const result = await transaction.query<Row>(statement, values);
            return {
              rows: result.rows,
              rowCount: result.affectedRows ?? result.rows.length,
            };
          }
          const results = await transaction.exec(statement);
          const lastResult = results.at(-1);
          const rows = (lastResult?.rows ?? []) as Row[];
          return {
            rows,
            rowCount: lastResult?.affectedRows ?? rows.length,
          };
        },
      }),
    );
  }

  async withAdvisoryLock<T>(
    lockKey: number,
    operation: (connection: MigrationConnection) => Promise<T>,
  ): Promise<T> {
    await this.query("SELECT pg_advisory_lock($1)", [lockKey]);
    try {
      return await operation(this);
    } finally {
      await this.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    }
  }

  async close(): Promise<void> {
    await this.postgres.close();
  }
}

const migrationDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

test("loads backend .env.local and .env before config validation", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "bonobos-environment-"),
  );
  const environmentKeys = [
    "DATABASE_URL",
    "DATABASE_SSL",
    "BONOBOS_API_HOST",
    "BONOBOS_API_PORT",
    "BONOBOS_CORS_ORIGINS",
    "INITIAL_ADMIN_STEAM_IDS",
    "INITIAL_ADMIN_STEAM_ID",
    "STEAM_OPENID_RETURN_URL",
    "POSTGRES_PASSWORD",
  ];
  const previousValues = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of environmentKeys) {
    delete process.env[key];
  }

  try {
    await writeFile(
      path.join(temporaryDirectory, ".env.local"),
      [
        "DATABASE_URL=postgres://localhost/local",
        "INITIAL_ADMIN_STEAM_IDS=76561198000000000,76561198000000001",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(temporaryDirectory, ".env"),
      "POSTGRES_PASSWORD=compose-test-password\n",
      "utf8",
    );

    loadBackendEnvironment(temporaryDirectory);
    const config = loadBackendConfig();
    assert.equal(config.databaseUrl, "postgres://localhost/local");
    assert.equal(config.initialAdminSteamIds.length, 2);
    assert.equal(process.env.POSTGRES_PASSWORD, "compose-test-password");
  } finally {
    for (const key of environmentKeys) {
      const previousValue = previousValues.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function seedUser(
  database: SqlExecutor,
  displayName: string,
  role?: "ADMINISTRATEUR" | "UTILISATEUR",
): Promise<string> {
  const user = await database.query<{ id: string }>(
    "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
    [displayName],
  );
  const userId = user.rows[0]?.id;
  assert.ok(userId);

  if (role !== undefined) {
    await database.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
    );
  }
  return userId;
}

function createPrincipal(
  userId: string,
  permissions: PermissionCode[],
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE",
): AuthenticatedPrincipal {
  return {
    userId,
    status,
    grants: permissions.map((permission) => ({
      permission,
      scope: "GLOBAL",
    })),
  };
}

function createOpenIdResponse(
  returnTo: string,
  state: string,
  steamId = "76561198000000000",
  responseNonce = `${new Date(Date.now() - 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")}nonce-test`,
): URLSearchParams {
  const identity = `https://steamcommunity.com/openid/id/${steamId}`;
  const parameters = new URLSearchParams({
    state,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": steamOpenIdEndpoint,
    "openid.claimed_id": identity,
    "openid.identity": identity,
    "openid.return_to": returnTo,
    "openid.response_nonce": responseNonce,
    "openid.assoc_handle": "test-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce",
    "openid.sig": "test-signature",
  });
  return parameters;
}

function getSetCookieValues(
  header: string | string[] | undefined,
): string[] {
  if (Array.isArray(header)) {
    return header;
  }
  return header === undefined ? [] : [header];
}

function getCookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `Expected ${name} Set-Cookie header`);
  return cookie.split(";", 1)[0].slice(name.length + 1);
}

async function completeDesktopSteamAuthorization(
  server: FastifyInstance,
  steamId: string,
  cancel = false,
) {
  const verifier = randomBytes(32).toString("base64url");
  const appState = randomBytes(32).toString("base64url");
  const start = await server.inject({
    method: "POST",
    url: "/auth/desktop/start",
    payload: {
      codeChallenge: createDesktopCodeChallenge(verifier),
      state: appState,
    },
  });
  assert.equal(start.statusCode, 200);

  const authorizationUrl = new URL(start.json().authorizationUrl);
  const browserStart = await server.inject({
    method: "GET",
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
  });
  assert.equal(browserStart.statusCode, 302);
  const steamUrl = new URL(browserStart.headers.location ?? "");
  const returnTo = steamUrl.searchParams.get("openid.return_to");
  assert.ok(returnTo);
  const openIdState = new URL(returnTo).searchParams.get("state");
  assert.ok(openIdState);
  const parameters = createOpenIdResponse(returnTo, openIdState, steamId);
  if (cancel) {
    parameters.set("openid.mode", "cancel");
  }
  const stateCookie = getCookieValue(
    getSetCookieValues(browserStart.headers["set-cookie"]),
    steamStateCookieName,
  );
  const callback = await server.inject({
    method: "GET",
    url: `/auth/steam/callback?${parameters.toString()}`,
    headers: { cookie: `${steamStateCookieName}=${stateCookie}` },
  });
  return {
    appState,
    callback,
    verifier,
  };
}

test("validates backend settings without exposing database credentials", () => {
  assert.throws(() => loadBackendConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => loadBackendConfig({ DATABASE_URL: "https://example.test/db" }),
    /PostgreSQL server/,
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        BONOBOS_API_PORT: "70000",
      }),
    /1 to 65535/,
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        INITIAL_ADMIN_STEAM_ID: "not-a-steamid",
      }),
    /17-digit SteamID64/,
  );
  const initialAdminSteamIds = loadBackendConfig({
    DATABASE_URL: "postgres://localhost/bonobos",
    INITIAL_ADMIN_STEAM_IDS:
      "76561198000000000, 76561198000000001",
  }).initialAdminSteamIds;
  assert.deepEqual(initialAdminSteamIds, [
    "76561198000000000",
    "76561198000000001",
  ]);
  assert.deepEqual(
    loadBackendConfig({
      DATABASE_URL: "postgres://localhost/bonobos",
      INITIAL_ADMIN_STEAM_ID: "76561198000000000",
    }).initialAdminSteamIds,
    ["76561198000000000"],
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        INITIAL_ADMIN_STEAM_IDS:
          "76561198000000000,76561198000000000",
      }),
    /exactly two distinct/,
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        INITIAL_ADMIN_STEAM_IDS: "76561198000000000",
      }),
    /exactly two distinct/,
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        INITIAL_ADMIN_STEAM_IDS:
          "76561198000000000,76561198000000001",
        INITIAL_ADMIN_STEAM_ID: "76561198000000000",
      }),
    /Set only one/,
  );

  const config = loadBackendConfig({
    DATABASE_URL: "postgres://bonobos:private@localhost/bonobos",
    DATABASE_SSL: "true",
    STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS: "18",
    STEAM_AUTH_RATE_LIMIT_WINDOW_MS: "600000",
    STEAM_ACCOUNT_CREATION_RATE_LIMIT_MAX_REQUESTS: "4",
  });
  assert.equal(config.databaseUrl, "postgres://bonobos:private@localhost/bonobos");
  assert.equal(config.databaseSsl, true);
  assert.deepEqual(config.steamAuthRateLimit, {
    maxRequests: 18,
    windowMs: 600_000,
  });
  assert.deepEqual(config.accountCreationRateLimit, {
    maxRequests: 4,
    windowMs: 3_600_000,
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8080);
  assert.deepEqual(config.corsOrigins, [
    "http://localhost:1420",
    "http://tauri.localhost",
  ]);
  assert.deepEqual(
    loadBackendConfig({
      DATABASE_URL: "postgres://localhost/bonobos",
      BONOBOS_CORS_ORIGINS: "https://app.example.test",
    }).corsOrigins,
    ["https://app.example.test"],
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        BONOBOS_CORS_ORIGINS: "*",
      }),
    /BONOBOS_CORS_ORIGINS/,
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        BONOBOS_CORS_ORIGINS: "https://app.example.test/path",
      }),
    /exact HTTPS origins/,
  );
  assert.equal(
    config.steamOpenIdReturnUrl,
    "http://127.0.0.1:8080/auth/steam/callback",
  );
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
        STEAM_OPENID_RETURN_URL: "http://example.test/auth/steam/callback",
      }),
    /HTTPS callback URL/,
  );

  assert.equal(
      loadBackendConfig({
        DATABASE_URL: "postgres://localhost/bonobos",
      }).databaseSsl,
      false,
  );
  assert.throws(
      () =>
        loadBackendConfig({
          DATABASE_URL: "postgres://db.example/bonobos",
        }),
      /DATABASE_SSL=true is required/,
  );
  assert.throws(
      () =>
        loadBackendConfig({
          DATABASE_URL: "postgres://db.example/bonobos",
          DATABASE_SSL: "false",
        }),
      /DATABASE_SSL=true is required/,
  );
  assert.equal(
      loadBackendConfig({
        DATABASE_URL: "postgres://db.example/bonobos",
        DATABASE_SSL: "true",
      }).databaseSsl,
      true,
  );
  assert.throws(
      () =>
        loadBackendConfig({
          DATABASE_URL: "postgres://db.example/bonobos?sslmode=no-verify",
          DATABASE_SSL: "true",
        }),
      /Remove PostgreSQL TLS options/,
  );
  assert.throws(
      () =>
        loadBackendConfig({
          DATABASE_URL: "postgres://db.example/bonobos?ssl=no-verify",
          DATABASE_SSL: "true",
        }),
      /Remove PostgreSQL TLS options/,
  );
  assert.throws(
      () =>
        loadBackendConfig({
          DATABASE_URL: "postgres://localhost/bonobos",
          STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS: "0",
        }),
      /STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS must be an integer/,
  );
});

test("allows insecure internal DB only for the postgres Docker service", () => {
  const base = {
    DATABASE_URL: "postgres://postgres/bonobos",
    BONOBOS_ALLOW_INSECURE_INTERNAL_DB: "true",
    DATABASE_SSL: "false",
  };
  assert.doesNotThrow(() => loadBackendConfig(base));

  // Remote IP refused even with flag
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://1.2.3.4/bonobos",
        BONOBOS_ALLOW_INSECURE_INTERNAL_DB: "true",
        DATABASE_SSL: "false",
      }),
    /DATABASE_SSL=true is required/,
  );

  // Arbitrary no-dot hostname refused
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://dbinterne/bonobos",
        BONOBOS_ALLOW_INSECURE_INTERNAL_DB: "true",
        DATABASE_SSL: "false",
      }),
    /DATABASE_SSL=true is required/,
  );

  // Remote domain refused
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://db.example.com/bonobos",
        BONOBOS_ALLOW_INSECURE_INTERNAL_DB: "true",
        DATABASE_SSL: "false",
      }),
    /DATABASE_SSL=true is required/,
  );

  // Without flag, strict
  assert.throws(
    () =>
      loadBackendConfig({
        DATABASE_URL: "postgres://postgres/bonobos",
        DATABASE_SSL: "false",
      }),
    /DATABASE_SSL=true is required/,
  );

  // Flag ignored if DATABASE_SSL=true (no contradiction needed; accepted)
  assert.doesNotThrow(() =>
    loadBackendConfig({
      DATABASE_URL: "postgres://postgres/bonobos",
      BONOBOS_ALLOW_INSECURE_INTERNAL_DB: "true",
      DATABASE_SSL: "true",
    }),
  );
});

test("enforces fixed-window limits and resets expired windows", () => {
  const limiter = new FixedWindowRateLimiter();
  const policy = { maxRequests: 2, windowMs: 1_000 };

  assert.deepEqual(limiter.consume(policy, 10_000), {
      allowed: true,
      retryAfterSeconds: 0,
  });
  assert.equal(limiter.consume(policy, 10_100).allowed, true);
  assert.deepEqual(limiter.consume(policy, 10_200), {
      allowed: false,
      retryAfterSeconds: 1,
  });
  assert.equal(limiter.consume(policy, 11_000).allowed, true);
});

test("applies PostgreSQL migrations transactionally and rejects changed history", async () => {
  const database = new InProcessPostgres();
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "bonobos-migrations-"),
  );
  const sourceMigration = await readFile(
    path.join(migrationDirectory, "001_initial_platform_schema.sql"),
    "utf8",
  );
  const migrationFile = path.join(
    temporaryDirectory,
    "001_initial_platform_schema.sql",
  );

  try {
    assert.doesNotMatch(sourceMigration, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA)\b/i);
    await writeFile(migrationFile, sourceMigration, "utf8");

    assert.deepEqual(
      await runMigrations(database, temporaryDirectory),
      ["001"],
    );
    assert.deepEqual(await runMigrations(database, temporaryDirectory), []);

    const tables = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'users',
           'external_identities',
           'roles',
           'permissions',
           'role_permissions',
           'user_roles',
           'games',
           'projects',
           'applications',
           'project_applications',
           'project_memberships',
           'pages',
           'page_revisions',
           'configurations',
           'configuration_revisions',
           'user_sessions',
           'platform_bootstrap_state',
           'activity_log'
         )`,
    );
    assert.equal(tables.rows[0]?.count, 18);

    const userGlobalPermissions = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM role_permissions
       JOIN roles ON roles.id = role_permissions.role_id
       WHERE roles.code = 'UTILISATEUR'
         AND role_permissions.scope = 'GLOBAL'`,
    );
    assert.equal(userGlobalPermissions.rows[0]?.count, 0);
    const userProjectPermissions = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM role_permissions
       JOIN roles ON roles.id = role_permissions.role_id
       WHERE roles.code = 'UTILISATEUR'
         AND role_permissions.scope = 'PROJECT'`,
    );
    assert.equal(userProjectPermissions.rows[0]?.count, 4);

    const roles = await database.query<{ code: string }>(
      "SELECT code FROM roles ORDER BY code",
    );
    assert.deepEqual(
      roles.rows.map(({ code }) => code),
      ["ADMINISTRATEUR", "UTILISATEUR"],
    );
    const administrators = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM user_roles
       JOIN roles ON roles.id = user_roles.role_id
       WHERE roles.code = 'ADMINISTRATEUR'`,
    );
    assert.equal(administrators.rows[0]?.count, 0);

    const secondMigrationFile = path.join(
      temporaryDirectory,
      "002_pending.sql",
    );
    await writeFile(secondMigrationFile, "SELECT 1;", "utf8");
    await rm(migrationFile);
    await assert.rejects(
      () => runMigrations(database, temporaryDirectory),
      /Applied migration 001 is missing/,
    );
    await writeFile(migrationFile, sourceMigration, "utf8");
    await rm(secondMigrationFile);

    await writeFile(migrationFile, `${sourceMigration}\n-- changed\n`, "utf8");
    await assert.rejects(
      () => runMigrations(database, temporaryDirectory),
      /has changed/,
    );

  } finally {
    await database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("migrates a previously claimed bootstrap administrator without losing the claim", async () => {
  const database = new InProcessPostgres();
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "bonobos-bootstrap-migration-"),
  );
  const migrationNames = [
    "001_initial_platform_schema.sql",
    "002_steam_authentication.sql",
  ];

  try {
    for (const migrationName of migrationNames) {
      await writeFile(
        path.join(temporaryDirectory, migrationName),
        await readFile(path.join(migrationDirectory, migrationName), "utf8"),
        "utf8",
      );
    }
    assert.deepEqual(
      await runMigrations(database, temporaryDirectory),
      ["001", "002"],
    );
    const userId = await seedUser(database, "Existing bootstrap admin", "ADMINISTRATEUR");
    const steamId = "76561198000000000";
    await database.query(
      `INSERT INTO external_identities
         (user_id, provider, subject, verified_at)
       VALUES ($1, 'steam', $2, now())`,
      [userId, steamId],
    );
    await database.query(
      `UPDATE platform_bootstrap_state
       SET initial_admin_user_id = $1,
           initial_admin_claimed_at = now()
       WHERE singleton = true`,
      [userId],
    );

    await writeFile(
      path.join(
        temporaryDirectory,
        "003_multiple_initial_administrators.sql",
      ),
      await readFile(
        path.join(migrationDirectory, "003_multiple_initial_administrators.sql"),
        "utf8",
      ),
      "utf8",
    );
    assert.deepEqual(
      await runMigrations(database, temporaryDirectory),
      ["003"],
    );
    const existingClaim = await database.query<{
      steam_id: string;
      user_id: string;
    }>(
      `SELECT steam_id, user_id
       FROM platform_initial_admin_claims`,
    );
    assert.deepEqual(existingClaim.rows, [{ steam_id: steamId, user_id: userId }]);
  } finally {
    await database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("enforces active principals and project-scoped permissions", () => {
  const projectA = "project-a";
  const projectB = "project-b";
  const user: AuthenticatedPrincipal = {
    userId: "user-1",
    status: "ACTIVE",
    grants: [
      { permission: "layouts.read", scope: "PROJECT", projectId: projectA },
    ],
  };

  assert.equal(hasPermission(user, "layouts.read", projectA), true);
  assert.equal(hasPermission(user, "layouts.read", projectB), false);
  assert.equal(hasPermission(user, "layouts.read"), false);
  assert.equal(
    hasPermission({ ...user, status: "SUSPENDED" }, "layouts.read", projectA),
    false,
  );
  assert.equal(
    hasPermission(
      createPrincipal("admin", ["layouts.read"]),
      "layouts.read",
      projectB,
    ),
    true,
  );
});

test("requires server-side authorization before changing global roles", async () => {
  const database = new InProcessPostgres();
  const applied = await runMigrations(database, migrationDirectory);
  assert.deepEqual(applied, ["001", "002", "003", "004"]);

  const administratorId = await seedUser(
    database,
    "Administrateur",
    "ADMINISTRATEUR",
  );
  const targetUserId = await seedUser(database, "Utilisateur", "UTILISATEUR");
  const staleUserId = await seedUser(database, "Administrateur périmé", "UTILISATEUR");
  const staleAdministrator = createPrincipal(staleUserId, [
    "administration.access",
    "users.roles.manage",
  ]);
  const administrator = createPrincipal(administratorId, [
    "administration.access",
    "users.roles.manage",
  ]);
  const ordinaryUser = createPrincipal(targetUserId, []);

  try {
    await assert.rejects(
      () =>
        changeGlobalRole(database, ordinaryUser, targetUserId, "ADMINISTRATEUR"),
      (error: unknown) =>
        error instanceof RoleServiceError && error.code === "forbidden",
    );
    await assert.rejects(
      () =>
        changeGlobalRole(
          database,
          administrator,
          administratorId,
          "UTILISATEUR",
        ),
      (error: unknown) =>
        error instanceof RoleServiceError &&
        error.code === "self_role_change_forbidden",
    );
    await assert.rejects(
      () =>
        changeGlobalRole(
          database,
          staleAdministrator,
          targetUserId,
          "ADMINISTRATEUR",
        ),
      (error: unknown) =>
        error instanceof RoleServiceError && error.code === "forbidden",
    );

    const server = await buildServer({
      database,
      transactions: database,
      authentication: {
        async authenticate(authorizationHeader) {
          if (authorizationHeader === "Bearer admin-test") {
            return administrator;
          }
          if (authorizationHeader === "Bearer user-test") {
            return ordinaryUser;
          }
          if (authorizationHeader === "Bearer stale-admin-test") {
            return staleAdministrator;
          }
          return null;
        },
      } satisfies AuthenticationProvider,
    });

    try {
      const anonymous = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${targetUserId}/role`,
        payload: { role: "ADMINISTRATEUR" },
      });
      assert.equal(anonymous.statusCode, 401);

      const denied = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${targetUserId}/role`,
        headers: { authorization: "Bearer user-test" },
        payload: { role: "ADMINISTRATEUR" },
      });
      assert.equal(denied.statusCode, 403);

      const staleAuthorization = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${targetUserId}/role`,
        headers: { authorization: "Bearer stale-admin-test" },
        payload: { role: "ADMINISTRATEUR" },
      });
      assert.equal(staleAuthorization.statusCode, 403);

      const invalidRole = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${targetUserId}/role`,
        headers: { authorization: "Bearer admin-test" },
        payload: { role: "SUPERUSER" },
      });
      assert.equal(invalidRole.statusCode, 400);

      const selfRoleChange = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${administratorId}/role`,
        headers: { authorization: "Bearer admin-test" },
        payload: { role: "UTILISATEUR" },
      });
      assert.equal(selfRoleChange.statusCode, 403);
      assert.equal(selfRoleChange.json().error, "self_role_change_forbidden");

      const promoted = await server.inject({
        method: "PUT",
        url: `/v1/admin/users/${targetUserId}/role`,
        headers: { authorization: "Bearer admin-test" },
        payload: { role: "ADMINISTRATEUR" },
      });
      assert.equal(promoted.statusCode, 200);
      assert.equal(promoted.json().previousRole, "UTILISATEUR");

      const assignment = await database.query<{ code: string }>(
        `SELECT roles.code
         FROM user_roles
         JOIN roles ON roles.id = user_roles.role_id
         WHERE user_roles.user_id = $1`,
        [targetUserId],
      );
      assert.deepEqual(
        assignment.rows.map(({ code }) => code),
        ["ADMINISTRATEUR"],
      );
      const audit = await database.query<{ action: string }>(
        "SELECT action FROM activity_log WHERE actor_user_id = $1",
        [administratorId],
      );
      assert.deepEqual(
        audit.rows.map(({ action }) => action),
        ["user.global_role_changed"],
      );

      const permissions = await server.inject({
        method: "GET",
        url: "/v1/admin/permissions",
        headers: { authorization: "Bearer user-test" },
      });
      assert.equal(permissions.statusCode, 403);
    } finally {
      await server.close();
    }
  } finally {
    await database.close();
  }
});

test("prevents administrators from changing their own role", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const onlyAdministratorId = await seedUser(
    database,
    "Administrateur unique",
    "ADMINISTRATEUR",
  );
  const administrator = createPrincipal(onlyAdministratorId, [
    "users.roles.manage",
  ]);

  try {
    await assert.rejects(
      () =>
        changeGlobalRole(
          database,
          administrator,
          onlyAdministratorId,
          "UTILISATEUR",
        ),
      (error: unknown) =>
        error instanceof RoleServiceError &&
        error.code === "self_role_change_forbidden",
    );

    const role = await database.query<{ code: string }>(
      `SELECT roles.code
       FROM user_roles
       JOIN roles ON roles.id = user_roles.role_id
       WHERE user_roles.user_id = $1`,
      [onlyAdministratorId],
    );
    assert.deepEqual(
      role.rows.map(({ code }) => code),
      ["ADMINISTRATEUR"],
    );
  } finally {
    await database.close();
  }
});

test("protects the last active administrator from suspension and revokes suspended sessions", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const administratorId = await seedUser(
    database,
    "Administrateur",
    "ADMINISTRATEUR",
  );
  const targetId = await seedUser(database, "Utilisateur", "UTILISATEUR");
  const administrator = createPrincipal(administratorId, ["users.manage"]);
  const tokenHash = hashSessionToken("target-session-token");
  await database.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [targetId, tokenHash],
  );

  try {
    await assert.rejects(
      () =>
        updateUserAccount(database, administrator, administratorId, {
          status: "SUSPENDED",
        }),
      (error: unknown) =>
        error instanceof AccountServiceError &&
        error.code === "last_active_administrator",
    );

    const updated = await updateUserAccount(database, administrator, targetId, {
      displayName: "Compte modifié",
      status: "SUSPENDED",
    });
    assert.equal(updated.displayName, "Compte modifié");
    assert.equal(updated.status, "SUSPENDED");

    const session = await database.query<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM user_sessions WHERE user_id = $1",
      [targetId],
    );
    assert.ok(session.rows[0]?.revoked_at);
    const audit = await database.query<{ action: string }>(
      "SELECT action FROM activity_log WHERE entity_id = $1 ORDER BY created_at",
      [targetId],
    );
    assert.deepEqual(
      audit.rows.map(({ action }) => action),
      ["user.account_updated"],
    );
  } finally {
    await database.close();
  }
});

test("admin account routes enforce permissions and audit account changes", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const administratorId = await seedUser(
    database,
    "Administrateur",
    "ADMINISTRATEUR",
  );
  const targetId = await seedUser(database, "Compte à gérer", "UTILISATEUR");
  const administrator = createPrincipal(administratorId, [
    "users.read",
    "users.manage",
  ]);
  const ordinaryUser = createPrincipal(targetId, ["projects.read"]);
  const server = await buildServer({
    database,
    transactions: database,
    authentication: {
      async authenticate(authorizationHeader) {
        return authorizationHeader === "Bearer admin"
          ? administrator
          : authorizationHeader === "Bearer user"
            ? ordinaryUser
            : null;
      },
    },
  });

  try {
    const listed = await server.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: "Bearer admin" },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().users.length, 2);

    const deniedList = await server.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: "Bearer user" },
    });
    assert.equal(deniedList.statusCode, 403);

    const updated = await server.inject({
      method: "PATCH",
      url: `/v1/admin/users/${targetId}`,
      headers: { authorization: "Bearer admin" },
      payload: { displayName: "Nom administré" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().displayName, "Nom administré");

    const deniedUpdate = await server.inject({
      method: "PATCH",
      url: `/v1/admin/users/${targetId}`,
      headers: { authorization: "Bearer user" },
      payload: { status: "SUSPENDED" },
    });
    assert.equal(deniedUpdate.statusCode, 403);
  } finally {
    await server.close();
    await database.close();
  }
});

test("verifies Steam OpenID with the official provider and rejects forged or stale responses", async () => {
  const state = "test-state";
  const returnTo =
    "https://bonobos.example/auth/steam/callback?state=test-state";
  const parameters = createOpenIdResponse(returnTo, state);
  let verificationRequest: RequestInit | undefined;
  const verified = await verifySteamOpenIdResponse(
    parameters,
    returnTo,
    async (input, init) => {
      assert.equal(input, steamOpenIdEndpoint);
      verificationRequest = init;
      return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
    },
  );
  assert.equal(verified.steamId, "76561198000000000");
  assert.ok(
    String(verificationRequest?.body).includes(
      "openid.mode=check_authentication",
    ),
  );

  await assert.rejects(
    () =>
      verifySteamOpenIdResponse(
        parameters,
        "https://attacker.example/auth/steam/callback?state=test-state",
        async () => {
          throw new Error("Provider must not be called for a mismatched return_to.");
        },
      ),
    (error: unknown) =>
      error instanceof SteamOpenIdError &&
      error.code === "invalid_response",
  );
  const mismatchedIdentity = createOpenIdResponse(returnTo, state);
  mismatchedIdentity.set(
    "openid.identity",
    "https://steamcommunity.com/openid/id/76561198000000001",
  );
  await assert.rejects(
    () =>
      verifySteamOpenIdResponse(mismatchedIdentity, returnTo, async () => {
        throw new Error("Provider must not be called for mismatched identity.");
      }),
    (error: unknown) =>
      error instanceof SteamOpenIdError &&
      error.code === "invalid_response",
  );
  await assert.rejects(
    () =>
      verifySteamOpenIdResponse(parameters, returnTo, async () =>
        new Response("is_valid:false\n"),
      ),
    (error: unknown) =>
      error instanceof SteamOpenIdError &&
      error.code === "invalid_response",
  );
  const stale = createOpenIdResponse(
    returnTo,
    state,
    "76561198000000000",
    "2000-01-01T00:00:00Zold-nonce",
  );
  await assert.rejects(
    () =>
      verifySteamOpenIdResponse(stale, returnTo, async () => {
        throw new Error("Provider must not be called for a stale nonce.");
      }),
    (error: unknown) =>
      error instanceof SteamOpenIdError &&
      error.code === "invalid_response",
  );
  await assert.rejects(
    () =>
      verifySteamOpenIdResponse(parameters, returnTo, async () =>
        new Response("x".repeat(8_193)),
      ),
    (error: unknown) =>
      error instanceof SteamOpenIdError &&
      error.code === "invalid_response",
  );
});

test("Steam login provisions one user, stores only a session hash, enforces CSRF and supports logout", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  let providerVerifications = 0;
  const server = await buildServer({
    database,
    transactions: database,
    authentication: new PostgresSessionAuthenticationProvider(database),
    initialAdminSteamIds: [
      "76561198000000000",
      "76561198000000001",
    ],
    steamOpenIdReturnUrl:
      "https://bonobos.example/auth/steam/callback",
    steamOpenIdFetch: async (_input, init) => {
      providerVerifications += 1;
      assert.equal(init?.method, "POST");
      assert.ok(
        String(init?.body).includes("openid.mode=check_authentication"),
      );
      return new Response("is_valid:true\n");
    },
  });

  try {
    const start = await server.inject({
      method: "GET",
      url: "/auth/steam",
    });
    assert.equal(start.statusCode, 302);
    const location = new URL(start.headers.location ?? "");
    assert.equal(location.origin + location.pathname, steamOpenIdEndpoint);
    const state = new URL(
      location.searchParams.get("openid.return_to") ?? "",
    ).searchParams.get("state");
    assert.ok(state);
    const startCookies = getSetCookieValues(start.headers["set-cookie"]);
    assert.ok(
      startCookies
        .find((cookie) => cookie.startsWith(`${steamStateCookieName}=`))
        ?.includes("HttpOnly"),
    );

    const returnTo = location.searchParams.get("openid.return_to");
    assert.ok(returnTo);
    const callbackParameters = createOpenIdResponse(returnTo, state);
    const callbackPath = `/auth/steam/callback?${callbackParameters.toString()}`;
    const stateCookie = `${steamStateCookieName}=${state}`;

    const mismatchedState = new URLSearchParams(callbackParameters);
    mismatchedState.set("state", "attacker-state");
    const csrfRejected = await server.inject({
      method: "GET",
      url: `/auth/steam/callback?${mismatchedState.toString()}`,
      headers: { cookie: stateCookie },
    });
    assert.equal(csrfRejected.statusCode, 400);
    assert.equal(providerVerifications, 0);

    const callback = await server.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: stateCookie },
    });
    assert.equal(callback.statusCode, 200);
    assert.equal(providerVerifications, 1);
    assert.deepEqual(callback.json().user.roles, ["ADMINISTRATEUR"]);
    assert.match(callback.json().user.displayName, /^Steam \d{6}$/);

    const loginCookies = getSetCookieValues(callback.headers["set-cookie"]);
    const sessionToken = getCookieValue(loginCookies, sessionCookieName);
    const csrfToken = getCookieValue(loginCookies, csrfCookieName);
    assert.doesNotMatch(JSON.stringify(callback.json()), new RegExp(sessionToken));
    assert.ok(
      loginCookies
        .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
        ?.includes("HttpOnly"),
    );
    assert.ok(
      loginCookies
        .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
        ?.includes("Secure"),
    );
    assert.ok(
      !loginCookies
        .find((cookie) => cookie.startsWith(`${csrfCookieName}=`))
        ?.includes("HttpOnly"),
    );

    const identity = await database.query<{
      count: number;
      verified_at: string;
      last_login_at: string;
    }>(
      `SELECT count(*)::int AS count,
              max(external_identities.verified_at)::text AS verified_at,
              max(users.last_login_at)::text AS last_login_at
       FROM external_identities
       JOIN users ON users.id = external_identities.user_id
       WHERE external_identities.provider = 'steam'
         AND external_identities.subject = '76561198000000000'`,
    );
    assert.equal(identity.rows[0]?.count, 1);
    assert.ok(identity.rows[0]?.verified_at);
    assert.ok(identity.rows[0]?.last_login_at);
    const sessions = await database.query<{ token_hash: Uint8Array }>(
      "SELECT token_hash FROM user_sessions",
    );
    assert.equal(sessions.rows.length, 1);
    assert.deepEqual(
      Buffer.from(sessions.rows[0]?.token_hash ?? []),
      hashSessionToken(sessionToken),
    );
    assert.notEqual(
      Buffer.from(sessions.rows[0]?.token_hash ?? []).toString("utf8"),
      sessionToken,
    );

    const me = await server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json().roles, ["ADMINISTRATEUR"]);
    assert.equal(me.json().steamId, "76561198000000000");
    const deniedAdminUsers = await server.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(deniedAdminUsers.statusCode, 200);

    const bootstrapWithoutCsrf = await server.inject({
      method: "POST",
      url: "/v1/bootstrap/claim-admin",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(bootstrapWithoutCsrf.statusCode, 403);
    const bootstrap = await server.inject({
      method: "POST",
      url: "/v1/bootstrap/claim-admin",
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(bootstrap.statusCode, 409);
    assert.equal(bootstrap.json().error, "bootstrap_already_claimed");
    const secondBootstrap = await server.inject({
      method: "POST",
      url: "/v1/bootstrap/claim-admin",
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(secondBootstrap.statusCode, 409);
    const adminPermissions = await server.inject({
      method: "GET",
      url: "/v1/admin/permissions",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(adminPermissions.statusCode, 200);
    assert.ok(adminPermissions.json().permissions.includes("users.manage"));
    const adminUsers = await server.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(adminUsers.statusCode, 200);
    assert.equal(adminUsers.json().users.length, 1);
    assert.equal(adminUsers.json().users[0].steamId, "76561198000000000");

    const missingCsrf = await server.inject({
      method: "POST",
      url: "/v1/logout",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.json().error, "csrf_failed");

    const logout = await server.inject({
      method: "POST",
      url: "/v1/logout",
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(logout.statusCode, 204);
    const afterLogout = await server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(afterLogout.statusCode, 401);

    const replay = await server.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: stateCookie },
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error, "openid_replayed_or_expired");
    assert.equal(providerVerifications, 1);

    const repeatLogin = await loginWithVerifiedSteamIdentity(
      database,
      "76561198000000000",
      hashSessionToken("second-session-token"),
      new Date(Date.now() + 60_000),
    );
    assert.equal(repeatLogin.kind, "authenticated");
    const counts = await database.query<{ users: number; identities: number }>(
      `SELECT
         (SELECT count(*)::int FROM users) AS users,
         (SELECT count(*)::int FROM external_identities) AS identities`,
    );
    assert.equal(counts.rows[0]?.users, 1);
    assert.equal(counts.rows[0]?.identities, 1);
    await assert.rejects(
      () =>
        database.transaction(async (transaction) => {
          const secondUser = await transaction.query<{ id: string }>(
            "INSERT INTO users (display_name) VALUES ('Second Steam account') RETURNING id",
          );
          await transaction.query(
            `INSERT INTO external_identities
               (user_id, provider, subject, verified_at)
             VALUES ($1, 'steam', '76561198000000000', now())`,
            [secondUser.rows[0]?.id],
          );
        }),
      /external_identities_provider_subject_key/,
    );
    const accountsAfterDuplicateAttempt = await database.query<{
      count: number;
    }>("SELECT count(*)::int AS count FROM users");
    assert.equal(accountsAfterDuplicateAttempt.rows[0]?.count, 1);
  } finally {
    await server.close();
    await database.close();
  }
});

test("exchanges desktop Steam auth once through PKCE and returns a WebView session", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const adminSteamId = "76561198000000000";
  const server = await buildServer({
    database,
    transactions: database,
    authentication: new PostgresSessionAuthenticationProvider(database),
    initialAdminSteamIds: [adminSteamId, "76561198000000001"],
    steamOpenIdReturnUrl: "https://bonobos.example/auth/steam/callback",
    steamOpenIdFetch: async () => new Response("is_valid:true\n"),
  });

  try {
    const { appState, callback, verifier } =
      await completeDesktopSteamAuthorization(server, adminSteamId);
    assert.equal(callback.statusCode, 302);
    const deepLink = new URL(callback.headers.location ?? "");
    assert.equal(deepLink.protocol, "com.canni.bonobos-fr-app:");
    assert.equal(deepLink.hostname, "auth");
    assert.equal(deepLink.pathname, "/callback");
    assert.deepEqual(
      [...deepLink.searchParams.keys()].sort(),
      ["code", "state"],
    );
    assert.equal(deepLink.searchParams.get("state"), appState);
    const code = deepLink.searchParams.get("code");
    assert.ok(code);
    assert.equal(code.length, 43);
    assert.ok(
      !getSetCookieValues(callback.headers["set-cookie"]).some((cookie) =>
        cookie.startsWith(`${sessionCookieName}=`),
      ),
    );

    const wrongVerifier = await server.inject({
      method: "POST",
      url: "/auth/desktop/exchange",
      payload: {
        code,
        verifier: randomBytes(32).toString("base64url"),
        state: appState,
      },
    });
    assert.equal(wrongVerifier.statusCode, 401);
    const beforeExchange = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM user_sessions",
    );
    assert.equal(beforeExchange.rows[0]?.count, 0);

    const corsPreflight = await server.inject({
      method: "OPTIONS",
      url: "/auth/desktop/start",
      headers: {
        origin: "http://tauri.localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(corsPreflight.statusCode, 204);
    assert.equal(
      corsPreflight.headers["access-control-allow-origin"],
      "http://tauri.localhost",
    );
    assert.equal(
      corsPreflight.headers["access-control-allow-credentials"],
      "true",
    );
    const rejectedOrigin = await server.inject({
      method: "OPTIONS",
      url: "/auth/desktop/start",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(
      rejectedOrigin.headers["access-control-allow-origin"],
      undefined,
    );

    const exchange = await server.inject({
      method: "POST",
      url: "/auth/desktop/exchange",
      payload: { code, verifier, state: appState },
    });
    assert.equal(exchange.statusCode, 200);
    assert.deepEqual(exchange.json().user.roles, ["ADMINISTRATEUR"]);
    assert.doesNotMatch(JSON.stringify(exchange.json()), new RegExp(code));
    const sessionCookies = getSetCookieValues(exchange.headers["set-cookie"]);
    const sessionToken = getCookieValue(sessionCookies, sessionCookieName);
    const csrfToken = getCookieValue(sessionCookies, csrfCookieName);
    assert.ok(
      sessionCookies
        .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
        ?.includes("HttpOnly"),
    );
    const sessionCookie = sessionCookies.find((cookie) =>
      cookie.startsWith(`${sessionCookieName}=`),
    );
    assert.ok(sessionCookie?.includes("SameSite=None"));
    assert.ok(sessionCookie?.includes("Secure"));
    assert.ok(exchange.json().csrfToken);

    const me = await server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json().roles, ["ADMINISTRATEUR"]);
    assert.equal(me.json().steamId, adminSteamId);
    assert.equal(me.json().csrfToken, csrfToken);
    const adminPermissions = await server.inject({
      method: "GET",
      url: "/v1/admin/permissions",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(adminPermissions.statusCode, 200);

    const logout = await server.inject({
      method: "POST",
      url: "/v1/logout",
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(logout.statusCode, 204);
    const replay = await server.inject({
      method: "POST",
      url: "/auth/desktop/exchange",
      payload: { code, verifier, state: appState },
    });
    assert.equal(replay.statusCode, 401);
  } finally {
    await server.close();
    await database.close();
  }
});

test("returns Steam cancellation and keeps ordinary desktop users out of admin routes", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const server = await buildServer({
    database,
    transactions: database,
    authentication: new PostgresSessionAuthenticationProvider(database),
    initialAdminSteamIds: [
      "76561198000000000",
      "76561198000000001",
    ],
    steamOpenIdReturnUrl: "https://bonobos.example/auth/steam/callback",
    steamOpenIdFetch: async () => new Response("is_valid:true\n"),
  });

  try {
    const cancelled = await completeDesktopSteamAuthorization(
      server,
      "76561198000000010",
      true,
    );
    assert.equal(cancelled.callback.statusCode, 302);
    const cancelLink = new URL(cancelled.callback.headers.location ?? "");
    assert.equal(cancelLink.searchParams.get("error"), "cancelled");
    assert.equal(cancelLink.searchParams.get("code"), null);
    assert.equal(cancelLink.searchParams.get("state"), cancelled.appState);

    const userSteamId = "76561198000000010";
    const ordinary = await completeDesktopSteamAuthorization(server, userSteamId);
    const deepLink = new URL(ordinary.callback.headers.location ?? "");
    const code = deepLink.searchParams.get("code");
    assert.ok(code);
    const exchange = await server.inject({
      method: "POST",
      url: "/auth/desktop/exchange",
      payload: {
        code,
        verifier: ordinary.verifier,
        state: ordinary.appState,
      },
    });
    assert.equal(exchange.statusCode, 200);
    assert.deepEqual(exchange.json().user.roles, ["UTILISATEUR"]);
    const sessionToken = getCookieValue(
      getSetCookieValues(exchange.headers["set-cookie"]),
      sessionCookieName,
    );
    const deniedAdminUsers = await server.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(deniedAdminUsers.statusCode, 403);
    const deniedAdminPermissions = await server.inject({
      method: "GET",
      url: "/v1/admin/permissions",
      headers: { cookie: `${sessionCookieName}=${sessionToken}` },
    });
    assert.equal(deniedAdminPermissions.statusCode, 403);
  } finally {
    await server.close();
    await database.close();
  }
});

test("rejects expired desktop Steam exchange codes", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const server = await buildServer({
    database,
    transactions: database,
    authentication: new PostgresSessionAuthenticationProvider(database),
    steamOpenIdReturnUrl: "https://bonobos.example/auth/steam/callback",
    steamOpenIdFetch: async () => new Response("is_valid:true\n"),
  });

  try {
    const { appState, callback, verifier } =
      await completeDesktopSteamAuthorization(server, "76561198000000010");
    const code = new URL(callback.headers.location ?? "").searchParams.get(
      "code",
    );
    assert.ok(code);
    await database.query(
      `UPDATE desktop_auth_attempts
       SET exchange_expires_at = now() - interval '1 second'
       WHERE exchange_code_hash = $1`,
      [createHash("sha256").update(code).digest()],
    );
    const exchange = await server.inject({
      method: "POST",
      url: "/auth/desktop/exchange",
      payload: { code, verifier, state: appState },
    });
    assert.equal(exchange.statusCode, 401);
    assert.equal(exchange.json().error, "invalid_desktop_exchange");
  } finally {
    await server.close();
    await database.close();
  }
});

test("rate limits Steam auth requests and prevents excess automatic account creation", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const server = await buildServer({
    database,
    transactions: database,
    authentication: new PostgresSessionAuthenticationProvider(database),
    steamOpenIdReturnUrl: "https://bonobos.example/auth/steam/callback",
    steamAuthRateLimit: { maxRequests: 2, windowMs: 60_000 },
    accountCreationRateLimit: { maxRequests: 1, windowMs: 60_000 },
    steamOpenIdFetch: async () => new Response("is_valid:true\n"),
  });

  async function attemptSteamLogin(steamId: string) {
    const start = await server.inject({ method: "GET", url: "/auth/steam" });
    assert.equal(start.statusCode, 302);
    const location = new URL(start.headers.location ?? "");
    const returnTo = location.searchParams.get("openid.return_to");
    assert.ok(returnTo);
    const state = new URL(returnTo).searchParams.get("state");
    assert.ok(state);
    const nonce = `${new Date(Date.now() - 1_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")}nonce-${steamId}`;
    const parameters = createOpenIdResponse(returnTo, state, steamId, nonce);
    return server.inject({
      method: "GET",
      url: `/auth/steam/callback?${parameters.toString()}`,
      headers: { cookie: `${steamStateCookieName}=${state}` },
    });
  }

  try {
    const firstLogin = await attemptSteamLogin("76561198000000010");
    assert.equal(firstLogin.statusCode, 200);

    const blockedAccountCreation = await attemptSteamLogin(
      "76561198000000011",
    );
    assert.equal(blockedAccountCreation.statusCode, 429);
    assert.equal(blockedAccountCreation.json().error, "rate_limited");
    assert.equal(blockedAccountCreation.headers["retry-after"], "60");

    const blockedAuthStart = await server.inject({
      method: "GET",
      url: "/auth/steam",
      headers: {
        "cf-connecting-ip": "198.51.100.1",
        "x-forwarded-for": "198.51.100.1",
      },
    });
    assert.equal(blockedAuthStart.statusCode, 429);
    assert.equal(blockedAuthStart.headers["retry-after"], "60");

    const users = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users",
    );
    const sessions = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM user_sessions",
    );
    assert.equal(users.rows[0]?.count, 1);
    assert.equal(sessions.rows[0]?.count, 1);
  } finally {
    await server.close();
    await database.close();
  }
});

test("rejects expired sessions and suspended Steam accounts", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const verifiedSteamId = "76561198000000000";
  const expiredSessionToken = "e".repeat(43);
  const initialLogin = await loginWithVerifiedSteamIdentity(
    database,
    verifiedSteamId,
    hashSessionToken(expiredSessionToken),
    new Date(Date.now() - 1_000),
  );
  assert.equal(initialLogin.kind, "authenticated");
  const suspendedUserId = initialLogin.userId;

  try {
    const server = await buildServer({
      database,
      transactions: database,
      authentication: new PostgresSessionAuthenticationProvider(database),
    });
    try {
      const expired = await server.inject({
        method: "GET",
        url: "/v1/me",
        headers: {
          cookie: `${sessionCookieName}=${expiredSessionToken}`,
        },
      });
      assert.equal(expired.statusCode, 401);
    } finally {
      await server.close();
    }

    await database.query(
      "UPDATE users SET status = 'SUSPENDED' WHERE id = $1",
      [suspendedUserId],
    );
    const suspendedLogin = await loginWithVerifiedSteamIdentity(
      database,
      verifiedSteamId,
      hashSessionToken("new-session-token"),
      new Date(Date.now() + 60_000),
    );
    assert.deepEqual(suspendedLogin, {
      kind: "suspended",
      userId: suspendedUserId,
    });

    const sessionCount = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM user_sessions",
    );
    assert.equal(sessionCount.rows[0]?.count, 1);
    const rejectedAudit = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM activity_log WHERE action = 'auth.login_rejected'`,
    );
    assert.equal(rejectedAudit.rows[0]?.count, 1);
  } finally {
    await database.close();
  }
});

test("promotes only configured verified identities once during Steam login", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const configuredIds = [
    "76561198000000000",
    "76561198000000001",
  ];

  try {
    const first = await loginWithVerifiedSteamIdentity(
      database,
      configuredIds[0]!,
      hashSessionToken("initial-admin-one"),
      new Date(Date.now() + 60_000),
      configuredIds,
    );
    const second = await loginWithVerifiedSteamIdentity(
      database,
      configuredIds[1]!,
      hashSessionToken("initial-admin-two"),
      new Date(Date.now() + 60_000),
      configuredIds,
    );
    const ordinary = await loginWithVerifiedSteamIdentity(
      database,
      "76561198000000002",
      hashSessionToken("ordinary-user"),
      new Date(Date.now() + 60_000),
      configuredIds,
    );
    if (
      first.kind !== "authenticated" ||
      second.kind !== "authenticated" ||
      ordinary.kind !== "authenticated"
    ) {
      throw new Error("Steam login unexpectedly rejected an active account.");
    }
    assert.deepEqual(first.roles, ["ADMINISTRATEUR"]);
    assert.deepEqual(second.roles, ["ADMINISTRATEUR"]);
    assert.deepEqual(ordinary.roles, ["UTILISATEUR"]);

    const demotion = await changeGlobalRole(
      database,
      createPrincipal(second.userId, ["users.roles.manage"]),
      first.userId,
      "UTILISATEUR",
    );
    assert.equal(demotion.changed, true);

    const repeatLogin = await loginWithVerifiedSteamIdentity(
      database,
      configuredIds[0]!,
      hashSessionToken("initial-admin-one-again"),
      new Date(Date.now() + 60_000),
      configuredIds,
    );
    if (repeatLogin.kind !== "authenticated") {
      throw new Error("Repeat login unexpectedly rejected an active account.");
    }
    assert.deepEqual(repeatLogin.roles, ["UTILISATEUR"]);

    const claims = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM platform_initial_admin_claims",
    );
    assert.equal(claims.rows[0]?.count, 2);
    const auditEntries = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM activity_log
       WHERE action = 'platform.initial_admin_claimed'`,
    );
    assert.equal(auditEntries.rows[0]?.count, 2);
  } finally {
    await database.close();
  }
});

test("bootstraps only from the configured verified Steam identity", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const userId = await seedUser(database, "Compte Steam", "UTILISATEUR");
  const verifiedSteamId = "76561198000000000";
  await database.query(
    `INSERT INTO external_identities
       (user_id, provider, subject, verified_at)
     VALUES ($1, 'steam', $2, now())`,
    [userId, verifiedSteamId],
  );
  const principal = createPrincipal(userId, []);

  try {
    await assert.rejects(
      () =>
        claimInitialAdministrator(
          database,
          principal,
          ["76561198000000001", "76561198000000002"],
        ),
      (error: unknown) =>
        error instanceof BootstrapServiceError &&
        error.code === "bootstrap_identity_not_verified",
    );

    const configuredIds = [
      verifiedSteamId,
      "76561198000000002",
    ];
    await claimInitialAdministrator(database, principal, configuredIds);
    await assert.rejects(
      () => claimInitialAdministrator(database, principal, configuredIds),
      (error: unknown) =>
        error instanceof BootstrapServiceError &&
        error.code === "bootstrap_already_claimed",
    );

    const roles = await database.query<{ code: string }>(
      `SELECT roles.code
       FROM user_roles
       JOIN roles ON roles.id = user_roles.role_id
       WHERE user_roles.user_id = $1`,
      [userId],
    );
    assert.deepEqual(
      roles.rows.map(({ code }) => code),
      ["ADMINISTRATEUR"],
    );
    const bootstrap = await database.query<{
      initial_admin_user_id: string;
      initial_admin_claimed_at: string;
    }>(
      `SELECT initial_admin_user_id, initial_admin_claimed_at
       FROM platform_bootstrap_state
       WHERE singleton = true`,
    );
    assert.equal(bootstrap.rows[0]?.initial_admin_user_id, userId);
    assert.ok(bootstrap.rows[0]?.initial_admin_claimed_at);

    const secondUserId = await seedUser(
      database,
      "Second configured account",
      "UTILISATEUR",
    );
    await database.query(
      `INSERT INTO external_identities
         (user_id, provider, subject, verified_at)
       VALUES ($1, 'steam', $2, now())`,
      [secondUserId, configuredIds[1]],
    );
    await claimInitialAdministrator(
      database,
      createPrincipal(secondUserId, []),
      configuredIds,
    );
    const claimCount = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM platform_initial_admin_claims",
    );
    assert.equal(claimCount.rows[0]?.count, 2);
  } finally {
    await database.close();
  }
});

test("keeps authenticated APIs closed unless the server verifies a principal", async () => {
  const database = new InProcessPostgres();
  await runMigrations(database, migrationDirectory);
  const server = await buildServer({
    database,
    transactions: database,
    authentication: {
      async authenticate() {
        return null;
      },
    },
  });

  try {
    const alive = await server.inject({
      method: "GET",
      url: "/health/live",
    });
    assert.equal(alive.statusCode, 200);

    const ready = await server.inject({
      method: "GET",
      url: "/health/ready",
    });
    assert.equal(ready.statusCode, 200);

    const identity = await server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer forged-client-role" },
    });
    assert.equal(identity.statusCode, 401);

    const bootstrap = await server.inject({
      method: "POST",
      url: "/v1/bootstrap/claim-admin",
    });
    assert.equal(bootstrap.statusCode, 401);
  } finally {
    await server.close();
    await database.close();
  }
});
