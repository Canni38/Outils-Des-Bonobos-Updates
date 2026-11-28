export const steamOpenIdEndpoint = "https://steamcommunity.com/openid/login";
const openIdNamespace = "http://specs.openid.net/auth/2.0";
const identifierSelect = "http://specs.openid.net/auth/2.0/identifier_select";
const requiredSignedFields = [
  "op_endpoint",
  "claimed_id",
  "identity",
  "return_to",
  "response_nonce",
] as const;

export class SteamOpenIdError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "invalid_response"
      | "provider_unavailable",
  ) {
    super(code);
    this.name = "SteamOpenIdError";
  }
}

export interface VerifiedSteamIdentity {
  steamId: string;
  responseNonce: string;
}

function requiredParameter(
  parameters: URLSearchParams,
  name: string,
): string {
  const values = parameters.getAll(name);
  if (values.length !== 1 || values[0] === "") {
    throw new SteamOpenIdError("invalid_response");
  }
  return values[0];
}

function parseFreshNonce(responseNonce: string, now: number): void {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)([^\x00-\x20\x7f]{1,235})$/.exec(
      responseNonce,
    );
  if (match === null) {
    throw new SteamOpenIdError("invalid_response");
  }
  const timestamp = Date.parse(match[1]);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + 60_000 ||
    now - timestamp > 10 * 60_000
  ) {
    throw new SteamOpenIdError("invalid_response");
  }
}

export function createSteamOpenIdRequest(
  returnTo: string,
  realm: string,
): string {
  const url = new URL(steamOpenIdEndpoint);
  url.searchParams.set("openid.ns", openIdNamespace);
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", realm);
  url.searchParams.set("openid.identity", identifierSelect);
  url.searchParams.set("openid.claimed_id", identifierSelect);
  return url.toString();
}

async function readProviderResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 8_192) {
        await reader.cancel();
        throw new SteamOpenIdError("invalid_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SteamOpenIdError) {
      throw error;
    }
    throw new SteamOpenIdError("provider_unavailable");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function verifySteamOpenIdResponse(
  parameters: URLSearchParams,
  expectedReturnTo: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<VerifiedSteamIdentity> {
  for (const name of parameters.keys()) {
    if (parameters.getAll(name).length !== 1) {
      throw new SteamOpenIdError("invalid_response");
    }
  }

  if (parameters.get("openid.mode") === "cancel") {
    throw new SteamOpenIdError("cancelled");
  }

  if (
    requiredParameter(parameters, "openid.ns") !== openIdNamespace ||
    requiredParameter(parameters, "openid.mode") !== "id_res" ||
    requiredParameter(parameters, "openid.op_endpoint") !== steamOpenIdEndpoint ||
    requiredParameter(parameters, "openid.return_to") !== expectedReturnTo
  ) {
    throw new SteamOpenIdError("invalid_response");
  }

  const claimedId = requiredParameter(parameters, "openid.claimed_id");
  const identity = requiredParameter(parameters, "openid.identity");
  const match =
    /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/.exec(
      claimedId,
    );
  if (match === null || identity !== claimedId) {
    throw new SteamOpenIdError("invalid_response");
  }

  const signedFields = new Set(
    requiredParameter(parameters, "openid.signed").split(","),
  );
  if (
    !requiredParameter(parameters, "openid.sig") ||
    requiredSignedFields.some((field) => !signedFields.has(field))
  ) {
    throw new SteamOpenIdError("invalid_response");
  }

  const responseNonce = requiredParameter(parameters, "openid.response_nonce");
  parseFreshNonce(responseNonce, now);

  const verification = new URLSearchParams();
  for (const [name, value] of parameters) {
    if (name.startsWith("openid.")) {
      verification.append(name, value);
    }
  }
  verification.set("openid.mode", "check_authentication");

  let response: Response;
  try {
    response = await fetcher(steamOpenIdEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: verification.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new SteamOpenIdError("provider_unavailable");
  }
  if (!response.ok) {
    throw new SteamOpenIdError("provider_unavailable");
  }

  const body = await readProviderResponse(response);
  if (
    body.length > 8_192 ||
    !/(?:^|\r?\n)is_valid:true(?:\r?\n|$)/.test(body)
  ) {
    throw new SteamOpenIdError("invalid_response");
  }

  return { steamId: match[1], responseNonce };
}
