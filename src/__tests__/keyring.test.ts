import { describe, it, expect, beforeEach, vi } from "vitest";

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

  it("getLlmApiStyle returns anthropic for anthropic provider", async () => {
    const env = await loadEnv();
    env.seedKeyring([
      { provider: "anthropic", apiKey: "sk-ant", baseUrl: "https://api.anthropic.com", apiStyle: "anthropic" },
    ], "anthropic");
    expect(env.getLlmApiStyle()).toBe("anthropic");
  });
});
