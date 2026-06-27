import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  withCodexOAuthTransition,
  buildCodexOAuthAgentsDefaults,
  CODEX_OAUTH_DEFAULT_MODEL,
} from "../services/codex-oauth.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex OAuth canonical model config (OpenClaw 2026.6.x)", () => {
  it("CODEX_OAUTH_DEFAULT_MODEL is a canonical openai/* ref, not legacy openai-codex/*", () => {
    // Must stay in sync with @iclawagent/shared OPENCLAW_DEFAULTS.codexOAuthDefaultModel.
    expect(CODEX_OAUTH_DEFAULT_MODEL).toBe("openai/gpt-5.4");
    expect(CODEX_OAUTH_DEFAULT_MODEL).not.toContain("openai-codex/");
  });

  it("buildCodexOAuthAgentsDefaults binds the model to the native codex runtime", () => {
    const defaults = buildCodexOAuthAgentsDefaults();
    expect(defaults.model).toBe("openai/gpt-5.4");
    expect(defaults.models["openai/gpt-5.4"]).toEqual({
      agentRuntime: { id: "codex" },
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: no autonomous refresh timer — sidecar is write-once only
// ---------------------------------------------------------------------------

describe("codex-oauth no-refresh regression", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    // Stub env to avoid real disk state-dir at module load
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("storeTokens persists codex-oauth.json and sets in-memory token but never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers();

    const { storeTokens } = await import("../services/codex-oauth.js");
    storeTokens("access-abc", "refresh-xyz", 3600);

    // Advance time well past any expiry to prove no timer fires
    await vi.advanceTimersByTimeAsync(7_200_000);

    const tokenFile = path.join(stateDir, "codex-oauth.json");
    expect(fs.existsSync(tokenFile)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(tokenFile, "utf-8"));
    expect(stored.accessToken).toBe("access-abc");
    expect(stored.refreshToken).toBe("refresh-xyz");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);

    vi.useRealTimers();
  });

  it("loadPersistedTokens returns the record for a valid token without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ accessToken: "acc", refreshToken: "ref", expiresAt }),
      "utf-8",
    );

    const { loadPersistedTokens } = await import("../services/codex-oauth.js");
    const result = loadPersistedTokens();

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("acc");
    expect(result?.refreshToken).toBe("ref");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);
  });

  it("loadPersistedTokens (D1) returns the record even when the token is expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ accessToken: "acc-exp", refreshToken: "ref-exp", expiresAt }),
      "utf-8",
    );

    const { loadPersistedTokens } = await import("../services/codex-oauth.js");
    const result = loadPersistedTokens();

    // D1: must return the record, not null
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("acc-exp");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);
  });

  it("clearTokens resets llmAuthMode to platform and removes the token file", async () => {
    const { setLlmAuthMode } = await import("../env.js");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    fs.writeFileSync(tokenFile, JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: "2099-01-01T00:00:00.000Z" }), "utf-8");

    const { clearTokens } = await import("../services/codex-oauth.js");
    clearTokens();

    expect(setLlmAuthMode).toHaveBeenCalledWith("platform");
    expect(fs.existsSync(tokenFile)).toBe(false);
  });
});

describe("withCodexOAuthTransition", () => {
  it("serializes overlapping OAuth state transitions in request order", async () => {
    const events: string[] = [];

    const first = withCodexOAuthTransition(async () => {
      events.push("first:start");
      await delay(20);
      events.push("first:end");
      return "first";
    });

    const second = withCodexOAuthTransition(async () => {
      events.push("second:start");
      await delay(1);
      events.push("second:end");
      return "second";
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("continues processing after a failed transition", async () => {
    const events: string[] = [];

    await expect(
      withCodexOAuthTransition(async () => {
        events.push("fail:start");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      withCodexOAuthTransition(async () => {
        events.push("next:start");
        return "next";
      }),
    ).resolves.toBe("next");

    expect(events).toEqual(["fail:start", "next:start"]);
  });
});
