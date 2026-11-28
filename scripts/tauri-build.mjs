import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "Canni38/Outils-Des-Bonobos-Updates";
const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`;
const tauriCli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

function findGitHubCli() {
  if (process.platform !== "win32") {
    return "gh";
  }

  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", "gh.exe"),
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "GitHub CLI",
      "gh.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Microsoft",
      "WinGet",
      "Links",
      "gh.exe",
    ),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "gh";
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });

  if (result.error) {
    return { status: null, stdout: "", stderr: "", error: result.error };
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: null,
  };
}

function runGh(args) {
  const result = run(findGitHubCli(), args, { capture: true });
  if (result.error?.code === "ENOENT") {
    fail(
      "GitHub CLI is not installed. Install it with `winget install --id GitHub.cli`, " +
        "reopen the terminal, then run `gh auth login --hostname github.com --web`.",
    );
  }
  if (result.error) {
    fail("Could not start GitHub CLI.");
  }
  return result;
}

function readProjectVersion() {
  const packageJson = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const tauriConfig = JSON.parse(
    readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const cargoToml = readFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    "utf8",
  );
  const cargoVersion = cargoToml.match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  )?.[1];
  const versions = [packageJson.version, tauriConfig.version, cargoVersion];

  if (versions.some((version) => !version) || new Set(versions).size !== 1) {
    fail("The versions in package.json, tauri.conf.json, and Cargo.toml must match.");
  }

  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    fail("Releases must use a stable semantic version such as 0.1.2.");
  }

  return { version: packageJson.version, productName: tauriConfig.productName };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

function ensureSigningKey() {
  const keyPath = path.join(
    os.homedir(),
    ".tauri",
    "bonobos-fr-app-updater.key",
  );

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    if (!existsSync(keyPath)) {
      fail(
        "The local Tauri signing key was not found in the user profile. " +
          "Set TAURI_SIGNING_PRIVATE_KEY to its path before building.",
      );
    }
    process.env.TAURI_SIGNING_PRIVATE_KEY = keyPath;
  }
}

function isValidProductionApiUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  const isLocalHost =
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.hostname.startsWith("127.");
  if (isLocalHost) {
    return false;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return false;
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  return true;
}

function generateProdCspFragment(apiUrl) {
  const parsed = new URL(apiUrl.trim());
  const fragment = {
    app: {
      security: {
        csp: {
          "connect-src": ["'self'", parsed.origin],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
        },
      },
    },
  };
  const fragmentDir = mkdtempSync(
    path.join(os.tmpdir(), "bonobos-csp-prod-")
  );
  const fragmentPath = path.join(fragmentDir, "csp-prod.json");
  writeFileSync(
    fragmentPath,
    `${JSON.stringify(fragment, null, 2)}\n`,
    { encoding: "utf8" }
  );
  return fragmentPath;
}

function ensureGitHubReady(version) {
  const auth = runGh(["auth", "status", "--hostname", "github.com"]);
  if (auth.status !== 0) {
    fail(
      "GitHub CLI is not authenticated. Run `gh auth login --hostname github.com --web`, " +
        "then retry the build.",
    );
  }

  const repoResult = runGh([
    "repo",
    "view",
    repository,
    "--json",
    "nameWithOwner,isPrivate,defaultBranchRef",
  ]);
  if (repoResult.status !== 0) {
    fail(`Cannot access the GitHub repository ${repository}.`);
  }

  let repoInfo;
  try {
    repoInfo = JSON.parse(repoResult.stdout);
  } catch {
    fail("GitHub CLI returned invalid repository information.");
  }
  if (repoInfo.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) {
    fail(`GitHub returned an unexpected repository instead of ${repository}.`);
  }
  if (repoInfo.isPrivate) {
    fail(`The update repository ${repository} must be public for players.`);
  }
  const defaultBranch = repoInfo.defaultBranchRef?.name;
  if (!defaultBranch) {
    fail(`Could not determine the default branch for ${repository}.`);
  }

  const permissions = runGh([
    "api",
    `repos/${repository}`,
    "--jq",
    ".permissions.push",
  ]);
  if (permissions.status !== 0 || permissions.stdout.trim() !== "true") {
    fail(`The authenticated GitHub account cannot publish releases to ${repository}.`);
  }

  const tag = `v${version}`;
  const release = runGh([
    "api",
    `repos/${repository}/releases/tags/${tag}`,
  ]);
  if (release.status === 0) {
    fail(`Release ${tag} already exists. Increase the project version before publishing.`);
  }
  if (!/404|Not Found/i.test(release.stderr + release.stdout)) {
    fail(`Could not verify whether release ${tag} already exists.`);
  }

  const tagRef = runGh([
    "api",
    `repos/${repository}/git/ref/tags/${tag}`,
  ]);
  if (tagRef.status === 0) {
    fail(`Git tag ${tag} already exists. Increase the project version before publishing.`);
  }
  if (!/404|Not Found/i.test(tagRef.stderr + tagRef.stdout)) {
    fail(`Could not verify whether Git tag ${tag} already exists.`);
  }

  const releasesResult = runGh([
    "release",
    "list",
    "--repo",
    repository,
    "--limit",
    "1000",
    "--json",
    "tagName,isPrerelease",
  ]);
  if (releasesResult.status !== 0) {
    fail("Could not read the existing GitHub Releases.");
  }

  let releases;
  try {
    releases = JSON.parse(releasesResult.stdout);
  } catch {
    fail("GitHub CLI returned invalid release information.");
  }

  const stableVersions = releases
    .filter((releaseEntry) => !releaseEntry.isPrerelease)
    .map((releaseEntry) => releaseEntry.tagName.replace(/^v/, ""))
    .filter((releaseVersion) => /^\d+\.\d+\.\d+$/.test(releaseVersion));

  if (
    stableVersions.some(
      (releaseVersion) => compareVersions(version, releaseVersion) <= 0,
    )
  ) {
    fail(
      `Version ${version} is not newer than the existing stable releases. ` +
        "Increase all project version fields before publishing.",
    );
  }

  return defaultBranch;
}

function buildApplication(extraArgs) {
  if (!existsSync(tauriCli)) {
    fail("Tauri CLI is missing. Run `npm install` before building.");
  }

  const result = run(process.execPath, [
    tauriCli,
    "build",
    "--ci",
    ...extraArgs,
  ]);
  if (result.status !== 0) {
    fail(`Tauri build failed${result.status === null ? "." : ` (exit ${result.status}).`}`);
  }
}

function createLatestJson(version, productName) {
  const bundleDir = path.join(
    root,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
  );
  if (!existsSync(bundleDir)) {
    fail("The NSIS bundle directory was not created by the build.");
  }

  const prefix = `${productName}_${version}_`;
  const installers = readdirSync(bundleDir).filter(
    (name) => name.startsWith(prefix) && name.endsWith("-setup.exe"),
  );
  if (installers.length !== 1) {
    fail(`Expected one NSIS setup executable for version ${version}.`);
  }

  const installerName = installers[0];
  const installerPath = path.join(bundleDir, installerName);
  const signaturePath = `${installerPath}.sig`;
  if (
    !existsSync(installerPath) ||
    statSync(installerPath).size === 0 ||
    !existsSync(signaturePath) ||
    statSync(signaturePath).size === 0
  ) {
    fail("The installer or its signed updater signature is missing or empty.");
  }

  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) {
    fail("The updater signature file is empty.");
  }

  const tag = `v${version}`;
  const latest = {
    version,
    notes: `Outils Des Bonobos ${tag}`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(installerName)}`,
      },
    },
  };

  const latestDir = mkdtempSync(path.join(os.tmpdir(), "bonobos-release-"));
  const latestPath = path.join(latestDir, "latest.json");
  try {
    writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    const validated = JSON.parse(readFileSync(latestPath, "utf8"));
    const platform = validated.platforms["windows-x86_64"];
    if (
      validated.version !== version ||
      typeof validated.notes !== "string" ||
      !Number.isFinite(Date.parse(validated.pub_date)) ||
      platform?.signature !== signature ||
      platform.url !== latest.platforms["windows-x86_64"].url
    ) {
      fail("Generated latest.json failed validation.");
    }

    return {
      bundleDir,
      installerPath,
      signaturePath,
      latestDir,
      latestPath,
      tag,
    };
  } catch (error) {
    rmSync(latestPath, { force: true });
    rmdirSync(latestDir);
    throw error;
  }
}

function verifyDraftRelease(tag, requiredAssets) {
  const result = runGh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/releases?per_page=100`,
  ]);
  if (result.status !== 0) {
    fail("Could not list GitHub Releases to verify the draft.");
  }

  let releases;
  try {
    releases = JSON.parse(result.stdout).flat();
  } catch {
    fail("GitHub returned invalid release-list information.");
  }
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length !== 1) {
    fail(`Expected one GitHub Release with tag ${tag}, found ${matches.length}.`);
  }

  const release = matches[0];
  if (!release.draft) {
    fail(`Release ${tag} is not a draft; refusing to publish without validation.`);
  }

  const uploadedAssets = new Set((release.assets ?? []).map((asset) => asset.name));
  if (requiredAssets.some((asset) => !uploadedAssets.has(asset))) {
    fail(`Draft release ${tag} is missing one or more required assets.`);
  }
  return release;
}

async function verifyPublishedEndpoint(version) {
  let lastStatus = "no response";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (response.ok) {
        const latest = await response.json();
        if (latest.version === version) {
          return;
        }
        lastStatus = `latest.json reports version ${latest.version}`;
      } else {
        lastStatus = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  fail(`Release is published, but updater endpoint verification failed: ${lastStatus}`);
}

async function publishRelease(version, artifacts, defaultBranch) {
  const title = `Outils Des Bonobos v${version}`;
  const notes = `Version ${version} publiée automatiquement depuis le build signé.`;
  const create = runGh([
    "release",
    "create",
    artifacts.tag,
    artifacts.installerPath,
    artifacts.signaturePath,
    artifacts.latestPath,
    "--repo",
    repository,
    "--target",
    defaultBranch,
    "--draft",
    "--title",
    title,
    "--notes",
    notes,
  ]);
  if (create.status !== 0) {
    fail(`Could not create draft GitHub Release ${artifacts.tag}.`);
  }

  const assetNames = [
    path.basename(artifacts.installerPath),
    path.basename(artifacts.signaturePath),
    "latest.json",
  ];
  const draftRelease = verifyDraftRelease(artifacts.tag, assetNames);

  const draft = runGh([
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/releases/${draftRelease.id}`,
    "-F",
    "draft=false",
    "-F",
    "make_latest=true",
  ]);
  if (draft.status !== 0) {
    fail(
      `Assets were uploaded to draft release ${artifacts.tag}, but publication failed. ` +
        "Review or publish the draft in GitHub before retrying.",
    );
  }

  const release = runGh([
    "api",
    `repos/${repository}/releases/tags/${artifacts.tag}`,
  ]);
  if (release.status !== 0) {
    fail(`Could not verify published release ${artifacts.tag}.`);
  }

  let published;
  try {
    published = JSON.parse(release.stdout);
  } catch {
    fail("GitHub returned invalid published release information.");
  }
  if (published.draft || published.tag_name !== artifacts.tag) {
    fail(`GitHub did not publish release ${artifacts.tag} as expected.`);
  }

  await verifyPublishedEndpoint(version);
  return published.html_url ?? `https://github.com/${repository}/releases/tag/${artifacts.tag}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const tauriArgs = [...process.argv.slice(2)];
  if (command === "dev") {
    const devConfig = path.join(root, "src-tauri", "tauri.dev.conf.json");
    if (!existsSync(devConfig)) {
      fail("Le fichier de configuration de développement est introuvable.");
    }
    tauriArgs.push("-c", devConfig);
  }
  if (command !== "build") {
    const result = run(process.execPath, [tauriCli, ...tauriArgs]);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    }
    return;
  }

  const dryRun = args.includes("--dry-run");
  const preflightOnly = args.includes("--preflight-only");
  const inspectDraftOnly = args.includes("--inspect-draft-only");
  const verifyArtifactsOnly = args.includes("--verify-artifacts-only");
  const extraArgs = args.filter(
    (arg) =>
      arg !== "--dry-run" &&
      arg !== "--preflight-only" &&
      arg !== "--inspect-draft-only" &&
      arg !== "--verify-artifacts-only",
  );
  const inspectionModes = [
    dryRun,
    preflightOnly,
    inspectDraftOnly,
    verifyArtifactsOnly,
  ].filter(Boolean);
  if (inspectionModes.length > 1) {
    fail("Choose only one inspection mode.");
  }
  if (extraArgs.length > 0) {
    fail(
      "The publishing build does not accept extra Tauri flags. " +
        "Use `--dry-run` to test without publishing.",
    );
  }

  const { version, productName } = readProjectVersion();
  if (!verifyArtifactsOnly) {
    ensureSigningKey();
  }

  if (preflightOnly) {
    ensureGitHubReady(version);
    console.log(
      `Preflight passed for v${version}. Key, GitHub authentication, repository access, and version availability are ready; no build or publication was started.`,
    );
    return;
  }

  if (inspectDraftOnly) {
    const release = verifyDraftRelease(`v${version}`, []);
    console.log(
      `Found draft ${release.tag_name} (id ${release.id}). Assets: ${(release.assets ?? []).map((asset) => asset.name).join(", ") || "none"}.`,
    );
    return;
  }

  if (verifyArtifactsOnly) {
    const artifacts = createLatestJson(version, productName);
    try {
      console.log(
        `Artifact validation passed: ${path.basename(artifacts.latestPath)}, ${path.basename(artifacts.installerPath)}, and ${path.basename(artifacts.signaturePath)}.`,
      );
    } finally {
      rmSync(artifacts.latestPath, { force: true });
      rmdirSync(artifacts.latestDir);
    }
    return;
  }

  ensureGitHubReady(version);
  const apiUrl = process.env.VITE_BONOBOS_API_URL;
  if (!isValidProductionApiUrl(apiUrl)) {
    fail(
      "VITE_BONOBOS_API_URL doit être définie avec une origine HTTPS absolue " +
        "(ex: https://api.example.com) pour le build de production."
    );
  }
  const prodCspFragment = generateProdCspFragment(apiUrl);
  extraArgs.push("-c", prodCspFragment);
  try {
    buildApplication(extraArgs);
  } finally {
    try {
      rmSync(prodCspFragment, { force: true });
      rmdirSync(path.dirname(prodCspFragment), { force: true });
    } catch {
      // Ignorer les erreurs de nettoyage du fragment CSP temporaire
    }
  }
  const artifacts = createLatestJson(version, productName);

  try {
    if (dryRun) {
      console.log(
        `Dry run passed for v${version}. Verified the NSIS installer, signature, and latest.json; nothing was published.`,
      );
      return;
    }

    const releaseUrl = await publishRelease(version, artifacts, defaultBranch);
    console.log(`Published Outils Des Bonobos v${version}: ${releaseUrl}`);
  } finally {
    rmSync(artifacts.latestPath, { force: true });
    rmdirSync(artifacts.latestDir);
  }
}

main().catch((error) => {
  console.error(`[tauri-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
