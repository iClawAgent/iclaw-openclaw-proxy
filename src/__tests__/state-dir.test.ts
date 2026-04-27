import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Tests for lib/state-dir.ts.
 *
 * The module runs its absolute-path guard at load time. To test that behavior
 * we use vi.resetModules() before each dynamic import() so vitest re-evaluates
 * the module with the env var set by vi.stubEnv().
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("lib/state-dir — module-load-time guard", () => {
  it("throws when OPENCLAW_STATE_DIR is a relative path", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "relative/path");
    vi.resetModules();
    await expect(import("../lib/state-dir.js")).rejects.toThrow(
      "OPENCLAW_STATE_DIR must be an absolute path",
    );
  });

  it("throws when OPENCLAW_STATE_DIR starts with a dot-slash", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "./data");
    vi.resetModules();
    await expect(import("../lib/state-dir.js")).rejects.toThrow(
      "OPENCLAW_STATE_DIR must be an absolute path",
    );
  });

  it("throws when OPENCLAW_STATE_DIR starts with a dot only", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", ".openclaw");
    vi.resetModules();
    await expect(import("../lib/state-dir.js")).rejects.toThrow(
      "OPENCLAW_STATE_DIR must be an absolute path",
    );
  });

  it("does not throw and exports the value when OPENCLAW_STATE_DIR is an absolute path", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/root/.openclaw");
    vi.resetModules();
    const mod = await import("../lib/state-dir.js");
    expect(mod.STATE_DIR).toBe("/root/.openclaw");
  });

  it("does not throw and exports the value when OPENCLAW_STATE_DIR is /data", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/data");
    vi.resetModules();
    const mod = await import("../lib/state-dir.js");
    expect(mod.STATE_DIR).toBe("/data");
  });

  it("exports STATE_DIR as exactly /root/.openclaw when OPENCLAW_STATE_DIR is absent", async () => {
    // Ensure the var is absent (not just empty) by deleting it before reset.
    delete process.env.OPENCLAW_STATE_DIR;
    vi.resetModules();
    const mod = await import("../lib/state-dir.js");
    expect(mod.STATE_DIR).toBe("/root/.openclaw");
  });
});
