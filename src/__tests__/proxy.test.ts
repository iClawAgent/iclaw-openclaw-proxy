import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCheckSidecarQuota, mockGetLlmApiStyle, mockGetLlmBaseUrl } = vi.hoisted(() => ({
  mockCheckSidecarQuota: vi.fn(),
  mockGetLlmApiStyle: vi.fn(() => "openai" as "openai" | "anthropic" | "google-generative-ai"),
  mockGetLlmBaseUrl: vi.fn(() => "https://api.openai.com"),
}));

vi.mock("../services/quota.js", () => ({
  checkSidecarQuota: mockCheckSidecarQuota,
}));

vi.mock("../env.js", () => ({
  getLlmApiKey: () => "sk-real-key",
  getLlmBaseUrl: mockGetLlmBaseUrl,
  getLlmProvider: () => "openai",
  getLlmApiStyle: mockGetLlmApiStyle,
}));

const { proxyRouter } = await import("../routes/proxy.js");
const originalFetch = globalThis.fetch;

describe("proxy router", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmApiStyle.mockReturnValue("openai");
    mockGetLlmBaseUrl.mockReturnValue("https://api.openai.com");
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  describe("POST /v1/chat/completions (quota-gated)", () => {
    it("forwards when quota is allowed", async () => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: true,
        remaining: 7,
        plan: "free_trial",
      });

      const res = await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("Authorization")).toBe("Bearer sk-real-key");
    });

    it("returns 429 when quota exhausted", async () => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: false,
        remaining: 0,
        plan: "free_trial",
        trialExpired: false,
        resetAt: "1700000000000",
      });

      const res = await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("quota_exceeded");
      expect(res.headers.get("x-should-retry")).toBe("false");
    });

    it("returns trial expired message", async () => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: false,
        remaining: 0,
        plan: "free_trial",
        trialExpired: true,
      });

      const res = await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
      });
      const body = (await res.json()) as { error: { code: string; message: string } };

      expect(body.error.message).toContain("Free trial has expired");
    });
  });

  describe("GET /v1/models (pass-through, no quota)", () => {
    it("forwards to upstream", async () => {
      const res = await proxyRouter.request("/v1/models");

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("POST /v1/messages (Anthropic native path — quota-gated)", () => {
    it("returns 429 when quota exhausted on /v1/messages", async () => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: false,
        remaining: 0,
        plan: "free_trial",
        trialExpired: false,
        resetAt: "1700000000000",
      });

      const res = await proxyRouter.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("quota_exceeded");
    });

    it("forwards /v1/messages when quota is allowed", async () => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: true,
        remaining: 5,
        plan: "plus",
      });

      const res = await proxyRouter.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("auth header injection by apiStyle", () => {
    beforeEach(() => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: true,
        remaining: 5,
        plan: "plus",
      });
    });

    it("emits Authorization: Bearer for openai apiStyle", async () => {
      mockGetLlmApiStyle.mockReturnValue("openai");

      await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("Authorization")).toBe("Bearer sk-real-key");
      expect(init.headers.get("x-api-key")).toBeNull();
      expect(init.headers.get("x-goog-api-key")).toBeNull();
    });

    it("emits x-api-key + anthropic-version for anthropic apiStyle", async () => {
      mockGetLlmApiStyle.mockReturnValue("anthropic");

      await proxyRouter.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("x-api-key")).toBe("sk-real-key");
      expect(init.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(init.headers.get("Authorization")).toBeNull();
      expect(init.headers.get("x-goog-api-key")).toBeNull();
    });

    it("emits x-goog-api-key for google-generative-ai apiStyle", async () => {
      mockGetLlmApiStyle.mockReturnValue("google-generative-ai");

      await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }),
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("x-goog-api-key")).toBe("sk-real-key");
      expect(init.headers.get("Authorization")).toBeNull();
      expect(init.headers.get("x-api-key")).toBeNull();
    });

    it("strips inbound x-goog-api-key to prevent injection bypass", async () => {
      mockGetLlmApiStyle.mockReturnValue("openai");

      await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "attacker-key",
        },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      const [, init] = mockFetch.mock.calls[0];
      // inbound x-goog-api-key must be stripped regardless of apiStyle
      expect(init.headers.get("x-goog-api-key")).toBeNull();
    });

    it("strips inbound Authorization to prevent injection bypass", async () => {
      mockGetLlmApiStyle.mockReturnValue("anthropic");

      await proxyRouter.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer attacker-key",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      });

      const [, init] = mockFetch.mock.calls[0];
      // Authorization must be stripped; only x-api-key is set for anthropic style
      expect(init.headers.get("Authorization")).toBeNull();
      expect(init.headers.get("x-api-key")).toBe("sk-real-key");
    });
  });

  describe("provider path composition", () => {
    beforeEach(() => {
      mockCheckSidecarQuota.mockResolvedValue({
        allowed: true,
        remaining: 5,
        plan: "plus",
      });
    });

    it("relays DeepSeek /v1/chat/completions to https://api.deepseek.com/v1/chat/completions without path translation", async () => {
      mockGetLlmApiStyle.mockReturnValue("openai");
      mockGetLlmBaseUrl.mockReturnValue("https://api.deepseek.com");

      await proxyRouter.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [upstreamUrl] = mockFetch.mock.calls[0];
      expect(upstreamUrl).toBe("https://api.deepseek.com/v1/chat/completions");

      // Uses Bearer auth (openai-style)
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("Authorization")).toBe("Bearer sk-real-key");
    });

    it("relays Google /v1/models/{model}:streamGenerateContent?alt=sse to generativelanguage.googleapis.com/v1beta path", async () => {
      mockGetLlmApiStyle.mockReturnValue("google-generative-ai");
      mockGetLlmBaseUrl.mockReturnValue("https://generativelanguage.googleapis.com/v1beta");

      await proxyRouter.request(
        "/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [] }),
        },
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const [upstreamUrl] = mockFetch.mock.calls[0];
      // OpenClaw emits /v1/models/…; sidecar strips /v1 prefix and prepends /v1beta base path.
      expect(upstreamUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      );

      // Uses x-goog-api-key auth
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.get("x-goog-api-key")).toBe("sk-real-key");
      expect(init.headers.get("Authorization")).toBeNull();
    });
  });
});
