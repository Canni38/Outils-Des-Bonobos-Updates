import type { AuthenticatedPrincipal, UserStatus } from "../authorization.js";
import { hasPermission } from "../authorization.js";
import type {
  SqlExecutor,
  TransactionalSqlExecutor,
} from "./contracts.js";

export interface UserAccount {
  id: string;
  displayName: string;
  status: UserStatus;
  steamId: string | null;
  steamPersonaName: string | null;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

export class AccountServiceError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "user_not_found"
      | "invalid_display_name"
      | "last_active_administrator",
  ) {
    super(code);
    this.name = "AccountServiceError";
  }
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  status: UserStatus;
  steam_id: string | null;
  steam_persona_name: string | null;
  roles: string[];
  created_at: Date | string;
  last_login_at: Date | string | null;
}

interface ExistsRow extends Record<string, unknown> {
  exists: boolean;
}

interface AllowedRow extends Record<string, unknown> {
  allowed: boolean;
}

function mapAccount(row: AccountRow): UserAccount {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    steamId: row.steam_id,
    steamPersonaName: row.steam_persona_name,
    roles: row.roles,
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt:
      row.last_login_at === null
        ? null
        : new Date(row.last_login_at).toISOString(),
  };
}

async function selectAccounts(
  database: SqlExecutor,
  userId?: string,
  search?: string,
): Promise<UserAccount[]> {
  const result = await database.query<AccountRow>(
    `SELECT users.id, users.display_name, users.status,
             max(external_identities.subject)
               FILTER (WHERE external_identities.provider = 'steam') AS steam_id,
             max(external_identities.profile ->> 'steamPersonaName')
               FILTER (WHERE external_identities.provider = 'steam') AS steam_persona_name,
            coalesce(
              array_agg(DISTINCT roles.code)
                FILTER (WHERE roles.code IS NOT NULL),
              ARRAY[]::text[]
            ) AS roles,
            users.created_at, users.last_login_at
     FROM users
     LEFT JOIN external_identities ON external_identities.user_id = users.id
     LEFT JOIN user_roles ON user_roles.user_id = users.id
     LEFT JOIN roles ON roles.id = user_roles.role_id
     WHERE ($1::uuid IS NULL OR users.id = $1)
       AND (
         $2::text IS NULL OR
         users.display_name ILIKE '%' || $2 || '%' OR
         external_identities.subject ILIKE '%' || $2 || '%' OR
         external_identities.profile ->> 'steamPersonaName' ILIKE '%' || $2 || '%'
       )
     GROUP BY users.id
     ORDER BY users.created_at DESC, users.id`,
    [userId ?? null, search ?? null],
  );
  return result.rows.map(mapAccount);
}

export async function listUserAccounts(
  database: SqlExecutor,
  search?: string,
): Promise<UserAccount[]> {
  return selectAccounts(database, undefined, search);
}

export async function updateUserAccount(
  database: TransactionalSqlExecutor,
  actor: AuthenticatedPrincipal,
  userId: string,
  updates: { displayName?: string; status?: UserStatus },
): Promise<UserAccount> {
  if (!hasPermission(actor, "users.manage")) {
    throw new AccountServiceError("forbidden");
  }
  if (
    updates.displayName !== undefined &&
    (updates.displayName.trim().length === 0 ||
      updates.displayName.length > 120)
  ) {
    throw new AccountServiceError("invalid_display_name");
  }

  return database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [73190422]);

    const actorAccess = await transaction.query<AllowedRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM users
         JOIN user_roles ON user_roles.user_id = users.id
         JOIN roles ON roles.id = user_roles.role_id
         JOIN role_permissions ON role_permissions.role_id = roles.id
         JOIN permissions ON permissions.id = role_permissions.permission_id
         WHERE users.id = $1
           AND users.status = 'ACTIVE'
           AND permissions.code = 'users.manage'
           AND role_permissions.scope = 'GLOBAL'
       ) AS allowed`,
      [actor.userId],
    );
    if (!actorAccess.rows[0]?.allowed) {
      throw new AccountServiceError("forbidden");
    }

    const target = await transaction.query<{
      id: string;
      display_name: string;
      status: UserStatus;
    }>(
      "SELECT id, display_name, status FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const current = target.rows[0];
    if (current === undefined) {
      throw new AccountServiceError("user_not_found");
    }

    if (
      current.status === "ACTIVE" &&
      updates.status === "SUSPENDED"
    ) {
      const lastAdministrator = await transaction.query<ExistsRow>(
        `SELECT EXISTS (
           SELECT 1
           FROM users
           JOIN user_roles ON user_roles.user_id = users.id
           JOIN roles ON roles.id = user_roles.role_id
           WHERE users.status = 'ACTIVE'
             AND roles.code = 'ADMINISTRATEUR'
             AND users.id = $1
         ) AS exists`,
        [userId],
      );
      if (lastAdministrator.rows[0]?.exists) {
        const otherAdministrator = await transaction.query<ExistsRow>(
          `SELECT EXISTS (
             SELECT 1
             FROM users
             JOIN user_roles ON user_roles.user_id = users.id
             JOIN roles ON roles.id = user_roles.role_id
             WHERE users.status = 'ACTIVE'
               AND roles.code = 'ADMINISTRATEUR'
               AND users.id <> $1
           ) AS exists`,
          [userId],
        );
        if (!otherAdministrator.rows[0]?.exists) {
          throw new AccountServiceError("last_active_administrator");
        }
      }
    }

    const displayName = updates.displayName?.trim() ?? current.display_name;
    const status = updates.status ?? current.status;
    const changed =
      displayName !== current.display_name || status !== current.status;
    if (changed) {
      await transaction.query(
        `UPDATE users
         SET display_name = $2, status = $3, updated_at = now()
         WHERE id = $1`,
        [userId, displayName, status],
      );
      if (current.status !== "SUSPENDED" && status === "SUSPENDED") {
        await transaction.query(
          `UPDATE user_sessions
           SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
      }
      await transaction.query(
        `INSERT INTO activity_log
           (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'user.account_updated', 'user', $2, $3::jsonb)`,
        [
          actor.userId,
          userId,
          JSON.stringify({
            ...(displayName !== current.display_name
              ? { displayName: { from: current.display_name, to: displayName } }
              : {}),
            ...(status !== current.status
              ? { status: { from: current.status, to: status } }
              : {}),
          }),
        ],
      );
    }

    const accounts = await selectAccounts(transaction, userId);
    const updated = accounts[0];
    if (updated === undefined) {
      throw new Error("Updated account could not be read.");
    }
    return updated;
  });
}
