function getEnvOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
import {
  loadPersistedTokens,
  type CodexOAuthStatus,
} from "./services/codex-oauth.js";

// ---------------------------------------------------------------------------
// LLM Keyring — per-provider credential store
// ---------------------------------------------------------------------------

type Cred = {
  apiKey: string;
  baseUrl: string;
  /**
   * Sidecar-local copy of provider auth/header mode. No @iclawagent/shared import.
   * - "openai": Authorization: Bearer <key>
   * - "anthropic": x-api-key + anthropic-version
   * - "google-generative-ai": x-goog-api-key
   * Does NOT imply sidecar translation.
   */
  apiStyle: "openai" | "anthropic" | "google-generative-ai";
  /**
   * Provider-specific headers to stamp on outbound requests.
   * e.g. { "HTTP-Referer": "https://…", "X-Title": "iClawAgent" } for OpenRouter.
   * No @iclawagent/shared import — sidecar-local parallel type.
   */
  requiredAuth?: Record<string, string>;
};

const keyring = new Map<string, Cred>();
let activeProvider: string = "openai";

let memberId: string;
let sidecarAdminToken: string;
let llmAuthMode: string = "platform";
let codexOAuthAccessToken: string | null = null;

export function validateEnv(): void {
  llmAuthMode = process.env.LLM_AUTH_MODE ?? "platform";
  const bootBaseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com";
  activeProvider = process.env.LLM_PROVIDER ?? "openai";
  memberId = getEnvOrThrow("MEMBER_ID");
  sidecarAdminToken = getEnvOrThrow("SIDECAR_ADMIN_TOKEN");

  let bootApiKey: string;
  if (llmAuthMode === "codex_oauth") {
    bootApiKey = process.env.LLM_API_KEY ?? "";
    const persisted = loadPersistedTokens();
    if (persisted) {
      codexOAuthAccessToken = persisted.accessToken;
    }
  } else {
    bootApiKey = getEnvOrThrow("LLM_API_KEY");
  }

  // NON-FATAL gog-only: warn if TOKEN_CALLBACK_BASE_URL is absent. This var is needed only
  // for the GOG OAuth token-exchange relay. Do NOT use getEnvOrThrow here — a missing var
  // must never abort the sidecar boot, as that would break the Telegram webhook relay and
  // LLM proxy for ALL non-gog instances (INC-2026-03-23 / INC-2026-04-11 class).
  // Placement is SAFETY-CRITICAL: placed AFTER the getEnvOrThrow credential sequence above.
  if (!process.env.TOKEN_CALLBACK_BASE_URL) {
    console.warn("[sidecar] TOKEN_CALLBACK_BASE_URL is not set — GOG OAuth token exchange will fail if GOG setup is attempted");
  }

  // Seed the active provider into the keyring from boot env.
  const bootApiStyle: "openai" | "anthropic" | "google-generative-ai" =
    activeProvider === "anthropic" ? "anthropic"
    : activeProvider === "google" ? "google-generative-ai"
    : "openai";
  keyring.set(activeProvider, {
    apiKey: bootApiKey,
    baseUrl: bootBaseUrl,
    apiStyle: bootApiStyle,
  });
}

// ---------------------------------------------------------------------------
// Keyring accessors
// ---------------------------------------------------------------------------

export function getLlmApiKey(): string {
  return keyring.get(activeProvider)?.apiKey ?? "";
}

export function getLlmBaseUrl(): string {
  return keyring.get(activeProvider)?.baseUrl ?? "https://api.openai.com";
}

export function getLlmApiStyle(): "openai" | "anthropic" | "google-generative-ai" {
  return keyring.get(activeProvider)?.apiStyle ?? "openai";
}

/**
 * Returns the requiredAuth headers for the active provider (e.g. HTTP-Referer for OpenRouter).
 * Returns undefined if no requiredAuth is configured.
 */
export function getRequiredAuthHeaders(): Record<string, string> | undefined {
  return keyring.get(activeProvider)?.requiredAuth;
}

export function getLlmAuthMode(): string {
  return llmAuthMode;
}

export function setLlmAuthMode(mode: string): void {
  llmAuthMode = mode;
  console.log(`[sidecar] Auth mode changed to: ${mode}`);
}

export function getLlmProvider(): string {
  return activeProvider;
}

export function setLlmProvider(
  provider: string,
  upstreamUrl?: string,
  apiStyle?: "openai" | "anthropic" | "google-generative-ai",
): void {
  const existing = keyring.get(provider);
  if (existing) {
    // Update the cached entry if new values provided
    if (upstreamUrl) existing.baseUrl = upstreamUrl;
    if (apiStyle) existing.apiStyle = apiStyle;
  } else if (upstreamUrl) {
    // Create a placeholder entry — apiKey will be filled by rotate-key or llm-keyring
    keyring.set(provider, {
      apiKey: "",
      baseUrl: upstreamUrl,
      apiStyle: apiStyle ?? "openai",
    });
  }
  activeProvider = provider;
  console.log(`[sidecar] Provider set to: ${provider}`);
}

export function setCodexOAuthAccessToken(token: string | null): void {
  codexOAuthAccessToken = token;
}

export function getCodexOAuthStatus(): CodexOAuthStatus {
  return {
    connected:
      codexOAuthAccessToken !== null && llmAuthMode === "codex_oauth",
    authMode: llmAuthMode,
  };
}

/**
 * Atomic upsert of a credential into the keyring.
 * If `provider` is omitted, updates the active provider's entry (backward compat).
 * Does NOT flip activeProvider — call setLlmProvider() separately to switch.
 */
export function setLlmCredentials(
  apiKeyOrProvider: string,
  baseUrlOrApiKey?: string,
  apiStyleOrBaseUrl?: string,
  apiStyle?: "openai" | "anthropic" | "google-generative-ai",
  requiredAuth?: Record<string, string>,
): void {
  // Overload 1 (new): setLlmCredentials(provider, apiKey, baseUrl?, apiStyle?, requiredAuth?)
  // Overload 2 (legacy): setLlmCredentials(apiKey, baseUrl?)
  // Distinguish by checking if the first arg is a known provider-like string.
  // Since this is a sidecar-local file, we keep the provider list local.
  const KNOWN_PROVIDERS = new Set(["openai", "anthropic", "openrouter", "google", "deepseek"]);

  let provider: string;
  let apiKey: string;
  let baseUrl: string | undefined;
  let style: "openai" | "anthropic" | "google-generative-ai";

  if (KNOWN_PROVIDERS.has(apiKeyOrProvider) && baseUrlOrApiKey !== undefined) {
    // New multi-arg form: (provider, apiKey, baseUrl?, apiStyle?, requiredAuth?)
    provider = apiKeyOrProvider;
    apiKey = baseUrlOrApiKey;
    baseUrl = apiStyleOrBaseUrl;
    style = (apiStyle ?? (provider === "anthropic" ? "anthropic" : provider === "google" ? "google-generative-ai" : "openai"));
  } else {
    // Legacy form: (apiKey, baseUrl?)
    provider = activeProvider;
    apiKey = apiKeyOrProvider;
    baseUrl = baseUrlOrApiKey;
    const existingStyle = keyring.get(provider)?.apiStyle;
    style = apiStyleOrBaseUrl === "anthropic"
      ? "anthropic"
      : apiStyleOrBaseUrl === "google-generative-ai"
      ? "google-generative-ai"
      : (existingStyle ?? "openai");
  }

  const existing = keyring.get(provider);
  // Preserve existing requiredAuth if the caller does not supply a new one.
  // This prevents /admin/rotate-key from silently erasing attribution headers
  // that were set by the initial /admin/llm-keyring seed.
  const resolvedRequiredAuth = requiredAuth ?? existing?.requiredAuth;
  keyring.set(provider, {
    apiKey,
    baseUrl: baseUrl ?? existing?.baseUrl ?? "https://api.openai.com",
    apiStyle: style,
    ...(resolvedRequiredAuth !== undefined ? { requiredAuth: resolvedRequiredAuth } : {}),
  });
  console.log(`[sidecar] Credentials set for provider: ${provider}`);
}

/**
 * Bulk-seed the keyring from a list of entries. Optionally flips activeProvider.
 */
export function seedKeyring(
  entries: Array<{
    provider: string;
    apiKey: string;
    baseUrl?: string;
    apiStyle?: "openai" | "anthropic" | "google-generative-ai";
    requiredAuth?: Record<string, string>;
  }>,
  newActiveProvider?: string,
): void {
  for (const entry of entries) {
    const defaultStyle: "openai" | "anthropic" | "google-generative-ai" =
      entry.provider === "anthropic" ? "anthropic"
      : entry.provider === "google" ? "google-generative-ai"
      : "openai";
    const style: "openai" | "anthropic" | "google-generative-ai" = entry.apiStyle ?? defaultStyle;
    const defaultBaseUrl =
      entry.provider === "anthropic" ? "https://api.anthropic.com"
      : entry.provider === "google" ? "https://generativelanguage.googleapis.com/v1beta"
      : "https://api.openai.com";
    keyring.set(entry.provider, {
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl ?? defaultBaseUrl,
      apiStyle: style,
      requiredAuth: entry.requiredAuth,
    });
  }
  if (newActiveProvider) {
    activeProvider = newActiveProvider;
  }
  console.log(`[sidecar] Keyring seeded with ${entries.length} entries; active=${newActiveProvider ?? activeProvider}`);
}

export function hasKeyringEntry(provider: string): boolean {
  const cred = keyring.get(provider);
  return Boolean(cred && cred.apiKey);
}

/**
 * Returns the number of entries currently in the keyring (no key material exposed).
 */
export function getKeyringSize(): number {
  return keyring.size;
}

/**
 * Returns true if the active provider has a non-empty apiKey in the keyring.
 */
export function isActiveProviderKeyed(): boolean {
  const cred = keyring.get(activeProvider);
  return Boolean(cred && cred.apiKey);
}

export function getMemberId(): string {
  return memberId;
}

export function getSidecarAdminToken(): string {
  return sidecarAdminToken;
}
