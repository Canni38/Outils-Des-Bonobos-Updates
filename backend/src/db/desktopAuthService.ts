import { createHash, randomBytes } from "node:crypto";
import { constantTimeStringEqual } from "../httpCookies.js";
import type {
  SqlExecutor,
  TransactionalSqlExecutor,
} from "./contracts.js";
import {
  loginWithVerifiedSteamIdentityInTransaction,
  type SteamLoginResult,
} from "./sessionService.js";

const desktopAuthAttemptLifetimeMs = 10 * 60 * 1_000;

interface DesktopAttemptRow extends Record<string, unknown> {
  app_state: string;
  code_challenge: string;
  steam_id: string | null;
}

interface AttemptHashRow extends Record<string, unknown> {
  attempt_hash: Uint8Array;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createDesktopCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export async function createDesktopAuthAttempt(
  database: SqlExecutor,
  codeChallenge: string,
  appState: string,
): Promise<string> {
  await database.query(
    "DELETE FROM steam_openid_transactions WHERE expires_at < now() - interval '1 day'",
  );
  await database.query(
    "DELETE FROM desktop_auth_attempts WHERE expires_at < now() - interval '1 day'",
  );
  const attempt = randomBytes(32).toString("base64url");
  await database.query(
    `INSERT INTO desktop_auth_attempts
       (attempt_hash, code_challenge, app_state, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      hash(attempt),
      codeChallenge,
      appState,
      new Date(Date.now() + desktopAuthAttemptLifetimeMs),
    ],
  );
  return attempt;
}

export async function beginDesktopAuthAttempt(
  database: SqlExecutor,
  attempt: string,
): Promise<Buffer | null> {
  const result = await database.query<AttemptHashRow>(
    `UPDATE desktop_auth_attempts
     SET started_at = now()
     WHERE attempt_hash = $1
       AND started_at IS NULL
       AND completed_at IS NULL
       AND expires_at > now()
     RETURNING attempt_hash`,
    [hash(attempt)],
  );
  const attemptHash = result.rows[0]?.attempt_hash;
  return attemptHash === undefined ? null : Buffer.from(attemptHash);
}

export async function getDesktopAttemptForOpenIdState(
  database: SqlExecutor,
  stateHash: Buffer,
): Promise<Buffer | null> {
  const result = await database.query<AttemptHashRow>(
    `SELECT desktop_attempt_hash AS attempt_hash
     FROM steam_openid_transactions
     WHERE state_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()
       AND desktop_attempt_hash IS NOT NULL`,
    [stateHash],
  );
  const attemptHash = result.rows[0]?.attempt_hash;
  return attemptHash === undefined ? null : Buffer.from(attemptHash);
}

export async function completeDesktopAuthWithCode(
  database: TransactionalSqlExecutor,
  attemptHash: Buffer,
  steamId: string,
  code: string,
): Promise<string | null> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ app_state: string }>(
      `UPDATE desktop_auth_attempts
       SET completed_at = now(),
           steam_id = $2,
           exchange_code_hash = $3,
           exchange_expires_at = now() + interval '90 seconds'
       WHERE attempt_hash = $1
         AND started_at IS NOT NULL
         AND completed_at IS NULL
         AND expires_at > now()
       RETURNING app_state`,
      [attemptHash, steamId, hash(code)],
    );
    return result.rows[0]?.app_state ?? null;
  });
}

export async function completeDesktopAuthWithError(
  database: TransactionalSqlExecutor,
  attemptHash: Buffer,
  error: "cancelled" | "provider_unavailable" | "invalid_openid_response",
): Promise<string | null> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ app_state: string }>(
      `UPDATE desktop_auth_attempts
       SET completed_at = now(), failure_code = $2
       WHERE attempt_hash = $1
         AND started_at IS NOT NULL
         AND completed_at IS NULL
         AND expires_at > now()
       RETURNING app_state`,
      [attemptHash, error],
    );
    return result.rows[0]?.app_state ?? null;
  });
}

export async function getDesktopAuthSteamId(
  database: SqlExecutor,
  code: string,
  verifier: string,
  appState: string,
): Promise<string | null> {
  const result = await database.query<DesktopAttemptRow>(
    `SELECT app_state, code_challenge, steam_id
     FROM desktop_auth_attempts
     WHERE exchange_code_hash = $1
       AND completed_at IS NOT NULL
       AND exchanged_at IS NULL
       AND expires_at > now()
       AND exchange_expires_at > now()`,
    [hash(code)],
  );
  const attempt = result.rows[0];
  if (
    attempt?.steam_id === null ||
    attempt?.steam_id === undefined ||
    !constantTimeStringEqual(attempt.app_state, appState) ||
    !constantTimeStringEqual(
      attempt.code_challenge,
      createDesktopCodeChallenge(verifier),
    )
  ) {
    return null;
  }
  return attempt.steam_id;
}

export async function exchangeDesktopAuthCode(
  database: TransactionalSqlExecutor,
  code: string,
  verifier: string,
  appState: string,
  sessionTokenHash: Buffer,
  sessionExpiresAt: Date,
  initialAdminSteamIds: readonly string[],
): Promise<SteamLoginResult | null> {
  const codeHash = hash(code);
  const codeChallenge = createDesktopCodeChallenge(verifier);
  return database.transaction(async (transaction) => {
    const selected = await transaction.query<
      DesktopAttemptRow & { attempt_hash: Uint8Array }
    >(
      `SELECT attempt_hash, app_state, code_challenge, steam_id
       FROM desktop_auth_attempts
       WHERE exchange_code_hash = $1
         AND completed_at IS NOT NULL
         AND exchanged_at IS NULL
         AND expires_at > now()
         AND exchange_expires_at > now()
       FOR UPDATE`,
      [codeHash],
    );
    const attempt = selected.rows[0];
    if (
      attempt?.steam_id === null ||
      attempt?.steam_id === undefined ||
      !constantTimeStringEqual(attempt.app_state, appState) ||
      !constantTimeStringEqual(attempt.code_challenge, codeChallenge)
    ) {
      return null;
    }

    const consumed = await transaction.query(
      `UPDATE desktop_auth_attempts
       SET exchanged_at = now()
       WHERE attempt_hash = $1
         AND exchanged_at IS NULL
         AND expires_at > now()
         AND exchange_expires_at > now()
       RETURNING attempt_hash`,
      [attempt.attempt_hash],
    );
    if (consumed.rowCount !== 1) {
      return null;
    }

    return loginWithVerifiedSteamIdentityInTransaction(
      transaction,
      attempt.steam_id,
      sessionTokenHash,
      sessionExpiresAt,
      initialAdminSteamIds,
    );
  });
}

