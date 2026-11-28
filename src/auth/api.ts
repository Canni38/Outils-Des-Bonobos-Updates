export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

function getApiBaseUrl(): string {
  const configuredUrl = import.meta.env.VITE_BONOBOS_API_URL?.trim();
  if (configuredUrl === undefined || configuredUrl.length === 0) {
    if (import.meta.env.DEV) {
      return "http://127.0.0.1:8080";
    }
    throw new ApiError(0, "api_not_configured");
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new ApiError(0, "api_url_invalid");
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "tauri.localhost";
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ApiError(0, "api_url_invalid");
  }
  return url.origin;
}

function getResponseError(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return "server_error";
}

export async function requestApi(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = new URL(path, `${getApiBaseUrl()}/`);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error");
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new ApiError(response.status, "invalid_server_response");
      }
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, getResponseError(payload));
  }
  return payload;
}

export function getApiOrigin(): string {
  return getApiBaseUrl();
}
