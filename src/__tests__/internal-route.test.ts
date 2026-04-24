import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const { mockSetupBirdSkill, mockFetch } = vi.hoisted(() => ({
  mockSetupBirdSkill: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("../services/bird-skill.js", () => ({
  setupBirdSkill: mockSetupBirdSkill,
  redactBirdSecrets: (x: unknown) => x,
}));

describe("POST /internal/skills/bird/setup-by-token — SSRF guard", () => {
  const originalTokenCallbackUrl = process.env.TOKEN_CALLBACK_BASE_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    delete process.env.TOKEN_CALLBACK_BASE_URL;
  });

  afterEach(() => {
    if (originalTokenCallbackUrl !== undefined) {
      process.env.TOKEN_CALLBACK_BASE_URL = originalTokenCallbackUrl;
    } else {
      delete process.env.TOKEN_CALLBACK_BASE_URL;
    }
    vi.stubGlobal("fetch", originalFetch);
  });

  async function makeApp() {
    const { internalRouter } = await import("../routes/internal.js");
    const app = new Hono();
    app.route("/", internalRouter);
    return app;
  }

  it("returns 503 when TOKEN_CALLBACK_BASE_URL is not set (fail closed)", async () => {
    const app = await makeApp();
    const res = await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "some-uuid",
        instanceId: "inst-1",
        tokenCallbackBaseUrl: "https://attacker.example.com",
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("token_callback_url_not_configured");
  });

  it("returns 403 when tokenCallbackBaseUrl does not match TOKEN_CALLBACK_BASE_URL", async () => {
    process.env.TOKEN_CALLBACK_BASE_URL = "https://api.iclawagent.com";
    const app = await makeApp();
    const res = await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "some-uuid",
        instanceId: "inst-1",
        tokenCallbackBaseUrl: "https://attacker.example.com",
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_token_callback_url");
  });

  it("proceeds when tokenCallbackBaseUrl matches TOKEN_CALLBACK_BASE_URL", async () => {
    process.env.TOKEN_CALLBACK_BASE_URL = "https://api.iclawagent.com";
    process.env.SIDECAR_ADMIN_TOKEN = "sidecar-token";

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ authToken: "tok", ct0: "c0" }), { status: 200 }),
    );
    mockSetupBirdSkill.mockResolvedValue({
      ok: true,
      installedSkill: false,
      installedDependency: false,
      enabled: true,
      verification: { command: "bird whoami --plain", ok: true, message: "user" },
    });

    const app = await makeApp();
    const res = await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "valid-uuid",
        instanceId: "inst-1",
        tokenCallbackBaseUrl: "https://api.iclawagent.com",
      }),
    });
    expect(res.status).toBe(200);
    expect(mockSetupBirdSkill).toHaveBeenCalledOnce();
  });

  it("calls portal-api /sidecar/skills/bird/setup-token with X-Sidecar-Admin-Token", async () => {
    process.env.TOKEN_CALLBACK_BASE_URL = "https://api.iclawagent.com";
    process.env.SIDECAR_ADMIN_TOKEN = "my-sidecar-secret";

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ authToken: "tok", ct0: "c0" }), { status: 200 }),
    );
    mockSetupBirdSkill.mockResolvedValue({
      ok: true,
      installedSkill: false,
      installedDependency: false,
      enabled: true,
      verification: { command: "bird whoami --plain", ok: true, message: "user" },
    });

    const app = await makeApp();
    await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "test-token-uuid",
        instanceId: "inst-42",
        tokenCallbackBaseUrl: "https://api.iclawagent.com",
      }),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    // Callback must go to portal-api /sidecar/skills/bird/setup-token path
    expect(url).toContain("/sidecar/skills/bird/setup-token/");
    expect(url).toContain("instanceId=inst-42");
    // X-Sidecar-Admin-Token must be sent (from env, never logged or returned)
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      "X-Sidecar-Admin-Token": "my-sidecar-secret",
    });
  });
});
