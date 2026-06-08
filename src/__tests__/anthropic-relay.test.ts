/**
 * Anthropic relay contract tests (Part 2-A).
 *
 * These tests assert the sidecar's relay-only contract for the Anthropic provider:
 * - POST /v1/messages is quota-gated
 * - Correct upstream URL composition (no double /v1)
 * - Strips inbound auth headers, injects stored key as x-api-key
 * - Preserves anthropic-version, never invents anthropic-beta
 * - Upstream error/status pass-through unchanged (401, 403, 413, 429, 500, 504, 529)
 * - Streaming SSE bytes are relayed unchanged (no parsing/transformation)
 *
 * REGRESSION GUARD: No test in this file may assert OpenAI-to-Anthropic body,
 * stream, tool-call, or error translation. The sidecar must not translate.
 * All provider-shape conversion is owned by OpenClaw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCheckSidecarQuota, mockGetLlmApiStyle, mockGetLlmBaseUrl, mockGetLlmApiKey } =
  vi.hoisted(() => ({
    mockCheckSidecarQuota: vi.fn(),
    mockGetLlmApiStyle: vi.fn(
      () => "anthropic" as "openai" | "anthropic" | "google-generative-ai",
    ),
    mockGetLlmBaseUrl: vi.fn(() => "https://api.anthropic.com"),
    mockGetLlmApiKey: vi.fn(() => "sk-ant-member-key"),
  }));

vi.mock("../services/quota.js", () => ({
  checkSidecarQuota: mockCheckSidecarQuota,
}));

vi.mock("../env.js", () => ({
  getLlmApiKey: mockGetLlmApiKey,
  getLlmBaseUrl: mockGetLlmBaseUrl,
  getLlmProvider: () => "anthropic",
  getLlmApiStyle: mockGetLlmApiStyle,
}));

const { proxyRouter } = await import("../routes/proxy.js");
const originalFetch = globalThis.fetch;

const ANTHROPIC_REQUEST = JSON.stringify({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
});

const QUOTA_ALLOWED = { allowed: true, remaining: 5, plan: "plus" };
const QUOTA_EXHAUSTED = {
  allowed: false,
  remaining: 0,
  plan: "free_trial",
  trialExpired: false,
  resetAt: "1700000000000",
};

describe("Anthropic relay contract — sidecar Part 2-A", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmApiStyle.mockReturnValue("anthropic");
    mockGetLlmBaseUrl.mockReturnValue("https://api.anthropic.com");
    mockGetLlmApiKey.mockReturnValue("sk-ant-member-key");
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_01", type: "message" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  // ── Quota gate ────────────────────────────────────────────────────────────

  it("POST /v1/messages is quota-gated: returns 429 when exhausted", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_EXHAUSTED);

    const res = await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POST /v1/messages forwards when quota is allowed", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    const res = await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // ── Upstream URL composition (no double /v1) ─────────────────────────────

  it("routes POST /v1/messages to https://api.anthropic.com/v1/messages (no double /v1)", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    const [upstreamUrl] = mockFetch.mock.calls[0];
    // Anthropic base URL is https://api.anthropic.com (no /v1 suffix).
    // Sidecar appends the request path /v1/messages directly → no double /v1.
    expect(upstreamUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("does NOT double /v1 when base URL has no /v1 suffix", async () => {
    // anthropic base is https://api.anthropic.com — already correct; verify no mangling
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);
    mockGetLlmBaseUrl.mockReturnValue("https://api.anthropic.com");

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(url).not.toContain("/v1/v1/");
  });

  // ── Auth header injection ─────────────────────────────────────────────────

  it("strips inbound authorization and injects x-api-key with stored member key", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer attacker-key",
      },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("Authorization")).toBeNull();
    expect(init.headers.get("x-api-key")).toBe("sk-ant-member-key");
  });

  it("strips inbound x-api-key and injects stored member key", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "caller-injected-key",
      },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    // Must be the stored key, not the caller-supplied one
    expect(init.headers.get("x-api-key")).toBe("sk-ant-member-key");
  });

  it("sets anthropic-version: 2023-06-01", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not inject Authorization header for anthropic style", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("Authorization")).toBeNull();
  });

  // ── anthropic-beta: forwarded when OpenClaw sends it; sidecar never invents it ─

  it("does NOT inject anthropic-beta when OpenClaw did not send it", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).toBeNull();
  });

  it("preserves anthropic-beta when OpenClaw sends it (forwarded unchanged)", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "tools-2024-04-04",
      },
      body: ANTHROPIC_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).toBe("tools-2024-04-04");
  });

  // ── Upstream error pass-through ──────────────────────────────────────────

  it.each([
    [401, "authentication_error"],
    [403, "permission_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ])(
    "passes through upstream %i unchanged (status + body)",
    async (status, errorType) => {
      mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);
      const errorBody = JSON.stringify({ error: { type: errorType, message: "upstream error" } });
      mockFetch.mockResolvedValue(
        new Response(errorBody, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );

      const res = await proxyRouter.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ANTHROPIC_REQUEST,
      });

      // Sidecar must pass through the upstream status unchanged
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe(errorType);
    },
  );

  // ── Streaming SSE pass-through ────────────────────────────────────────────

  it("relays streaming SSE bytes unchanged — does not parse or transform Anthropic events", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    // Simulate a minimal Anthropic SSE body
    const sseBody =
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\"}}\n\n" +
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n" +
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    const encoder = new TextEncoder();
    const bytes = encoder.encode(sseBody);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    mockFetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "transfer-encoding": "chunked",
        },
      }),
    );

    const res = await proxyRouter.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: ANTHROPIC_REQUEST,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the relayed body and verify it matches the upstream bytes exactly
    const relayed = await res.text();
    expect(relayed).toBe(sseBody);

    // The sidecar must have called fetch exactly once — no intermediate parsing
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // ── REGRESSION GUARD ─────────────────────────────────────────────────────
  // This file must not contain any test asserting OpenAI→Anthropic translation.
  // The sidecar is a relay only. All provider-shape conversion is OpenClaw's job.
});
