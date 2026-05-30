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
  /** Sidecar-local copy of provider auth style. No @iclawagent/shared import. */
  apiStyle: "openai" | "anthropic";
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

  // Seed the active provider into the keyring from boot env.
  // apiStyle defaults to "anthropic" for "anthropic", "openai" for everything else.
  const bootApiStyle: "openai" | "anthropic" =
    activeProvider === "anthropic" ? "anthropic" : "openai";
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

export function getLlmApiStyle(): "openai" | "anthropic" {
  return keyring.get(activeProvider)?.apiStyle ?? "openai";
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
  apiStyle?: "openai" | "anthropic",
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

export function getCodexOAuthToken(): string | null {
  return codexOAuthAccessToken;
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
  apiStyle?: "openai" | "anthropic",
): void {
  // Overload 1 (new): setLlmCredentials(provider, apiKey, baseUrl?, apiStyle?)
  // Overload 2 (legacy): setLlmCredentials(apiKey, baseUrl?)
  // Distinguish by checking if the first arg is a known provider-like string.
  // Since this is a sidecar-local file, we keep the provider list local.
  const KNOWN_PROVIDERS = new Set(["openai", "anthropic", "openrouter", "google"]);

  let provider: string;
  let apiKey: string;
  let baseUrl: string | undefined;
  let style: "openai" | "anthropic";

  if (KNOWN_PROVIDERS.has(apiKeyOrProvider) && baseUrlOrApiKey !== undefined) {
    // New multi-arg form: (provider, apiKey, baseUrl?, apiStyle?)
    provider = apiKeyOrProvider;
    apiKey = baseUrlOrApiKey;
    baseUrl = apiStyleOrBaseUrl;
    style = (apiStyle ?? (provider === "anthropic" ? "anthropic" : "openai"));
  } else {
    // Legacy form: (apiKey, baseUrl?)
    provider = activeProvider;
    apiKey = apiKeyOrProvider;
    baseUrl = baseUrlOrApiKey;
    style = apiStyleOrBaseUrl === "anthropic" ? "anthropic" : (keyring.get(provider)?.apiStyle ?? "openai");
  }

  const existing = keyring.get(provider);
  keyring.set(provider, {
    apiKey,
    baseUrl: baseUrl ?? existing?.baseUrl ?? "https://api.openai.com",
    apiStyle: style,
  });
  console.log(`[sidecar] Credentials set for provider: ${provider}`);
}

/**
 * Bulk-seed the keyring from a list of entries. Optionally flips activeProvider.
 */
export function seedKeyring(
  entries: Array<{ provider: string; apiKey: string; baseUrl?: string; apiStyle?: "openai" | "anthropic" }>,
  newActiveProvider?: string,
): void {
  for (const entry of entries) {
    const style: "openai" | "anthropic" =
      entry.apiStyle ?? (entry.provider === "anthropic" ? "anthropic" : "openai");
    keyring.set(entry.provider, {
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl ?? (entry.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"),
      apiStyle: style,
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

export function getMemberId(): string {
  return memberId;
}

export function getSidecarAdminToken(): string {
  return sidecarAdminToken;
}
