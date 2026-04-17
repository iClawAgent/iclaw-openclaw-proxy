import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCheckSidecarQuota } = vi.hoisted(() => ({
  mockCheckSidecarQuota: vi.fn(),
}));

vi.mock("../services/quota.js", () => ({
  checkSidecarQuota: mockCheckSidecarQuota,
}));

vi.mock("../env.js", () => ({
  getLlmApiKey: () => "sk-real-key",
  getLlmAuthMode: () => "platform",
  getLlmBaseUrl: () => "https://api.openai.com",
  getLlmProvider: () => "openai",
}));

vi.mock("../services/codex-forwarder.js", () => ({
  forwardToCodex: vi.fn(),
}));

const { proxyRouter } = await import("../routes/proxy.js");
const originalFetch = globalThis.fetch;

describe("proxy router", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
});
