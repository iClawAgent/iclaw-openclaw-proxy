import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { installSkillFromClawHub, updateSkill } from "./gateway-rpc.js";
import { STATE_DIR as _MODULE_STATE_DIR } from "../lib/state-dir.js";

// Local types — sidecar is a git submodule and MUST NOT import from @iclawagent/shared.
// Keep in sync with packages/shared/src/types.ts Gog* types manually.

export type GogAuthMode = "oauth" | "service_account" | "temporary_access_token";
export type GogService = "gmail" | "calendar" | "drive" | "contacts" | "docs" | "sheets";

const DEFAULT_SERVICES: GogService[] = ["gmail", "calendar", "drive", "contacts", "docs", "sheets"];

export interface GogSetupRequest {
  accountEmail: string;
  authMode: GogAuthMode;
  services: GogService[];
  oauthClientJson?: unknown;
  serviceAccountJson?: unknown;
  temporaryAccessToken?: string;
}

export interface GogSidecarEvent {
  action: string;
  status: "success" | "failed";
  message?: string;
  errorCode?: string;
}

export interface GogSetupResponse {
  ok: boolean;
  status: "pending_oauth" | "connected" | "failed" | "needs_image_upgrade";
  accountEmail?: string;
  authMode: GogAuthMode;
  message?: string;
  authorizationUrl?: string;
  expiresAt?: string;
  events: GogSidecarEvent[];
}

export interface GogStatusResponse {
  installed: boolean;
  connected: boolean;
  accountEmail?: string;
  authMode?: GogAuthMode;
  temporary?: boolean;
  lastVerifiedAt?: string;
  missing?: {
    bins?: string[];
    credentials?: string[];
  };
}

export interface GogOauthStartRequest {
  accountEmail: string;
}

export interface GogOauthStartResponse {
  ok: boolean;
  authorizationUrl: string;
  expiresAt: string;
  events: GogSidecarEvent[];
}

export interface GogOauthCompleteRequest {
  accountEmail: string;
  redirectUrl: string;
}

export interface GogOauthCompleteResponse {
  ok: boolean;
  status: "connected" | "failed";
  message?: string;
  events: GogSidecarEvent[];
}

export interface GogDisconnectRequest {
  accountEmail: string;
}

export interface GogDisconnectResponse {
  ok: boolean;
  status: "disconnected";
  events: GogSidecarEvent[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const GOG_VERSION = "0.14.0";
export const GOG_CLAWHUB_SLUG = "gog";

/** SHA256 hashes per architecture for gogcli_0.14.0_linux_{arch}.tar.gz */
export const GOG_SHA256: Record<string, string> = {
  linux_amd64: "b2adaa503627aa56d9186cf1047a790aa15f8dd18522480dd4ff14060c9dd21b",
  linux_arm64: "28eab80326328d4bcbead32ae16b4e66ed9661376d251d60e38b85989b7ca07b",
};

/** Artifact URL pattern for gogcli releases */
export function gogArtifactUrl(arch: string): string {
  return `https://github.com/steipete/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_${arch}.tar.gz`;
}

const OAUTH_REMOTE_TTL_MS = parseInt(
  process.env.GOG_OAUTH_REMOTE_TTL_SECONDS ?? "600",
  10,
) * 1000;

const MUTEX_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

// ─── Pending OAuth State (in-memory, per account) ─────────────────────────────

interface PendingOauth {
  authorizationUrl: string;
  expiresAt: Date;
  services: GogService[];
}

const pendingOauthState = new Map<string, PendingOauth>();

// ─── Per-account mutex ────────────────────────────────────────────────────────

const mutexes = new Map<string, Promise<void>>();

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing lock
  const existing = mutexes.get(key);
  if (existing) {
    // Signal that the key is locked — caller should receive 409
    throw new Error("gog_setup_in_progress");
  }

  let resolve!: () => void;
  const lock = new Promise<void>((r) => { resolve = r; });
  mutexes.set(key, lock);

  const timeout = setTimeout(() => {
    mutexes.delete(key);
    resolve();
  }, MUTEX_TIMEOUT_MS);

  try {
    return await fn();
  } finally {
    clearTimeout(timeout);
    mutexes.delete(key);
    resolve();
  }
}

// ─── Path Getters ─────────────────────────────────────────────────────────────

function getStateDir(): string {
  const val = process.env.OPENCLAW_STATE_DIR;
  if (!val) throw new Error("OPENCLAW_STATE_DIR is not set");
  if (!val.startsWith("/")) throw new Error(`OPENCLAW_STATE_DIR must be an absolute path, got: "${val}"`);
  return val;
}

/**
 * Validates and returns OPENCLAW_STATE_DIR, also checking it is writable.
 * Call this at the start of any setup action that writes to persistent state.
 */
async function ensureStateDir(): Promise<string> {
  const stateDir = getStateDir(); // throws if unset or non-absolute
  await fs.access(stateDir, fs.constants.W_OK).catch(() => {
    throw new Error(`OPENCLAW_STATE_DIR is not writable: "${stateDir}"`);
  });
  return stateDir;
}

/** Real gogcli binary extracted from tarball */
export function getGogRealBinPath(): string {
  return path.join(getStateDir(), ".iclaw/gog/bin/gog-real");
}

/** Wrapper script exposed to OpenClaw skill execution */
export function getGogWrapperPath(): string {
  return path.join(getStateDir(), ".iclaw/bin/gog");
}

/** XDG_CONFIG_HOME override for gog — keeps config under persistent state */
export function getGogConfigHome(): string {
  return path.join(getStateDir(), ".iclaw/gog/config");
}

/** Keyring password file path */
export function getGogKeyringPasswordPath(): string {
  return path.join(getStateDir(), ".iclaw/gog/secrets/keyring.password");
}

/** Per-account credential directory */
export function getGogCredentialDir(accountEmail: string): string {
  return path.join(getStateDir(), `.iclaw/gog/credentials/${accountEmail}`);
}

/** Per-account profile directory */
export function getGogProfileDir(accountEmail: string): string {
  return path.join(getStateDir(), `.iclaw/gog/profiles/${accountEmail}`);
}

/** Per-account service-account key path */
export function getGogServiceAccountPath(accountEmail: string): string {
  return path.join(getStateDir(), `.iclaw/gog/service-accounts/${accountEmail}.json`);
}

/** Per-account temp token path */
export function getGogTempPath(accountEmail: string): string {
  return path.join(getStateDir(), `.iclaw/gog/temp/${accountEmail}.token`);
}

// ─── Env Builder ──────────────────────────────────────────────────────────────

/**
 * Build the env object for sidecar-direct gog command executions.
 * Reads the keyring password from file at call time.
 * All values are concrete absolute strings — no shell variable syntax.
 */
export async function getGogEnv(): Promise<Record<string, string>> {
  const passwordPath = getGogKeyringPasswordPath();
  let keyringPassword = "";
  try {
    keyringPassword = (await fs.readFile(passwordPath, "utf-8")).trim();
  } catch {
    // password file missing — will fail during auth operations
  }
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: keyringPassword,
    XDG_CONFIG_HOME: getGogConfigHome(),
    // Prepend gog bin dir so gog-real can resolve helpers if any
    PATH: `${path.dirname(getGogRealBinPath())}:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
  };
}

// ─── Architecture Detection ───────────────────────────────────────────────────

export function detectLinuxArch(): string {
  const machine = os.machine ? os.machine() : os.arch();
  if (machine === "aarch64" || machine === "arm64") return "linux_arm64";
  return "linux_amd64";
}

// ─── SHA256 Verification ──────────────────────────────────────────────────────

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

// ─── Download Helper ──────────────────────────────────────────────────────────

function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = require("node:fs").createWriteStream(dest);
    const doGet = (u: string) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (location) { doGet(location); return; }
          reject(new Error("redirect_missing_location"));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download_failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (err: Error) => { fs.unlink(dest).catch(() => {}); reject(err); });
      }).on("error", (err) => { fs.unlink(dest).catch(() => {}); reject(err); });
    };
    doGet(url);
  });
}

// ─── Binary Install ───────────────────────────────────────────────────────────

/**
 * Install gogcli v{GOG_VERSION} binary idempotently.
 * Returns events describing what happened.
 */
export async function installGogBinary(): Promise<GogSidecarEvent[]> {
  const events: GogSidecarEvent[] = [];
  const realBinPath = getGogRealBinPath();
  const wrapperPath = getGogWrapperPath();

  // Check if correct version already installed
  try {
    const gogEnv = await getGogEnv();
    const { stdout } = await execFileAsync(realBinPath, ["--version"], {
      timeout: 5_000,
      env: gogEnv,
    });
    if (stdout.trim().includes(GOG_VERSION)) {
      events.push({ action: "gog_binary_install_skipped", status: "success", message: `gog v${GOG_VERSION} already installed` });
      return events;
    }
  } catch {
    // not installed or wrong version — continue
  }

  // Detect arch
  const arch = detectLinuxArch();
  const expectedHash = GOG_SHA256[arch];
  if (!expectedHash) {
    events.push({ action: "gog_binary_install_failed", status: "failed", errorCode: "unsupported_arch", message: `Unsupported architecture: ${arch}` });
    throw new Error("needs_image_upgrade");
  }

  const url = gogArtifactUrl(arch);
  const tmpTar = path.join(os.tmpdir(), `gogcli_${GOG_VERSION}_${arch}_${Date.now()}.tar.gz`);
  const tmpExtractDir = path.join(os.tmpdir(), `gogcli_extract_${Date.now()}`);

  try {
    // Download
    await downloadToFile(url, tmpTar);

    // Verify SHA256
    const actualHash = await sha256File(tmpTar);
    if (actualHash !== expectedHash) {
      await fs.unlink(tmpTar).catch(() => {});
      events.push({ action: "gog_binary_install_failed", status: "failed", errorCode: "checksum_mismatch" });
      throw new Error("gog_binary_install_failed");
    }

    // Extract
    await fs.mkdir(tmpExtractDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tmpTar, "-C", tmpExtractDir], { timeout: 30_000 });

    const extractedBin = path.join(tmpExtractDir, "gog");
    await fs.access(extractedBin);

    // Install real binary
    const realBinDir = path.dirname(realBinPath);
    await fs.mkdir(realBinDir, { recursive: true, mode: 0o700 });
    await fs.copyFile(extractedBin, realBinPath);
    await fs.chmod(realBinPath, 0o755);

    // Generate keyring password on first install
    await ensureKeyringPassword();

    // Write wrapper script
    await writeGogWrapper();

    events.push({ action: "gog_binary_installed", status: "success", message: `gog v${GOG_VERSION} installed for ${arch}` });
    return events;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (message === "gog_binary_install_failed" || message === "needs_image_upgrade") throw err;
    events.push({ action: "gog_binary_install_failed", status: "failed", errorCode: message });
    throw new Error("gog_binary_install_failed");
  } finally {
    await fs.unlink(tmpTar).catch(() => {});
    await fs.rm(tmpExtractDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Keyring Password ─────────────────────────────────────────────────────────

async function ensureKeyringPassword(): Promise<void> {
  const passwordPath = getGogKeyringPasswordPath();
  try {
    await fs.access(passwordPath);
    return; // already exists
  } catch {
    // generate new password
  }
  const secretsDir = path.dirname(passwordPath);
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  const tmpPath = `${passwordPath}.tmp`;
  await fs.writeFile(tmpPath, password, { mode: 0o600 });
  await fs.rename(tmpPath, passwordPath);
  await fs.chmod(passwordPath, 0o600);
}

// ─── Wrapper Script ───────────────────────────────────────────────────────────

async function writeGogWrapper(): Promise<void> {
  const stateDir = getStateDir();
  const wrapperPath = getGogWrapperPath();
  const realBinPath = getGogRealBinPath();
  const keyringPasswordPath = getGogKeyringPasswordPath();
  const configHome = getGogConfigHome();

  const wrapperDir = path.dirname(wrapperPath);
  await fs.mkdir(wrapperDir, { recursive: true, mode: 0o755 });

  // Use literal paths (no shell variables) in wrapper for maximum reliability.
  // The wrapper reads the keyring password from the sidecar-owned file at exec time.
  const wrapperContent = `#!/bin/sh
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD="$(cat ${keyringPasswordPath})"
export XDG_CONFIG_HOME=${configHome}
exec ${realBinPath} "$@"
`;
  const tmpPath = `${wrapperPath}.tmp`;
  await fs.writeFile(tmpPath, wrapperContent, { mode: 0o755 });
  await fs.rename(tmpPath, wrapperPath);
  await fs.chmod(wrapperPath, 0o755);
}

// ─── Credential File Writing ──────────────────────────────────────────────────

async function writeOauthClientJson(accountEmail: string, clientJson: unknown): Promise<string> {
  const credDir = getGogCredentialDir(accountEmail);
  await fs.mkdir(credDir, { recursive: true, mode: 0o700 });
  const clientPath = path.join(credDir, "client.json");
  const tmpPath = `${clientPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(clientJson), { mode: 0o600 });
  await fs.rename(tmpPath, clientPath);
  await fs.chmod(clientPath, 0o600);
  return clientPath;
}

async function writeTempToken(accountEmail: string, token: string): Promise<void> {
  const tempDir = path.join(getStateDir(), ".iclaw/gog/temp");
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const tokenPath = getGogTempPath(accountEmail);
  const tmpPath = `${tokenPath}.tmp`;
  await fs.writeFile(tmpPath, token, { mode: 0o600 });
  await fs.rename(tmpPath, tokenPath);
  await fs.chmod(tokenPath, 0o600);
}

// ─── OAuth Client JSON Validation ────────────────────────────────────────────

export function validateOauthClientJson(clientJson: unknown): void {
  if (!clientJson || typeof clientJson !== "object") {
    throw new Error("oauth_client_json_invalid");
  }
  const obj = clientJson as Record<string, unknown>;

  if ("web" in obj) {
    throw new Error("unsupported_oauth_client_type");
  }
  if ("type" in obj && (obj as any).type === "service_account") {
    throw new Error("unsupported_oauth_client_type");
  }

  const installed = obj.installed as Record<string, unknown> | undefined;
  if (!installed || typeof installed !== "object") {
    throw new Error("oauth_client_json_invalid");
  }
  const required = ["client_id", "client_secret", "auth_uri", "token_uri"];
  for (const key of required) {
    if (!installed[key] || typeof installed[key] !== "string") {
      throw new Error("oauth_client_json_invalid");
    }
  }
  if (!Array.isArray(installed.redirect_uris) || (installed.redirect_uris as unknown[]).length === 0) {
    throw new Error("oauth_client_json_invalid");
  }
}

// ─── updateSkill Env Builder ──────────────────────────────────────────────────

function buildUpdateSkillEnv(accountEmail: string): Record<string, string> {
  const stateDir = getStateDir();
  const gogBinDir = path.join(stateDir, ".iclaw/bin");
  const gogConfigHome = path.join(stateDir, ".iclaw/gog/config");
  const basePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

  return {
    PATH: `${gogBinDir}:${basePath}`,
    XDG_CONFIG_HOME: gogConfigHome,
    GOG_ACCOUNT: accountEmail,
    GOG_CLIENT: accountEmail,
    GOG_JSON: "true",
    GOG_COLOR: "never",
    GOG_TIMEZONE: "UTC",
    GOG_GMAIL_NO_SEND: "true",
    GOG_DISABLE_COMMANDS: "",
  };
}

// ─── Services Array to CLI Flags ─────────────────────────────────────────────

function servicesToCliArg(services: GogService[]): string {
  return services.join(",");
}

// ─── Auth URL Parsing ─────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"']+/;

export function parseAuthorizationUrl(output: string): string | null {
  const match = output.match(GOOGLE_AUTH_URL_RE);
  return match ? match[0] : null;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

export async function setupGog(req: GogSetupRequest): Promise<GogSetupResponse> {
  return withMutex(`gog:${req.accountEmail}`, async () => {
    const events: GogSidecarEvent[] = [];
    events.push({ action: "gog_setup_started", status: "success" });

    await ensureStateDir();

    // Step 1: Install skill content
    await installSkillFromClawHub(GOG_CLAWHUB_SLUG);

    // Step 2: Install binary
    const binaryEvents = await installGogBinary();
    events.push(...binaryEvents);

    // Step 3: Write credential files
    if (req.authMode === "oauth") {
      validateOauthClientJson(req.oauthClientJson);
      await writeOauthClientJson(req.accountEmail, req.oauthClientJson);
    } else if (req.authMode === "temporary_access_token") {
      if (!req.temporaryAccessToken) throw new Error("temporaryAccessToken is required");
      await writeTempToken(req.accountEmail, req.temporaryAccessToken);
    }

    // Step 4: For OAuth mode — run step 1 and return pending_oauth
    if (req.authMode === "oauth") {
      const clientPath = path.join(getGogCredentialDir(req.accountEmail), "client.json");
      const gogEnv = await getGogEnv();
      const realBin = getGogRealBinPath();

      // gog auth credentials <path>
      await execFileAsync(realBin, ["auth", "credentials", clientPath], {
        env: gogEnv,
        timeout: 15_000,
      });

      const serviceArg = servicesToCliArg(req.services);
      // gog auth add <account> --services ... --gmail-scope readonly --drive-scope readonly --gmail-no-send --remote --step 1
      const { stdout } = await execFileAsync(realBin, [
        "auth", "add", req.accountEmail,
        "--services", serviceArg,
        "--gmail-scope", "readonly",
        "--drive-scope", "readonly",
        "--gmail-no-send",
        "--remote",
        "--step", "1",
      ], {
        env: gogEnv,
        timeout: 30_000,
      });

      const authorizationUrl = parseAuthorizationUrl(stdout);
      if (!authorizationUrl) {
        events.push({ action: "gog_binary_install_failed", status: "failed", errorCode: "oauth_url_parse_failed" });
        throw new Error("gog_binary_install_failed");
      }

      const expiresAt = new Date(Date.now() + OAUTH_REMOTE_TTL_MS).toISOString();
      pendingOauthState.set(req.accountEmail, {
        authorizationUrl,
        expiresAt: new Date(expiresAt),
        services: req.services,
      });

      events.push({ action: "gog_oauth_started", status: "success" });

      return {
        ok: true,
        status: "pending_oauth",
        accountEmail: req.accountEmail,
        authMode: req.authMode,
        authorizationUrl,
        expiresAt,
        events,
      };
    }

    // Step 5: Call updateSkill with non-secret env
    await updateSkill({
      skillKey: GOG_CLAWHUB_SLUG,
      enabled: true,
      env: buildUpdateSkillEnv(req.accountEmail),
    });
    events.push({ action: "gog_skill_enabled", status: "success" });

    // Step 6: For non-OAuth modes, verify auth
    const gogEnv = await getGogEnv();
    const realBin = getGogRealBinPath();
    try {
      await execFileAsync(realBin, ["auth", "list", "--check", "--no-input"], {
        env: gogEnv,
        timeout: 15_000,
      });
    } catch {
      events.push({ action: "gog_auth_check_failed", status: "failed" });
      return {
        ok: false,
        status: "failed",
        accountEmail: req.accountEmail,
        authMode: req.authMode,
        message: "gog_auth_check_failed",
        events,
      };
    }

    return {
      ok: true,
      status: "connected",
      accountEmail: req.accountEmail,
      authMode: req.authMode,
      events,
    };
  });
}

// ─── OAuth Start (re-trigger) ─────────────────────────────────────────────────

export async function gogOauthStart(accountEmail: string): Promise<GogOauthStartResponse> {
  return withMutex(`gog:${accountEmail}`, async () => {
    const events: GogSidecarEvent[] = [];

    // Idempotent: return existing URL if still valid
    const existing = pendingOauthState.get(accountEmail);
    if (existing && existing.expiresAt > new Date()) {
      events.push({ action: "gog_oauth_started", status: "success", message: "reused_existing_pending" });
      return {
        ok: true,
        authorizationUrl: existing.authorizationUrl,
        expiresAt: existing.expiresAt.toISOString(),
        events,
      };
    }

    const services = existing?.services ?? DEFAULT_SERVICES;
    const serviceArg = servicesToCliArg(services);
    const gogEnv = await getGogEnv();
    const realBin = getGogRealBinPath();
    const { stdout } = await execFileAsync(realBin, [
      "auth", "add", accountEmail,
      "--services", serviceArg,
      "--gmail-scope", "readonly",
      "--drive-scope", "readonly",
      "--gmail-no-send",
      "--remote",
      "--step", "1",
    ], {
      env: gogEnv,
      timeout: 30_000,
    });

    const authorizationUrl = parseAuthorizationUrl(stdout);
    if (!authorizationUrl) throw new Error("gog_binary_install_failed");

    const expiresAt = new Date(Date.now() + OAUTH_REMOTE_TTL_MS).toISOString();
    pendingOauthState.set(accountEmail, {
      authorizationUrl,
      expiresAt: new Date(expiresAt),
      services,
    });

    events.push({ action: "gog_oauth_started", status: "success" });
    return { ok: true, authorizationUrl, expiresAt, events };
  });
}

// ─── OAuth Complete ───────────────────────────────────────────────────────────

export async function gogOauthComplete(req: GogOauthCompleteRequest): Promise<GogOauthCompleteResponse> {
  return withMutex(`gog:${req.accountEmail}`, async () => {
    const events: GogSidecarEvent[] = [];
    const pending = pendingOauthState.get(req.accountEmail);

    if (!pending) {
      events.push({ action: "gog_oauth_expired", status: "failed", errorCode: "oauth_state_expired" });
      return { ok: false, status: "failed", message: "oauth_state_expired", events };
    }

    if (pending.expiresAt < new Date()) {
      pendingOauthState.delete(req.accountEmail);
      events.push({ action: "gog_oauth_expired", status: "failed", errorCode: "oauth_state_expired" });
      return { ok: false, status: "failed", message: "oauth_state_expired", events };
    }

    if (!req.redirectUrl || !req.redirectUrl.includes("state")) {
      events.push({ action: "gog_oauth_expired", status: "failed", errorCode: "oauth_invalid_redirect" });
      return { ok: false, status: "failed", message: "oauth_invalid_redirect", events };
    }

    const gogEnv = await getGogEnv();
    const realBin = getGogRealBinPath();
    const serviceArg = servicesToCliArg(pending.services);

    try {
      await execFileAsync(realBin, [
        "auth", "add", req.accountEmail,
        "--services", serviceArg,
        "--remote",
        "--step", "2",
        "--auth-url", req.redirectUrl,
      ], {
        env: gogEnv,
        timeout: 30_000,
      });
    } catch {
      events.push({ action: "gog_auth_check_failed", status: "failed" });
      return { ok: false, status: "failed", message: "gog_auth_check_failed", events };
    }

    // Verify auth
    try {
      await execFileAsync(realBin, ["auth", "list", "--check", "--no-input"], {
        env: gogEnv,
        timeout: 15_000,
      });
    } catch {
      events.push({ action: "gog_auth_check_failed", status: "failed" });
      return { ok: false, status: "failed", message: "gog_auth_check_failed", events };
    }

    pendingOauthState.delete(req.accountEmail);

    // Enable skill
    await updateSkill({
      skillKey: GOG_CLAWHUB_SLUG,
      enabled: true,
      env: buildUpdateSkillEnv(req.accountEmail),
    });
    events.push({ action: "gog_skill_enabled", status: "success" });
    events.push({ action: "gog_oauth_completed", status: "success" });

    return { ok: true, status: "connected", events };
  });
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function gogStatus(): Promise<GogStatusResponse> {
  const realBin = getGogRealBinPath();
  let installed = false;
  const missing: { bins?: string[]; credentials?: string[] } = {};

  try {
    const gogEnv = await getGogEnv();
    await execFileAsync(realBin, ["--version"], { env: gogEnv, timeout: 5_000 });
    installed = true;
  } catch {
    missing.bins = ["gog"];
  }

  if (!installed) {
    return { installed: false, connected: false, missing };
  }

  const gogEnv = await getGogEnv();
  try {
    await execFileAsync(realBin, ["auth", "list", "--check", "--no-input"], {
      env: gogEnv,
      timeout: 15_000,
    });
    return { installed: true, connected: true };
  } catch {
    return { installed: true, connected: false };
  }
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export async function gogDisconnect(accountEmail: string): Promise<GogDisconnectResponse> {
  return withMutex(`gog:${accountEmail}`, async () => {
    const events: GogSidecarEvent[] = [];

    // Remove per-account credential tree (idempotent — ignore ENOENT)
    const credDir = getGogCredentialDir(accountEmail);
    const profileDir = getGogProfileDir(accountEmail);
    const serviceAccountPath = getGogServiceAccountPath(accountEmail);
    const tempPath = getGogTempPath(accountEmail);
    const envPath = path.join(getStateDir(), `.iclaw/gog/env/${accountEmail}.env`);

    await fs.rm(credDir, { recursive: true, force: true });
    await fs.rm(profileDir, { recursive: true, force: true });
    await fs.rm(serviceAccountPath, { force: true }).catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(envPath, { force: true }).catch(() => {});

    // Remove pending OAuth state if any
    pendingOauthState.delete(accountEmail);

    // Disable skill via Gateway (Phase 1: single account, so always disable)
    try {
      await updateSkill({
        skillKey: GOG_CLAWHUB_SLUG,
        enabled: false,
        env: {},
      });
      events.push({ action: "gog_skill_disabled", status: "success" });
    } catch {
      // best-effort — disconnect still succeeds
    }

    events.push({ action: "gog_disconnected", status: "success" });
    return { ok: true, status: "disconnected", events };
  });
}
