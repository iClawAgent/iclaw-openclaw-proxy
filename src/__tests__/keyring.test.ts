import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";

// Reset env module state between tests by re-importing fresh each time.
// We stub process.env before each import.

describe("sidecar keyring", () => {
  beforeEach(() => {
    vi.resetModules();
    // Stub the codex-oauth service so validateEnv doesn't throw
    vi.doMock("../services/codex-oauth.js", () => ({
      loadPersistedTokens: vi.fn().mockReturnValue(null),
    }));
    // Set required env vars
    process.env.MEMBER_ID = "test-member";
    process.env.SIDECAR_ADMIN_TOKEN = "test-admin-token";
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_BASE_URL = "https://api.openai.com";
    process.env.LLM_API_KEY = "sk-openai-boot";
    process.env.LLM_AUTH_MODE = "api_key";
  });

  async function loadEnv() {
    const mod = await import("../env.js");
    mod.validateEnv();
    return mod;
  }

  it("initialises activeProvider from boot env", async () => {
    const env = await loadEnv();
    expect(env.getLlmProvider()).toBe("openai");
    expect(env.getLlmApiKey()).toBe("sk-openai-boot");
    expect(env.getLlmBaseUrl()).toBe("https://api.openai.com");
  });

  it("setLlmCredentials with provider updates keyring without flipping active", async () => {
    const env = await loadEnv();
    env.setLlmCredentials("anthropic", "sk-ant-test", "https://api.anthropic.com", "anthropic");

    // active provider unchanged
    expect(env.getLlmProvider()).toBe("openai");
    expect(env.getLlmApiKey()).toBe("sk-openai-boot");
    // anthropic key is now cached
    expect(env.hasKeyringEntry("anthropic")).toBe(true);
  });

  it("seedKeyring populates multiple providers and optionally flips active", async () => {
    const env = await loadEnv();
    env.seedKeyring([
      { provider: "openai", apiKey: "sk-openai-fresh", baseUrl: "https://api.openai.com" },
      { provider: "anthropic", apiKey: "sk-ant-fresh", baseUrl: "https://api.anthropic.com", apiStyle: "anthropic" },
    ], "anthropic");

    expect(env.getLlmProvider()).toBe("anthropic");
    expect(env.getLlmApiKey()).toBe("sk-ant-fresh");
    expect(env.getLlmApiStyle()).toBe("anthropic");
    expect(env.hasKeyringEntry("openai")).toBe(true);
  });

  it("setLlmProvider (legacy) without cached key creates placeholder", async () => {
    const env = await loadEnv();
    env.setLlmProvider("openrouter", "https://openrouter.ai/api");
    expect(env.getLlmProvider()).toBe("openrouter");
    expect(env.getLlmBaseUrl()).toBe("https://openrouter.ai/api");
    // key is empty placeholder until rotate-key or llm-keyring arrives
    expect(env.getLlmApiKey()).toBe("");
  });

  it("getKeyringSize returns the number of keyring entries", async () => {
    const env = await loadEnv();
    // Boot env seeds 1 entry (openai)
    expect(env.getKeyringSize()).toBe(1);
    env.setLlmCredentials("anthropic", "sk-ant", "https://api.anthropic.com", "anthropic");
    expect(env.getKeyringSize()).toBe(2);
  });

  it("isActiveProviderKeyed returns true when active provider has a key", async () => {
    const env = await loadEnv();
    expect(env.isActiveProviderKeyed()).toBe(true);
  });

  it("isActiveProviderKeyed returns false when active provider has an empty key", async () => {
    process.env.LLM_API_KEY = "";
    process.env.LLM_AUTH_MODE = "codex_oauth"; // allows empty key
    const env = await loadEnv();
    expect(env.isActiveProviderKeyed()).toBe(false);
  });

  it("getLlmApiStyle returns anthropic for anthropic provider", async () => {
    const env = await loadEnv();
    env.seedKeyring([
      { provider: "anthropic", apiKey: "sk-ant", baseUrl: "https://api.anthropic.com", apiStyle: "anthropic" },
    ], "anthropic");
    expect(env.getLlmApiStyle()).toBe("anthropic");
  });

  it("seedKeyring sets google-generative-ai apiStyle for google provider", async () => {
    const env = await loadEnv();
    env.seedKeyring([
      { provider: "google", apiKey: "AIza-test", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    ], "google");
    expect(env.getLlmApiStyle()).toBe("google-generative-ai");
  });
});

// ---------------------------------------------------------------------------
// Admin route: /admin/set-provider 409 when no key cached
// ---------------------------------------------------------------------------

describe("sidecar admin set-provider route", () => {
  let adminRouter: Hono;
  let app: Hono;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../services/codex-oauth.js", () => ({
      loadPersistedTokens: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("../services/backup.js", () => ({}));
    vi.doMock("../services/quota.js", () => ({ syncQuota: vi.fn(), getQuotaStatus: vi.fn() }));
    vi.doMock("../services/gateway-rpc.js", () => ({}));
    vi.doMock("../services/workspace-files.js", () => ({}));
    vi.doMock("../services/bird-skill.js", () => ({}));
    vi.doMock("../services/gog-skill.js", () => ({}));
    // Set required env
    process.env.MEMBER_ID = "test-member";
    process.env.SIDECAR_ADMIN_TOKEN = "test-admin-token";
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_BASE_URL = "https://api.openai.com";
    process.env.LLM_API_KEY = "sk-openai-boot";
    process.env.LLM_AUTH_MODE = "api_key";

    const envMod = await import("../env.js");
    envMod.validateEnv();

    const { adminRouter: router } = await import("../routes/admin.js");
    adminRouter = router as unknown as Hono;
    app = new Hono();
    // Bypass admin auth for unit tests
    app.route("/", adminRouter);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 409 missing_key_for_provider when switching to a provider with no cached key", async () => {
    // Boot env seeds openai; anthropic has no key yet.
    const res = await app.request("/admin/set-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; provider: string };
    expect(body.error).toBe("missing_key_for_provider");
    expect(body.provider).toBe("anthropic");
  });

  it("succeeds when switching to a provider that has a cached key", async () => {
    const envMod = await import("../env.js");
    envMod.setLlmCredentials("anthropic", "sk-ant", "https://api.anthropic.com", "anthropic");

    const res = await app.request("/admin/set-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(res.status).toBe(200);
  });

  it("GET /admin/llm-keyring/status returns entryCount, activeProvider, activeHasKey — no key material", async () => {
    const res = await app.request("/admin/llm-keyring/status", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Must return counts and active provider name — no key material
    expect(typeof body.entryCount).toBe("number");
    expect(typeof body.activeProvider).toBe("string");
    expect(typeof body.activeHasKey).toBe("boolean");

    // Critically: no apiKey, no baseUrl with secrets, no key material
    expect(body.apiKey).toBeUndefined();
    expect(body.key).toBeUndefined();
    expect(body.entries).toBeUndefined();
  });

  it("llm-keyring rejects oversized payloads (more than 32 entries)", async () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({
      provider: `provider-${i}`,
      apiKey: `sk-${i}`,
    }));

    const res = await app.request("/admin/llm-keyring", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too_many_entries");
  });
});
