import { isIP } from "node:net";
import type { RateLimitPolicy } from "./rateLimiter.js";

export interface BackendConfig {
  corsOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  host: string;
  initialAdminSteamIds: string[];
  steamApiKey: string | null;
  port: number;
  steamAuthRateLimit: RateLimitPolicy;
  accountCreationRateLimit: RateLimitPolicy;
  steamOpenIdReturnUrl: string;
}

const defaultCorsOrigins = [
  "http://localhost:1420",
  "http://tauri.localhost",
];

const connectionStringSslOptions = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
];

function parseInitialAdminSteamIds(
  environment: NodeJS.ProcessEnv,
): string[] {
  const configuredIds = environment.INITIAL_ADMIN_STEAM_IDS;
  const legacyId = environment.INITIAL_ADMIN_STEAM_ID;
  if (configuredIds !== undefined && legacyId !== undefined) {
    throw new Error(
      "Set only one of INITIAL_ADMIN_STEAM_IDS or INITIAL_ADMIN_STEAM_ID.",
    );
  }
  if (configuredIds === undefined && legacyId === undefined) {
    return [];
  }

  const value = configuredIds ?? legacyId;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Initial administrator SteamID configuration is empty.");
  }

  const steamIds =
    configuredIds === undefined
      ? [value.trim()]
      : value.split(",").map((steamId) => steamId.trim());
  if (
    steamIds.some((steamId) => !/^[0-9]{17}$/.test(steamId)) ||
    new Set(steamIds).size !== steamIds.length ||
    (configuredIds !== undefined && steamIds.length !== 2)
  ) {
    throw new Error(
      configuredIds === undefined
        ? "INITIAL_ADMIN_STEAM_ID must be a 17-digit SteamID64."
        : "INITIAL_ADMIN_STEAM_IDS must contain exactly two distinct 17-digit SteamID64 values.",
    );
  }
  return steamIds;
}

function parseSteamOpenIdReturnUrl(value: string | undefined): string {
  const returnUrl =
    value?.trim() ?? "http://127.0.0.1:8080/auth/steam/callback";
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new Error("STEAM_OPENID_RETURN_URL must be an absolute URL.");
  }
  const isLocalHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !isLocalHttp) ||
    parsed.pathname !== "/auth/steam/callback" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "STEAM_OPENID_RETURN_URL must be an HTTPS callback URL (HTTP is allowed only on localhost).",
    );
  }
  return parsed.toString();
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [...defaultCorsOrigins];
  }
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => origin.length === 0)) {
    throw new Error("BONOBOS_CORS_ORIGINS must contain exact origins.");
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("BONOBOS_CORS_ORIGINS must contain valid origins.");
    }
    const isLocalHttp =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "tauri.localhost"].includes(parsed.hostname);
    if (
      origin === "*" ||
      parsed.origin !== origin ||
      (parsed.protocol !== "https:" && !isLocalHttp) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new Error(
        "BONOBOS_CORS_ORIGINS accepts only exact HTTPS origins (HTTP is limited to local development).",
      );
    }
  }
  if (new Set(origins).size !== origins.length) {
    throw new Error("BONOBOS_CORS_ORIGINS must not contain duplicates.");
  }
  return origins;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`${name} must be "true" or "false".`);
}

function parseRateLimitInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  maximum: number,
  minimum = 1,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer within its supported range.`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`${name} must be an integer within its supported range.`);
  }
  return parsed;
}

function isLocalDatabaseHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const address =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  return (
    address === "localhost" ||
    address === "::1" ||
    (isIP(address) === 4 && address.startsWith("127."))
  );
}

export function loadBackendConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required.");
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol) ||
    parsedDatabaseUrl.hostname.length === 0
  ) {
    throw new Error("DATABASE_URL must point to a PostgreSQL server.");
  }

  const localDatabase = isLocalDatabaseHost(parsedDatabaseUrl.hostname);
  const databaseSsl = parseBoolean(environment.DATABASE_SSL, "DATABASE_SSL");
  const allowInsecureInternal =
    parseBoolean(
      environment.BONOBOS_ALLOW_INSECURE_INTERNAL_DB,
      "BONOBOS_ALLOW_INSECURE_INTERNAL_DB",
    ) &&
    parsedDatabaseUrl.hostname === "postgres" &&
    !databaseSsl;
  if (!localDatabase && !databaseSsl && !allowInsecureInternal) {
    throw new Error(
      "DATABASE_SSL=true is required for remote PostgreSQL connections.",
    );
  }
  if (
    !localDatabase &&
    [...parsedDatabaseUrl.searchParams.keys()].some((name) =>
      connectionStringSslOptions.includes(name.toLowerCase()),
    )
  ) {
    throw new Error(
      "Remove PostgreSQL TLS options from DATABASE_URL and configure DATABASE_SSL=true.",
    );
  }

  const portValue = environment.BONOBOS_API_PORT ?? "8080";
  if (!/^\d+$/.test(portValue)) {
    throw new Error("BONOBOS_API_PORT must be an integer from 1 to 65535.");
  }
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("BONOBOS_API_PORT must be an integer from 1 to 65535.");
  }

  return {
    corsOrigins: parseCorsOrigins(environment.BONOBOS_CORS_ORIGINS),
    databaseUrl,
    databaseSsl,
    host: environment.BONOBOS_API_HOST?.trim() || "127.0.0.1",
    initialAdminSteamIds: parseInitialAdminSteamIds(environment),
    steamApiKey: environment.STEAM_API_KEY?.trim() || null,
    port,
    steamAuthRateLimit: {
      maxRequests: parseRateLimitInteger(
        environment.STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS,
        "STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS",
        10,
        100_000,
      ),
      windowMs: parseRateLimitInteger(
        environment.STEAM_AUTH_RATE_LIMIT_WINDOW_MS,
        "STEAM_AUTH_RATE_LIMIT_WINDOW_MS",
        15 * 60 * 1_000,
        24 * 60 * 60 * 1_000,
        1_000,
      ),
    },
    accountCreationRateLimit: {
      maxRequests: parseRateLimitInteger(
        environment.STEAM_ACCOUNT_CREATION_RATE_LIMIT_MAX_REQUESTS,
        "STEAM_ACCOUNT_CREATION_RATE_LIMIT_MAX_REQUESTS",
        3,
        100_000,
      ),
      windowMs: parseRateLimitInteger(
        environment.STEAM_ACCOUNT_CREATION_RATE_LIMIT_WINDOW_MS,
        "STEAM_ACCOUNT_CREATION_RATE_LIMIT_WINDOW_MS",
        60 * 60 * 1_000,
        24 * 60 * 60 * 1_000,
        1_000,
      ),
    },
    steamOpenIdReturnUrl: parseSteamOpenIdReturnUrl(
      environment.STEAM_OPENID_RETURN_URL,
    ),
  };
}
