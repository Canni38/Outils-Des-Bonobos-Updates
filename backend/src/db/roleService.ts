import type { AuthenticatedPrincipal } from "../authorization.js";
import { hasPermission } from "../authorization.js";
import type { TransactionalSqlExecutor } from "./contracts.js";

export type GlobalRoleCode = "ADMINISTRATEUR" | "UTILISATEUR";

export interface RoleChangeResult {
  previousRole: GlobalRoleCode | null;
  role: GlobalRoleCode;
  changed: boolean;
}

export type RoleServiceErrorCode =
  | "forbidden"
  | "self_role_change_forbidden"
  | "user_not_found"
  | "role_unavailable"
  | "last_active_administrator";

export class RoleServiceError extends Error {
  constructor(readonly code: RoleServiceErrorCode) {
    super(code);
    this.name = "RoleServiceError";
  }
}

interface UserRow extends Record<string, unknown> {
  id: string;
  status: "ACTIVE" | "SUSPENDED";
}

interface RoleRow extends Record<string, unknown> {
  id: string;
  code: GlobalRoleCode;
}

interface ExistingRoleRow extends Record<string, unknown> {
  code: GlobalRoleCode;
}

interface ExistsRow extends Record<string, unknown> {
  exists: boolean;
}

interface AllowedRow extends Record<string, unknown> {
  allowed: boolean;
}

export async function changeGlobalRole(
  database: TransactionalSqlExecutor,
  actor: AuthenticatedPrincipal,
  targetUserId: string,
  role: GlobalRoleCode,
): Promise<RoleChangeResult> {
  if (!hasPermission(actor, "users.roles.manage")) {
    throw new RoleServiceError("forbidden");
  }
  if (actor.userId === targetUserId) {
    throw new RoleServiceError("self_role_change_forbidden");
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
           AND permissions.code = 'users.roles.manage'
           AND role_permissions.scope = 'GLOBAL'
       ) AS allowed`,
      [actor.userId],
    );
    if (!actorAccess.rows[0]?.allowed) {
      throw new RoleServiceError("forbidden");
    }

    const targetResult = await transaction.query<UserRow>(
      "SELECT id, status FROM users WHERE id = $1 FOR UPDATE",
      [targetUserId],
    );
    const target = targetResult.rows[0];
    if (target === undefined) {
      throw new RoleServiceError("user_not_found");
    }

    const roleResult = await transaction.query<RoleRow>(
      "SELECT id, code FROM roles WHERE code = $1 AND is_system = true",
      [role],
    );
    const targetRole = roleResult.rows[0];
    if (targetRole === undefined) {
      throw new RoleServiceError("role_unavailable");
    }

    const currentRoleResult = await transaction.query<ExistingRoleRow>(
      `SELECT roles.code
       FROM user_roles
       JOIN roles ON roles.id = user_roles.role_id
       WHERE user_roles.user_id = $1
         AND roles.code IN ('ADMINISTRATEUR', 'UTILISATEUR')
       ORDER BY roles.code`,
      [targetUserId],
    );
    const previousRole = currentRoleResult.rows[0]?.code ?? null;

    if (previousRole === role) {
      return { previousRole, role, changed: false };
    }

    if (previousRole === "ADMINISTRATEUR" && role === "UTILISATEUR") {
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
        [targetUserId],
      );
      if (target.status === "ACTIVE" && !otherAdministrator.rows[0]?.exists) {
        throw new RoleServiceError("last_active_administrator");
      }
    }

    await transaction.query(
      `DELETE FROM user_roles
       WHERE user_id = $1
         AND role_id IN (
           SELECT id FROM roles
           WHERE code IN ('ADMINISTRATEUR', 'UTILISATEUR')
         )`,
      [targetUserId],
    );
    await transaction.query(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       VALUES ($1, $2, $3)`,
      [targetUserId, targetRole.id, actor.userId],
    );
    await transaction.query(
      `INSERT INTO activity_log
         (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'user.global_role_changed', 'user', $2, $3::jsonb)`,
      [
        actor.userId,
        targetUserId,
        JSON.stringify({ from: previousRole, to: role }),
      ],
    );

    return { previousRole, role, changed: true };
  });
}
