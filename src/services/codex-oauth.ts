import fs from "node:fs";
import path from "node:path";
import { setCodexOAuthAccessToken, setCodexAccountId, setLlmAuthMode } from "../env.js";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR ?? "/data";

const TOKEN_FILE = path.join(STATE_DIR, "codex-oauth.json");

const AUTH_PROFILES_PATH = path.join(
  STATE_DIR,
  "agents/main/agent/auth-profiles.json",
);

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

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

    if (new Date(data.expiresAt).getTime() < Date.now()) {
      scheduleRefresh(data.refreshToken, 0);
      return null;
    }

    const accountId = extractAccountIdFromJwt(data.accessToken);
    setCodexAccountId(accountId);
    scheduleRefreshFromExpiry(data.refreshToken, data.expiresAt);
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
  const accountId = extractAccountIdFromJwt(accessToken);
  setCodexAccountId(accountId);
  persistTokens({ accessToken, refreshToken, expiresAt });
  scheduleRefreshFromExpiry(refreshToken, expiresAt);
  console.log(`[codex-oauth] Tokens stored, expires at ${expiresAt}, accountId=${accountId ?? "unknown"}`);
}

export function clearTokens(): void {
  setCodexOAuthAccessToken(null);
  setCodexAccountId(null);
  setLlmAuthMode("platform");
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.error("[codex-oauth] Failed to delete token file:", err);
  }
  console.log("[codex-oauth] Tokens cleared");
}

function scheduleRefreshFromExpiry(
  refreshToken: string,
  expiresAt: string,
): void {
  const delay = new Date(expiresAt).getTime() - Date.now() - REFRESH_BUFFER_MS;
  scheduleRefresh(refreshToken, Math.max(delay, 0));
}

function scheduleRefresh(refreshToken: string, delayMs: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => doRefresh(refreshToken), delayMs);
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
    // Primary: OpenAI Codex JWT stores account ID at this claim path
    const auth = payload["https://api.openai.com/auth"];
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
    // Fallback claims
    return payload.account_id ?? payload.sub ?? null;
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
 * OpenClaw's openai-codex provider is built-in; it reads this profile for
 * native OAuth routing + automatic token refresh.
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

  file.profiles["openai-codex:default"] = {
    provider: "openai-codex",
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires,
    ...(accountId ? { accountId } : {}),
  };

  writeJsonFile(AUTH_PROFILES_PATH, file);
  console.log(
    `[codex-oauth] Wrote auth-profiles.json profile openai-codex:default`,
  );
}

/**
 * Remove all openai-codex profiles from auth-profiles.json.
 */
export function clearAuthProfiles(): void {
  if (!fs.existsSync(AUTH_PROFILES_PATH)) return;
  try {
    const file = readAuthProfilesFile();
    for (const key of Object.keys(file.profiles)) {
      if (key.startsWith("openai-codex:")) {
        delete file.profiles[key];
      }
    }
    writeJsonFile(AUTH_PROFILES_PATH, file);
    console.log("[codex-oauth] Cleared openai-codex profiles from auth-profiles.json");
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

/**
 * Default model set when Codex OAuth is activated.
 *
 * Uses the `openai` provider prefix so OpenClaw routes through the sidecar
 * proxy at /v1/chat/completions. The proxy detects codex_oauth auth mode and
 * translates + forwards to the Codex Responses API automatically.
 *
 * Previously this was "openai-codex/gpt-5.1" which used OpenClaw's native
 * openai-codex provider (bypassing the proxy entirely).
 */
export const CODEX_OAUTH_DEFAULT_MODEL = "openai/gpt-5.1";

// ---------------------------------------------------------------------------
// Token refresh (Sidecar-local, kept for backward compat / status reporting)
// ---------------------------------------------------------------------------

async function doRefresh(refreshToken: string): Promise<void> {
  try {
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[codex-oauth] Refresh failed: ${res.status} ${text}`,
      );
      clearTokens();
      return;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    storeTokens(
      data.access_token,
      data.refresh_token ?? refreshToken,
      data.expires_in,
    );
    console.log("[codex-oauth] Token refreshed successfully");
  } catch (err) {
    console.error("[codex-oauth] Refresh error:", err);
    scheduleRefresh(refreshToken, 60_000);
  }
}
