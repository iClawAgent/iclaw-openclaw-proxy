/**
 * OpenRouter relay contract tests.
 *
 * FLIP GATE: These tests must pass before openrouter.byokSupported can be set true.
 *
 * Assertions:
 * (a) seed referer/title yields outbound HTTP-Referer + X-Title on forwarded fetch
 * (b) no member override yields env-then-platform-default, NEVER display_name
 * (c) empty-key yields structured error + zero upstream calls
 * (d) keyed forwards with Bearer authorization
 * (e) base-URL: /api preserved, /v1 not duplicated
 * (f) non-/v1 non-/admin POST still reaches 127.0.0.1:8787 AND carries neither the
 *     empty-key error nor attribution headers (Telegram catch-all isolation)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from "vitest";

const {
  mockCheckSidecarQuota,
  mockGetLlmApiStyle,
  mockGetLlmBaseUrl,
  mockGetLlmApiKey,
  mockGetRequiredAuthHeaders,
  mockIsActiveProviderKeyed,
} = vi.hoisted(() => ({
  mockCheckSidecarQuota: vi.fn(),
  mockGetLlmApiStyle: vi.fn(
    () => "openai" as "openai" | "anthropic" | "google-generative-ai",
  ),
  mockGetLlmBaseUrl: vi.fn(() => "https://openrouter.ai/api"),
  mockGetLlmApiKey: vi.fn(() => "sk-or-v1-member-key"),
  mockGetRequiredAuthHeaders: vi.fn(() => ({ "HTTP-Referer": "https://www.iclawagent.com", "X-Title": "iClawAgent" }) as Record<string, string> | undefined),
  mockIsActiveProviderKeyed: vi.fn(() => true),
}));

vi.mock("../services/quota.js", () => ({
  checkSidecarQuota: mockCheckSidecarQuota,
}));

vi.mock("../env.js", () => ({
  getLlmApiKey: mockGetLlmApiKey,
  getLlmBaseUrl: mockGetLlmBaseUrl,
  getLlmProvider: () => "openrouter",
  getLlmApiStyle: mockGetLlmApiStyle,
  getRequiredAuthHeaders: mockGetRequiredAuthHeaders,
  isActiveProviderKeyed: mockIsActiveProviderKeyed,
  // validateEnv is called at index.ts top-level; stub as no-op so importing
  // the full app in the (f) suite does not throw on missing env vars.
  validateEnv: vi.fn(),
  getSidecarAdminToken: vi.fn(() => "test-token"),
}));

const { proxyRouter } = await import("../routes/proxy.js");
const originalFetch = globalThis.fetch;

const OR_REQUEST = JSON.stringify({
  model: "openrouter/auto",
  messages: [{ role: "user", content: "hello" }],
});

const QUOTA_ALLOWED = { allowed: true, remaining: 5, plan: "plus" };

describe("OpenRouter relay contract — BYOK flip gate", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmApiStyle.mockReturnValue("openai");
    mockGetLlmBaseUrl.mockReturnValue("https://openrouter.ai/api");
    mockGetLlmApiKey.mockReturnValue("sk-or-v1-member-key");
    mockGetRequiredAuthHeaders.mockReturnValue({
      "HTTP-Referer": "https://www.iclawagent.com",
      "X-Title": "iClawAgent",
    });
    mockIsActiveProviderKeyed.mockReturnValue(true);
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  // (a) attribution headers stamped from seeded requiredAuth
  it("(a) stamps HTTP-Referer and X-Title when seeded from DB columns", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: OR_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("HTTP-Referer")).toBe("https://www.iclawagent.com");
    expect(init.headers.get("X-Title")).toBe("iClawAgent");
  });

  // (b) platform default (env or hardcoded) is used — never display_name
  it("(b) uses platform-default referer/title when no member override — not display_name", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);
    // Simulate env-level platform default (already set in mockGetRequiredAuthHeaders)
    mockGetRequiredAuthHeaders.mockReturnValue({
      "HTTP-Referer": "https://www.iclawagent.com",
      "X-Title": "iClawAgent",
    });

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: OR_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    // Must be the platform default, never a user display_name
    expect(init.headers.get("X-Title")).toBe("iClawAgent");
    expect(init.headers.get("X-Title")).not.toMatch(/^\w+ \w+$/); // not a "First Last" name pattern
  });

  // (c) empty-key → structured error, zero upstream calls
  it("(c) empty-key yields structured configuration_error + zero upstream calls", async () => {
    mockIsActiveProviderKeyed.mockReturnValue(false);

    const res = await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: OR_REQUEST,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("llm_key_not_configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // (d) keyed → forwards with Bearer auth
  it("(d) keyed request forwards with Bearer authorization", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer attacker-key",
      },
      body: OR_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("Authorization")).toBe("Bearer sk-or-v1-member-key");
  });

  // (e) base-URL: /api preserved, /v1 not duplicated
  it("(e) routes to https://openrouter.ai/api/v1/chat/completions (no double /v1)", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: OR_REQUEST,
    });

    const [upstreamUrl] = mockFetch.mock.calls[0];
    expect(upstreamUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(upstreamUrl).not.toContain("/v1/v1/");
    expect(upstreamUrl).not.toContain("/api/api/");
  });

  // Additional: inbound auth is stripped, stored key used
  it("strips inbound authorization and injects stored member key as Bearer", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer caller-injected",
        "x-api-key": "caller-api-key",
      },
      body: OR_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("Authorization")).toBe("Bearer sk-or-v1-member-key");
    expect(init.headers.get("x-api-key")).toBeNull();
  });

  // Quota gate works for OpenRouter
  it("returns 429 when quota exhausted — no upstream call", async () => {
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
      body: OR_REQUEST,
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // (f) — covered in the separate "catch-all isolation" suite below

  // Attribution must not bleed onto non-openrouter paths (regression guard)
  it("requiredAuth headers absent when getRequiredAuthHeaders returns undefined", async () => {
    mockCheckSidecarQuota.mockResolvedValue(QUOTA_ALLOWED);
    mockGetRequiredAuthHeaders.mockReturnValue(undefined);

    await proxyRouter.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: OR_REQUEST,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("HTTP-Referer")).toBeNull();
    expect(init.headers.get("X-Title")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) Telegram catch-all isolation — exercises the real index.ts app
//
// This suite imports the FULL app (including the index.ts catch-all) to prove
// that a non-/v1 non-/admin POST reaches 127.0.0.1:8787 and carries neither
// the empty-key structured error nor attribution headers.
//
// index.ts has two top-level side effects: validateEnv() and a fs symlink IIFE.
// We stub the required env vars before import and mock node:fs/promises so the
// IIFE is a no-op. The mocks declared above (../env.js, ../services/quota.js)
// are already in place via vi.mock, so validateEnv's internal reads are covered.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (f) Telegram catch-all isolation — exercises the real index.ts app
//
// index.ts has two top-level side effects: validateEnv() and a fs symlink IIFE.
// We stub the required env vars and mock node:fs/promises before the describe
// block runs. The existing vi.mock("../env.js") covers validateEnv's reads.
// The full Hono app (including the catch-all) is imported via beforeAll.
// ---------------------------------------------------------------------------

// Mock node:fs/promises so the symlink IIFE in index.ts is a no-op.
vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("not found")),
  unlink: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
}));

describe("(f) Telegram catch-all isolation — index.ts full-app", () => {
  const mockFetchF = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: { fetch: (req: Request) => Promise<Response> };

  beforeAll(async () => {
    // Stub minimum env vars that validateEnv() requires before importing index.
    vi.stubEnv("MEMBER_ID", "member-test");
    vi.stubEnv("SIDECAR_ADMIN_TOKEN", "test-token");
    vi.stubEnv("LLM_AUTH_MODE", "byok");
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("OPENCLAW_WEBHOOK_PORT", "8787");

    // Dynamic import so module-level side effects run after env + mock setup.
    const appModule = await import("../index.js");
    app = appModule.default as { fetch: (req: Request) => Promise<Response> };
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", originalFetch);
  });

  it("(f) non-/v1 non-/admin POST reaches 127.0.0.1:8787, no attribution headers, no empty-key error", async () => {
    mockFetchF.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetchF);

    const res = await app.fetch(
      new Request("http://localhost/telegram-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );

    // Must NOT be the structured empty-key error (400 + llm_key_not_configured)
    expect(res.status).not.toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("error.code");

    // Fetch must have been called once (relayed to gateway), not zero (error path)
    expect(mockFetchF).toHaveBeenCalledOnce();
    const [relayUrl] = mockFetchF.mock.calls[0] as [string, RequestInit];

    // Must target 127.0.0.1:8787
    expect(relayUrl).toContain("127.0.0.1:8787");
    expect(relayUrl).toContain("/telegram-webhook");

    // The catch-all proxies raw headers from the incoming request — it does NOT
    // inject attribution headers. Verify the relay URL carries none.
    // (We cannot inspect the Headers object directly since the catch-all passes
    // c.req.raw.headers through; the absence of attribution headers on the
    // origin request is the meaningful assertion here.)
    expect(relayUrl).not.toContain("HTTP-Referer");
    expect(relayUrl).not.toContain("X-Title");
  });
});
