import { createHash, randomBytes } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import type {
  AuthenticatedPrincipal,
  PermissionCode,
} from "./authorization.js";
import { hasPermission, permissionCodes } from "./authorization.js";
import {
  loadLayoutPage,
  saveDraftLayout,
  publishDraftLayout,
  listLayoutRevisions,
  restoreLayoutRevision,
  LayoutServiceError,
} from "./db/layoutService.js";
import type { AuthenticationProvider } from "./authentication.js";
import {
  csrfCookieName,
  createCsrfToken,
  constantTimeStringEqual,
  readCookie,
  serializeCookie,
  sessionCookieName,
  steamStateCookieName,
} from "./httpCookies.js";
import type {
  SqlExecutor,
  TransactionalSqlExecutor,
} from "./db/contracts.js";
import {
  AccountServiceError,
  listUserAccounts,
  updateUserAccount,
} from "./db/accountService.js";
import {
  BootstrapServiceError,
  claimInitialAdministrator,
} from "./db/bootstrapService.js";
import {
  changeGlobalRole,
  RoleServiceError,
  type GlobalRoleCode,
} from "./db/roleService.js";
import {
  completeDesktopAuthWithCode,
  completeDesktopAuthWithError,
  createDesktopAuthAttempt,
  beginDesktopAuthAttempt,
  exchangeDesktopAuthCode,
  getDesktopAuthSteamId,
  getDesktopAttemptForOpenIdState,
} from "./db/desktopAuthService.js";
import {
  consumeSteamLoginChallenge,
  createSteamLoginChallenge,
  hashSessionToken,
  isSteamLoginChallengeActive,
  loginWithVerifiedSteamIdentity,
  revokeSession,
  sessionLifetimeMs,
} from "./db/sessionService.js";
import {
  createSteamOpenIdRequest,
  SteamOpenIdError,
  verifySteamOpenIdResponse,
} from "./steamOpenId.js";
import {
  FixedWindowRateLimiter,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "./rateLimiter.js";

interface ServerDependencies {
  database: SqlExecutor;
  transactions: TransactionalSqlExecutor;
  authentication: AuthenticationProvider;
  corsOrigins?: readonly string[];
  initialAdminSteamIds?: readonly string[];
  steamApiKey?: string | null;
  steamOpenIdReturnUrl?: string;
  steamOpenIdFetch?: typeof fetch;
  steamAuthRateLimit?: RateLimitPolicy;
  accountCreationRateLimit?: RateLimitPolicy;
}

interface RoleRouteParams {
  userId: string;
}

interface RoleRouteBody {
  role: GlobalRoleCode;
}

interface AccountRouteParams {
  userId: string;
}

interface AccountRouteBody {
  displayName?: string;
  status?: "ACTIVE" | "SUSPENDED";
}

interface DesktopAuthStartBody {
  codeChallenge: string;
  state: string;
}

interface DesktopAuthExchangeBody {
  code: string;
  verifier: string;
  state: string;
}

const defaultSteamOpenIdReturnUrl =
  "http://127.0.0.1:8080/auth/steam/callback";
const defaultCorsOrigins = [
  "http://localhost:1420",
  "http://tauri.localhost",
];
const desktopAuthReturnUrl =
  "com.canni.bonobos-fr-app://auth/callback";
const openIdStateLifetimeMs = 10 * 60 * 1_000;
const defaultSteamAuthRateLimit: RateLimitPolicy = {
  maxRequests: 10,
  windowMs: 15 * 60 * 1_000,
};
const defaultAccountCreationRateLimit: RateLimitPolicy = {
  maxRequests: 3,
  windowMs: 60 * 60 * 1_000,
};

interface IdentityExistsRow extends Record<string, unknown> {
  exists: boolean;
}

function rejectRateLimitedRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: "steam_auth" | "account_creation",
  decision: RateLimitDecision,
) {
  request.log.warn({ reason: "rate_limited", scope }, "Request rate limited");
  reply.header("retry-after", String(decision.retryAfterSeconds));
  return reply.code(429).send({ error: "rate_limited" });
}

function createDesktopAuthRedirect(
  state: string,
  result: { code: string } | { error: string },
): string {
  const redirect = new URL(desktopAuthReturnUrl);
  redirect.searchParams.set("state", state);
  if ("code" in result) {
    redirect.searchParams.set("code", result.code);
  } else {
    redirect.searchParams.set("error", result.error);
  }
  return redirect.toString();
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  authentication: AuthenticationProvider,
  permission?: PermissionCode,
): Promise<AuthenticatedPrincipal | null> {
  const principal = await authentication.authenticate(
    request.headers.authorization,
    request.headers.cookie,
  );
  if (principal === null) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  if (principal.status !== "ACTIVE") {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  if (
    permission !== undefined &&
    !hasPermission(principal, permission)
  ) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    readCookie(request.headers.cookie, sessionCookieName) !== null
  ) {
    const csrfCookie = readCookie(request.headers.cookie, csrfCookieName);
    const sessionToken = readCookie(
      request.headers.cookie,
      sessionCookieName,
    );
    const csrfHeader = request.headers["x-csrf-token"];
    if (
      csrfCookie === null ||
      sessionToken === null ||
      !constantTimeStringEqual(csrfCookie, createCsrfToken(sessionToken)) ||
      typeof csrfHeader !== "string" ||
      !constantTimeStringEqual(csrfCookie, csrfHeader)
    ) {
      await reply.code(403).send({ error: "csrf_failed" });
      return null;
    }
  }
  return principal;
}

async function refreshSteamPersonaName(
  database: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { profile: unknown }[] }> },
  steamId: string,
  apiKey: string,
): Promise<void> {
  try {
    console.log("[diag-avatar] starting fetch", "steamId:", steamId);
    let response: Response;
    try {
      response = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`,
        { signal: AbortSignal.timeout(2_000) },
      );
    } catch (e) {
      console.error("[diag-avatar] fetch failed:", e instanceof Error ? e.constructor.name : typeof e, e instanceof Error ? e.message : String(e));
      return;
    }
    console.log("[diag-avatar] response status:", response.status, response.statusText, "ok:", response.ok);
    if (!response.ok) return;
    let data: { response?: { players?: { personaname?: string; avatarfull?: string }[] } };
    try {
      data = (await response.json()) as { response?: { players?: { personaname?: string; avatarfull?: string }[] } };
    } catch (e) {
      console.error("[diag-avatar] json parse failed:", e instanceof Error ? e.constructor.name : typeof e, e instanceof Error ? e.message : String(e));
      return;
    }
    const player = data.response?.players?.[0];
    const personaName = player?.personaname;
    const avatarUrl = player?.avatarfull;
    console.log("[diag-avatar] players count:", data.response?.players?.length, "keys:", player ? Object.keys(player) : null, "avatarfull type:", typeof avatarUrl, "avatarfull:", avatarUrl, "steamId:", steamId);
    if (typeof personaName !== "string" || personaName.length === 0) return;
    await database.query(
      `UPDATE external_identities
         SET profile = jsonb_set(jsonb_set(COALESCE(profile, '{}'::jsonb), '{steamPersonaName}', to_jsonb($1::text), true), '{steamAvatarUrl}', to_jsonb($2::text), true)
       WHERE provider = 'steam' AND subject = $3`,
      [personaName, typeof avatarUrl === "string" ? avatarUrl : null, steamId],
    );
  } catch {
    // Ignore Steam API failures; keep last known persona name.
  }
}
export async function buildServer(
  dependencies: ServerDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.url",
      ],
    },
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: [...(dependencies.corsOrigins ?? defaultCorsOrigins)],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await dependencies.database.query("SELECT 1");
      return { status: "ready" };
    } catch (error) {
      app.log.error({ err: error }, "Database readiness check failed");
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  const steamReturnUrl =
    dependencies.steamOpenIdReturnUrl ?? defaultSteamOpenIdReturnUrl;
  const initialAdminSteamIds = dependencies.initialAdminSteamIds ?? [];
  const steamReturn = new URL(steamReturnUrl);
  const secureCookies = steamReturn.protocol === "https:";
  const steamAuthRateLimit =
    dependencies.steamAuthRateLimit ?? defaultSteamAuthRateLimit;
  const accountCreationRateLimit =
    dependencies.accountCreationRateLimit ?? defaultAccountCreationRateLimit;
  const steamLoginStartLimiter = new FixedWindowRateLimiter();
  const steamLoginCallbackLimiter = new FixedWindowRateLimiter();
  const accountCreationLimiter = new FixedWindowRateLimiter();
  const desktopAuthStartLimiter = new FixedWindowRateLimiter();
  const desktopAuthExchangeLimiter = new FixedWindowRateLimiter();

  app.post<{ Body: DesktopAuthStartBody }>(
    "/auth/desktop/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["codeChallenge", "state"],
          additionalProperties: false,
          properties: {
            codeChallenge: {
              type: "string",
              pattern: "^[A-Za-z0-9_-]{43}$",
            },
            state: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const decision = desktopAuthStartLimiter.consume(steamAuthRateLimit);
      if (!decision.allowed) {
        return rejectRateLimitedRequest(request, reply, "steam_auth", decision);
      }

      const attempt = await createDesktopAuthAttempt(
        dependencies.database,
        request.body.codeChallenge,
        request.body.state,
      );
      const authorizationUrl = new URL("/auth/steam", steamReturnUrl);
      authorizationUrl.searchParams.set("desktop_attempt", attempt);
      reply.header("cache-control", "no-store");
      return { authorizationUrl: authorizationUrl.toString() };
    },
  );

  app.post<{ Body: DesktopAuthExchangeBody }>(
    "/auth/desktop/exchange",
    {
      schema: {
        body: {
          type: "object",
          required: ["code", "verifier", "state"],
          additionalProperties: false,
          properties: {
            code: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            verifier: {
              type: "string",
              minLength: 43,
              maxLength: 128,
              pattern: "^[A-Za-z0-9._~-]+$",
            },
            state: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const decision = desktopAuthExchangeLimiter.consume(steamAuthRateLimit);
      if (!decision.allowed) {
        return rejectRateLimitedRequest(request, reply, "steam_auth", decision);
      }

      const steamId = await getDesktopAuthSteamId(
        dependencies.database,
        request.body.code,
        request.body.verifier,
        request.body.state,
      );
      if (steamId === null) {
        return reply.code(401).send({ error: "invalid_desktop_exchange" });
      }

      const existingIdentity = await dependencies.database.query<IdentityExistsRow>(
        `SELECT EXISTS (
           SELECT 1
           FROM external_identities
           WHERE provider = 'steam' AND subject = $1
         ) AS exists`,
        [steamId],
      );
      if (!existingIdentity.rows[0]?.exists) {
        const creationLimit = accountCreationLimiter.consume(
          accountCreationRateLimit,
        );
        if (!creationLimit.allowed) {
          return rejectRateLimitedRequest(
            request,
            reply,
            "account_creation",
            creationLimit,
          );
        }
      }

      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = createCsrfToken(sessionToken);
      const login = await exchangeDesktopAuthCode(
        dependencies.transactions,
        request.body.code,
        request.body.verifier,
        request.body.state,
        hashSessionToken(sessionToken),
        new Date(Date.now() + sessionLifetimeMs),
        initialAdminSteamIds,
      );
      if (login === null) {
        return reply.code(401).send({ error: "invalid_desktop_exchange" });
      }
      if (login.kind === "suspended") {
        return reply.code(403).send({ error: "account_suspended" });
      }

      reply.header("cache-control", "no-store");
      reply.header("set-cookie", [
        serializeCookie(sessionCookieName, sessionToken, {
          maxAge: sessionLifetimeMs / 1_000,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        }),
        serializeCookie(csrfCookieName, csrfToken, {
          maxAge: sessionLifetimeMs / 1_000,
          httpOnly: false,
          secure: true,
          sameSite: "None",
        }),
      ]);
      return {
        authenticated: true,
        user: {
          id: login.userId,
          displayName: login.displayName,
          status: "ACTIVE",
          roles: login.roles,
        },
        csrfToken,
      };
    },
  );

  app.get("/auth/steam", async (_request, reply) => {
    const query = new URLSearchParams(_request.url.split("?", 2)[1] ?? "");
    const desktopAttempts = query.getAll("desktop_attempt");
    if (desktopAttempts.length > 1) {
      return reply.code(400).send({ error: "invalid_desktop_attempt" });
    }
    let desktopAttemptHash: Buffer | undefined;
    if (desktopAttempts.length === 1) {
      const desktopAttempt = desktopAttempts[0];
      if (
        desktopAttempt === undefined ||
        !/^[A-Za-z0-9_-]{43}$/.test(desktopAttempt)
      ) {
        return reply.code(400).send({ error: "invalid_desktop_attempt" });
      }
      desktopAttemptHash =
        (await beginDesktopAuthAttempt(
          dependencies.database,
          desktopAttempt,
        )) ?? undefined;
      if (desktopAttemptHash === undefined) {
        return reply.code(401).send({ error: "invalid_desktop_attempt" });
      }
    }

    const decision = steamLoginStartLimiter.consume(steamAuthRateLimit);
    if (!decision.allowed) {
      return rejectRateLimitedRequest(
        _request,
        reply,
        "steam_auth",
        decision,
      );
    }

    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest();
    await createSteamLoginChallenge(
      dependencies.database,
      stateHash,
      new Date(Date.now() + openIdStateLifetimeMs),
      desktopAttemptHash,
    );
    const returnTo = new URL(steamReturnUrl);
    returnTo.searchParams.set("state", state);
    reply.header(
      "set-cookie",
      serializeCookie(steamStateCookieName, state, {
        maxAge: openIdStateLifetimeMs / 1_000,
        httpOnly: true,
        secure: secureCookies,
      }),
    );
    reply.header("cache-control", "no-store");
    return reply.redirect(
      createSteamOpenIdRequest(
        returnTo.toString(),
        `${steamReturn.origin}/`,
      ),
    );
  });

  app.get("/auth/steam/callback", async (request, reply) => {
    const authLimit = steamLoginCallbackLimiter.consume(steamAuthRateLimit);
    if (!authLimit.allowed) {
      return rejectRateLimitedRequest(
        request,
        reply,
        "steam_auth",
        authLimit,
      );
    }

    reply.header("cache-control", "no-store");
    if (request.url.length > 16_384) {
      return reply.code(400).send({ error: "invalid_openid_response" });
    }
    const rawQuery = request.url.split("?", 2)[1] ?? "";
    const parameters = new URLSearchParams(rawQuery);
    const states = parameters.getAll("state");
    const stateCookie = readCookie(
      request.headers.cookie,
      steamStateCookieName,
    );
    if (
      states.length !== 1 ||
      stateCookie === null ||
      !constantTimeStringEqual(stateCookie, states[0])
    ) {
      request.log.warn({ reason: "state_mismatch" }, "Steam login rejected");
      return reply.code(400).send({ error: "invalid_openid_state" });
    }

    const stateHash = createHash("sha256").update(states[0]).digest();
    if (
      !(await isSteamLoginChallengeActive(dependencies.database, stateHash))
    ) {
      request.log.warn({ reason: "state_expired_or_replayed" }, "Steam login rejected");
      return reply.code(401).send({ error: "openid_replayed_or_expired" });
    }
    const desktopAttemptHash = await getDesktopAttemptForOpenIdState(
      dependencies.database,
      stateHash,
    );

    async function redirectDesktopFailure(
      error: "cancelled" | "provider_unavailable" | "invalid_openid_response",
    ) {
      if (desktopAttemptHash === null) {
        return null;
      }
      await consumeSteamLoginChallenge(
        dependencies.transactions,
        stateHash,
      );
      const appState = await completeDesktopAuthWithError(
        dependencies.transactions,
        desktopAttemptHash,
        error,
      );
      if (appState === null) {
        return null;
      }
      reply.header(
        "set-cookie",
        serializeCookie(steamStateCookieName, "", {
          maxAge: 0,
          httpOnly: true,
          secure: secureCookies,
        }),
      );
      return reply.redirect(
        createDesktopAuthRedirect(appState, { error }),
      );
    }

    const expectedReturnTo = new URL(steamReturnUrl);
    expectedReturnTo.searchParams.set("state", states[0]);
    let verified: Awaited<ReturnType<typeof verifySteamOpenIdResponse>>;
    try {
      verified = await verifySteamOpenIdResponse(
        parameters,
        expectedReturnTo.toString(),
        dependencies.steamOpenIdFetch,
      );
    } catch (error) {
      if (error instanceof SteamOpenIdError) {
        request.log.warn({ reason: error.code }, "Steam OpenID verification failed");
        const redirect = await redirectDesktopFailure(
          error.code === "cancelled"
            ? "cancelled"
            : error.code === "provider_unavailable"
              ? "provider_unavailable"
              : "invalid_openid_response",
        );
        if (redirect !== null) {
          return redirect;
        }
        return reply
          .code(error.code === "provider_unavailable" ? 503 : 401)
          .send({ error: error.code });
      }
      throw error;
    }

    const consumed = await consumeSteamLoginChallenge(
      dependencies.transactions,
      createHash("sha256").update(states[0]).digest(),
      verified.responseNonce,
    );
    if (!consumed) {
      request.log.warn({ reason: "nonce_replayed" }, "Steam login rejected");
      const redirect = await redirectDesktopFailure(
        "invalid_openid_response",
      );
      if (redirect !== null) {
        return redirect;
      }
      return reply.code(401).send({ error: "openid_replayed_or_expired" });
    }

    if (desktopAttemptHash !== null) {
      const exchangeCode = randomBytes(32).toString("base64url");
      const appState = await completeDesktopAuthWithCode(
        dependencies.transactions,
        desktopAttemptHash,
        verified.steamId,
        exchangeCode,
      );
      if (appState === null) {
        return reply.code(401).send({ error: "invalid_desktop_attempt" });
      }
      reply.header(
        "set-cookie",
        serializeCookie(steamStateCookieName, "", {
          maxAge: 0,
          httpOnly: true,
          secure: secureCookies,
        }),
      );
      if (dependencies.steamApiKey) {
        await refreshSteamPersonaName(
          dependencies.database,
          verified.steamId,
          dependencies.steamApiKey,
        ).catch((e) => console.error("[diag-avatar] refresh failed:", e instanceof Error ? e.constructor.name : typeof e, e instanceof Error ? e.message : String(e)));
      }
      return reply.redirect(
        createDesktopAuthRedirect(appState, { code: exchangeCode }),
      );
    }

    const existingIdentity = await dependencies.database.query<IdentityExistsRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM external_identities
         WHERE provider = 'steam' AND subject = $1
       ) AS exists`,
      [verified.steamId],
    );
    if (!existingIdentity.rows[0]?.exists) {
      const creationLimit = accountCreationLimiter.consume(
        accountCreationRateLimit,
      );
      if (!creationLimit.allowed) {
        return rejectRateLimitedRequest(
          request,
          reply,
          "account_creation",
          creationLimit,
        );
      }
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = createCsrfToken(sessionToken);
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    const login = await loginWithVerifiedSteamIdentity(
      dependencies.transactions,
      verified.steamId,
      hashSessionToken(sessionToken),
      expiresAt,
      initialAdminSteamIds,
    );
    if (login.kind === "suspended") {
      return reply.code(403).send({ error: "account_suspended" });
    }

    // Refresh Steam persona name before responding so /v1/me can return it.
    if (dependencies.steamApiKey) {
      await refreshSteamPersonaName(
        dependencies.database,
        verified.steamId,
        dependencies.steamApiKey,
      ).catch((e) => console.error("[diag-avatar] refresh failed:", e instanceof Error ? e.constructor.name : typeof e, e instanceof Error ? e.message : String(e)));
    }

    reply.header("set-cookie", [
      serializeCookie(sessionCookieName, sessionToken, {
        maxAge: sessionLifetimeMs / 1_000,
        httpOnly: true,
        secure: secureCookies,
      }),
      serializeCookie(csrfCookieName, csrfToken, {
        maxAge: sessionLifetimeMs / 1_000,
        httpOnly: false,
        secure: secureCookies,
      }),
      serializeCookie(steamStateCookieName, "", {
        maxAge: 0,
        httpOnly: true,
        secure: secureCookies,
      }),
    ]);
    return {
      authenticated: true,
      user: {
        id: login.userId,
        displayName: login.displayName,
        status: "ACTIVE",
        roles: login.roles,
      },
    };
  });

  app.post("/v1/logout", async (request, reply) => {
    const principal = await authorizeRequest(
      request,
      reply,
      dependencies.authentication,
    );
    if (principal === null) {
      return;
    }
    const token = readCookie(request.headers.cookie, sessionCookieName);
    if (token === null) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    await revokeSession(dependencies.transactions, token);
    reply.header("set-cookie", [
      serializeCookie(sessionCookieName, "", {
        maxAge: 0,
        httpOnly: true,
        secure: secureCookies,
      }),
      serializeCookie(csrfCookieName, "", {
        maxAge: 0,
        httpOnly: false,
        secure: secureCookies,
      }),
    ]);
    return reply.code(204).send();
  });

  app.get("/v1/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await authorizeRequest(
      request,
      reply,
      dependencies.authentication,
    );
    if (principal === null) {
      return;
    }
    const sessionToken = readCookie(
      request.headers.cookie,
      sessionCookieName,
    );
    if (sessionToken === null) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const isAdmin =
      hasPermission(principal, "users.read") ||
      hasPermission(principal, "administration.access");
    // Read steam persona name and avatar from external_identities.profile
    let steamPersonaName: string | null = null;
    let steamAvatarUrl: string | null = null;
    try {
      const personaResult = await dependencies.database.query<{ profile: unknown }>(
        `SELECT profile FROM external_identities WHERE user_id = $1 AND provider = 'steam'`,
        [principal.userId],
      );
      const profile = personaResult.rows[0]?.profile;
      if (
        typeof profile === "object" &&
        profile !== null &&
        "steamPersonaName" in profile &&
        typeof (profile as { steamPersonaName: unknown }).steamPersonaName ===
          "string"
      ) {
        steamPersonaName = (profile as { steamPersonaName: string })
          .steamPersonaName;
      }
      if (
        typeof profile === "object" &&
        profile !== null &&
        "steamAvatarUrl" in profile &&
        typeof (profile as { steamAvatarUrl: unknown }).steamAvatarUrl ===
          "string"
      ) {
        steamAvatarUrl = (profile as { steamAvatarUrl: string })
          .steamAvatarUrl;
      }
    } catch {
      steamPersonaName = null;
      steamAvatarUrl = null;
    }
    // Lazy refresh if missing
    if (steamPersonaName === null) {
      const steamIdRow = await dependencies.database.query<{ subject: string }>(
        `SELECT subject FROM external_identities WHERE user_id = $1 AND provider = 'steam'`,
        [principal.userId],
      );
      const sid = steamIdRow.rows[0]?.subject;
      if (sid && dependencies.steamApiKey) {
        await refreshSteamPersonaName(dependencies.database, sid, dependencies.steamApiKey).catch((e) => console.error("[diag-avatar] refresh failed:", e instanceof Error ? e.constructor.name : typeof e, e instanceof Error ? e.message : String(e)));
        const r2 = await dependencies.database.query<{ profile: unknown }>(
          `SELECT profile FROM external_identities WHERE user_id = $1 AND provider = 'steam'`,
          [principal.userId],
        );
        const p2 = r2.rows[0]?.profile;
        if (typeof p2 === "object" && p2 !== null && "steamPersonaName" in p2 && typeof (p2 as { steamPersonaName: unknown }).steamPersonaName === "string") {
          steamPersonaName = (p2 as { steamPersonaName: string }).steamPersonaName;
        }
      }
    }
     return {
       userId: principal.userId,
       status: principal.status,
      displayName: principal.displayName ?? null,
       steamPersonaName,
       steamAvatarUrl,
       steamId: isAdmin ? (principal.steamId ?? null) : null,
      roles: principal.roles ?? [],
      grants: principal.grants,
      csrfToken: createCsrfToken(sessionToken),
    };
  });

  app.get("/v1/admin/users", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await authorizeRequest(
      request,
      reply,
      dependencies.authentication,
      "users.read",
    );
    if (principal === null) {
      return;
    }
    return { users: await listUserAccounts(dependencies.database, (request.query as { q?: string })?.q) };
  });

  // Layout routes
  app.get<{ Params: { projectId: string; applicationId: string; pageKey: string } }>(
    "/v1/layouts/:projectId/:applicationId/:pageKey",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.read");
      if (principal === null) return;
      const { projectId, applicationId, pageKey } = request.params;
      const page = await loadLayoutPage(dependencies.database, projectId, applicationId, pageKey);
      if (!page) return reply.code(404).send({ error: "not_found" });
      return { page };
    },
  );

  app.put<{ Params: { projectId: string; applicationId: string; pageKey: string }; Body: { title: string; schemaVersion: number; layout: unknown } }>(
    "/v1/layouts/:projectId/:applicationId/:pageKey",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.write");
      if (principal === null) return;
      const { projectId, applicationId, pageKey } = request.params;
      const body = request.body ?? {};
      try {
        const page = await saveDraftLayout(
          dependencies.database as unknown as TransactionalSqlExecutor,
          principal.userId,
          projectId,
          applicationId,
          pageKey,
          body.title,
          body.schemaVersion,
          body.layout as any,
        );
        return { page };
      } catch (error) {
        if (error instanceof LayoutServiceError) return reply.code(400).send({ error: error.code });
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string; applicationId: string; pageKey: string } }>(
    "/v1/layouts/:projectId/:applicationId/:pageKey/publish",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.publish");
      if (principal === null) return;
      const { projectId, applicationId, pageKey } = request.params;
      try {
        const page = await publishDraftLayout(
          dependencies.database as unknown as TransactionalSqlExecutor,
          principal.userId,
          projectId,
          applicationId,
          pageKey,
        );
        return { page };
      } catch (error) {
        if (error instanceof LayoutServiceError) return reply.code(400).send({ error: error.code });
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string; applicationId: string; pageKey: string } }>(
    "/v1/layouts/:projectId/:applicationId/:pageKey/revisions",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.read");
      if (principal === null) return;
      const { projectId, applicationId, pageKey } = request.params;
      const revisions = await listLayoutRevisions(dependencies.database, projectId, applicationId, pageKey);
      return { revisions };
    },
  );

  app.post<{ Params: { projectId: string; applicationId: string; pageKey: string }; Body: { revisionNumber: number } }>(
    "/v1/layouts/:projectId/:applicationId/:pageKey/restore",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.publish");
      if (principal === null) return;
      const { projectId, applicationId, pageKey } = request.params;
      const body = request.body ?? {};
      try {
        const page = await restoreLayoutRevision(
          dependencies.database as unknown as TransactionalSqlExecutor,
          principal.userId,
          projectId,
          applicationId,
          pageKey,
          body.revisionNumber,
        );
        return { page };
      } catch (error) {
        if (error instanceof LayoutServiceError) return reply.code(400).send({ error: error.code });
        throw error;
      }
    },
  );

  // Layout editor global toggle (reuses configurations table)
  app.get<{ Params: { projectId: string; applicationId: string } }>(
    "/v1/configurations/:projectId/:applicationId/layout-editor",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "layouts.read");
      if (principal === null) return;
      const { projectId, applicationId } = request.params;
      const res = await dependencies.database.query<{ json_content: { enabled?: boolean } | null }>(
        `SELECT json_content FROM configurations WHERE project_id = $1 AND application_id = $2 AND config_key = 'layout_editor_enabled'`,
        [projectId, applicationId],
      );
      const enabled = res.rows[0]?.json_content?.enabled ?? false;
      return { enabled };
    },
  );

  app.put<{ Params: { projectId: string; applicationId: string }; Body: { enabled: boolean } }>(
    "/v1/configurations/:projectId/:applicationId/layout-editor",
    async (request, reply) => {
      const principal = await authorizeRequest(request, reply, dependencies.authentication, "administration.access");
      if (principal === null) return;
      const { projectId, applicationId } = request.params;
      const enabled = Boolean(request.body?.enabled);
      const existing = await dependencies.database.query<{ id: string }>(
        `SELECT id FROM configurations WHERE project_id = $1 AND application_id = $2 AND config_key = 'layout_editor_enabled'`,
        [projectId, applicationId],
      );
      if (existing.rows[0]) {
        await dependencies.database.query(
          `UPDATE configurations SET json_content = $1, status = 'PUBLISHED', updated_by = $2, updated_at = now() WHERE id = $3`,
          [JSON.stringify({ enabled }), principal.userId, existing.rows[0].id],
        );
      } else {
        await dependencies.database.query(
          `INSERT INTO configurations (project_id, application_id, config_key, format, json_content, status, updated_by)
           VALUES ($1,$2,'layout_editor_enabled','json',$3,'PUBLISHED',$4)`,
          [projectId, applicationId, JSON.stringify({ enabled }), principal.userId],
        );
      }
      return { enabled };
    },
  );

  app.patch<{ Params: AccountRouteParams; Body: AccountRouteBody }>(
    "/v1/admin/users/:userId",
    {
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: {
            userId: {
              type: "string",
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
            },
          },
        },
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 120 },
            status: { type: "string", enum: ["ACTIVE", "SUSPENDED"] },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authorizeRequest(
        request,
        reply,
        dependencies.authentication,
        "users.manage",
      );
      if (actor === null) {
        return;
      }
      try {
        return await updateUserAccount(
          dependencies.transactions,
          actor,
          request.params.userId,
          request.body,
        );
      } catch (error) {
        if (error instanceof AccountServiceError) {
          const statusCode =
            error.code === "forbidden"
              ? 403
              : error.code === "user_not_found"
                ? 404
                : error.code === "last_active_administrator"
                  ? 409
                  : 400;
          return reply.code(statusCode).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  app.get("/v1/admin/permissions", async (request, reply) => {
    const principal = await authorizeRequest(
      request,
      reply,
      dependencies.authentication,
      "administration.access",
    );
    if (principal === null) {
      return;
    }
    return { permissions: permissionCodes };
  });

  app.post("/v1/bootstrap/claim-admin", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await authorizeRequest(
      request,
      reply,
      dependencies.authentication,
    );
    if (principal === null) {
      return;
    }

    try {
      await claimInitialAdministrator(
        dependencies.transactions,
        principal,
        initialAdminSteamIds,
      );
      return {
      userId: principal.userId, role: "ADMINISTRATEUR" };
    } catch (error) {
      if (error instanceof BootstrapServiceError) {
        const statusCode =
          error.code === "bootstrap_identity_not_verified"
            ? 403
            : error.code === "bootstrap_not_configured"
              ? 503
              : 409;
        return reply.code(statusCode).send({ error: error.code });
      }
      throw error;
    }
  });

  app.put<{ Params: RoleRouteParams; Body: RoleRouteBody }>(
    "/v1/admin/users/:userId/role",
    {
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: {
            userId: {
              type: "string",
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
            },
          },
        },
        body: {
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: ["ADMINISTRATEUR", "UTILISATEUR"] },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authorizeRequest(
        request,
        reply,
        dependencies.authentication,
        "users.roles.manage",
      );
      if (actor === null) {
        return;
      }

      try {
        return await changeGlobalRole(
          dependencies.transactions,
          actor,
          request.params.userId,
          request.body.role,
        );
      } catch (error) {
        if (error instanceof RoleServiceError) {
          const statusCode =
            error.code === "user_not_found"
              ? 404
              : error.code === "last_active_administrator"
                ? 409
                : error.code === "role_unavailable"
                  ? 503
                  : 403;
          return reply.code(statusCode).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined
    ) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({ error: "internal_server_error" });
  });

  return app;
}
