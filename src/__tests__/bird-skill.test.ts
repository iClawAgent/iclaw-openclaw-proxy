import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import {
  redactBirdSecrets,
  readBirdCredentials,
  verifyBirdRuntime,
  setupBirdSkill,
  installBirdDependency,
  getBirdBinPath,
  getBirdInstallPrefix,
  getBirdCredentialsPath,
  getBirdSkillMdPath,
  BIRD_CLAWHUB_SLUG,
  type BirdSetupRequest,
} from "../services/bird-skill.js";

// mockExecFileAsync replaces promisify(execFile) inside bird-skill.ts.
// We attach it to execFile via util.promisify.custom so promisify() picks it up.
const { mockExecFileAsync, mockInstallSkill, mockUpdateSkill } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  mockInstallSkill: vi.fn(),
  mockUpdateSkill: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const stub = vi.fn();
  (stub as any)[util.promisify.custom] = mockExecFileAsync;
  return { execFile: stub };
});

vi.mock("../services/gateway-rpc.js", () => ({
  installSkillFromClawHub: mockInstallSkill,
  updateSkill: mockUpdateSkill,
}));

// Stub OPENCLAW_STATE_DIR for all tests in this file.
// The getter functions read process.env at call time, so this value is used
// consistently across all tests without needing to re-import the module.
vi.stubEnv("OPENCLAW_STATE_DIR", "/test-state");

describe("bird-skill service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ─── redactBirdSecrets ───────────────────────────────────────────────────

  describe("redactBirdSecrets", () => {
    it("replaces authToken with [REDACTED]", () => {
      expect(redactBirdSecrets({ authToken: "secret123", other: "value" })).toEqual({
        authToken: "[REDACTED]",
        other: "value",
      });
    });

    it("replaces ct0 with [REDACTED]", () => {
      expect(redactBirdSecrets({ ct0: "secret456", other: "value" })).toEqual({
        ct0: "[REDACTED]",
        other: "value",
      });
    });

    it("replaces sweetisticsApiKey with [REDACTED]", () => {
      expect(redactBirdSecrets({ sweetisticsApiKey: "key789" })).toEqual({ sweetisticsApiKey: "[REDACTED]" });
    });

    it("recursively redacts nested objects", () => {
      const result = redactBirdSecrets({ level1: { authToken: "s", level2: { ct0: "s2" } } }) as any;
      expect(result.level1.authToken).toBe("[REDACTED]");
      expect(result.level1.level2.ct0).toBe("[REDACTED]");
    });

    it("recursively redacts array items", () => {
      const result = redactBirdSecrets([{ authToken: "s1" }, { ct0: "s2" }]) as any[];
      expect(result[0].authToken).toBe("[REDACTED]");
      expect(result[1].ct0).toBe("[REDACTED]");
    });
  });

  // ─── Path getter functions ────────────────────────────────────────────────

  describe("path getters", () => {
    it("getBirdInstallPrefix derives from OPENCLAW_STATE_DIR", () => {
      expect(getBirdInstallPrefix()).toBe("/test-state/.iclaw");
    });

    it("getBirdBinPath derives from OPENCLAW_STATE_DIR", () => {
      expect(getBirdBinPath()).toBe("/test-state/.iclaw/bin/bird");
    });

    it("getBirdBinPath is derived from getBirdInstallPrefix", () => {
      expect(getBirdBinPath()).toBe(`${getBirdInstallPrefix()}/bin/bird`);
    });

    it("getBirdCredentialsPath derives from OPENCLAW_STATE_DIR", () => {
      expect(getBirdCredentialsPath()).toBe("/test-state/.iclaw/skills/bird/credentials.json");
    });

    it("getBirdSkillMdPath derives from OPENCLAW_STATE_DIR", () => {
      expect(getBirdSkillMdPath()).toBe(`/test-state/skills/${BIRD_CLAWHUB_SLUG}/SKILL.md`);
    });

    it("BIRD_CLAWHUB_SLUG is the OpenClaw ClawHub slug", () => {
      expect(BIRD_CLAWHUB_SLUG).toBe("bird-twitter");
    });

    it("getBirdBinPath starts with / (absolute path)", () => {
      expect(getBirdBinPath().startsWith("/")).toBe(true);
    });

    it("paths contain no /data literal — all derived from STATE_DIR", () => {
      expect(getBirdBinPath()).not.toContain("/data");
      expect(getBirdInstallPrefix()).not.toContain("/data");
      expect(getBirdCredentialsPath()).not.toContain("/data");
      expect(getBirdSkillMdPath()).not.toContain("/data");
    });
  });

  // ─── readBirdCredentials ──────────────────────────────────────────────────

  describe("readBirdCredentials", () => {
    it("returns null if credentials file does not exist", async () => {
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      const result = await readBirdCredentials();
      expect(result).toBeNull();
    });
  });

  // ─── verifyBirdRuntime ────────────────────────────────────────────────────

  describe("verifyBirdRuntime", () => {
    it("calls execFileAsync with getBirdBinPath() and --version (absolute path)", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "bird 1.0.0\n", stderr: "" });
      const result = await verifyBirdRuntime();
      expect(mockExecFileAsync).toHaveBeenCalledOnce();
      const [cmd, args] = mockExecFileAsync.mock.calls[0];
      expect(cmd).toBe(getBirdBinPath());
      expect(args).toContain("--version");
      expect(result.installed).toBe(true);
    });

    it("returns installed: false if binary does not exist", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("ENOENT"));
      const result = await verifyBirdRuntime();
      expect(result.installed).toBe(false);
    });
  });

  // ─── setupBirdSkill validation ────────────────────────────────────────────

  describe("setupBirdSkill validation", () => {
    it("rejects missing authToken", async () => {
      await expect(
        setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: "", ct0: "ct0-val" }),
      ).rejects.toThrow();
    });

    it("rejects missing ct0", async () => {
      await expect(
        setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: "tok", ct0: "" }),
      ).rejects.toThrow();
    });
  });

  // ─── setupBirdSkill response purity ──────────────────────────────────────

  describe("setupBirdSkill response purity", () => {
    const AUTH_TOKEN = "super-secret-auth-token-xyz";
    const CT0 = "super-secret-ct0-abc";

    beforeEach(() => {
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "rename").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true } as any);
      vi.spyOn(fs, "unlink").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "symlink").mockResolvedValue(undefined as any);
    });

    function setupSuccessMocks() {
      mockInstallSkill.mockResolvedValue(undefined);
      mockUpdateSkill.mockResolvedValue(undefined);
      // verifyBirdRuntime → installed: true
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "bird 2.0.0\n", stderr: "" });
      // setupBirdSkill verification → whoami ok
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "user_handle\n", stderr: "" });
    }

    it("response JSON does not contain raw authToken value", async () => {
      setupSuccessMocks();
      const result = await setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: AUTH_TOKEN, ct0: CT0 });
      expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
    });

    it("response JSON does not contain raw ct0 value", async () => {
      setupSuccessMocks();
      const result = await setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: AUTH_TOKEN, ct0: CT0 });
      expect(JSON.stringify(result)).not.toContain(CT0);
    });
  });

  // ─── env injection for verification ──────────────────────────────────────

  describe("env injection for verification", () => {
    const AUTH_TOKEN = "env-inject-auth-token";
    const CT0 = "env-inject-ct0";

    beforeEach(() => {
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "rename").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true } as any);
      vi.spyOn(fs, "unlink").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "symlink").mockResolvedValue(undefined as any);
    });

    it("bird whoami is invoked with AUTH_TOKEN and CT0 in env, not in argv", async () => {
      mockInstallSkill.mockResolvedValue(undefined);
      mockUpdateSkill.mockResolvedValue(undefined);
      mockExecFileAsync
        // verifyBirdRuntime → installed: true
        .mockResolvedValueOnce({ stdout: "bird 2.0.0\n", stderr: "" })
        // setupBirdSkill verification (whoami)
        .mockImplementationOnce((cmd: string, args: string[], opts: any) => {
          expect(args).not.toContain(AUTH_TOKEN);
          expect(args).not.toContain(CT0);
          expect(opts?.env?.AUTH_TOKEN).toBe(AUTH_TOKEN);
          expect(opts?.env?.CT0).toBe(CT0);
          return Promise.resolve({ stdout: "user_handle\n", stderr: "" });
        });

      await setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: AUTH_TOKEN, ct0: CT0 });
      expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    });
  });

  // ─── PATH propagation ─────────────────────────────────────────────────────

  describe("PATH propagation", () => {
    beforeEach(() => {
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "rename").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true } as any);
      vi.spyOn(fs, "unlink").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "symlink").mockResolvedValue(undefined as any);
    });

    it("updateSkill is called with PATH derived from STATE_DIR and credential env", async () => {
      mockInstallSkill.mockResolvedValue(undefined);
      mockUpdateSkill.mockResolvedValue(undefined);
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: "bird 2.0.0\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "user_handle\n", stderr: "" });

      await setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: "tok", ct0: "ct0" });

      expect(mockInstallSkill).toHaveBeenCalledWith("bird-twitter");
      expect(mockUpdateSkill).toHaveBeenCalledOnce();
      const updateArg = mockUpdateSkill.mock.calls[0][0];
      expect(updateArg.skillKey).toBe("bird-twitter");
      expect(updateArg.enabled).toBe(true);
      // PATH must contain the bin dir derived from STATE_DIR — not a hardcoded /data path
      expect(updateArg.env?.PATH).toContain("/test-state/.iclaw/bin");
      expect(updateArg.env?.PATH).not.toContain("/data");
      expect(updateArg.env?.AUTH_TOKEN).toBe("tok");
      expect(updateArg.env?.CT0).toBe("ct0");
      // symlink must use the STATE_DIR-derived bin path
      expect(fs.symlink).toHaveBeenCalledWith("/test-state/.iclaw/bin/bird", "/usr/local/bin/bird");
    });

    it("fails setup when bird skill content install fails", async () => {
      mockInstallSkill.mockRejectedValue(new Error("skills_install_failed"));

      await expect(
        setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: "tok", ct0: "ct0" }),
      ).rejects.toThrow("skills_install_failed");

      expect(mockUpdateSkill).not.toHaveBeenCalled();
    });

    it("fails setup when bird SKILL.md is still missing after install", async () => {
      mockInstallSkill.mockResolvedValue(undefined);
      vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await expect(
        setupBirdSkill({ slug: "bird", authMode: "cookies", authToken: "tok", ct0: "ct0" }),
      ).rejects.toThrow("bird_skill_content_missing");

      expect(mockUpdateSkill).not.toHaveBeenCalled();
    });
  });

  // ─── log redaction ────────────────────────────────────────────────────────

  describe("log redaction", () => {
    it("redactBirdSecrets masks authToken before logging", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const redacted = redactBirdSecrets({ authToken: "secret", message: "setup" });
      console.log("[test]", redacted);
      expect(JSON.stringify(consoleSpy.mock.calls[0])).not.toContain("secret");
      expect(JSON.stringify(consoleSpy.mock.calls[0])).toContain("[REDACTED]");
      consoleSpy.mockRestore();
    });

    it("redactBirdSecrets masks ct0 before logging", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const redacted = redactBirdSecrets({ ct0: "my-ct0-secret", error: "setup failed" });
      console.error("[test]", redacted);
      expect(JSON.stringify(consoleSpy.mock.calls[0])).not.toContain("my-ct0-secret");
      consoleSpy.mockRestore();
    });
  });

  // ─── installBirdDependency ────────────────────────────────────────────────

  describe("installBirdDependency", () => {
    it("writes wrapper script at getBirdBinPath() and best-effort symlinks /usr/local/bin/bird", async () => {
      // npm install
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

      const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
      const renameSpy = vi.spyOn(fs, "rename").mockResolvedValue(undefined as any);
      const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      const symlinkSpy = vi.spyOn(fs, "symlink").mockResolvedValue(undefined as any);

      await installBirdDependency();

      const binPath = getBirdBinPath();
      const installPrefix = getBirdInstallPrefix();

      // Bin directory created before writing the wrapper
      expect(mkdirSpy).toHaveBeenCalledWith(
        `${installPrefix}/bin`,
        expect.objectContaining({ recursive: true }),
      );

      // Wrapper script written at the canonical absolute path and includes
      // credential fallback so AUTH_TOKEN/CT0 are loaded from credentials.json
      // when not already in the environment (e.g. manual shell invocation).
      expect(writeFileSpy).toHaveBeenCalledWith(
        `${binPath}.tmp`,
        expect.stringContaining(`exec ${installPrefix}/node_modules/.bin/bird`),
        expect.objectContaining({ mode: 0o755 }),
      );
      const wrapperArg = writeFileSpy.mock.calls[0][1] as string;
      expect(wrapperArg).toContain("AUTH_TOKEN");
      expect(wrapperArg).toContain("CT0");
      expect(wrapperArg).toContain("credentials.json");
      expect(renameSpy).toHaveBeenCalledWith(`${binPath}.tmp`, binPath);

      // Guaranteed-PATH symlink attempted at /usr/local/bin/bird
      expect(symlinkSpy).toHaveBeenCalledWith(binPath, "/usr/local/bin/bird");

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
      unlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
    });

    it("throws if /usr/local/bin/bird symlink cannot be created", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "rename").mockResolvedValue(undefined as any);
      vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      // /usr/local/bin not writable — must propagate, not swallow
      vi.spyOn(fs, "symlink").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

      await expect(installBirdDependency()).rejects.toThrow();

      vi.restoreAllMocks();
    });
  });
});
