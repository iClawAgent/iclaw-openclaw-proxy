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
  const originalEnv = process.env.ORCHESTRATOR_BASE_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    delete process.env.ORCHESTRATOR_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ORCHESTRATOR_BASE_URL = originalEnv;
    } else {
      delete process.env.ORCHESTRATOR_BASE_URL;
    }
    vi.stubGlobal("fetch", originalFetch);
  });

  async function makeApp() {
    const { internalRouter } = await import("../routes/internal.js");
    const app = new Hono();
    app.route("/", internalRouter);
    return app;
  }

  it("returns 503 when ORCHESTRATOR_BASE_URL is not set (fail closed)", async () => {
    const app = await makeApp();
    const res = await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "some-uuid",
        instanceId: "inst-1",
        orchestratorBaseUrl: "http://attacker.example.com",
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("orchestrator_url_not_configured");
  });

  it("returns 403 when orchestratorBaseUrl does not match ORCHESTRATOR_BASE_URL", async () => {
    process.env.ORCHESTRATOR_BASE_URL = "http://orchestrator.internal";
    const app = await makeApp();
    const res = await app.request("/internal/skills/bird/setup-by-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "some-uuid",
        instanceId: "inst-1",
        orchestratorBaseUrl: "http://attacker.example.com",
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_orchestrator_url");
  });

  it("proceeds when orchestratorBaseUrl matches ORCHESTRATOR_BASE_URL", async () => {
    process.env.ORCHESTRATOR_BASE_URL = "http://orchestrator.internal";
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
        orchestratorBaseUrl: "http://orchestrator.internal",
      }),
    });
    expect(res.status).toBe(200);
    expect(mockSetupBirdSkill).toHaveBeenCalledOnce();
  });
});
