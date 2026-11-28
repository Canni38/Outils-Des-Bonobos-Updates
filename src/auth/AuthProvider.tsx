import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ApiError, requestApi } from "./api";
import { SessionOperationCoordinator } from "./sessionOperationCoordinator";
import { parseAuthenticatedUser, type AuthenticatedUser } from "./types";

type AuthPhase = "loading" | "anonymous" | "authenticated" | "unavailable";

interface DesktopCallback {
  state: string;
  code: string | null;
  error: string | null;
}

interface PendingDesktopAuth {
  state: string;
  verifier: string;
  expiresAt: number;
}

interface AuthContextValue {
  phase: AuthPhase;
  user: AuthenticatedUser | null;
  errorCode: string | null;
  loginPending: boolean;
  beginLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function readErrorCode(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "login_failed";
}

function validateAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid_authorization_url");
  }
  const url = new URL(value);
  const attempts = url.searchParams.getAll("desktop_attempt");
  if (
    url.pathname !== "/auth/steam" ||
    attempts.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(attempts[0] ?? "")
  ) {
    throw new Error("invalid_authorization_url");
  }
  return url.toString();
}

async function revokeCurrentWebViewSession(): Promise<void> {
  let currentUser: AuthenticatedUser;
  try {
    currentUser = parseAuthenticatedUser(await requestApi("/v1/me"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    throw error;
  }
  await requestApi("/v1/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": currentUser.csrfToken },
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const processedUrls = useRef(new Map<string, Promise<void>>());
  const loginStarting = useRef(false);
  const coordinatorRef = useRef<SessionOperationCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new SessionOperationCoordinator();
  }
  const coordinator = coordinatorRef.current;
  const initialCompleteRef = useRef(false);
  const lastRevalidationRef = useRef(0);

  const refreshSession = useCallback(async () => {
    const isInitial = !initialCompleteRef.current;
    await coordinator.runRefresh(async ({ generation, signal }) => {
      if (isInitial) {
        coordinator.runIfCurrent(generation, () => setPhase("loading"));
      }
      try {
          const raw = await requestApi("/v1/me", { signal });
          console.log("[diag-auth] /v1/me raw keys:", Object.keys(raw as object));
          const r = raw as Record<string, unknown>;
          console.log("[diag-auth] /v1/me steamPersonaName:", r.steamPersonaName, "steamId:", r.steamId, "roles:", r.roles, "grants:", Array.isArray(r.grants) ? r.grants.length : r.grants, "csrfToken:", typeof r.csrfToken);
          const profile = parseAuthenticatedUser(raw);
          coordinator.runIfCurrent(generation, () => {
           setUser(profile);
          setPhase("authenticated");
          setErrorCode(null);
          console.log("[diag-auth] phase set authenticated, errorCode cleared");
        });
      } catch (error) {
        if (signal.aborted || !coordinator.isCurrent(generation)) {
          return;
        }
        coordinator.runIfCurrent(generation, () => {
          setUser(null);
          if (error instanceof ApiError && error.status === 401) {
            setPhase("anonymous");
            setErrorCode(null);
          } else {
            setPhase("unavailable");
            setErrorCode(readErrorCode(error));
          }
          console.log("[diag-auth] refreshSession catch, phase set, error:", readErrorCode(error));
        });
      }
    });
    initialCompleteRef.current = true;
  }, [coordinator]);

  const processDeepLink = useCallback((rawUrl: string): Promise<void> => {
    const alreadyProcessing = processedUrls.current.get(rawUrl);
    if (alreadyProcessing !== undefined) {
      return alreadyProcessing;
    }
    const generation = coordinator.invalidate();

    const processing = (async () => {
      console.log("[diag-auth] processDeepLink start");
      try {
        const callback = await coordinator.runCredentialOperation(() =>
          invoke<DesktopCallback>("validate_desktop_auth_callback", { rawUrl }),
        );
        console.log("[diag-auth] callback validated, error:", callback.error);
        if (!coordinator.isCurrent(generation)) {
          return;
        }
        if (callback.error !== null) {
          await coordinator.runCredentialOperation(() =>
            invoke("clear_pending_desktop_auth"),
          );
          coordinator.runIfCurrent(generation, () => {
            setLoginPending(false);
            setUser(null);
            setPhase("anonymous");
            setErrorCode(callback.error);
          });
          return;
        }
        if (callback.code === null) {
          throw new Error("invalid_callback_parameters");
        }

        const pending = await coordinator.runCredentialOperation(() =>
          invoke<PendingDesktopAuth>("get_pending_desktop_auth"),
        );
        if (!coordinator.isCurrent(generation)) {
          return;
        }
        if (pending === null) {
          throw new Error("no_pending_auth");
        }
        if (pending.state !== callback.state) {
          throw new Error("invalid_callback_state");
        }
        await coordinator.runSessionMutation(() =>
          requestApi("/auth/desktop/exchange", {
            method: "POST",
            body: JSON.stringify({
              code: callback.code,
              verifier: pending.verifier,
              state: callback.state,
            }),
          }).then(() => undefined),
        );
        console.log("[diag-auth] desktop/exchange done");
        if (!coordinator.isCurrent(generation)) {
          return;
        }
        await coordinator.runCredentialOperation(() =>
          invoke("clear_pending_desktop_auth"),
        );
        if (!coordinator.isCurrent(generation)) {
          return;
        }
        setLoginPending(false);
        coordinator.invalidate();
        console.log("[diag-auth] refreshSession start");
        await refreshSession();
        console.log("[diag-auth] refreshSession done");
      } catch (error) {
        console.error("[diag-auth] processDeepLink failed", error);
        if (!coordinator.isCurrent(generation)) {
          return;
        }
        const code = readErrorCode(error);
        try {
          await coordinator.runCredentialOperation(() =>
            invoke("clear_pending_desktop_auth"),
          );
        } catch (cleanupError) {
          console.error(
            "Unable to clear pending desktop authentication:",
            cleanupError,
          );
          coordinator.runIfCurrent(generation, () => {
            setErrorCode("secure_store_error");
            setLoginPending(false);
            setUser(null);
            setPhase("anonymous");
          });
          return;
        }
        coordinator.runIfCurrent(generation, () => {
          setUser(null);
          setPhase("anonymous");
          setErrorCode(code);
          setLoginPending(false);
        });
      }
    })();

    processedUrls.current.set(rawUrl, processing);
    return processing;
  }, [coordinator, refreshSession]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function initialize() {
      if (isTauri()) {
        try {
          const stopListening = await onOpenUrl((urls) => {
            if (disposed) {
              return;
            }
            for (const url of urls) {
              void processDeepLink(url);
            }
          });
          if (disposed) {
            stopListening();
            return;
          }
          unlisten = stopListening;
          const currentUrls = await getCurrent();
          if (!disposed && currentUrls !== null) {
            await Promise.all(currentUrls.map(processDeepLink));
          }
    } catch (error) {
          console.error("Unable to initialize the desktop login callback:", error);
          if (!disposed) {
            setErrorCode("deep_link_unavailable");
          }
        }
      }
      if (!disposed) {
        await refreshSession();
      }
    }

    void initialize();
    return () => {
      disposed = true;
      unlisten?.();
      coordinator.invalidate();
    };
  }, [coordinator, processDeepLink, refreshSession]);

  useEffect(() => {
    if (
      (phase !== "authenticated" && phase !== "unavailable") ||
      loginPending
    ) {
      return;
    }
    let refreshing = false;
    const revalidateSession = () => {
      if (document.visibilityState !== "visible" || refreshing) {
        return;
      }
      const now = Date.now();
      if (now - lastRevalidationRef.current < 2_000) {
        return;
      }
      lastRevalidationRef.current = now;
      refreshing = true;
      void refreshSession().finally(() => {
        refreshing = false;
      });
    };
    const interval = window.setInterval(revalidateSession, 300_000);
    window.addEventListener("focus", revalidateSession);
    document.addEventListener("visibilitychange", revalidateSession);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidateSession);
      document.removeEventListener("visibilitychange", revalidateSession);
    };
  }, [loginPending, phase, refreshSession]);

  const beginLogin = useCallback(async () => {
    console.log("[diag-auth] beginLogin start");
    if (loginStarting.current) {
      return;
    }
    loginStarting.current = true;
    const generation = coordinator.invalidate();
    setErrorCode(null);
    if (!isTauri()) {
      coordinator.runIfCurrent(generation, () =>
        setErrorCode("desktop_login_required"),
      );
      loginStarting.current = false;
      return;
    }

    const state = randomBase64Url(32);
    const verifier = randomBase64Url(32);
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    let stored = false;
    try {
      await coordinator.runCredentialOperation(() =>
        invoke("store_pending_desktop_auth", {
          state,
          verifier,
          expiresAt,
        }),
      );
      stored = true;
      if (!coordinator.isCurrent(generation)) {
        return;
      }
      console.log("[diag-auth] desktop/start request");
      const start = await requestApi("/auth/desktop/start", {
        method: "POST",
        body: JSON.stringify({
          codeChallenge: await createCodeChallenge(verifier),
          state,
        }),
      });
      console.log("[diag-auth] desktop/start response received");
      if (!coordinator.isCurrent(generation)) {
        return;
      }
      if (
        typeof start !== "object" ||
        start === null ||
        !("authorizationUrl" in start)
      ) {
        throw new Error("invalid_authorization_response");
      }
      const authorizationUrl = validateAuthorizationUrl(start.authorizationUrl);
      console.log("[diag-auth] authorizationUrl validated");
      coordinator.runIfCurrent(generation, () => setLoginPending(true));
      console.log("[diag-auth] openUrl calling");
      await openUrl(authorizationUrl);
      console.log("[diag-auth] openUrl done");
     } catch (error) {
      console.error("[diag-auth] beginLogin failed", error);
      if (stored && coordinator.isCurrent(generation)) {
        try {
          await coordinator.runCredentialOperation(() =>
            invoke("clear_pending_desktop_auth"),
          );
        } catch (cleanupError) {
          console.error("Unable to clear pending desktop authentication:", cleanupError);
        }
      }
      coordinator.runIfCurrent(generation, () => {
        setLoginPending(false);
        setErrorCode(readErrorCode(error));
      });
    } finally {
      loginStarting.current = false;
    }
  }, [coordinator]);

  const cancelLogin = useCallback(async () => {
    const generation = coordinator.invalidate();
    try {
      await coordinator.runCredentialOperation(() =>
        invoke("clear_pending_desktop_auth"),
      );
      await coordinator.runSessionMutation(revokeCurrentWebViewSession);
      coordinator.runIfCurrent(generation, () => {
        setLoginPending(false);
        setUser(null);
        setPhase("anonymous");
        setErrorCode(null);
      });
    } catch (error) {
      coordinator.runIfCurrent(generation, () => {
        setLoginPending(false);
        setUser(null);
        setPhase("anonymous");
        setErrorCode(readErrorCode(error));
      });
    }
  }, [coordinator]);

  const logout = useCallback(async () => {
    const generation = coordinator.invalidate();
    let cleanupError: unknown;
    try {
      await coordinator.runCredentialOperation(() =>
        invoke("clear_pending_desktop_auth"),
      );
    } catch (error) {
      cleanupError = error;
      console.error("Unable to clear pending desktop authentication:", error);
    }

    try {
      await coordinator.runSessionMutation(revokeCurrentWebViewSession);
      coordinator.runIfCurrent(generation, () => {
        setUser(null);
        setPhase("anonymous");
        setLoginPending(false);
        setErrorCode(null);
      });
     } catch (error) {
      console.error("[diag-auth] logout exchange failed", error);
      coordinator.runIfCurrent(generation, () => {
        if (error instanceof ApiError && error.status === 401) {
          setUser(null);
          setPhase("anonymous");
        }
        setErrorCode(
          cleanupError === undefined
            ? readErrorCode(error)
            : "secure_store_error",
        );
      });
    }
  }, [coordinator]);

  const clearError = useCallback(() => setErrorCode(null), []);
  const contextValue = useMemo(
    () => ({
      phase,
      user,
      errorCode,
      loginPending,
      beginLogin,
      cancelLogin,
      logout,
      refreshSession,
      clearError,
    }),
    [
      beginLogin,
      cancelLogin,
      clearError,
      errorCode,
      loginPending,
      logout,
      phase,
      refreshSession,
      user,
    ],
  );

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return value;
}
