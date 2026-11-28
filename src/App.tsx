import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import bonobosEmblem from "./assets/bonobos-embleme.png";
import "./App.css";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SteamIdDisplay } from "./components/SteamIdDisplay";
import { LayoutEditor } from "./layout/editor/LayoutEditor";
import { SyncingLayoutRepository } from "./layout/storage/SyncingLayoutRepository";
import { ApiLayoutRepository } from "./layout/storage/ApiLayoutRepository";
import {
  hasGlobalPermission,
  permissionCodes,
  type PermissionCode,
  type PermissionGrant,
} from "./auth/types";
import { ApiError, requestApi } from "./auth/api";

type Language = "fr" | "en";
type ConnectedPage = "account" | "permissions" | "administration" | "layout-editor";

const translations = {
  fr: {
    chooseLanguage: "Choisir la langue",
    appName: "Outils des Bonobos",
    publicEyebrow: "Application desktop",
    publicTitle: "Vos outils, au même endroit.",
    publicIntro:
      "Un espace desktop sécurisé, relié à Steam et adapté aux autorisations de votre compte.",
    publicFeatureAuth: "Connexion vérifiée par Steam OpenID",
    publicFeatureAccess: "Accès et rôles contrôlés par le serveur",
    publicFeatureDesktop: "Parcours conçu pour l’application Windows",
    signIn: "Se connecter avec Steam",
    openingSteam: "Ouverture de Steam…",
    waitingForSteam: "Terminez la connexion dans votre navigateur.",
    cancelLogin: "Annuler la connexion",
    loadingSession: "Vérification de la session…",
    connectionError: "La session ne peut pas être vérifiée pour le moment.",
    accountSuspended: "Ce compte est suspendu. Contactez un administrateur.",
    loginCancelled: "Connexion Steam annulée.",
    providerUnavailable: "Steam est momentanément indisponible. Réessayez.",
    invalidOpenId: "La réponse Steam n’a pas pu être validée. Réessayez.",
    invalidExchange: "Le retour de connexion a expiré ou a déjà été utilisé.",
    networkError: "Le serveur est injoignable. Vérifiez votre connexion.",
    apiNotConfigured:
      "L’adresse du serveur n’est pas configurée pour cette version.",
    deepLinkUnavailable:
      "Le retour sécurisé vers l’application n’est pas disponible.",
    desktopLoginRequired:
      "La connexion Steam doit être lancée depuis l’application installée.",
    secure_store_error:
      "Impossible de nettoyer les informations temporaires de connexion.",
    rateLimited: "Trop de tentatives. Patientez avant de réessayer.",
    genericLoginError: "La connexion a échoué. Réessayez.",
    version: "Version",
    connectedArea: "Espace connecté",
    account: "Mon compte",
    permissions: "Mes permissions",
    administration: "Administration",
    permissionCatalog: "Catalogue des permissions",
    catalogLoading: "Chargement du catalogue…",
    catalogUnavailable: "Impossible de charger le catalogue.",
    logout: "Se déconnecter",
    role: "Rôle",
    steamIdentity: "Identité Steam",
    steamId: "SteamID64",
    accountStatus: "Statut du compte",
    active: "Actif",
    noRole: "Aucun rôle attribué",
    accountSummary: "Votre compte",
    accountDescription:
      "Votre identité et vos accès sont chargés directement depuis le serveur.",
    permissionsTitle: "Permissions effectives",
    permissionsDescription:
      "Ces autorisations sont fournies par le serveur et appliquées par ses routes.",
    noPermissions: "Aucune permission spécifique n’est attribuée.",
    globalScope: "Globale",
    projectScope: "Projet",
    permissionLabels: {
      "users.read": "Consulter les utilisateurs",
      "users.manage": "Gérer les utilisateurs",
      "users.roles.manage": "Gérer les rôles",
      "projects.read": "Consulter les projets",
      "projects.manage": "Gérer les projets",
      "applications.read": "Consulter les applications",
      "applications.manage": "Gérer les applications",
      "layouts.read": "Consulter les mises en page",
      "layouts.write": "Modifier les mises en page",
      "layouts.publish": "Publier les mises en page",
      "configurations.read": "Consulter les configurations",
      "configurations.write": "Modifier les configurations",
      "activity.read": "Consulter le journal d’activité",
      "administration.access": "Accéder à l’administration",
    },
    diagnosticTitle: "Diagnostic Tauri",
    diagnosticDescription: "Commande locale conservée depuis l’application existante.",
    namePlaceholder: "Entrez un nom…",
    greet: "Saluer",
    updateTitle: "Mise à jour disponible",
    updateAvailable: "Une nouvelle version est disponible :",
    installUpdate: "Télécharger et installer",
    installingUpdate: "Téléchargement et installation…",
    remindLater: "Plus tard",
    updateFailed: "La mise à jour a échoué :",
    checkUpdates: "Vérifier les mises à jour",
    checkingUpdates: "Vérification…",
    upToDate: "Vous utilisez la dernière version.",
    updateCheckFailed: "Impossible de vérifier les mises à jour.",
    updateCheckInstalledOnly:
      "La vérification est disponible dans l’application installée.",
  },
  en: {
    chooseLanguage: "Choose language",
    appName: "Outils des Bonobos",
    publicEyebrow: "Desktop application",
    publicTitle: "Your tools, in one place.",
    publicIntro:
      "A secure desktop space connected to Steam and adapted to your account permissions.",
    publicFeatureAuth: "Steam OpenID verified sign-in",
    publicFeatureAccess: "Roles and access enforced by the server",
    publicFeatureDesktop: "A sign-in flow built for the Windows app",
    signIn: "Sign in with Steam",
    openingSteam: "Opening Steam…",
    waitingForSteam: "Finish signing in in your browser.",
    cancelLogin: "Cancel sign-in",
    loadingSession: "Checking session…",
    connectionError: "Your session cannot be checked right now.",
    accountSuspended: "This account is suspended. Contact an administrator.",
    loginCancelled: "Steam sign-in was cancelled.",
    providerUnavailable: "Steam is temporarily unavailable. Try again.",
    invalidOpenId: "The Steam response could not be verified. Try again.",
    invalidExchange: "The sign-in return expired or has already been used.",
    networkError: "The server is unreachable. Check your connection.",
    apiNotConfigured: "The server address is not configured for this build.",
    deepLinkUnavailable: "Secure return to the app is unavailable.",
    desktopLoginRequired: "Steam sign-in must start from the installed app.",
    secure_store_error: "Unable to clear temporary sign-in information.",
    rateLimited: "Too many attempts. Wait before trying again.",
    genericLoginError: "Sign-in failed. Try again.",
    version: "Version",
    connectedArea: "Signed-in area",
    account: "My account",
    permissions: "My permissions",
    administration: "Administration",
    permissionCatalog: "Permission catalog",
    catalogLoading: "Loading the catalog…",
    catalogUnavailable: "Unable to load the catalog.",
    logout: "Sign out",
    role: "Role",
    steamIdentity: "Steam identity",
    steamId: "SteamID64",
    accountStatus: "Account status",
    active: "Active",
    noRole: "No role assigned",
    accountSummary: "Your account",
    accountDescription: "Your identity and access are loaded directly from the server.",
    permissionsTitle: "Effective permissions",
    permissionsDescription:
      "These permissions are supplied by the server and enforced by its routes.",
    noPermissions: "No specific permissions are assigned.",
    globalScope: "Global",
    projectScope: "Project",
    permissionLabels: {
      "users.read": "Read users",
      "users.manage": "Manage users",
      "users.roles.manage": "Manage roles",
      "projects.read": "Read projects",
      "projects.manage": "Manage projects",
      "applications.read": "Read applications",
      "applications.manage": "Manage applications",
      "layouts.read": "Read layouts",
      "layouts.write": "Edit layouts",
      "layouts.publish": "Publish layouts",
      "configurations.read": "Read configurations",
      "configurations.write": "Edit configurations",
      "activity.read": "Read activity log",
      "administration.access": "Access administration",
    },
    diagnosticTitle: "Tauri diagnostics",
    diagnosticDescription: "Local command retained from the existing application.",
    namePlaceholder: "Enter a name…",
    greet: "Greet",
    updateTitle: "Update available",
    updateAvailable: "A new version is available:",
    installUpdate: "Download and install",
    installingUpdate: "Downloading and installing…",
    remindLater: "Later",
    updateFailed: "The update failed:",
    checkUpdates: "Check for updates",
    checkingUpdates: "Checking…",
    upToDate: "You’re using the latest version.",
    updateCheckFailed: "Unable to check for updates.",
    updateCheckInstalledOnly: "Update checks are available in the installed app.",
  },
} satisfies Record<
  Language,
  {
    permissionLabels: Record<PermissionCode, string>;
    [key: string]: string | Record<PermissionCode, string>;
  }
>;

const authErrorKeys: Record<string, keyof typeof translations.fr> = {
  account_suspended: "accountSuspended",
  cancelled: "loginCancelled",
  provider_unavailable: "providerUnavailable",
  invalid_openid_response: "invalidOpenId",
  invalid_desktop_exchange: "invalidExchange",
  pending_auth_expired: "invalidExchange",
  network_error: "networkError",
  api_not_configured: "apiNotConfigured",
  deep_link_unavailable: "deepLinkUnavailable",
  desktop_login_required: "desktopLoginRequired",
  secure_store_error: "secure_store_error",
  rate_limited: "rateLimited",
};

function readSavedLanguage(): Language {
  const saved = window.localStorage.getItem("bonobos-language");
  return saved === "en" ? "en" : "fr";
}

function getErrorMessage(
  code: string | null,
  t: (typeof translations)[Language],
): string | null {
  if (code === null) {
    return null;
  }
  const key = authErrorKeys[code];
  if (key === undefined) {
    return t.genericLoginError;
  }
  const message = t[key];
  return typeof message === "string" ? message : t.genericLoginError;
}

function LanguageSelector({
  language,
  onChange,
  label,
}: {
  language: Language;
  onChange: (language: Language) => void;
  label: string;
}) {
  return (
    <label className="language-control">
      <span className="visually-hidden">{label}</span>
      <select
        aria-label={label}
        value={language}
        onChange={(event) =>
          onChange(event.currentTarget.value === "en" ? "en" : "fr")
        }
      >
        <option value="fr">Français</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}

function PermissionList({
  grants,
  t,
}: {
  grants: PermissionGrant[];
  t: (typeof translations)[Language];
}) {
  if (grants.length === 0) {
    return <p className="empty-state">{t.noPermissions}</p>;
  }
  return (
    <ul className="permission-list">
      {grants.map((grant) => (
        <li key={`${grant.permission}:${grant.scope}:${grant.projectId ?? ""}`}>
          <span>{t.permissionLabels[grant.permission]}</span>
          <span className="permission-scope">
            {grant.scope === "GLOBAL" ? t.globalScope : t.projectScope}
            {grant.projectId ? ` · ${grant.projectId}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function parsePermissionCatalog(value: unknown): PermissionCode[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("permissions" in value) ||
    !Array.isArray(value.permissions) ||
    !value.permissions.every(
      (permission) =>
        typeof permission === "string" &&
        permissionCodes.some((known) => known === permission),
    )
  ) {
    throw new Error("invalid_permission_catalog");
  }
  return value.permissions;
}

function AppContent() {
  const {
    phase,
    user,
    errorCode,
    loginPending,
    beginLogin,
    cancelLogin,
    logout,
    clearError,
    refreshSession,
  } = useAuth();
  const [language, setLanguage] = useState<Language>(readSavedLanguage);
  const [activePage, setActivePage] = useState<ConnectedPage>("account");
  const [permissionCatalog, setPermissionCatalog] =
    useState<PermissionCode[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [name, setName] = useState("");
  const [greetMessage, setGreetMessage] = useState("");
  const [availableUpdate, setAvailableUpdate] =
    useState<Awaited<ReturnType<typeof check>>>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateNotice, setUpdateNotice] = useState("");
  const [appVersion, setAppVersion] = useState(
    import.meta.env.DEV ? "dev" : "0.1.1",
  );
  const updateNoticeTimeout = useRef<number | null>(null);
  const t = translations[language];
  const errorMessage = getErrorMessage(errorCode, t);
  const canAccessAdministration =
    user !== null && hasGlobalPermission(user, "administration.access");

  useEffect(() => {
    window.localStorage.setItem("bonobos-language", language);
  }, [language]);

  useEffect(() => {
    if (activePage === "administration" && !canAccessAdministration) {
      setActivePage("account");
    }
  }, [activePage, canAccessAdministration]);

  useEffect(() => {
    if (
      phase !== "authenticated" ||
      user === null ||
      activePage !== "administration" ||
      !canAccessAdministration
    ) {
      return;
    }
    let cancelled = false;
    setPermissionCatalog(null);
    setCatalogError(false);
    requestApi("/v1/admin/permissions")
      .then((response) => {
        const catalog = parsePermissionCatalog(response);
        if (!cancelled) {
          setPermissionCatalog(catalog);
        }
      })
      .catch((error: unknown) => {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          void refreshSession();
        }
        if (!cancelled) {
          setCatalogError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activePage,
    canAccessAdministration,
    phase,
    refreshSession,
    user,
  ]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void getVersion()
      .then(setAppVersion)
      .catch((error: unknown) => {
        console.error("Unable to read the application version:", error);
      });
  }, []);

  useEffect(
    () => () => {
      if (updateNoticeTimeout.current !== null) {
        window.clearTimeout(updateNoticeTimeout.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }
    let cancelled = false;
    check()
      .then((update) => {
        if (!cancelled && update) {
          setAvailableUpdate(update);
        }
      })
      .catch((error: unknown) => {
        console.error("Unable to check for updates:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function greet() {
    try {
      setGreetMessage(await invoke<string>("greet", { name, language }));
    } catch (error) {
      console.error("Unable to run the Tauri diagnostic command:", error);
      setGreetMessage(t.genericLoginError);
    }
  }

  async function checkForUpdates() {
    if (isCheckingUpdate || isInstallingUpdate) {
      return;
    }
    if (updateNoticeTimeout.current !== null) {
      window.clearTimeout(updateNoticeTimeout.current);
      updateNoticeTimeout.current = null;
    }
    setIsCheckingUpdate(true);
    setUpdateNotice("");
    try {
      if (import.meta.env.DEV) {
        setUpdateNotice(t.updateCheckInstalledOnly);
        return;
      }
      const update = await check();
      if (update) {
        setAvailableUpdate(update);
      } else {
        setUpdateNotice(t.upToDate);
        updateNoticeTimeout.current = window.setTimeout(() => {
          setUpdateNotice("");
          updateNoticeTimeout.current = null;
        }, 10_000);
      }
    } catch (error) {
      console.error("Unable to check for updates:", error);
      const details = error instanceof Error ? error.message : String(error);
      setUpdateNotice(`${t.updateCheckFailed} ${details}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function installUpdate() {
    if (!availableUpdate) {
      return;
    }
    setIsInstallingUpdate(true);
    setUpdateError("");
    try {
      await availableUpdate.downloadAndInstall();
      await relaunch();
    } catch (error) {
      console.error("Unable to install the update:", error);
      setUpdateError(error instanceof Error ? error.message : String(error));
      setIsInstallingUpdate(false);
    }
  }

  const displayName =
    user?.displayName?.trim() ||
    (language === "fr" ? "Compte Steam" : "Steam account");
  const roleLabels =
    user?.roles.map((role) =>
      role === "ADMINISTRATEUR"
        ? language === "fr"
          ? "Administrateur"
          : "Administrator"
        : role === "UTILISATEUR"
          ? language === "fr"
            ? "Utilisateur"
            : "User"
          : role,
    ) ?? [];

  return (
    <main className="app-frame">
      <header className="topbar">
        <a className="brand-lockup" href="#" aria-label={t.appName}>
          <img src={bonobosEmblem} alt="" />
          <span>{t.appName}</span>
        </a>
        <LanguageSelector
          language={language}
          onChange={setLanguage}
          label={t.chooseLanguage}
        />
      </header>

      {phase === "loading" && (
        <section className="loading-screen" aria-live="polite" role="status">
          <span className="loading-indicator" />
          <p>{t.loadingSession}</p>
        </section>
      )}

      {(phase === "anonymous" || phase === "unavailable") && (
        <section className="landing-page">
          <div className="landing-copy">
            <p className="eyebrow">{t.publicEyebrow}</p>
            <h1>{t.publicTitle}</h1>
            <p className="landing-intro">{t.publicIntro}</p>
            <ul className="feature-list">
              <li>{t.publicFeatureAuth}</li>
              <li>{t.publicFeatureAccess}</li>
              <li>{t.publicFeatureDesktop}</li>
            </ul>
            {phase === "unavailable" && (
              <p className="feedback-message error" role="alert">
                {getErrorMessage(errorCode, t) ?? t.connectionError}
              </p>
            )}
            {phase === "anonymous" && errorMessage && (
              <p className="feedback-message error" role="alert">
                {errorMessage}
              </p>
            )}
            <div className="login-actions">
              <button
                className="steam-login-button"
                disabled={loginPending}
                onClick={() => void beginLogin()}
                type="button"
              >
                <span className="steam-mark" aria-hidden="true">
                  S
                </span>
                {loginPending ? t.openingSteam : t.signIn}
              </button>
              {loginPending && (
                <div className="pending-login">
                  <span>{t.waitingForSteam}</span>
                  <button
                    className="text-button"
                    onClick={() => void cancelLogin()}
                    type="button"
                  >
                    {t.cancelLogin}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="landing-art" aria-hidden="true">
            <img src={bonobosEmblem} alt="" />
            <span className="art-glow" />
          </div>
        </section>
      )}

      {phase === "authenticated" && user !== null && (
        <section className="connected-layout">
          <aside className="side-panel">
            <div className="user-summary">
              <img src={user.steamAvatarUrl ?? bonobosEmblem} alt="" />
              <div>
                <strong>{user?.steamPersonaName ?? displayName}</strong>
                <span>{roleLabels.join(" · ") || t.noRole}</span>
              </div>
            </div>
            <nav aria-label={t.connectedArea} className="main-navigation">
              <button
                aria-current={activePage === "account" ? "page" : undefined}
                className={activePage === "account" ? "nav-link active" : "nav-link"}
                onClick={() => setActivePage("account")}
                type="button"
              >
                {t.account}
              </button>
              <button
                aria-current={
                  activePage === "permissions" ? "page" : undefined
                }
                className={
                  activePage === "permissions" ? "nav-link active" : "nav-link"
                }
                onClick={() => setActivePage("permissions")}
                type="button"
              >
                {t.permissions}
              </button>
               {canAccessAdministration && (
                 <button
                   aria-current={
                     activePage === "administration" ? "page" : undefined
                   }
                   className={
                     activePage === "administration"
                       ? "nav-link active"
                       : "nav-link"
                   }
                   onClick={() => setActivePage("administration")}
                   type="button"
                 >
                   {t.administration}
                 </button>
               )}
               {canAccessAdministration &&
                 user !== null &&
                 hasGlobalPermission(user, "layouts.write") && (
                   <button
                     aria-current={
                       activePage === "layout-editor" ? "page" : undefined
                     }
                     className={
                       activePage === "layout-editor"
                         ? "nav-link active"
                         : "nav-link"
                     }
                     onClick={() => setActivePage("layout-editor")}
                     type="button"
                   >
                     Éditeur de mise en page
                   </button>
                 )}
            </nav>
            <button className="logout-button" onClick={() => void logout()} type="button">
              {t.logout}
            </button>
          </aside>

          <div className="content-panel">
            {errorMessage && (
              <p className="feedback-message error" role="alert">
                {errorMessage}
                <button className="dismiss-button" onClick={clearError} type="button">
                  ×
                </button>
              </p>
            )}
            {activePage === "account" ? (
              <section className="content-card">
                <p className="eyebrow">{t.connectedArea}</p>
                <h1>{t.accountSummary}</h1>
                <p className="section-description">{t.accountDescription}</p>
                <dl className="profile-grid">
                  <div>
                    <dt>{t.steamIdentity}</dt>
                    <dd>{user.steamPersonaName ?? displayName}</dd>
                  </div>
                  <div>
                    <dt>{t.role}</dt>
                    <dd>{roleLabels.join(", ") || t.noRole}</dd>
                  </div>
                  <div>
                    <dt>{t.steamId}</dt>
                    <dd className="monospace-value"><SteamIdDisplay steamId={user.steamId} /></dd>
                  </div>
                  <div>
                    <dt>{t.accountStatus}</dt>
                    <dd>{t.active}</dd>
                  </div>
                </dl>
                <details className="diagnostic-panel">
                  <summary>{t.diagnosticTitle}</summary>
                  <p>{t.diagnosticDescription}</p>
                  <form
                    className="diagnostic-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void greet();
                    }}
                  >
                    <input
                      onChange={(event) => setName(event.currentTarget.value)}
                      placeholder={t.namePlaceholder}
                      value={name}
                    />
                    <button type="submit">{t.greet}</button>
                  </form>
                  {greetMessage && <p role="status">{greetMessage}</p>}
                </details>
              </section>
            ) : activePage === "permissions" ? (
              <section className="content-card">
                <p className="eyebrow">{t.connectedArea}</p>
                <h1>{t.permissionsTitle}</h1>
                <p className="section-description">
                  {t.permissionsDescription}
                </p>
                <PermissionList grants={user.grants} t={t} />
              </section>
              ) : activePage === "administration" ? (
                <section className="content-card">
                  <p className="eyebrow">{t.connectedArea}</p>
                  <h1>{t.permissionCatalog}</h1>
                  {permissionCatalog === null && !catalogError && (
                    <p className="section-description" role="status">
                      {t.catalogLoading}
                    </p>
                  )}
                  {catalogError && (
                    <p className="feedback-message error" role="alert">
                      {t.catalogUnavailable}
                    </p>
                  )}
                  {permissionCatalog !== null && (
                    <ul className="permission-list">
                      {permissionCatalog.map((permission) => (
                        <li key={permission}>
                          <span>{t.permissionLabels[permission]}</span>
                          <code>{permission}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : activePage === "layout-editor" ? (
                <section className="content-card">
                  <p className="eyebrow">{t.connectedArea}</p>
                  <h1>Éditeur de mise en page</h1>
                  <p className="section-description">
                    Réglage global de l'éditeur de mise en page.
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const base = import.meta.env.VITE_BONOBOS_API_URL || "http://127.0.0.1:8080";
                        const res = await fetch(`${base}/v1/configurations/demo-project/demo-app/layout-editor`, { credentials: "include" });
                        const data = await res.json();
                        const next = !data.enabled;
                        await fetch(`${base}/v1/configurations/demo-project/demo-app/layout-editor`, {
                          method: "PUT",
                          credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ enabled: next }),
                        });
                        alert(next ? "Éditeur activé" : "Éditeur désactivé");
                      } catch (e) {
                        alert("Erreur: " + String(e));
                      }
                    }}
                  >
                    Basculer l'éditeur ON/OFF
                  </button>
                  <LayoutEditor
                    repository={
                      new SyncingLayoutRepository(
                        new ApiLayoutRepository("demo-project", "demo-app", "demo-home"),
                      )
                    }
                  />
                </section>
              ) : (
                <section className="content-card">
                  <p>Chargement…</p>
                </section>
              )}
              </div>
            </section>
          )}

      <footer className="app-footer">
        <span>{t.appName}</span>
        <span>{t.version} {appVersion}</span>
      </footer>

      <div className="update-check-control">
        {updateNotice && (
          <p aria-live="polite" className="update-notice" role="status">
            {updateNotice}
          </p>
        )}
        <button
          disabled={isCheckingUpdate || isInstallingUpdate}
          onClick={() => void checkForUpdates()}
          type="button"
        >
          {isCheckingUpdate ? t.checkingUpdates : t.checkUpdates}
        </button>
      </div>

      {availableUpdate && (
        <div className="update-overlay">
          <section
            aria-labelledby="update-title"
            aria-modal="true"
            className="update-dialog"
            role="dialog"
          >
            <h2 id="update-title">{t.updateTitle}</h2>
            <p>
              {t.updateAvailable} <strong>{availableUpdate.version}</strong>
            </p>
            {updateError && (
              <p aria-live="polite" className="update-error">
                {t.updateFailed} {updateError}
              </p>
            )}
            <div className="update-actions">
              <button
                disabled={isInstallingUpdate}
                onClick={() => void installUpdate()}
                type="button"
              >
                {isInstallingUpdate ? t.installingUpdate : t.installUpdate}
              </button>
              <button
                disabled={isInstallingUpdate}
                onClick={() => setAvailableUpdate(null)}
                type="button"
              >
                {t.remindLater}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <ErrorBoundary>
        <AppContent />
      </ErrorBoundary>
    </AuthProvider>
  );
}

export default App;
