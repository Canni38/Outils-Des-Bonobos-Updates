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
export type UserStatus = "ACTIVE" | "SUSPENDED";

export type PermissionGrant =
  | { permission: PermissionCode; scope: "GLOBAL" }
  | { permission: PermissionCode; scope: "PROJECT"; projectId: string };

export interface AuthenticatedPrincipal {
  userId: string;
  status: UserStatus;
  displayName?: string;
  steamId?: string;
  roles?: readonly string[];
  grants: readonly PermissionGrant[];
}

export function hasPermission(
  principal: AuthenticatedPrincipal,
  permission: PermissionCode,
  projectId?: string,
): boolean {
  if (principal.status !== "ACTIVE") {
    return false;
  }

  return principal.grants.some(
    (grant) =>
      grant.permission === permission &&
      (grant.scope === "GLOBAL" ||
        (projectId !== undefined &&
          grant.scope === "PROJECT" &&
          grant.projectId === projectId)),
  );
}
