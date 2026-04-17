function getEnvOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
import {
  loadPersistedTokens,
  type CodexOAuthStatus,
} from "./services/codex-oauth.js";

let llmApiKey: string;
let llmBaseUrl: string;
let llmProvider: string = "openai";
let memberId: string;
let sidecarAdminToken: string;
let llmAuthMode: string = "platform";
let codexOAuthAccessToken: string | null = null;
let codexAccountId: string | null = null;

export function validateEnv(): void {
  llmAuthMode = process.env.LLM_AUTH_MODE ?? "platform";
  llmBaseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com";
  llmProvider = process.env.LLM_PROVIDER ?? "openai";
  memberId = getEnvOrThrow("MEMBER_ID");
  sidecarAdminToken = getEnvOrThrow("SIDECAR_ADMIN_TOKEN");

  if (llmAuthMode === "codex_oauth") {
    llmApiKey = process.env.LLM_API_KEY ?? "";
    const persisted = loadPersistedTokens();
    if (persisted) {
      codexOAuthAccessToken = persisted.accessToken;
    }
  } else {
    llmApiKey = getEnvOrThrow("LLM_API_KEY");
  }
}

export function getLlmApiKey(): string {
  return llmApiKey;
}

export function getLlmBaseUrl(): string {
  return llmBaseUrl;
}

export function getLlmAuthMode(): string {
  return llmAuthMode;
}

export function setLlmAuthMode(mode: string): void {
  llmAuthMode = mode;
  console.log(`[sidecar] Auth mode changed to: ${mode}`);
}

export function getLlmProvider(): string {
  return llmProvider;
}

export function setLlmProvider(provider: string, baseUrl?: string): void {
  llmProvider = provider;
  if (baseUrl) llmBaseUrl = baseUrl;
  console.log(
    `[sidecar] Provider set to: ${provider} (baseUrl=${baseUrl ? "changed" : "unchanged"})`,
  );
}

export function getCodexOAuthToken(): string | null {
  return codexOAuthAccessToken;
}

export function setCodexOAuthAccessToken(token: string | null): void {
  codexOAuthAccessToken = token;
}

export function getCodexAccountId(): string | null {
  return codexAccountId;
}

export function setCodexAccountId(id: string | null): void {
  codexAccountId = id;
}

export function getCodexOAuthStatus(): CodexOAuthStatus {
  return {
    connected: codexOAuthAccessToken !== null,
    authMode: llmAuthMode,
  };
}

/**
 * Atomic swap of LLM credentials (called by /admin/rotate-key).
 * Single-threaded runtime guarantees no request sees a partial update.
 */
export function setLlmCredentials(apiKey: string, baseUrl?: string): void {
  llmApiKey = apiKey;
  if (baseUrl) llmBaseUrl = baseUrl;
  console.log(
    `[sidecar] Credentials rotated (baseUrl=${baseUrl ? "changed" : "unchanged"})`,
  );
}

export function getMemberId(): string {
  return memberId;
}

export function getSidecarAdminToken(): string {
  return sidecarAdminToken;
}
