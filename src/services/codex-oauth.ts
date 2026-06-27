import fs from "node:fs";
import path from "node:path";
import { setCodexOAuthAccessToken, setLlmAuthMode } from "../env.js";
import { STATE_DIR } from "../lib/state-dir.js";

const TOKEN_FILE = path.join(STATE_DIR, "codex-oauth.json");

const AUTH_PROFILES_PATH = path.join(
  STATE_DIR,
  "agents/main/agent/auth-profiles.json",
);

// OpenClaw 2026.6.x merged Codex OAuth into the canonical `openai` provider.
// The ChatGPT/Codex OAuth credential lives under the `openai:default` profile
// (legacy installs used `openai-codex:default`, migrated by `openclaw doctor`).
const CODEX_OAUTH_PROFILE_KEY = "openai:default";
const LEGACY_CODEX_PROFILE_PREFIX = "openai-codex:";

export interface CodexOAuthStatus {
  connected: boolean;
  authMode: string;
  expiresAt?: string;
}

interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

let transitionQueue: Promise<void> = Promise.resolve();

export function withCodexOAuthTransition<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const run = transitionQueue.then(operation, operation);
  transitionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function persistTokens(tokens: PersistedTokens): void {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), "utf-8");
  } catch (err) {
    console.error("[codex-oauth] Failed to persist tokens:", err);
  }
}

export function loadPersistedTokens(): PersistedTokens | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
    const data = JSON.parse(raw) as PersistedTokens;
    if (!data.accessToken || !data.refreshToken) return null;
    // D1: return the persisted record even when expired. Token freshness is
    // OpenClaw's responsibility (sole refresher via auth-profiles.json); the
    // sidecar token is a liveness flag only. Returning null would mis-report a
    // healthy instance as disconnected after a restart.
    return data;
  } catch {
    return null;
  }
}

export function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  setCodexOAuthAccessToken(accessToken);
  persistTokens({ accessToken, refreshToken, expiresAt });
  console.log(`[codex-oauth] Tokens stored, expires at ${expiresAt}`);
}

export function clearTokens(): void {
  setCodexOAuthAccessToken(null);
  setLlmAuthMode("platform");
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.error("[codex-oauth] Failed to delete token file:", err);
  }
  console.log("[codex-oauth] Tokens cleared");
}

// ---------------------------------------------------------------------------
// OpenClaw auth-profiles.json management
// ---------------------------------------------------------------------------

function extractAccountIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString(),
    );
    const authClaim = payload["https://api.openai.com/auth"];
    return (
      authClaim?.chatgpt_account_id ??
      payload.account_id ??
      payload.sub ??
      null
    );
  } catch {
    return null;
  }
}

interface AuthProfilesFile {
  profiles: Record<string, Record<string, unknown>>;
}

function readAuthProfilesFile(): AuthProfilesFile {
  try {
    if (fs.existsSync(AUTH_PROFILES_PATH)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, "utf-8"));
      if (raw?.profiles && typeof raw.profiles === "object") return raw;
      return { profiles: {} };
    }
  } catch {}
  return { profiles: {} };
}

/**
 * Write an OpenAI Codex OAuth profile into OpenClaw's auth-profiles.json.
 * OpenClaw 2026.6.x reads the ChatGPT/Codex OAuth credential from the
 * canonical `openai:default` profile (it is paired with an
 * `openai/<model>` + `agentRuntime.id: "codex"` agent config) and refreshes
 * the token automatically.
 *
 * Field names per OpenClaw docs: access, refresh, expires (ms), accountId.
 */
export function writeAuthProfiles(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const expires = Date.now() + expiresIn * 1000;
  const accountId = extractAccountIdFromJwt(accessToken);

  const file = readAuthProfilesFile();

  file.profiles[CODEX_OAUTH_PROFILE_KEY] = {
    provider: "openai",
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires,
    ...(accountId ? { accountId } : {}),
  };

  writeJsonFile(AUTH_PROFILES_PATH, file);
  console.log(
    `[codex-oauth] Wrote auth-profiles.json profile ${CODEX_OAUTH_PROFILE_KEY}`,
  );
}

/**
 * Remove the Codex OAuth profile from auth-profiles.json. Clears the canonical
 * `openai:default` OAuth profile plus any legacy `openai-codex:*` profiles from
 * pre-2026.6.x installs. A BYOK `openai` API-key profile (type "api_key") is
 * left intact — only the OAuth credential is removed.
 */
export function clearAuthProfiles(): void {
  if (!fs.existsSync(AUTH_PROFILES_PATH)) return;
  try {
    const file = readAuthProfilesFile();
    for (const key of Object.keys(file.profiles)) {
      const isLegacyCodex = key.startsWith(LEGACY_CODEX_PROFILE_PREFIX);
      const isCanonicalCodex =
        key === CODEX_OAUTH_PROFILE_KEY &&
        file.profiles[key]?.type === "oauth";
      if (isLegacyCodex || isCanonicalCodex) {
        delete file.profiles[key];
      }
    }
    writeJsonFile(AUTH_PROFILES_PATH, file);
    console.log("[codex-oauth] Cleared Codex OAuth profile from auth-profiles.json");
  } catch {
    try {
      fs.unlinkSync(AUTH_PROFILES_PATH);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// models.json + openclaw.json direct manipulation
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// OpenClaw 2026.6.x retired the `openai-codex/*` namespace (legacy refs fail at
// runtime with "Unknown model"). Codex OAuth now uses a canonical
// `openai/<model>` ref. Keep in sync with @iclawagent/shared
// OPENCLAW_DEFAULTS.codexOAuthDefaultModel.
export const CODEX_OAUTH_DEFAULT_MODEL = "openai/gpt-5.4";

/**
 * Build the OpenClaw `agents.defaults` fragment for Codex OAuth.
 * Mirrors @iclawagent/shared `buildCodexOAuthAgentsDefaults` — the sidecar is an
 * isolated submodule and cannot import the shared package, so this is kept in
 * sync manually. The per-model `agentRuntime.id: "codex"` binding routes the
 * turn through OpenClaw's native Codex app-server harness.
 */
export function buildCodexOAuthAgentsDefaults(
  model: string = CODEX_OAUTH_DEFAULT_MODEL,
): { model: string; models: Record<string, { agentRuntime: { id: string } }> } {
  return {
    model,
    models: { [model]: { agentRuntime: { id: "codex" } } },
  };
}

