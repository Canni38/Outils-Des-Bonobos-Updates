export const permissionCodes = [
  "users.read",
  "users.manage",
  "users.roles.manage",
  "projects.read",
  "projects.manage",
  "applications.read",
  "applications.manage",
  "layouts.read",
  "layouts.write",
  "layouts.publish",
  "configurations.read",
  "configurations.write",
  "activity.read",
  "administration.access",
] as const;

export type PermissionCode = (typeof permissionCodes)[number];

export interface PermissionGrant {
  permission: PermissionCode;
  scope: "GLOBAL" | "PROJECT";
  projectId?: string;
}

export interface AuthenticatedUser {
  userId: string;
  status: "ACTIVE";
  displayName: string | null;
  steamId: string | null;
  steamPersonaName: string | null;
  steamAvatarUrl: string | null;
  roles: string[];
  grants: PermissionGrant[];
  csrfToken: string;
}

export function hasGlobalPermission(
  user: AuthenticatedUser,
  permission: PermissionCode,
): boolean {
  return user.grants.some(
    (grant) => grant.permission === permission && grant.scope === "GLOBAL",
  );
}

function isPermissionCode(value: string): value is PermissionCode {
  return permissionCodes.some((permission) => permission === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAuthenticatedUser(value: unknown): AuthenticatedUser {
  if (
    !isRecord(value) ||
    typeof value.userId !== "string" ||
    value.status !== "ACTIVE" ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    (value.steamId !== null &&
      (typeof value.steamId !== "string" ||
        !/^[0-9]{17}$/.test(value.steamId))) ||
    (value.steamPersonaName !== null &&
      value.steamPersonaName !== undefined &&
      typeof value.steamPersonaName !== "string") ||
    (value.steamAvatarUrl !== null &&
      value.steamAvatarUrl !== undefined &&
      typeof value.steamAvatarUrl !== "string") ||
    !Array.isArray(value.roles) ||
    !value.roles.every((role) => typeof role === "string") ||
    !Array.isArray(value.grants) ||
    typeof value.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)
  ) {
    throw new Error("invalid_profile_response");
  }

  const grants = value.grants.map((grant): PermissionGrant => {
    if (isRecord(grant) === false || typeof grant.permission !== "string") {
      throw new Error("invalid_profile_response");
    }
    const permission = grant.permission;
    const scope = grant.scope;
    if (
      !isPermissionCode(permission) ||
      (scope !== "GLOBAL" && scope !== "PROJECT")
    ) {
      throw new Error("invalid_profile_response");
    }
    if (scope === "PROJECT") {
      if (typeof grant.projectId !== "string") {
        throw new Error("invalid_profile_response");
      }
      return { permission, scope, projectId: grant.projectId };
    }
    return { permission, scope };
  });

  return {
    userId: value.userId,
    status: "ACTIVE",
    displayName: value.displayName,
    steamId: value.steamId,
    steamPersonaName:
      typeof value.steamPersonaName === "string"
        ? value.steamPersonaName
        : null,
    steamAvatarUrl:
      typeof value.steamAvatarUrl === "string"
        ? value.steamAvatarUrl
        : null,
    roles: value.roles,
    grants,
    csrfToken: value.csrfToken,
  };
}
