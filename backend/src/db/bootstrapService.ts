import type { AuthenticatedPrincipal } from "../authorization.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "./contracts.js";

export type BootstrapErrorCode =
  | "bootstrap_not_configured"
  | "bootstrap_already_claimed"
  | "bootstrap_identity_not_verified";

export class BootstrapServiceError extends Error {
  constructor(readonly code: BootstrapErrorCode) {
    super(code);
    this.name = "BootstrapServiceError";
  }
}

interface IdentityRow extends Record<string, unknown> {
  subject: string;
}

interface ClaimRow extends Record<string, unknown> {
  user_id: string;
}

interface RoleRow extends Record<string, unknown> {
  id: string;
}

interface ExistingRoleRow extends Record<string, unknown> {
  code: "ADMINISTRATEUR" | "UTILISATEUR";
}

export async function claimInitialAdministratorInTransaction(
  transaction: SqlExecutor,
  userId: string,
  steamId: string,
): Promise<boolean> {
  const identity = await transaction.query<IdentityRow>(
    `SELECT external_identities.subject
     FROM external_identities
     JOIN users ON users.id = external_identities.user_id
     WHERE external_identities.provider = 'steam'
       AND external_identities.subject = $1
       AND external_identities.verified_at IS NOT NULL
       AND external_identities.user_id = $2
       AND users.status = 'ACTIVE'`,
    [steamId, userId],
  );
  if (identity.rows[0] === undefined) {
    throw new BootstrapServiceError("bootstrap_identity_not_verified");
  }

  const existingClaim = await transaction.query<ClaimRow>(
    `SELECT user_id
     FROM platform_initial_admin_claims
     WHERE steam_id = $1
     FOR UPDATE`,
    [steamId],
  );
  if (existingClaim.rows[0] !== undefined) {
    if (existingClaim.rows[0].user_id !== userId) {
      throw new BootstrapServiceError("bootstrap_identity_not_verified");
    }
    return false;
  }

  const administratorRole = await transaction.query<RoleRow>(
    "SELECT id FROM roles WHERE code = 'ADMINISTRATEUR' AND is_system = true",
  );
  const roleId = administratorRole.rows[0]?.id;
  if (roleId === undefined) {
    throw new Error("The system administrator role is missing.");
  }

  const currentRole = await transaction.query<ExistingRoleRow>(
    `SELECT roles.code
     FROM user_roles
     JOIN roles ON roles.id = user_roles.role_id
     WHERE user_roles.user_id = $1
       AND roles.code IN ('ADMINISTRATEUR', 'UTILISATEUR')
     ORDER BY roles.code`,
    [userId],
  );
  const previousRole = currentRole.rows[0]?.code ?? null;

  await transaction.query(
    `DELETE FROM user_roles
     WHERE user_id = $1
       AND role_id IN (
         SELECT id FROM roles
         WHERE code IN ('ADMINISTRATEUR', 'UTILISATEUR')
       )
       AND role_id <> $2`,
    [userId, roleId],
  );
  await transaction.query(
    `INSERT INTO user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, roleId],
  );
  await transaction.query(
    `INSERT INTO platform_initial_admin_claims (steam_id, user_id, claimed_at)
     VALUES ($1, $2, now())`,
    [steamId, userId],
  );
  await transaction.query(
    `UPDATE platform_bootstrap_state
     SET initial_admin_claimed_at = coalesce(initial_admin_claimed_at, now()),
         initial_admin_user_id = coalesce(initial_admin_user_id, $1)
     WHERE singleton = true`,
    [userId],
  );
  await transaction.query(
    `INSERT INTO activity_log
       (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'platform.initial_admin_claimed', 'user', $2, $3::jsonb)`,
    [
      userId,
      userId,
      JSON.stringify({
        from: previousRole,
        to: "ADMINISTRATEUR",
        source: "initial_allowlist",
      }),
    ],
  );
  return true;
}

export async function claimInitialAdministrator(
  database: TransactionalSqlExecutor,
  principal: AuthenticatedPrincipal,
  initialAdminSteamIds: readonly string[],
): Promise<void> {
  if (initialAdminSteamIds.length === 0) {
    throw new BootstrapServiceError("bootstrap_not_configured");
  }
  if (principal.status !== "ACTIVE") {
    throw new BootstrapServiceError("bootstrap_identity_not_verified");
  }

  await database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [73190422]);

    const identity = await transaction.query<IdentityRow>(
      `SELECT external_identities.subject
       FROM external_identities
       JOIN users ON users.id = external_identities.user_id
       WHERE external_identities.provider = 'steam'
         AND external_identities.verified_at IS NOT NULL
         AND external_identities.user_id = $1
         AND users.status = 'ACTIVE'`,
      [principal.userId],
    );
    const steamId = identity.rows[0]?.subject;
    if (
      steamId === undefined ||
      !initialAdminSteamIds.includes(steamId)
    ) {
      throw new BootstrapServiceError("bootstrap_identity_not_verified");
    }

    const claimed = await claimInitialAdministratorInTransaction(
      transaction,
      principal.userId,
      steamId,
    );
    if (!claimed) {
      throw new BootstrapServiceError("bootstrap_already_claimed");
    }
  });
}
