import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// D5: sidecar validateEnv must NOT throw/exit when TOKEN_CALLBACK_BASE_URL is absent.
// The sidecar gates ALL instances (LLM proxy + Telegram relay) — a throwing/aborting
// path here would be a platform-wide outage for non-gog instances (INC-2026-03-23 class).

// Mock heavy dependencies that validateEnv loads at module scope.
vi.mock("../services/codex-oauth.js", () => ({
  loadPersistedTokens: () => null,
}));

describe("sidecar env validateEnv — D5 non-fatal TOKEN_CALLBACK_BASE_URL", () => {
  const REQUIRED_ENV = {
    MEMBER_ID: "member-test-123",
    SIDECAR_ADMIN_TOKEN: "admin-token-test",
    LLM_API_KEY: "llm-key-test",
  };

  beforeEach(() => {
    vi.resetModules();
    // Ensure required vars are set so getEnvOrThrow does not abort
    for (const [k, v] of Object.entries(REQUIRED_ENV)) {
      process.env[k] = v;
    }
    delete process.env.TOKEN_CALLBACK_BASE_URL;
  });

  afterEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) {
      delete process.env[k];
    }
    delete process.env.TOKEN_CALLBACK_BASE_URL;
    vi.restoreAllMocks();
  });

  it("validateEnv does NOT throw when TOKEN_CALLBACK_BASE_URL is absent", async () => {
    const { validateEnv } = await import("../env.js");
    expect(() => validateEnv()).not.toThrow();
  });

  it("validateEnv emits a console.warn when TOKEN_CALLBACK_BASE_URL is absent", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const { validateEnv } = await import("../env.js");
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TOKEN_CALLBACK_BASE_URL"),
    );
  });

  it("validateEnv does NOT warn when TOKEN_CALLBACK_BASE_URL is present", async () => {
    process.env.TOKEN_CALLBACK_BASE_URL = "https://api.example.com";
    const warnSpy = vi.spyOn(console, "warn");
    const { validateEnv } = await import("../env.js");
    validateEnv();
    const gogWarn = warnSpy.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("TOKEN_CALLBACK_BASE_URL"),
    );
    expect(gogWarn).toBeUndefined();
    delete process.env.TOKEN_CALLBACK_BASE_URL;
  });

  it("validateEnv still requires MEMBER_ID (getEnvOrThrow)", async () => {
    delete process.env.MEMBER_ID;
    const { validateEnv } = await import("../env.js");
    expect(() => validateEnv()).toThrow("Missing required env var: MEMBER_ID");
    process.env.MEMBER_ID = REQUIRED_ENV.MEMBER_ID;
  });

  it("validateEnv still requires SIDECAR_ADMIN_TOKEN (getEnvOrThrow)", async () => {
    delete process.env.SIDECAR_ADMIN_TOKEN;
    const { validateEnv } = await import("../env.js");
    expect(() => validateEnv()).toThrow("Missing required env var: SIDECAR_ADMIN_TOKEN");
    process.env.SIDECAR_ADMIN_TOKEN = REQUIRED_ENV.SIDECAR_ADMIN_TOKEN;
  });
});
