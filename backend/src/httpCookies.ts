import { createHmac, timingSafeEqual } from "node:crypto";

export const sessionCookieName = "bonobos_session";
export const csrfCookieName = "bonobos_csrf";
export const steamStateCookieName = "bonobos_steam_state";

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (cookieHeader === undefined) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function createCsrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken)
    .update("bonobos-csrf-v1")
    .digest("base64url");
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "Lax" | "None";
  },
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}
