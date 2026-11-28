import { createHash } from "node:crypto";
import type { AuthenticationProvider } from "../authentication.js";
import type { AuthenticatedPrincipal, UserStatus } from "../authorization.js";
import { readCookie, sessionCookieName } from "../httpCookies.js";
import { claimInitialAdministratorInTransaction } from "./bootstrapService.js";
import type {
  SqlExecutor,
  TransactionalSqlExecutor,
} from "./contracts.js";

export const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

interface UserRow extends Record<string, unknown> {
  id: string;
  status: UserStatus;
  display_name: string;
}

interface RoleRow extends Record<string, unknown> {
  code: string;
}

interface LoginResult {
  kind: "authenticated";
  userId: string;
  displayName: string;
  roles: string[];
}

interface SuspendedLoginResult {
  kind: "suspended";
  userId: string;
}

export type SteamLoginResult = LoginResult | SuspendedLoginResult;

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function createSteamLoginChallenge(
  database: SqlExecutor,
  stateHash: Buffer,
  expiresAt: Date,
  desktopAttemptHash?: Buffer,
): Promise<void> {
  await database.query(
    "DELETE FROM steam_openid_transactions WHERE expires_at < now() - interval '1 day'",
  );
  await database.query(
    "DELETE FROM steam_openid_nonces WHERE expires_at < now()",
  );
  if (desktopAttemptHash === undefined) {
    await database.query(
      `INSERT INTO steam_openid_transactions (state_hash, expires_at)
       VALUES ($1, $2)`,
      [stateHash, expiresAt],
    );
  } else {
    await database.query(
      `INSERT INTO steam_openid_transactions
         (state_hash, expires_at, desktop_attempt_hash)
       VALUES ($1, $2, $3)`,
      [stateHash, expiresAt, desktopAttemptHash],
    );
  }
}

export async function isSteamLoginChallengeActive(
  database: SqlExecutor,
  stateHash: Buffer,
): Promise<boolean> {
  const result = await database.query(
    `SELECT 1
     FROM steam_openid_transactions
     WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [stateHash],
  );
  return result.rows.length === 1;
}

export async function consumeSteamLoginChallenge(
  database: TransactionalSqlExecutor,
  stateHash: Buffer,
  responseNonce?: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const challenge = await transaction.query(
      `UPDATE steam_openid_transactions
       SET consumed_at = now()
       WHERE state_hash = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING state_hash`,
      [stateHash],
    );
    if (challenge.rowCount !== 1) {
      return false;
    }

    if (responseNonce !== undefined) {
      const nonce = await transaction.query(
        `INSERT INTO steam_openid_nonces (response_nonce, expires_at)
         VALUES ($1, now() + interval '1 day')
         ON CONFLICT (response_nonce) DO NOTHING
         RETURNING response_nonce`,
        [responseNonce],
      );
      if (nonce.rowCount !== 1) {
        return false;
      }
    }
    return true;
  });
}

export async function loginWithVerifiedSteamIdentity(
  database: TransactionalSqlExecutor,
  steamId: string,
  sessionTokenHash: Buffer,
  expiresAt: Date,
  initialAdminSteamIds: readonly string[] = [],
): Promise<SteamLoginResult> {
  return database.transaction((transaction) =>
    loginWithVerifiedSteamIdentityInTransaction(
      transaction,
      steamId,
      sessionTokenHash,
      expiresAt,
      initialAdminSteamIds,
    ),
  );
}

export async function loginWithVerifiedSteamIdentityInTransaction(
  transaction: SqlExecutor,
  steamId: string,
  sessionTokenHash: Buffer,
  expiresAt: Date,
  initialAdminSteamIds: readonly string[] = [],
): Promise<SteamLoginResult> {
  await transaction.query("SELECT pg_advisory_xact_lock($1)", [73190423]);
  if (initialAdminSteamIds.includes(steamId)) {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [73190422]);
  }

  let userResult = await transaction.query<UserRow>(
    `SELECT users.id, users.status, users.display_name
     FROM external_identities
     JOIN users ON users.id = external_identities.user_id
     WHERE external_identities.provider = 'steam'
       AND external_identities.subject = $1
     FOR UPDATE OF users`,
    [steamId],
  );
  let user = userResult.rows[0];
  if (user === undefined) {
    userResult = await transaction.query<UserRow>(
      `INSERT INTO users (display_name, last_login_at)
       VALUES ($1, now())
       RETURNING id, status, display_name`,
      [`Steam ${steamId.slice(-6)}`],
    );
    user = userResult.rows[0];
    if (user === undefined) {
      throw new Error("Steam account creation returned no user.");
    }

    await transaction.query(
      `INSERT INTO external_identities
         (user_id, provider, subject, verified_at)
       VALUES ($1, 'steam', $2, now())`,
      [user.id, steamId],
    );
    const assignedRole = await transaction.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'UTILISATEUR' AND is_system = true`,
      [user.id],
    );
    if (assignedRole.rowCount !== 1) {
      throw new Error("The system user role is missing.");
    }
    await transaction.query(
      `INSERT INTO activity_log
         (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'user.account_created', 'user', $2, '{"provider":"steam"}'::jsonb)`,
      [user.id, user.id],
    );
  }

  if (user.status !== "ACTIVE") {
    await transaction.query(
      `INSERT INTO activity_log
         (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'auth.login_rejected', 'user', $2, '{"reason":"suspended"}'::jsonb)`,
      [user.id, user.id],
    );
    return { kind: "suspended", userId: user.id };
  }

  if (initialAdminSteamIds.includes(steamId)) {
    await claimInitialAdministratorInTransaction(
      transaction,
      user.id,
      steamId,
    );
  }

  await transaction.query(
    "UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1",
    [user.id],
  );
  await transaction.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, sessionTokenHash, expiresAt],
  );
  await transaction.query(
    `INSERT INTO activity_log
       (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'auth.login_succeeded', 'user', $2, '{"provider":"steam"}'::jsonb)`,
    [user.id, user.id],
  );
  const roles = await transaction.query<RoleRow>(
    `SELECT roles.code
     FROM user_roles
     JOIN roles ON roles.id = user_roles.role_id
     WHERE user_roles.user_id = $1
     ORDER BY roles.code`,
    [user.id],
  );

  return {
    kind: "authenticated",
    userId: user.id,
    displayName: user.display_name,
    roles: roles.rows.map(({ code }) => code),
  };
}

interface AuthenticatedUserRow extends Record<string, unknown> {
  id: string;
  status: UserStatus;
  display_name: string;
  steam_id: string;
  role_code: string | null;
  permission_code: AuthenticatedPrincipal["grants"][number]["permission"] | null;
  permission_scope: "GLOBAL" | "PROJECT" | null;
  project_id: string | null;
}

export async function authenticateSession(
  database: SqlExecutor,
  sessionToken: string,
): Promise<AuthenticatedPrincipal | null> {
  const result = await database.query<AuthenticatedUserRow>(
    `WITH assigned_roles AS (
       SELECT user_id, role_id, NULL::uuid AS project_id, true AS is_global
       FROM user_roles
       UNION ALL
       SELECT user_id, role_id, project_id, false AS is_global
       FROM project_memberships
     )
     SELECT users.id, users.status, users.display_name,
            external_identities.subject AS steam_id,
            roles.code AS role_code,
            permissions.code AS permission_code,
            role_permissions.scope AS permission_scope,
            assigned_roles.project_id
     FROM user_sessions
     JOIN users ON users.id = user_sessions.user_id
     JOIN external_identities
       ON external_identities.user_id = users.id
      AND external_identities.provider = 'steam'
     LEFT JOIN assigned_roles ON assigned_roles.user_id = users.id
     LEFT JOIN roles ON roles.id = assigned_roles.role_id
     LEFT JOIN role_permissions
       ON role_permissions.role_id = roles.id
      AND ((assigned_roles.is_global AND role_permissions.scope = 'GLOBAL')
        OR (NOT assigned_roles.is_global AND role_permissions.scope = 'PROJECT'))
     LEFT JOIN permissions ON permissions.id = role_permissions.permission_id
     WHERE user_sessions.token_hash = $1
       AND user_sessions.revoked_at IS NULL
       AND user_sessions.expires_at > now()`,
    [hashSessionToken(sessionToken)],
  );
  const first = result.rows[0];
  if (first === undefined || first.status !== "ACTIVE") {
    return null;
  }

  const roles = new Set<string>();
  const grants = new Map<string, AuthenticatedPrincipal["grants"][number]>();
  for (const row of result.rows) {
    if (row.role_code !== null) {
      roles.add(row.role_code);
    }
    if (row.permission_code === null || row.permission_scope === null) {
      continue;
    }
    const grant =
      row.permission_scope === "GLOBAL"
        ? { permission: row.permission_code, scope: "GLOBAL" as const }
        : row.project_id === null
          ? null
          : {
              permission: row.permission_code,
              scope: "PROJECT" as const,
              projectId: row.project_id,
            };
    if (grant !== null) {
      grants.set(
        `${grant.permission}:${grant.scope}:${"projectId" in grant ? grant.projectId : ""}`,
        grant,
      );
    }
  }

  return {
    userId: first.id,
    status: first.status,
    displayName: first.display_name,
    steamId: first.steam_id,
    roles: [...roles],
    grants: [...grants.values()],
  };
}

export async function revokeSession(
  database: TransactionalSqlExecutor,
  sessionToken: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ user_id: string }>(
      `UPDATE user_sessions
       SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [hashSessionToken(sessionToken)],
    );
    const userId = result.rows[0]?.user_id;
    if (userId === undefined) {
      return false;
    }
    await transaction.query(
      `INSERT INTO activity_log
         (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'auth.logout', 'user', $2, '{"provider":"steam"}'::jsonb)`,
      [userId, userId],
    );
    return true;
  });
}

export class PostgresSessionAuthenticationProvider
  implements AuthenticationProvider
{
  constructor(private readonly database: SqlExecutor) {}

  async authenticate(
    _authorizationHeader: string | undefined,
    cookieHeader?: string,
  ): Promise<AuthenticatedPrincipal | null> {
    const token = readCookie(cookieHeader, sessionCookieName);
    if (token === null || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      return null;
    }
    return authenticateSession(this.database, token);
  }
}
